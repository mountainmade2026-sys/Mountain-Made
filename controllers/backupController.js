const Backup = require('../models/Backup');
const db = require('../config/database');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const readline = require('readline');
const path = require('path');
const execAsync = promisify(exec);
const isWindows = process.platform === 'win32';
let autoBackupTimer = null;
let isAutoBackupRunning = false;

const toBool = (value) => String(value || '').trim().toLowerCase() === 'true';

const AUTO_BACKUP_SETTING_KEYS = [
  'auto_backup_enabled',
  'auto_backup_frequency',
  'auto_backup_time',
  'auto_backup_day_of_month',
  'auto_backup_keep_months',
  'auto_backup_drive',
  'auto_backup_folder',
  'auto_backup_last_run_at'
];

const AUTO_BACKUP_DEFAULTS = {
  enabled: toBool(process.env.AUTO_BACKUP_ENABLED),
  frequency: (process.env.AUTO_BACKUP_FREQUENCY || 'daily').toLowerCase() === 'monthly' ? 'monthly' : 'daily',
  time: process.env.AUTO_BACKUP_TIME || '02:00',
  dayOfMonth: Number(process.env.AUTO_BACKUP_DAY_OF_MONTH || 1),
  keepMonths: Number(process.env.AUTO_BACKUP_KEEP_MONTHS || 3),
  drive: process.env.AUTO_BACKUP_DRIVE || (isWindows ? 'C:' : '/'),
  folder: process.env.AUTO_BACKUP_FOLDER || 'mountain_made_backups',
  lastRunAt: ''
};

const normalizeAutoBackupTime = (value) => {
  const text = String(value || '').trim();
  if (!/^\d{2}:\d{2}$/.test(text)) {
    return '02:00';
  }

  const [hours, minutes] = text.split(':').map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return '02:00';
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return '02:00';
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

const parseMonthPositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(parsed));
};

const normalizeAutoBackupSettings = (raw = {}) => {
  const frequency = String(raw.frequency || AUTO_BACKUP_DEFAULTS.frequency).toLowerCase() === 'monthly' ? 'monthly' : 'daily';
  const normalized = {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : toBool(raw.enabled),
    frequency,
    time: normalizeAutoBackupTime(raw.time || AUTO_BACKUP_DEFAULTS.time),
    dayOfMonth: Math.min(31, Math.max(1, Math.floor(Number(raw.dayOfMonth || AUTO_BACKUP_DEFAULTS.dayOfMonth) || 1))),
    keepMonths: parseMonthPositiveInt(raw.keepMonths || AUTO_BACKUP_DEFAULTS.keepMonths, 3),
    drive: String(raw.drive || AUTO_BACKUP_DEFAULTS.drive || (isWindows ? 'C:' : '/')).trim() || (isWindows ? 'C:' : '/'),
    folder: String(raw.folder || AUTO_BACKUP_DEFAULTS.folder || 'mountain_made_backups').trim() || 'mountain_made_backups',
    lastRunAt: String(raw.lastRunAt || '').trim()
  };

  if (normalized.frequency !== 'monthly') {
    normalized.dayOfMonth = 1;
  }

  return normalized;
};

const upsertSiteSetting = async (key, value) => {
  await db.query(
    `
      INSERT INTO site_settings (setting_key, setting_value)
      VALUES ($1, $2)
      ON CONFLICT (setting_key)
      DO UPDATE SET setting_value = EXCLUDED.setting_value, updated_at = CURRENT_TIMESTAMP
    `,
    [key, String(value ?? '')]
  );
};

const saveAutoBackupSettings = async (settings) => {
  const normalized = normalizeAutoBackupSettings(settings);

  await Promise.all([
    upsertSiteSetting('auto_backup_enabled', normalized.enabled ? 'true' : 'false'),
    upsertSiteSetting('auto_backup_frequency', normalized.frequency),
    upsertSiteSetting('auto_backup_time', normalized.time),
    upsertSiteSetting('auto_backup_day_of_month', String(normalized.dayOfMonth)),
    upsertSiteSetting('auto_backup_keep_months', String(normalized.keepMonths)),
    upsertSiteSetting('auto_backup_drive', normalized.drive),
    upsertSiteSetting('auto_backup_folder', normalized.folder),
    upsertSiteSetting('auto_backup_last_run_at', normalized.lastRunAt || '')
  ]);

  return normalized;
};

