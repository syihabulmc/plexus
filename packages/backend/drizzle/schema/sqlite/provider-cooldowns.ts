import { sqliteTable, integer, text, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const providerCooldowns = sqliteTable(
  'provider_cooldowns',
  {
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    keyId: text('key_id').notNull().default(''),
    expiry: integer('expiry').notNull(),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdAt: integer('created_at').notNull(),
    lastError: text('last_error'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.provider, table.model, table.keyId] }),
    expiryIdx: index('idx_cooldowns_expiry').on(table.expiry),
  })
);
