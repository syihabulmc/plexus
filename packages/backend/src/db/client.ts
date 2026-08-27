import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { logger } from '../utils/logger';
import path from 'node:path';
import fs from 'node:fs';

type SupportedDialect = 'sqlite' | 'postgres';
type PostgresDriver = 'postgres-js' | 'pglite';

type SqliteDb = ReturnType<typeof drizzle>;
type PostgresJsDb = ReturnType<typeof drizzlePg>;
type PgliteDb = any;

let dbInstance: SqliteDb | PostgresJsDb | PgliteDb | null = null;
let sqlClient: postgres.Sql | null = null;
let pgliteClient: any = null;
let tursoClient: any = null;
const PGLITE_BOOT_EXIT_CODE = 99;
let currentDialect: SupportedDialect | null = null;
let currentSchema: any = null;

export function parseConnectionString(uri: string): {
  dialect: SupportedDialect;
  connectionString: string;
} {
  if (uri.startsWith('sqlite://')) {
    let connStr = uri.replace('sqlite://', '');
    // Normalize :memory: path (handles sqlite://:memory: and sqlite://:memory:/)
    if (
      connStr === ':memory:' ||
      connStr === 'memory:' ||
      connStr === ':memory:/' ||
      connStr === 'memory:/'
    ) {
      connStr = ':memory:';
    }
    return { dialect: 'sqlite', connectionString: connStr };
  } else if (uri.startsWith('libsql://') || uri.startsWith('turso://')) {
    // Turso Cloud / libSQL remote server — still the SQLite dialect, reached
    // over Hrana HTTP via @tursodatabase/serverless/compat (see below).
    // `turso://` is the newer official scheme accepted by that driver.
    return { dialect: 'sqlite', connectionString: uri };
  } else if (uri.startsWith('postgres://') || uri.startsWith('postgresql://')) {
    return { dialect: 'postgres', connectionString: uri };
  }
  throw new Error(
    `Invalid database URI: must start with sqlite://, libsql://, turso:// or postgres://. Got: ${uri}`
  );
}

function resolvePath(relPath: string): string {
  if (path.isAbsolute(relPath)) return relPath;
  if (relPath.startsWith('./')) {
    return path.resolve(process.cwd(), relPath);
  }
  const projectRoot = path.resolve(process.cwd(), '../../');
  return path.join(projectRoot, relPath);
}

function getPostgresDriver(): PostgresDriver {
  return process.env.PLEXUS_POSTGRES_DRIVER === 'pglite' ? 'pglite' : 'postgres-js';
}