const loadAutoBackupSettings = async () => {
  try {
    const result = await db.query(
      `SELECT setting_key, setting_value FROM site_settings WHERE setting_key = ANY($1::text[])`,
      [AUTO_BACKUP_SETTING_KEYS]
    );

    const mapped = {};
    for (const row of result.rows || []) {
      mapped[row.setting_key] = row.setting_value;
    }

    return normalizeAutoBackupSettings({
      enabled: mapped.auto_backup_enabled ?? AUTO_BACKUP_DEFAULTS.enabled,
      frequency: mapped.auto_backup_frequency ?? AUTO_BACKUP_DEFAULTS.frequency,
      time: mapped.auto_backup_time ?? AUTO_BACKUP_DEFAULTS.time,
      dayOfMonth: mapped.auto_backup_day_of_month ?? AUTO_BACKUP_DEFAULTS.dayOfMonth,
      keepMonths: mapped.auto_backup_keep_months ?? AUTO_BACKUP_DEFAULTS.keepMonths,
      drive: mapped.auto_backup_drive ?? AUTO_BACKUP_DEFAULTS.drive,
      folder: mapped.auto_backup_folder ?? AUTO_BACKUP_DEFAULTS.folder,
      lastRunAt: mapped.auto_backup_last_run_at ?? AUTO_BACKUP_DEFAULTS.lastRunAt
    });
  } catch (error) {
    console.warn('Auto backup settings load warning:', error.message);
    return normalizeAutoBackupSettings(AUTO_BACKUP_DEFAULTS);
  }
};

const isSameDate = (a, b) => (
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()
);

const isSameMonth = (a, b) => (
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth()
);

const shouldRunAutoBackupNow = (settings, now = new Date()) => {
  if (!settings.enabled) {
    return false;
  }

  const [hours, minutes] = String(settings.time || '02:00').split(':').map(Number);
  const lastRunAt = settings.lastRunAt ? new Date(settings.lastRunAt) : null;

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return false;
  }

  const scheduled = new Date(now);
  scheduled.setSeconds(0, 0);

  if (settings.frequency === 'monthly') {
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const day = Math.min(lastDay, Math.max(1, Number(settings.dayOfMonth) || 1));
    scheduled.setDate(day);
  }

  scheduled.setHours(hours, minutes, 0, 0);

  if (now < scheduled) {
    return false;
  }

  if (!(lastRunAt instanceof Date) || Number.isNaN(lastRunAt.getTime())) {
    return true;
  }

  if (settings.frequency === 'monthly') {
    return !isSameMonth(lastRunAt, now);
  }

  return !isSameDate(lastRunAt, now);
};

const applyBackupRetention = async (keepMonths) => {
  const safeKeepMonths = Math.max(1, Math.floor(Number(keepMonths) || 1));
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - safeKeepMonths);

  const result = await db.query(
    `
      SELECT id, file_path
      FROM backups
      WHERE status = 'completed' AND created_at < $1
      ORDER BY created_at ASC
    `,
    [cutoff.toISOString()]
  );

  for (const row of result.rows || []) {
    const filePath = row.file_path;
    try {
      if (filePath && fsSync.existsSync(filePath)) {
        await fs.unlink(filePath);
      }
    } catch (error) {
      console.warn(`Failed to delete old backup file ${filePath}:`, error.message);
    }

    try {
      await Backup.deleteById(row.id);
    } catch (error) {
      console.warn(`Failed to delete old backup record ${row.id}:`, error.message);
    }
  }
};

function toSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString().replace('T', ' ').replace('Z', '')}'`;
  const text = String(value).replace(/'/g, "''");
  return `'${text}'`;
}

