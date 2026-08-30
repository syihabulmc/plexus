import { eq } from 'drizzle-orm';
import { getDatabase, getSchema } from './client';
import { logger } from '../utils/logger';
import {
  encrypt,
  encryptField,
  hashSecret,
  isEncrypted,
  isEncryptionEnabled,
} from '../utils/encryption';

/**
 * Migrate existing plaintext sensitive data to encrypted form.
 * This runs at startup after schema migrations, before config service init.
 *
 * - Skips if ENCRYPTION_KEY is not set
 * - Skips if migration has already been completed
 * - Detects plaintext vs encrypted values by the `enc:v1:` prefix
 * - Idempotent: safe to run multiple times
 */
export async function runEncryptionMigration(): Promise<void> {
  if (!isEncryptionEnabled()) {
    logger.debug('ENCRYPTION_KEY not set, skipping encryption migration');
    return;
  }

  logger.debug('Starting encryption migration for existing plaintext data...');

  const db = getDatabase();
  const schema = getSchema();

  let migratedCount = 0;

  // ─── API Keys ───────────────────────────────────────────────────
  try {
    const apiKeyRows = await db.select().from(schema.apiKeys);
    for (const row of apiKeyRows) {
      if (!isEncrypted(row.secret)) {
        const secretHash = hashSecret(row.secret);
        const encryptedSecret = encrypt(row.secret);
        await db
          .update(schema.apiKeys)
          .set({ secret: encryptedSecret, secretHash })
          .where(eq(schema.apiKeys.id, row.id));
        migratedCount++;
      }
    }
    logger.debug(`Encrypted ${migratedCount} API key(s)`);
  } catch (error) {
    logger.error('Failed to encrypt API keys:', error);
    throw error;
  }

  // ─── OAuth Credentials ──────────────────────────────────────────
  try {
    let oauthCount = 0;
    const oauthRows = await db.select().from(schema.oauthCredentials);
    for (const row of oauthRows) {
      const updates: Record<string, string> = {};
      if (!isEncrypted(row.accessToken)) {
        updates.accessToken = encrypt(row.accessToken);
      }
      if (!isEncrypted(row.refreshToken)) {
        updates.refreshToken = encrypt(row.refreshToken);
      }
      if (Object.keys(updates).length > 0) {
        await db
          .update(schema.oauthCredentials)
          .set(updates as any)
          .where(eq(schema.oauthCredentials.id, row.id));
        oauthCount++;
      }
    }
    logger.debug(`Encrypted ${oauthCount} OAuth credential(s)`);
  } catch (error) {
    logger.error('Failed to encrypt OAuth credentials:', error);
    throw error;
  }

  // ─── Providers ──────────────────────────────────────────────────
  try {
    let providerCount = 0;
    const providerRows = await db.select().from(schema.providers);
    for (const row of providerRows) {
      const updates: Record<string, any> = {};

      // Encrypt apiKey
      if (row.apiKey && !isEncrypted(row.apiKey)) {
        updates.apiKey = encrypt(row.apiKey);
      }

      // Encrypt JSONB fields that contain sensitive data (headers may contain auth tokens,
      // quotaCheckerOptions may contain API credentials). extraBody is excluded as it
      // contains non-sensitive model parameters.
      const jsonFields = ['headers', 'quotaCheckerOptions'] as const;
      for (const field of jsonFields) {
        const val = row[field];
        if (val !== null && val !== undefined) {
          const strVal = typeof val === 'string' ? val : JSON.stringify(val);
          if (!isEncrypted(strVal)) {
            updates[field] = encrypt(strVal);
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await db.update(schema.providers).set(updates).where(eq(schema.providers.id, row.id));
        providerCount++;
      }
    }
    logger.debug(`Encrypted ${providerCount} provider(s)`);
  } catch (error) {
    logger.error('Failed to encrypt providers:', error);
    throw error;
  }

  // ─── MCP Servers ────────────────────────────────────────────────
  try {
    let mcpCount = 0;
    const mcpRows = await db.select().from(schema.mcpServers);
    for (const row of mcpRows) {
      if (row.headers !== null && row.headers !== undefined) {
        const strVal = typeof row.headers === 'string' ? row.headers : JSON.stringify(row.headers);
        if (!isEncrypted(strVal)) {
          await db
            .update(schema.mcpServers)
            .set({ headers: encrypt(strVal) as any })
            .where(eq(schema.mcpServers.id, row.id));
          mcpCount++;
        }
      }
    }
    logger.debug(`Encrypted ${mcpCount} MCP server(s)`);
  } catch (error) {
    logger.error('Failed to encrypt MCP servers:', error);
    throw error;
  }

  // ─── Provider Keys ──────────────────────────────────────────────
  // Encrypt plaintext apiKey + managementKey columns in provider_keys.
  // Idempotent: rows whose value already starts with `enc:v1:` are
  // skipped. Required so that the new feature can read encrypted values
  // via ConfigRepository.rowToProviderKeyConfig.
  try {
    const schema = getSchema() as any;
    if (schema.providerKeys) {
      let providerKeyCount = 0;
      const providerKeyRows = await db.select().from(schema.providerKeys);
      for (const row of providerKeyRows) {
        const updates: Record<string, string | null> = {};
        if (row.apiKey && !isEncrypted(row.apiKey)) {
          updates.apiKey = encryptField(row.apiKey);
        }
        if (row.managementKey && !isEncrypted(row.managementKey)) {
          updates.managementKey = encryptField(row.managementKey);
        }
        if (Object.keys(updates).length > 0) {
          await db
            .update(schema.providerKeys)
            .set(updates as any)
            .where(eq(schema.providerKeys.id, row.id));
          providerKeyCount++;
        }
      }
      logger.debug(`Encrypted ${providerKeyCount} provider-key field(s)`);
    } else {
      // The provider_keys table is not part of the schema (this is a
      // pre-feature database). Skip silently — same pattern as the
      // mcp_keys block above.
      logger.debug('provider_keys table not present, skipping');
    }
  } catch (error) {
    // The provider_keys block should not abort startup. Log a warning
    // so any unexpected error (corrupt row, permission denied, etc.)
    // surfaces in the operator's logs rather than failing silently
    // like the previous version did.
    logger.warn(
      'Failed to encrypt provider_keys rows; some keys may remain plaintext',
      error
    );
  }

  logger.debug('Encryption migration completed successfully');
}