export function initializeDatabase(connectionString?: string) {
  if (dbInstance) {
    logger.silly('Database already initialized, skipping');
    return dbInstance;
  }

  let effectiveUri = connectionString;

  if (!effectiveUri) {
    effectiveUri = process.env.DATABASE_URL;

    if (!effectiveUri) {
      throw new Error('DATABASE_URL environment variable is required for database connection');
    }

    logger.silly(`Using DATABASE_URL: ${effectiveUri.substring(0, 30)}...`);
  }

  const { dialect, connectionString: connStr } = parseConnectionString(effectiveUri);
  currentDialect = dialect;

  logger.silly(`Initializing ${dialect} database...`);

  if (dialect === 'sqlite') {
    const sqliteSchema = require('../../drizzle/schema/sqlite/index');
    const {
      requestUsage,
      providerCooldowns,
      debugLogs,
      inferenceErrors,
      providerPerformance,
      quotaState,
      providers: providersTable,
      providerModels,
      modelAliases,
      modelAliasTargets,
      apiKeys,
      userQuotaDefinitions,
      mcpServers,
      mcpKeys,
      systemSettings,
      oauthCredentials,
      customCheckers,
    } = sqliteSchema;

    currentSchema = sqliteSchema;

    const schema = {
      requestUsage,
      providerCooldowns,
      debugLogs,
      inferenceErrors,
      providerPerformance,
      quotaState,
      providers: providersTable,
      providerModels,
      modelAliases,
      modelAliasTargets,
      apiKeys,
      userQuotaDefinitions,
      mcpServers,
      mcpKeys,
      systemSettings,
      oauthCredentials,
      customCheckers,
    };

    if (connStr.startsWith('libsql://') || connStr.startsWith('turso://')) {
      // Remote Turso / libSQL server: pure-fetch Hrana client exposed through
      // the @libsql/client-compatible API (/compat), wrapped by drizzle's
      // LibSQL driver core.
      //
      // We deliberately bypass the `drizzle-orm/libsql` entry point: its
      // driver.cjs unconditionally requires `@libsql/client`, whose Node entry
      // loads platform-native bindings (@libsql/linux-x64-gnu etc.) that
      // cannot resolve inside a `bun build --compile` single-file binary.
      // `construct` from the public ./libsql/driver-core export is what that
      // wrapper calls internally, takes the same (client, config) shape, and
      // depends only on other pure-JS drizzle internals.
      const urlToken = connStr.match(/[?&]authToken=([^&]+)/)?.[1];
      const authToken =
        process.env.TURSO_AUTH_TOKEN ??
        (typeof urlToken === 'string' ? decodeURIComponent(urlToken) : undefined);
      if (!authToken) {
        throw new Error(
          'TURSO_AUTH_TOKEN environment variable (or ?authToken= URL parameter) is required for libsql:// connections'
        );
      }
      const { createClient } = require('@tursodatabase/serverless/compat');
      const { construct: constructLibSql } = require('drizzle-orm/libsql/driver-core') as {
        construct: (client: unknown, config?: { schema?: unknown }) => SqliteDb;
      };
      tursoClient = createClient({ url: connStr, authToken });
      // ponytail: every query is now one HTTPS round trip; if hot-path latency
      // hurts, upgrade to an embedded replica (@tursodatabase/database sync).
      dbInstance = constructLibSql(tursoClient, { schema });
      logger.silly(
        `Connecting to Turso: ${connStr.replace(/[?&]authToken=[^&]+/, '?authToken=***')}`
      );
      return dbInstance;
    }

    // Local SQLite (Bun native) — original behavior preserved.
    const dbPath = connStr === ':memory:' ? ':memory:' : resolvePath(connStr);

    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (dir !== '.' && !fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    const sqlite = new Database(dbPath);
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA busy_timeout = 5000');
    sqlite.exec('PRAGMA foreign_keys = ON');

    dbInstance = drizzle(sqlite, { schema });
  } else {
    const postgresDriver = getPostgresDriver();
    const pgSchema = require('../../drizzle/schema/postgres/index');
    const {
      requestUsage,
      providerCooldowns,
      debugLogs,
      inferenceErrors,
      providerPerformance,
      quotaState,
      providers: providersTable,
      providerModels,
      modelAliases,
      modelAliasTargets,
      apiKeys,
      userQuotaDefinitions,
      mcpServers,
      mcpKeys,
      systemSettings,
      oauthCredentials,
      customCheckers,
    } = pgSchema;

    currentSchema = pgSchema;

    const schema = {
      requestUsage,
      providerCooldowns,
      debugLogs,
      inferenceErrors,
      providerPerformance,
      quotaState,
      providers: providersTable,
      providerModels,
      modelAliases,
      modelAliasTargets,
      apiKeys,
      userQuotaDefinitions,
      mcpServers,
      mcpKeys,
      systemSettings,
      oauthCredentials,
      customCheckers,
    };

    if (postgresDriver === 'pglite') {
      const { PGlite } = require('@electric-sql/pglite');
      const { drizzle: drizzlePglite } = require('drizzle-orm/pglite');
      const dataDir = process.env.PLEXUS_PGLITE_DATA_DIR;
      const previousExitCode = process.exitCode;
      const restoreExitCode = () => {
        if (process.exitCode === PGLITE_BOOT_EXIT_CODE) {
          process.exitCode = previousExitCode ?? 0;
        }
      };
      try {
        pgliteClient = dataDir ? new PGlite(dataDir) : new PGlite();
      } finally {
        restoreExitCode();
      }
      void pgliteClient.waitReady.then(restoreExitCode, () => {});
      dbInstance = drizzlePglite(pgliteClient, {
        schema,
      });
    } else {
      // Auto-detect SSL from connection string sslmode parameter
      const needsSsl =
        /[?&]sslmode=(require|verify-ca|verify-full)/i.test(connStr) ||
        process.env.PLEXUS_DB_SSL === 'true';

      sqlClient = postgres(connStr, {
        ssl: needsSsl ? { rejectUnauthorized: false } : false,
        max: 10,
        idle_timeout: 20,
        connect_timeout: 10,
        onnotice: () => {},
      });

      // Set statement timeout to prevent long-running queries from blocking
      sqlClient`SET statement_timeout = '30s'`.catch((err) => {
        logger.silly(`Failed to set statement_timeout: ${err}`);
      });

      dbInstance = drizzlePg(sqlClient, {
        schema,
      });
    }
  }

  return dbInstance;
}

export function getDatabase() {
  if (!dbInstance) {
    initializeDatabase();
  }
  return dbInstance as SqliteDb | PostgresJsDb | PgliteDb;
}

export function getSchema() {
  if (!currentSchema) {
    initializeDatabase();
  }
  return currentSchema;
}

export function getCurrentDialect(): SupportedDialect {
  if (!currentDialect) {
    throw new Error('Database not initialized');
  }
  return currentDialect;
}

export async function closeDatabase() {
  if (tursoClient) {
    try {
      tursoClient.close();
    } catch {
      // Compat clients are disposable; ignore double-close/shutdown races.
    }
    tursoClient = null;
  }
  if (sqlClient) {
    await sqlClient.end();
    sqlClient = null;
  }
  if (pgliteClient) {
    await pgliteClient.close();
    pgliteClient = null;
  }
  dbInstance = null;
}