async function countUsersRowsInSql(sqlFilePath) {
  try {
    const stream = fsSync.createReadStream(sqlFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let inUsersCopy = false;
    let count = 0;

    for await (const line of rl) {
      if (!inUsersCopy) {
        if (line.startsWith('COPY public.users ') && line.includes(' FROM stdin;')) {
          inUsersCopy = true;
        }
        continue;
      }

      if (line.trim() === '\\.') {
        break;
      }

      if (line.trim().length > 0) {
        count += 1;
      }
    }

    return count;
  } catch (error) {
    console.warn('Could not inspect users rows in SQL backup:', error.message);
    return null;
  }
}

async function countTableRowsInSql(sqlFilePath, tableName) {
  try {
    const stream = fsSync.createReadStream(sqlFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const markerRegex = new RegExp(`^--\\s*APP_${String(tableName || '').toUpperCase()}_TOTAL\\s*:\\s*(\\d+)\\s*$`);
    const copyPrefix = `COPY public.${tableName} `;

    let inCopyBlock = false;
    let count = 0;
    let markerCount = null;

    for await (const line of rl) {
      if (markerCount === null) {
        const markerMatch = line.match(markerRegex);
        if (markerMatch) {
          markerCount = parseInt(markerMatch[1], 10);
        }
      }

      if (!inCopyBlock) {
        if (line.startsWith(copyPrefix) && line.includes(' FROM stdin;')) {
          inCopyBlock = true;
        }
        continue;
      }

      if (line.trim() === '\\.') {
        break;
      }

      if (line.trim().length > 0) {
        count += 1;
      }
    }

    if (typeof markerCount === 'number' && !Number.isNaN(markerCount)) {
      return markerCount;
    }

    return inCopyBlock ? count : 0;
  } catch (error) {
    console.warn(`Could not inspect ${tableName} rows in SQL backup:`, error.message);
    return null;
  }
}

async function appendTableUpsertBlock(sqlFilePath, tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return;
  }

  const columns = Object.keys(rows[0]);
  const quotedColumns = columns.map(col => `"${col}"`).join(', ');
  const conflictTarget = columns.includes('id') ? 'id' : columns[0];
  const updateCols = columns.filter(col => col !== conflictTarget);
  const updateSet = updateCols.map(col => `"${col}" = EXCLUDED."${col}"`).join(', ');

  let block = `\n\n-- APP_${String(tableName).toUpperCase()}_TOTAL:${rows.length}\n`;
  block += `-- App-level ${tableName} backup (ensures all ${tableName} rows are restorable)\n`;

  for (const row of rows) {
    const values = columns.map(col => toSqlLiteral(row[col])).join(', ');
    block += `INSERT INTO public.${tableName} (${quotedColumns}) VALUES (${values}) ON CONFLICT ("${conflictTarget}") DO UPDATE SET ${updateSet};\n`;
  }

  await fs.appendFile(sqlFilePath, block, 'utf8');
}

// Get available drives and their space (Windows)
exports.getDrives = async (req, res) => {
  try {
    if (isWindows) {
      const { stdout } = await execAsync(
        'powershell -Command "Get-PSDrive -PSProvider FileSystem | Select-Object Name, @{Name=\'FreeSpace\';Expression={$_.Free}}, @{Name=\'TotalSpace\';Expression={$_.Used + $_.Free}} | ConvertTo-Json"',
        { windowsHide: true }
      );

      const drives = JSON.parse(stdout);
      const driveList = (Array.isArray(drives) ? drives : [drives])
        .filter(drive => drive.FreeSpace !== null)
        .map(drive => ({
          name: drive.Name + ':',
          freeSpaceGB: (drive.FreeSpace / (1024 ** 3)).toFixed(2),
          totalSpaceGB: (drive.TotalSpace / (1024 ** 3)).toFixed(2),
          usedSpaceGB: ((drive.TotalSpace - drive.FreeSpace) / (1024 ** 3)).toFixed(2),
          freeSpaceBytes: drive.FreeSpace,
          totalSpaceBytes: drive.TotalSpace
        }));

      return res.json({ drives: driveList });
    }

    const { stdout } = await execAsync('df -kP /');
    const lines = stdout.trim().split('\n');
    const dataLine = lines[lines.length - 1] || '';
    const parts = dataLine.trim().split(/\s+/);

    const totalKB = Number(parts[1] || 0);
    const usedKB = Number(parts[2] || 0);
    const availableKB = Number(parts[3] || 0);

    const totalBytes = totalKB * 1024;
    const usedBytes = usedKB * 1024;
    const freeBytes = availableKB * 1024;

    return res.json({
      drives: [{
        name: '/',
        freeSpaceGB: (freeBytes / (1024 ** 3)).toFixed(2),
        totalSpaceGB: (totalBytes / (1024 ** 3)).toFixed(2),
        usedSpaceGB: (usedBytes / (1024 ** 3)).toFixed(2),
        freeSpaceBytes: freeBytes,
        totalSpaceBytes: totalBytes
      }]
    });
  } catch (error) {
    console.error('Get drives error:', error);
    if (!isWindows) {
      return res.json({
        drives: [{
          name: '/',
          freeSpaceGB: '0.00',
          totalSpaceGB: '0.00',
          usedSpaceGB: '0.00',
          freeSpaceBytes: 0,
          totalSpaceBytes: 0
        }]
      });
    }
    res.status(500).json({ error: 'Failed to get drive information' });
  }
};

const createBackupInternal = async ({ drive, folderPath, createdByUserId = null }) => {
    const driveInput = (drive || '').trim();
    const envBackupRoot = (process.env.BACKUP_DIR || '').trim();

    // Allow optional folderPath (can be empty string)
    const safeFolderPath = (folderPath || '').trim();

    let backupRoot;
    if (isWindows) {
      if (!driveInput && !envBackupRoot) {
        throw new Error('Drive is required on Windows');
      }
      backupRoot = envBackupRoot || `${driveInput}\\`;
    } else {
      backupRoot = envBackupRoot || '/tmp';
    }

    const backupDir = safeFolderPath
      ? path.join(backupRoot, safeFolderPath)
      : path.join(backupRoot, 'mountain_made_backups');

    const driveLabel = driveInput || (isWindows ? backupRoot : '/');
    
    // Create directory if it doesn't exist
    try {
      await fs.mkdir(backupDir, { recursive: true });
    } catch (err) {
      throw new Error('Failed to create backup directory: ' + err.message);
    }

    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `mountain_made_backup_${timestamp}.sql`;
    const filePath = path.join(backupDir, filename);

    // Get database credentials from environment
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || '5432';
    const dbName = process.env.DB_NAME || 'mountain_made';
    const dbUser = process.env.DB_USER || 'postgres';
    const dbPassword = process.env.DB_PASSWORD || '';

    // Set PGPASSWORD environment variable for pg_dump
    const env = { ...process.env, PGPASSWORD: dbPassword };

    // Determine pg_dump binary path (allow override via PG_DUMP_PATH)
    const pgDumpBinary = process.env.PG_DUMP_PATH || 'pg_dump';

    // Snapshot user counts at backup time for visibility/verification
    let usersTotal = 0;
    let nonAdminUsers = 0;
    try {
      const countResult = await db.query(`
        SELECT
          COUNT(*)::int AS users_total,
          COUNT(*) FILTER (WHERE role <> 'admin')::int AS non_admin_users
        FROM users
      `);
      usersTotal = countResult.rows[0]?.users_total || 0;
      nonAdminUsers = countResult.rows[0]?.non_admin_users || 0;
    } catch (countError) {
      console.warn('Backup user count warning:', countError.message);
    }

    // Execute pg_dump command (quote binary and output path for Windows safety)
    const pgDumpCommand = `"${pgDumpBinary}" -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -F p -f "${filePath}"`;

    console.log('Starting database backup...');
    
    try {
      await execAsync(pgDumpCommand, { env, windowsHide: true });
      
      // Append app-level critical table upsert blocks so data is restorable even if pg_dump COPY is partial
      const usersResult = await db.query('SELECT * FROM users ORDER BY id ASC');
      const usersRows = usersResult.rows || [];
      const ordersResult = await db.query('SELECT * FROM orders ORDER BY id ASC');
      const ordersRows = ordersResult.rows || [];
      const orderItemsResult = await db.query('SELECT * FROM order_items ORDER BY id ASC');
      const orderItemsRows = orderItemsResult.rows || [];

      await appendTableUpsertBlock(filePath, 'users', usersRows);
      await appendTableUpsertBlock(filePath, 'orders', ordersRows);
      await appendTableUpsertBlock(filePath, 'order_items', orderItemsRows);

      // Get file size after append
      const stats = await fs.stat(filePath);
      const fileSizeBytes = stats.size;
      const fileSizeMB = (fileSizeBytes / (1024 ** 2)).toFixed(2);

      // Verify backup file contains critical table rows (marker-aware)
      const usersRowsInDump = usersRows.length;
      if (usersRowsInDump < usersTotal) {
        throw new Error(`Backup verification failed: users in database=${usersTotal}, users in backup=${usersRowsInDump}`);
      }

      const ordersRowsInDump = await countTableRowsInSql(filePath, 'orders');
      const orderItemsRowsInDump = await countTableRowsInSql(filePath, 'order_items');
      const ordersTotal = ordersRows.length;
      const orderItemsTotal = orderItemsRows.length;

      if (typeof ordersRowsInDump === 'number' && ordersRowsInDump < ordersTotal) {
        throw new Error(`Backup verification failed: orders in database=${ordersTotal}, orders in backup=${ordersRowsInDump}`);
      }

      if (typeof orderItemsRowsInDump === 'number' && orderItemsRowsInDump < orderItemsTotal) {
        throw new Error(`Backup verification failed: order_items in database=${orderItemsTotal}, order_items in backup=${orderItemsRowsInDump}`);
      }

      // Save backup record to database
      const backupRecord = await Backup.create({
        filename,
        file_path: filePath,
        drive: driveLabel,
        file_size: fileSizeBytes,
        created_by: createdByUserId,
        status: 'completed'
      });

      console.log('✓ Backup completed successfully');

      return {
        message: 'Database backup created successfully',
        backup: {
          id: backupRecord.id,
          filename,
          filePath,
          drive: driveLabel,
          fileSizeMB,
          createdAt: backupRecord.created_at,
          snapshot: {
            usersTotal,
            nonAdminUsers,
            usersRowsInDump,
            ordersTotal,
            orderItemsTotal,
            ordersRowsInDump,
            orderItemsRowsInDump
          }
        }
      };
    } catch (pgError) {
      console.error('pg_dump error:', pgError);
      
      // Save failed backup record
      await Backup.create({
        filename,
        file_path: filePath,
        drive: driveLabel,
        file_size: 0,
        created_by: createdByUserId,
        status: 'failed',
        error_message: pgError.message
      });

      // Provide clearer guidance when pg_dump is missing
      const notRecognized = pgError.message && pgError.message.includes('\'pg_dump\' is not recognized');
      const errorMessage = notRecognized
        ? 'pg_dump executable not found. Set PG_DUMP_PATH in your .env to the full path of pg_dump.exe (e.g., C:/Program Files/PostgreSQL/16/bin/pg_dump.exe).'
        : 'Database backup failed: ' + pgError.message;

      const err = new Error(errorMessage);
      err.details = notRecognized
        ? 'Install PostgreSQL (with pgAdmin) and point PG_DUMP_PATH to pg_dump.exe, or add the PostgreSQL bin directory to your system PATH.'
        : 'Make sure PostgreSQL bin directory is in your system PATH';
      throw err;
    }
};

// Create database backup
exports.createBackup = async (req, res) => {
  try {
    const { drive, folderPath } = req.body;
    const response = await createBackupInternal({
      drive,
      folderPath,
      createdByUserId: req.user?.id || null
    });

    res.json(response);
  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({
      error: error.message,
      details: error.details || 'Backup creation failed'
    });
  }
};

exports.runAutomatedBackup = async () => {
  const settings = await loadAutoBackupSettings();
  const autoDrive = settings.drive || AUTO_BACKUP_DEFAULTS.drive;
  const autoFolder = settings.folder || AUTO_BACKUP_DEFAULTS.folder;
  return createBackupInternal({
    drive: autoDrive,
    folderPath: autoFolder,
    createdByUserId: null
  });
};

exports.getAutoBackupSettings = async (req, res) => {
  try {
    const settings = await loadAutoBackupSettings();
    res.json({ settings });
  } catch (error) {
    console.error('Get auto backup settings error:', error);
    res.status(500).json({ error: 'Failed to load auto backup settings' });
  }
};

exports.updateAutoBackupSettings = async (req, res) => {
  try {
    const payload = req.body || {};
    const normalized = normalizeAutoBackupSettings({
      enabled: payload.enabled,
      frequency: payload.frequency,
      time: payload.time,
      dayOfMonth: payload.dayOfMonth,
      keepMonths: payload.keepMonths,
      drive: payload.drive,
      folder: payload.folder,
      lastRunAt: payload.lastRunAt
    });

    const saved = await saveAutoBackupSettings(normalized);
    res.json({ success: true, message: 'Auto backup settings saved.', settings: saved });
  } catch (error) {
    console.error('Update auto backup settings error:', error);
    res.status(500).json({ error: 'Failed to save auto backup settings.' });
  }
};

exports.startAutoBackupScheduler = () => {
  if (autoBackupTimer) {
    return;
  }

  const intervalMs = Math.max(30, Number(process.env.AUTO_BACKUP_CHECK_INTERVAL_SECONDS || 60)) * 1000;

  const runJob = async () => {
    if (isAutoBackupRunning) {
      return;
    }

    isAutoBackupRunning = true;
    try {
      const settings = await loadAutoBackupSettings();
      if (!shouldRunAutoBackupNow(settings, new Date())) {
        return;
      }

      const result = await createBackupInternal({
        drive: settings.drive,
        folderPath: settings.folder,
        createdByUserId: null
      });

      const fileName = result?.backup?.filename || 'unknown';
      const lastRunAt = new Date().toISOString();
      await saveAutoBackupSettings({ ...settings, lastRunAt });
      await applyBackupRetention(settings.keepMonths);

      console.log(`✓ Auto backup completed: ${fileName} (${settings.frequency} @ ${settings.time})`);
    } catch (error) {
      console.error('Auto backup failed:', error.message || error);
    } finally {
      isAutoBackupRunning = false;
    }
  };

  autoBackupTimer = setInterval(runJob, intervalMs);

  if (typeof autoBackupTimer.unref === 'function') {
    autoBackupTimer.unref();
  }

  runJob();

  const intervalSeconds = Math.round(intervalMs / 1000);
  console.log(`✓ Auto backup scheduler enabled (checks every ${intervalSeconds} seconds)`);
};

// Get all backups
exports.getAllBackups = async (req, res) => {
  try {
    const backups = await Backup.getAll();
    
    // Format backup data
    const formattedBackups = backups.map(backup => ({
      id: backup.id,
      filename: backup.filename,
      filePath: backup.file_path,
      drive: backup.drive,
      fileSizeMB: (backup.file_size / (1024 ** 2)).toFixed(2),
      status: backup.status,
      canDownload: backup.status === 'completed',
      createdBy: backup.created_by_name,
      createdAt: backup.created_at,
      errorMessage: backup.error_message
    }));

    res.json({ backups: formattedBackups });
  } catch (error) {
    console.error('Get backups error:', error);
    res.status(500).json({ error: 'Failed to get backups' });
  }
};

// Download backup file by backup ID
exports.downloadBackup = async (req, res) => {
  try {
    const { id } = req.params;
    const backup = await Backup.getById(id);

    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    const filePath = backup.file_path;
    if (!filePath || !fsSync.existsSync(filePath)) {
      return res.status(404).json({
        error: 'Backup file is not available on server storage. Create a new backup and download it immediately.'
      });
    }

    const filename = backup.filename || `backup-${backup.id}.sql`;
    return res.download(filePath, filename);
  } catch (error) {
    console.error('Download backup error:', error);
    return res.status(500).json({ error: 'Failed to download backup file' });
  }
};

// Delete backup record (does not delete the actual file)
exports.deleteBackup = async (req, res) => {
  try {
    const { id } = req.params;
    const backup = await Backup.deleteById(id);
    
    if (!backup) {
      return res.status(404).json({ error: 'Backup not found' });
    }

    res.json({ message: 'Backup record deleted successfully' });
  } catch (error) {
    console.error('Delete backup error:', error);
    res.status(500).json({ error: 'Failed to delete backup' });
  }
};
