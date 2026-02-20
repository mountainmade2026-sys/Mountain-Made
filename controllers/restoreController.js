const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const db = require('../config/database');
const { initializeDatabase } = require('../config/database');
const User = require('../models/User');
const execAsync = promisify(exec);

const resolveRestoreDbConfig = () => {
  const databaseUrl = String(process.env.DATABASE_URL || '').trim();
  const direct = {
    dbHost: String(process.env.DB_HOST || '').trim(),
    dbPort: String(process.env.DB_PORT || '').trim(),
    dbName: String(process.env.DB_NAME || '').trim(),
    dbUser: String(process.env.DB_USER || '').trim(),
    dbPassword: String(process.env.DB_PASSWORD || ''),
    sslMode: String(process.env.PGSSLMODE || '').trim()
  };

  if (direct.dbHost && direct.dbPort && direct.dbName && direct.dbUser) {
    return {
      dbHost: direct.dbHost,
      dbPort: direct.dbPort,
      dbName: direct.dbName,
      dbUser: direct.dbUser,
      dbPassword: direct.dbPassword,
      sslMode: direct.sslMode
    };
  }

  if (!databaseUrl) {
    return {
      dbHost: direct.dbHost || 'localhost',
      dbPort: direct.dbPort || '5432',
      dbName: direct.dbName || 'mountain_made',
      dbUser: direct.dbUser || 'postgres',
      dbPassword: direct.dbPassword || '',
      sslMode: direct.sslMode
    };
  }

  try {
    const parsed = new URL(databaseUrl);
    const querySslMode = parsed.searchParams.get('sslmode') || '';
    return {
      dbHost: parsed.hostname || direct.dbHost || 'localhost',
      dbPort: parsed.port || direct.dbPort || '5432',
      dbName: (parsed.pathname || '').replace(/^\//, '') || direct.dbName || 'mountain_made',
      dbUser: parsed.username || direct.dbUser || 'postgres',
      dbPassword: parsed.password || direct.dbPassword || '',
      sslMode: direct.sslMode || querySslMode || (parsed.hostname.includes('render.com') ? 'require' : '')
    };
  } catch (_) {
    return {
      dbHost: direct.dbHost || 'localhost',
      dbPort: direct.dbPort || '5432',
      dbName: direct.dbName || 'mountain_made',
      dbUser: direct.dbUser || 'postgres',
      dbPassword: direct.dbPassword || '',
      sslMode: direct.sslMode
    };
  }
};

const decodeCopyValue = (value) => {
  if (value === '\\N') {
    return null;
  }

  return value
    .replace(/\\\\t/g, '\t')
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\b/g, '\b')
    .replace(/\\\\f/g, '\f')
    .replace(/\\\\v/g, '\v')
    .replace(/\\\\\\\\/g, '\\');
};

const toSqlLiteral = (value) => {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  return `'${String(value).replace(/'/g, "''")}'`;
};

const sanitizeRestoreSqlContent = (sqlContent) => {
  const lines = String(sqlContent || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const sanitized = [];

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const trimmed = line.trim();

    // pg_restore list/comment style lines often begin with ';'
    if (trimmed.startsWith(';')) {
      continue;
    }

    // TOC / metadata lines that are not executable SQL
    if (/^\d+;\s+\d+\s+\d+\s+/.test(trimmed)) {
      continue;
    }

    // Some dumps may contain plain metadata rows without SQL comment prefixes
    if (/^Name:\s+.*\bType:\s+/i.test(trimmed)) {
      continue;
    }

    if (/^Type:\s+/i.test(trimmed)) {
      continue;
    }

    sanitized.push(line);
  }

  return sanitized.join('\n');
};

const transformPlainSqlDump = (sqlContent) => {
  const lines = sqlContent.split(/\r?\n/);
  const transformed = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const copyMatch = line.match(/^COPY\s+([^\s]+)\s+\((.+)\)\s+FROM\s+stdin;\s*$/i);

    if (!copyMatch) {
      if (line.trim().startsWith('\\')) {
        continue;
      }

      transformed.push(line);
      continue;
    }

    const tableName = copyMatch[1];
    const columns = copyMatch[2];

    for (index += 1; index < lines.length; index += 1) {
      const rowLine = lines[index];

      if (rowLine.trim() === '\\.') {
        break;
      }

      if (!rowLine.length) {
        continue;
      }

      const values = rowLine.split('\t').map(decodeCopyValue);
      const literals = values.map(toSqlLiteral).join(', ');
      transformed.push(`INSERT INTO ${tableName} (${columns}) VALUES (${literals});`);
    }
  }

  return transformed.join('\n');
};

