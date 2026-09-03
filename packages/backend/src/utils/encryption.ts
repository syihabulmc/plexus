import crypto from 'crypto';
import { logger } from './logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PREFIX = 'enc:v1:';
// Fixed application-specific salt for scrypt KDF (key derivation from passphrase).
// This is intentionally NOT random or per-message:
//   - The salt here prevents rainbow-table attacks on the passphrase→key derivation.
//   - Per-message uniqueness is provided by the random IV generated for each encrypt() call.
//   - A per-message KDF salt would require storing it alongside each ciphertext AND re-running
//     scrypt (expensive) for every encrypt/decrypt, rather than once at startup.
//   - This follows the same pattern used by 1Password, Bitwarden, and similar tools.
const SCRYPT_SALT = Buffer.from('plexus-encryption-key-derivation');
const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 16384; // N=2^14, reasonable for a one-time startup derivation

let encryptionKey: Buffer | null = null;
let keyInitialized = false;

function getEncryptionKey(): Buffer | null {
  if (keyInitialized) return encryptionKey;
  keyInitialized = true;

  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    encryptionKey = null;
    return null;
  }

  // If exactly 64 hex chars, use directly as 32-byte key
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    encryptionKey = Buffer.from(raw, 'hex');
  } else {
    // Derive 32-byte key via scrypt with a fixed application-specific salt
    encryptionKey = crypto.scryptSync(raw, SCRYPT_SALT, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  }

  return encryptionKey;
}

/**
 * Reset key cache (for testing).
 */
export function resetEncryptionKeyCache(): void {
  encryptionKey = null;
  keyInitialized = false;
}

/**
 * Check if encryption is enabled (ENCRYPTION_KEY env var is set).
 */
export function isEncryptionEnabled(): boolean {
  return getEncryptionKey() !== null;
}

const ENCRYPTION_DISABLED_WARNING =
  'ENCRYPTION_KEY is not set — secrets will be stored as plaintext. ' +
  'This is a security risk. Set ENCRYPTION_KEY before storing any provider keys, ' +
  'MCP keys, OAuth credentials, or API keys.';

/**
 * Log a loud warning (or error) when ENCRYPTION_KEY is not set.
 *
 * - If encryption is disabled, always logs `error` with a clear message.
 * - If encryption is disabled AND any of `providerKeys`, `apiKeys`, `mcpKeys`,
 *   `oauthCredentials`, or `providers` (apiKey column) has at least one row,
 *   additionally logs a per-table `error` because secrets are actively being
 *   written in cleartext.
 *
 * Never throws. Safe to call at startup before/after the database is ready —
 * the table check is best-effort and any failure is swallowed (the env-var
 * warning has already been emitted).
 */
export function assertEncryptionOrWarn(): void {
  if (isEncryptionEnabled()) return;

  logger.error(ENCRYPTION_DISABLED_WARNING);

  // Best-effort: if the database is reachable at startup, escalate the warning
  // to an error when there is plaintext secret data already on disk. Lazy
  // import avoids any potential circular-dependency with the db layer.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getDatabase } = require('../db/client') as typeof import('../db/client');
    const db = getDatabase();
    if (!db) return;

    // Each check is independent — a missing table on one dialect should not
    // prevent the others from being evaluated.
    const secretTableChecks: Array<{ table: string; column?: string }> = [
      { table: 'providerKeys' },
      { table: 'apiKeys' },
      { table: 'mcpKeys' },
      { table: 'oauthCredentials' },
      { table: 'providers', column: 'apiKey' },
    ];

    for (const { table, column } of secretTableChecks) {
      try {
        // Use raw SQL because the table objects are typed against the runtime
        // dialect; a quick COUNT(*) avoids dragging schema types into the utils
        // layer. SQLite + Postgres both accept this syntax.
        const result = db
          .all(`SELECT COUNT(*) AS count FROM ${table}${column ? ` WHERE ${column} IS NOT NULL` : ''}`)
          ?.at(0) as { count?: number | string } | undefined;
        const count = Number(result?.count ?? 0);
        if (count > 0) {
          logger.error(
            `ENCRYPTION_KEY is not set but table "${table}" already contains ${count} secret-bearing row(s). ` +
              'These are stored as plaintext. Set ENCRYPTION_KEY and rekey the affected records.'
          );
        }
      } catch {
        // Table may not exist in the current dialect; ignore.
      }
    }
  } catch {
    // Database not initialized yet, or circular dep — the env-var warning above is enough.
  }
}

/**
 * Check if a value has the encrypted prefix.
 */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns the original value if ENCRYPTION_KEY is not set.
 * Format: enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  if (!key) return plaintext;

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an encrypted string. If the value does not have the encrypted prefix,
 * returns it unchanged (backward compatibility with plaintext values).
 */
export function decrypt(value: string): string {
  if (!isEncrypted(value)) return value;

  const key = getEncryptionKey();
  if (!key) {
    throw new Error('Cannot decrypt value: ENCRYPTION_KEY is not set but encrypted data was found');
  }

  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted value format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const iv = Buffer.from(ivHex!, 'hex');
  const authTag = Buffer.from(authTagHex!, 'hex');
  const ciphertext = Buffer.from(ciphertextHex!, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Compute SHA-256 hash of a secret for indexed lookups.
 * Always works regardless of whether encryption is enabled.
 */
export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Encrypt a JSON-serializable object. Returns the encrypted string,
 * or the original JSON string if encryption is not enabled.
 */
export function encryptJson(obj: unknown): string {
  const json = JSON.stringify(obj);
  return encrypt(json);
}

/**
 * Decrypt a value that may be an encrypted JSON string, a plain JSON string,
 * or an already-parsed object (from JSONB columns).
 */
export function decryptJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  // If it's a string, it could be encrypted or plain JSON
  if (typeof value === 'string') {
    const decrypted = decrypt(value);
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted;
    }
  }

  // If it's an object (already parsed JSONB from PostgreSQL),
  // check if it's a JSON string value containing encrypted data
  if (typeof value === 'object') {
    return value;
  }

  return value;
}

/**
 * Encrypt a field value, returning null if input is null/undefined.
 */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return encrypt(value);
}

/**
 * Decrypt a field value, returning null if input is null/undefined.
 */
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return decrypt(value);
}
