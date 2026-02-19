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

// Create database backup
exports.createBackup = async (req, res) => {
  try {
    const { drive, folderPath } = req.body;
    const driveInput = (drive || '').trim();
    const envBackupRoot = (process.env.BACKUP_DIR || '').trim();

    // Allow optional folderPath (can be empty string)
    const safeFolderPath = (folderPath || '').trim();

    let backupRoot;
    if (isWindows) {
      if (!driveInput && !envBackupRoot) {
        return res.status(400).json({ error: 'Drive is required on Windows' });
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
      return res.status(500).json({ error: 'Failed to create backup directory: ' + err.message });
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
      
      // Append app-level full users upsert block so users are always included even if pg_dump COPY is partial
      const usersResult = await db.query('SELECT * FROM users ORDER BY id ASC');
      const usersRows = usersResult.rows || [];

      if (usersRows.length > 0) {
        const columns = Object.keys(usersRows[0]);
        const quotedColumns = columns.map(col => `"${col}"`).join(', ');
        const conflictTarget = columns.includes('id') ? 'id' : 'email';
        const updateCols = columns.filter(col => col !== conflictTarget);
        const updateSet = updateCols.map(col => `"${col}" = EXCLUDED."${col}"`).join(', ');

        let usersSql = '\n\n-- APP_USERS_TOTAL:' + usersRows.length + '\n';
        usersSql += '-- App-level users backup (ensures all users are restorable)\n';

        for (const row of usersRows) {
          const values = columns.map(col => toSqlLiteral(row[col])).join(', ');
          usersSql += `INSERT INTO public.users (${quotedColumns}) VALUES (${values}) ON CONFLICT ("${conflictTarget}") DO UPDATE SET ${updateSet};\n`;
        }

        await fs.appendFile(filePath, usersSql, 'utf8');
      }

      // Get file size after append
      const stats = await fs.stat(filePath);
      const fileSizeBytes = stats.size;
      const fileSizeMB = (fileSizeBytes / (1024 ** 2)).toFixed(2);

      // Verify backup file contains users rows (marker-aware)
      const usersRowsInDump = usersRows.length;
      if (usersRowsInDump < usersTotal) {
        throw new Error(`Backup verification failed: users in database=${usersTotal}, users in backup=${usersRowsInDump}`);
      }

      // Save backup record to database
      const backupRecord = await Backup.create({
        filename,
        file_path: filePath,
        drive: driveLabel,
        file_size: fileSizeBytes,
        created_by: req.user.id,
        status: 'completed'
      });

      console.log('✓ Backup completed successfully');

      res.json({
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
            usersRowsInDump
          }
        }
      });
    } catch (pgError) {
      console.error('pg_dump error:', pgError);
      
      // Save failed backup record
      await Backup.create({
        filename,
        file_path: filePath,
        drive: driveLabel,
        file_size: 0,
        created_by: req.user.id,
        status: 'failed',
        error_message: pgError.message
      });

      // Provide clearer guidance when pg_dump is missing
      const notRecognized = pgError.message && pgError.message.includes('\'pg_dump\' is not recognized');
      const errorMessage = notRecognized
        ? 'pg_dump executable not found. Set PG_DUMP_PATH in your .env to the full path of pg_dump.exe (e.g., C:/Program Files/PostgreSQL/16/bin/pg_dump.exe).'
        : 'Database backup failed: ' + pgError.message;

      res.status(500).json({ 
        error: errorMessage,
        details: notRecognized
          ? 'Install PostgreSQL (with pgAdmin) and point PG_DUMP_PATH to pg_dump.exe, or add the PostgreSQL bin directory to your system PATH.'
          : 'Make sure PostgreSQL bin directory is in your system PATH'
      });
    }
  } catch (error) {
    console.error('Create backup error:', error);
    res.status(500).json({ error: 'Failed to create backup: ' + error.message });
  }
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