const splitSqlStatements = (sqlContent) => {
  const statements = [];
  let start = 0;
  let inSingleQuote = false;
  let dollarQuoteTag = null;

  for (let index = 0; index < sqlContent.length; index += 1) {
    const char = sqlContent[index];

    if (inSingleQuote) {
      if (char === "'" && sqlContent[index + 1] === "'") {
        index += 1;
        continue;
      }

      if (char === "'") {
        inSingleQuote = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (sqlContent.startsWith(dollarQuoteTag, index)) {
        index += dollarQuoteTag.length - 1;
        dollarQuoteTag = null;
      }
      continue;
    }

    if (char === "'") {
      inSingleQuote = true;
      continue;
    }

    if (char === '$') {
      const tagMatch = sqlContent.slice(index).match(/^\$[A-Za-z0-9_]*\$/);
      if (tagMatch) {
        dollarQuoteTag = tagMatch[0];
        index += dollarQuoteTag.length - 1;
        continue;
      }
    }

    if (char === ';') {
      const statement = sqlContent.slice(start, index + 1).trim();
      if (statement) {
        statements.push(statement);
      }
      start = index + 1;
    }
  }

  const trailing = sqlContent.slice(start).trim();
  if (trailing) {
    statements.push(trailing);
  }

  return statements;
};

const shouldIgnoreRestoreStatement = (statement) => {
  const normalized = statement.trim().replace(/\s+/g, ' ').toUpperCase();
  return (
    normalized.startsWith('ALTER DEFAULT PRIVILEGES') ||
    normalized.startsWith('COMMENT ON EXTENSION')
  );
};

const isIgnorableRestoreError = (error) => {
  const message = `${error?.message || ''}`.toLowerCase();
  return (
    message.includes('permission denied to change default privileges') ||
    message.includes('must be member of role')
  );
};

const restoreWithPgClient = async (sqlFilePath) => {
  const originalSql = await fs.promises.readFile(sqlFilePath, 'utf8');
  const sanitizedSql = sanitizeRestoreSqlContent(originalSql);
  const transformedSql = transformPlainSqlDump(sanitizedSql);
  const statements = splitSqlStatements(transformedSql);

  let executedStatements = 0;
  let skippedStatements = 0;

  for (const statement of statements) {
    if (shouldIgnoreRestoreStatement(statement)) {
      skippedStatements += 1;
      continue;
    }

    try {
      await db.query(statement);
      executedStatements += 1;
    } catch (error) {
      if (isIgnorableRestoreError(error)) {
        skippedStatements += 1;
        continue;
      }

      throw error;
    }
  }

  return { executedStatements, skippedStatements };
};

const isPsqlMissingError = (error) => {
  const message = `${error?.message || ''} ${error?.stderr || ''}`.toLowerCase();
  return (
    error?.code === 'ENOENT' ||
    message.includes('not recognized as an internal or external command') ||
    message.includes('command not found') ||
    message.includes('no such file or directory')
  );
};

const isNonCriticalPsqlPermissionError = (error) => {
  const message = `${error?.message || ''} ${error?.stderr || ''}`.toLowerCase();
  return (
    message.includes('permission denied to change default privileges') ||
    message.includes('must be member of role') ||
    message.includes('role') && message.includes('does not exist')
  );
};

const syncTableSequence = async (tableName, columnName = 'id') => {
  const sequenceResult = await db.query(
    `SELECT pg_get_serial_sequence($1, $2) AS seq`,
    [`public.${tableName}`, columnName]
  );

  const seq = sequenceResult.rows?.[0]?.seq;
  if (!seq) return;

  await db.query(
    `SELECT setval($1, COALESCE((SELECT MAX(${columnName}) FROM ${tableName}), 1), true)`,
    [seq]
  );
};

const runPostRestoreRepair = async () => {
  // Re-apply all idempotent schema migrations/defaults used by the app.
  await initializeDatabase();

  // Ensure admin users still exist after restore.
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@mountainmade.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
  const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'developer@mountainmade.com';
  const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD || 'SuperAdmin@123';

  await User.ensureAdmin(adminEmail, adminPassword);
  await User.ensureSuperAdmin(superAdminEmail, superAdminPassword);

  // Fix sequence drift caused by SQL dumps restoring explicit IDs.
  const tables = [
    'users',
    'categories',
    'homepage_sections',
    'products',
    'cart',
    'orders',
    'order_items',
    'addresses',
    'uploads',
    'contact_messages',
    'backups'
  ];

  for (const tableName of tables) {
    try {
      await syncTableSequence(tableName);
    } catch (error) {
      // Table may not exist in some backups; initializeDatabase will recreate core tables.
      console.warn(`Sequence sync warning for ${tableName}:`, error.message);
    }
  }
};

async function countUsersRowsInSql(sqlFilePath) {
  try {
    const stream = fs.createReadStream(sqlFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let inUsersCopy = false;
    let count = 0;
    let markerCount = null;

    for await (const line of rl) {
      if (markerCount === null) {
        const markerMatch = line.match(/^--\s*APP_USERS_TOTAL\s*:\s*(\d+)\s*$/);
        if (markerMatch) {
          markerCount = parseInt(markerMatch[1], 10);
        }
      }

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

    if (typeof markerCount === 'number' && !Number.isNaN(markerCount)) {
      return markerCount;
    }

    return count;
  } catch (error) {
    console.warn('Could not inspect users rows in SQL file:', error.message);
    return null;
  }
}

async function countTableRowsInSql(sqlFilePath, tableName) {
  try {
    const stream = fs.createReadStream(sqlFilePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const copyPrefix = `COPY public.${tableName} `;
    let inCopyBlock = false;
    let count = 0;

    for await (const line of rl) {
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

    return inCopyBlock ? count : null;
  } catch (error) {
    console.warn(`Could not inspect ${tableName} rows in SQL file:`, error.message);
    return null;
  }
}

async function inspectTableDataInSql(sqlFilePath, tableName) {
  try {
    const sqlText = await fs.promises.readFile(sqlFilePath, 'utf8');
    const normalized = String(tableName || '').trim().toLowerCase();
    if (!normalized) {
      return { hasData: false, copyRows: null, insertStatements: 0 };
    }

    const copyRows = await countTableRowsInSql(sqlFilePath, normalized);
    const insertRegex = new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${normalized}\\b`, 'ig');
    const insertStatements = (sqlText.match(insertRegex) || []).length;

    return {
      hasData: (typeof copyRows === 'number' && copyRows > 0) || insertStatements > 0,
      copyRows,
      insertStatements
    };
  } catch (error) {
    console.warn(`Could not inspect table payload for ${tableName}:`, error.message);
    return { hasData: false, copyRows: null, insertStatements: 0 };
  }
}

// Restore database from uploaded SQL file
exports.restoreDatabase = async (req, res) => {
  let sqlFilePath;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    sqlFilePath = req.file.path;

    // Inspect uploaded SQL so we know how many user rows are in the backup file itself
    const expectedUsersFromBackup = await countUsersRowsInSql(sqlFilePath);
    const expectedOrdersFromBackup = await countTableRowsInSql(sqlFilePath, 'orders');
    const expectedOrderItemsFromBackup = await countTableRowsInSql(sqlFilePath, 'order_items');
    const ordersDataInSql = await inspectTableDataInSql(sqlFilePath, 'orders');
    const orderItemsDataInSql = await inspectTableDataInSql(sqlFilePath, 'order_items');

    // Get DB credentials (prefer DATABASE_URL when DB_* is not provided)
    const { dbHost, dbPort, dbName, dbUser, dbPassword, sslMode } = resolveRestoreDbConfig();
    const psqlBinary = process.env.PSQL_PATH || 'psql';
    const env = {
      ...process.env,
      PGPASSWORD: dbPassword,
      ...(sslMode ? { PGSSLMODE: sslMode } : {})
    };

    // Step 1: Reset schema so restore doesn't fail with duplicate rows (e.g., existing admin/user IDs)
    await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');

    // Step 2: Restore SQL
    let restoreMethod = 'psql';
    let fallbackStats = null;
    try {
      const restoreCmd = `"${psqlBinary}" -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -v ON_ERROR_STOP=1 -f "${sqlFilePath}"`;
      await execAsync(restoreCmd, { env, windowsHide: true });
    } catch (psqlError) {
      if (isPsqlMissingError(psqlError)) {
        console.warn('psql not available. Falling back to pg client restore.');

        await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
        restoreMethod = 'pg-fallback(no-psql)';
        fallbackStats = await restoreWithPgClient(sqlFilePath);
      } else if (isNonCriticalPsqlPermissionError(psqlError)) {
        console.warn('psql restore hit non-critical permission errors. Retrying in tolerant mode.');

        const tolerantCmd = `"${psqlBinary}" -h ${dbHost} -p ${dbPort} -U ${dbUser} -d ${dbName} -v ON_ERROR_STOP=0 -f "${sqlFilePath}"`;
        await execAsync(tolerantCmd, { env, windowsHide: true });
        restoreMethod = 'psql-tolerant';
      } else {
        console.warn('psql restore failed unexpectedly. Falling back to pg client restore.', psqlError?.message || psqlError);

        await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
        restoreMethod = 'pg-fallback(psql-failed)';
        fallbackStats = await restoreWithPgClient(sqlFilePath);
      }
    }

    // Step 3: Repair schema/defaults/sequences for compatibility with older dumps
    await runPostRestoreRepair();

    // Verify key data is present after restore
    let usersCount = 0;
    let ordersCount = 0;
    let orderItemsCount = 0;
    try {
      const result = await db.query('SELECT COUNT(*)::int AS count FROM users');
      usersCount = result.rows[0]?.count || 0;

      const ordersResult = await db.query('SELECT COUNT(*)::int AS count FROM orders');
      ordersCount = ordersResult.rows[0]?.count || 0;

      const orderItemsResult = await db.query('SELECT COUNT(*)::int AS count FROM order_items');
      orderItemsCount = orderItemsResult.rows[0]?.count || 0;
    } catch (verifyError) {
      console.warn('Post-restore verification warning:', verifyError.message);
    }

    const hasUsersMismatch =
      typeof expectedUsersFromBackup === 'number' &&
      usersCount < expectedUsersFromBackup;
    const hasOrdersMismatch =
      typeof expectedOrdersFromBackup === 'number' &&
      ordersCount < expectedOrdersFromBackup;
    const hasOrderItemsMismatch =
      typeof expectedOrderItemsFromBackup === 'number' &&
      orderItemsCount < expectedOrderItemsFromBackup;

    const hasOrdersPayloadInBackup = !!ordersDataInSql.hasData;
    const hasOrderItemsPayloadInBackup = !!orderItemsDataInSql.hasData;
    const missingCriticalOrderData =
      (hasOrdersPayloadInBackup && ordersCount === 0) ||
      (hasOrderItemsPayloadInBackup && orderItemsCount === 0);

    if (missingCriticalOrderData && !String(restoreMethod).startsWith('pg-fallback-recovery')) {
      console.warn('Critical order data missing after restore. Running recovery restore with pg parser.');

      await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
      const recoveryStats = await restoreWithPgClient(sqlFilePath);
      await runPostRestoreRepair();

      restoreMethod = `pg-fallback-recovery(${restoreMethod})`;
      fallbackStats = {
        executedStatements: (fallbackStats?.executedStatements || 0) + (recoveryStats?.executedStatements || 0),
        skippedStatements: (fallbackStats?.skippedStatements || 0) + (recoveryStats?.skippedStatements || 0)
      };

      try {
        const result = await db.query('SELECT COUNT(*)::int AS count FROM users');
        usersCount = result.rows[0]?.count || 0;

        const ordersResult = await db.query('SELECT COUNT(*)::int AS count FROM orders');
        ordersCount = ordersResult.rows[0]?.count || 0;

        const orderItemsResult = await db.query('SELECT COUNT(*)::int AS count FROM order_items');
        orderItemsCount = orderItemsResult.rows[0]?.count || 0;
      } catch (verifyError) {
        console.warn('Post-recovery verification warning:', verifyError.message);
      }
    }

    const warnings = [];
    if (hasUsersMismatch) {
      warnings.push(`Expected users from backup: ${expectedUsersFromBackup}, restored users: ${usersCount}.`);
    }
    if (hasOrdersMismatch) {
      warnings.push(`Expected orders from backup: ${expectedOrdersFromBackup}, restored orders: ${ordersCount}.`);
    }
    if (hasOrderItemsMismatch) {
      warnings.push(`Expected order items from backup: ${expectedOrderItemsFromBackup}, restored order items: ${orderItemsCount}.`);
    }
    if (hasOrdersPayloadInBackup && ordersCount === 0) {
      warnings.push('Backup file contains order payload, but restored orders are still zero.');
    }
    if (hasOrderItemsPayloadInBackup && orderItemsCount === 0) {
      warnings.push('Backup file contains order_items payload, but restored order_items are still zero.');
    }

    if (typeof expectedUsersFromBackup === 'number' && expectedUsersFromBackup <= 1) {
      return res.json({
        message: 'Database restored successfully, but the uploaded backup contains only admin/no additional users.',
        verification: {
          usersCount,
          expectedUsersFromBackup,
          warning: 'Backup file has no non-admin users to restore.'
        }
      });
    }

    res.json({
      message: hasUsersMismatch
        ? 'Database restored successfully, but users verification found fewer users than expected from backup.'
        : 'Database restored successfully.',
      verification: {
        usersCount,
        ordersCount,
        orderItemsCount,
        expectedUsersFromBackup,
        expectedOrdersFromBackup,
        expectedOrderItemsFromBackup,
        restoreMethod,
        skippedStatements: fallbackStats?.skippedStatements || 0,
        warning: warnings.length > 0 ? warnings.join(' ') : null
      }
    });
  } catch (error) {
    console.error('Restore error:', error);
    res.status(500).json({ error: 'Restore failed: ' + error.message });
  } finally {
    if (sqlFilePath) {
      fs.unlink(sqlFilePath, () => {});
    }
  }
};
