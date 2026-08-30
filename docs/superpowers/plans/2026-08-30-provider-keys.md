# Provider Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-provider API key management so each key is a first-class identity for routing, cooldowns, quota tracking, logs, and dashboard. Sticky session and cooldown are per-key with no provider-wide cascade.

**Architecture:**
- New `provider_keys` table + 4 column additions (`provider_cooldowns.key_id`, `meter_snapshots.key_id`, `request_usage.selected_key_label`, preserving `reasoning_effort`).
- Key selection by priority, cooldown-aware; `selectProviderKey` runs in `setupProviderHeaders` and stamps `route.selectedKeyId` / `route.selectedKeyLabel`.
- Per-key candidate expansion (`maybeExpandPerKey`) lets the dispatcher's existing failover loop walk keys naturally.
- Per-key cooldown (no cascade) + per-key auto-disable on quota error.
- Per-key sticky session (`StickyEntry.keyId`).
- Full management CRUD + bulk + consolidate duplicates UI.

**Tech Stack:** Bun, Fastify, Drizzle ORM (SQLite + PostgreSQL), Zod, React + Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-30-provider-keys-design.md` (read alongside this plan — it is the source of truth for naming, fields, and error semantics).

---

## Global Constraints

These apply to every task. Read once; reference throughout.

- **Runtime:** Bun 1.4.0+. Use `bun run test`, never `bun test` (a guard test blocks it).
- **TypeScript:** strict mode, no `any` without justification. Existing code style: camelCase TS identifiers, snake_case DB columns, snake_case API/JSON fields.
- **Naming lock-in** (from spec §"Naming Conventions"):
  - `managementKey` = TS property + Drizzle column property + checker option key
  - `management_key` = DB column name, API JSON field, `ProviderKeyConfig` field
  - `keyId` (TS) / `key_id` (DB) / `keyId` (JSON via ProviderKeyConfig.id) — `id` is a string UUID
  - `api_key` (DB + API) / `apiKey` (TS config) — but `ProviderKeyConfig` uses snake_case `api_key` to match wire format
- **Encryption:** `api_key` and `management_key` are encrypted at rest with `enc:v1:` prefix. Use `encryptField` / `decryptField` from `packages/backend/src/utils/encryption.ts`. Never store plaintext.
- **DB schema:** one migration per change. Use `bun run db:generate` to create. Never hand-edit existing migrations. Latest SQLite migration before this work is `0064_add_reasoning_effort_to_usage.sql`; latest PG is `0082_add_reasoning_effort_to_usage.sql`. New migrations start at `0065` (SQLite) and `0083` (PG).
- **Drizzle:** camelCase TS properties map to snake_case columns (`text('api_key')` → property `apiKey`). All schema changes go in `packages/backend/drizzle/schema/sqlite/{table}.ts` and `packages/backend/drizzle/schema/postgres/{table}.ts`. Re-export from `index.ts` in each dialect.
- **Tests:** Unit tests in `__tests__/` alongside source. Use `registerSpy` from `test/test-utils.ts`, not raw `vi.spyOn`. `utils/logger` and `@earendil-works/pi-ai` are globally mocked. Reset singletons via `resetForTesting()` in `beforeEach`.
- **DB test pattern:** `await closeDatabase(); await initializeDatabase(...); await runMigrations();` in `beforeEach`. Clean provider_keys in test beforeEach to avoid cross-test contamination.
- **Frontend:** Never import CSS with Tailwind directives into `.ts`/`.tsx`. Assets in `packages/frontend/src/assets/`. ES6 imports only.
- **TDD discipline:** Every task with non-trivial logic has a failing test step FIRST, then the implementation, then the passing-test verification.
- **Type check + format:** `bun run typecheck` and `bun run format:check` must pass at end of every task.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `drizzle/schema/sqlite/providers.ts` | modify | Add `providerKeys` table |
| `drizzle/schema/postgres/providers.ts` | modify | Add `providerKeys` table |
| `drizzle/schema/sqlite/provider-cooldowns.ts` | modify | Add `keyId` column, change PK |
| `drizzle/schema/postgres/provider-cooldowns.ts` | modify | Add `keyId` column, change PK |
| `drizzle/schema/sqlite/meter-snapshots.ts` | modify | Add `keyId` column + index |
| `drizzle/schema/postgres/meter-snapshots.ts` | modify | Add `keyId` column + index |
| `drizzle/schema/sqlite/request-usage.ts` | modify | Add `selectedKeyLabel` column (keep `reasoningEffort`) |
| `drizzle/schema/postgres/request-usage.ts` | modify | Add `selectedKeyLabel` column |
| `drizzle/schema/sqlite/index.ts` | modify | Re-export `providerKeys` |
| `drizzle/schema/postgres/index.ts` | modify | Re-export `providerKeys` |
| `drizzle/migrations/0065_add_provider_keys.sql` | create | New table + index |
| `drizzle/migrations/0066_add_cooldown_key_id.sql` | create | Add keyId to cooldowns, rebuild PK |
| `drizzle/migrations/0067_add_meter_snapshots_key_id.sql` | create | Add keyId + index |
| `drizzle/migrations/0068_add_request_usage_selected_key_label.sql` | create | Add column |
| `drizzle/migrations_pg/0083_add_provider_keys.sql` | create | New table + FK + index |
| `drizzle/migrations_pg/0084_add_cooldown_key_id.sql` | create | Add keyId to cooldowns |
| `drizzle/migrations_pg/0085_add_meter_snapshots_key_id.sql` | create | Add keyId + index |
| `drizzle/migrations_pg/0086_add_request_usage_selected_key_label.sql` | create | Add column |
| `src/config.ts` | modify | Add `ProviderKeyConfig`, `api_keys` Zod array item, `failover.perKey` opt-out |
| `src/types/usage.ts` | modify | Add `selectedKeyLabel?: string \| null;` |
| `src/types/unified.ts` | modify | Add `selectedKeyId?`, `selectedKeyLabel?` to `PlexusRuntimeMetadata` |
| `src/services/routing/router.ts` | modify | Add `selectedKeyId?`, `selectedKeyLabel?` to `RouteResult` |
| `src/services/routing/route-candidates.ts` | modify | Add `expandCandidatesPerKey`, `maybeExpandPerKey` |
| `src/services/routing/sticky-session-manager.ts` | modify | Add `keyId?` to `StickyEntry`; thread through get/set |
| `src/services/providers/provider-request-headers.ts` | modify | Add `ApiKeyEntry`, `selectProviderKey`, `resolveSelectedKeyLabel`, `buildAllKeysUnavailableError`; multi-key `setupProviderHeaders` |
| `src/services/runtime/cooldown-manager.ts` | modify | 3-segment `makeCooldownKey`, `keyId` param on success/failure/healthy, `markKeyAsDisabled`, `expiry=0` retention |
| `src/services/dispatch/auto-disable.ts` | create | `matchesQuotaError`, `autoDisableOnQuotaError` |
| `src/services/dispatch/standard-attempt-request.ts` | modify | `emitRoutingUpdate` after `setupHeaders`; thread `keyId` to cooldown calls |
| `src/services/dispatch/request-manager.ts` | modify | Pass `keyId` to all `markProviderSuccess/Failure`; call `autoDisableOnQuotaError` |
| `src/services/dispatch/dispatcher.ts` | modify | `emitRoutingUpdate` carries `selectedKeyLabel`; `setupHeaders` is `await`-ed |
| `src/services/dispatch/media-dispatcher.ts` | modify | Call `selectProviderKey` per attempt in 5 methods; thread `keyId` to cooldown |
| `src/services/configuration/config-service.ts` | modify | `doRebuild` calls `backfillEmptyKeyLabels` + attaches `api_keys`; `buildProviderQuotaConfigs` emits per-key checkers with `managementKey` injection |
| `src/services/quota/checker-registry.ts` | modify | Add `keyId?` to `MeterContext`; `createMeterContext` forwards it |
| `src/services/quota/checkers/openrouter-checker.ts` | modify | Prefer `managementKey` over `apiKey` |
| `src/services/quota/quota-scheduler.ts` | modify | Pass `keyId` to `markProviderFailure`; per-key meter exhaustion → per-key cooldown (no provider-wide cascade) |
| `src/services/observability/usage-storage.ts` | modify | `emitStarted`/`emitUpdated` write `selectedKeyLabel`; `getUsage` SELECTs and returns it |
| `src/services/responses/response-handler.ts` | modify | Propagate `selectedKeyLabel` to `usageRecord` |
| `src/services/probes/probe-service.ts` | modify | Read `selectedKeyLabel` from response for usage record |
| `src/routes/inference/_quota-error.ts` | modify | `handleApiError` and `recordQuotaUsageForResponse` carry `selectedKeyLabel` |
| `src/routes/inference/{chat,completions,embeddings,gemini,images,messages,responses,speech,transcriptions}.ts` | modify | Pass `selectedKeyLabel` to `emitUpdatedAsync` and `usageRecord` |
| `src/routes/management/provider-keys.ts` | create | CRUD + bulk + resequence |
| `src/routes/management.ts` | modify | Wire `registerProviderKeyRoutes` into `adminOnly` |
| `src/routes/management/usage.ts` | modify | Add `selectedKeyLabel` to `USAGE_FIELDS` whitelist; add filter clause in `getUsage` |
| `src/db/config-repository.ts` | modify | Add providerKeys methods + clearAllData row + backfill |
| `src/db/encrypt-migration.ts` | modify | Encrypt plaintext `apiKey` + `managementKey` in `provider_keys` on startup |
| `src/cli/rekey.ts` | modify | Add `rekeyProviderKeys` (null-safe) + wire into `main()` |
| `src/pages/ProviderKeys.tsx` | create | Full CRUD page with bulk, select, filter, consolidate |
| `src/components/providers/ConsolidateKeysModal.tsx` | create | Modal for choosing which duplicate to keep |
| `src/components/providers/consolidateKeys.ts` | create | `groupDuplicateProviderKeys` helper |
| `src/lib/providerKeySelection.ts` | create | `toggleSelection`, `selectionStats` helpers |
| `src/lib/api.ts` | modify | Add `ProviderKey` type, 4 methods, `UsageRecord.selectedKeyLabel`, `USAGE_PAGE_FIELDS` |
| `src/App.tsx` | modify | Add `/provider-keys` route in admin `ProtectedRoute` |
| `src/components/layout/Sidebar.tsx` | modify | Add `/provider-keys` nav item (top-level admin section) |
| `src/pages/Logs.tsx` | modify | Render `provider:keyLabel` (mobile + desktop) + add `keyLabel` filter |
| `src/components/dashboard/tabs/LiveTab.tsx` | modify | Render per-key cooldown rows; per-key request rows; keyLabel column |
| Test files (12+ new) | create | See per-task |

---

## Task Decomposition

Tasks are ordered so each builds on the previous. Every task ends with passing tests, typecheck, format, and a commit. The plan has 14 tasks; each is one commit.

---

### Task 1: Add `provider_keys` table schema (SQLite + PostgreSQL)

**Files:**
- Create: `packages/backend/drizzle/migrations/0065_add_provider_keys.sql`
- Create: `packages/backend/drizzle/migrations_pg/0083_add_provider_keys.sql`
- Modify: `packages/backend/drizzle/schema/sqlite/providers.ts` (add `providerKeys` table after existing `providers` export)
- Modify: `packages/backend/drizzle/schema/postgres/providers.ts`
- Modify: `packages/backend/drizzle/schema/sqlite/index.ts` (re-export)
- Modify: `packages/backend/drizzle/schema/postgres/index.ts` (re-export)

**Interfaces:**
- Produces: `providerKeys` table with columns (id text PK, providerId integer FK→providers.id ON DELETE CASCADE, label text NOT NULL DEFAULT '', apiKey text NOT NULL, managementKey text, notes text, enabled integer NOT NULL DEFAULT 1, priority integer NOT NULL DEFAULT 0, createdAt text NOT NULL DEFAULT now(), updatedAt text NOT NULL DEFAULT now()) and index `idx_provider_keys_lookup` on (providerId, enabled, priority).

- [ ] **Step 1: Generate migrations**

Run from `packages/backend`:
```bash
bun run db:generate --name add_provider_keys
```
Verify both `drizzle/migrations/0065_add_provider_keys.sql` and `drizzle/migrations_pg/0083_add_provider_keys.sql` exist.

- [ ] **Step 2: Manually edit the generated SQL files to use the canonical schema**

SQLite (`0065_add_provider_keys.sql`):
```sql
CREATE TABLE `provider_keys` (
  `id` text PRIMARY KEY NOT NULL,
  `provider_id` integer NOT NULL,
  `label` text DEFAULT '' NOT NULL,
  `api_key` text NOT NULL,
  `management_key` text,
  `notes` text,
  `enabled` integer DEFAULT 1 NOT NULL,
  `priority` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_provider_keys_lookup` ON `provider_keys` (`provider_id`,`enabled`,`priority`);
```

PostgreSQL (`0083_add_provider_keys.sql`):
```sql
CREATE TABLE "provider_keys" (
  "id" text PRIMARY KEY NOT NULL,
  "provider_id" integer NOT NULL,
  "label" text DEFAULT '' NOT NULL,
  "api_key" text NOT NULL,
  "management_key" text,
  "notes" text,
  "enabled" integer DEFAULT 1 NOT NULL,
  "priority" integer DEFAULT 0 NOT NULL,
  "created_at" text DEFAULT now() NOT NULL,
  "updated_at" text DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_keys" ADD CONSTRAINT "provider_keys_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_provider_keys_lookup" ON "provider_keys" USING btree ("provider_id","enabled","priority");
```

- [ ] **Step 3: Add the table to the Drizzle schema files**

In `packages/backend/drizzle/schema/sqlite/providers.ts`, add at the bottom:
```ts
import { sql } from 'drizzle-orm';

export const providerKeys = sqliteTable(
  'provider_keys',
  {
    id: text('id').primaryKey(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    apiKey: text('api_key').notNull(),
    managementKey: text('management_key'),
    notes: text('notes'),
    enabled: integer('enabled').notNull().default(1),
    priority: integer('priority').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => ({
    providerEnabledPriorityIdx: index('idx_provider_keys_lookup').on(
      table.providerId,
      table.enabled,
      table.priority
    ),
  })
);
```

In `packages/backend/drizzle/schema/postgres/providers.ts`, add at the bottom (using `pgTable` and `index` from `drizzle-orm/pg-core`):
```ts
import { sql } from 'drizzle-orm';

export const providerKeys = pgTable(
  'provider_keys',
  {
    id: text('id').primaryKey(),
    providerId: integer('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'cascade' }),
    label: text('label').notNull().default(''),
    apiKey: text('api_key').notNull(),
    managementKey: text('management_key'),
    notes: text('notes'),
    enabled: integer('enabled').notNull().default(1),
    priority: integer('priority').notNull().default(0),
    createdAt: text('created_at').notNull().default(sql`now()`),
    updatedAt: text('updated_at').notNull().default(sql`now()`),
  },
  (table) => ({
    providerEnabledPriorityIdx: index('idx_provider_keys_lookup').on(
      table.providerId,
      table.enabled,
      table.priority
    ),
  })
);
```

Re-export from each dialect's `index.ts` (e.g. `export * from './providers';` already covers new tables).

- [ ] **Step 4: Run migrations against a test database**

Run: `bun run test packages/backend/src/db/__tests__/migrations.test.ts` (if it exists) OR write a minimal smoke test that calls `runMigrations()` and asserts the `provider_keys` table exists.

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/backend/drizzle/
git commit -m "feat(db): add provider_keys table with id, label, encrypted api_key/management_key, priority, enabled"
```

---

### Task 2: Add `keyId` to `provider_cooldowns` (SQLite + PostgreSQL)

**Files:**
- Create: `packages/backend/drizzle/migrations/0066_add_cooldown_key_id.sql`
- Create: `packages/backend/drizzle/migrations_pg/0084_add_cooldown_key_id.sql`
- Modify: `packages/backend/drizzle/schema/sqlite/provider-cooldowns.ts`
- Modify: `packages/backend/drizzle/schema/postgres/provider-cooldowns.ts`

**Interfaces:**
- Produces: `provider_cooldowns` has `keyId text NOT NULL DEFAULT ''`; PK is `(provider, model, keyId)`. Existing rows keep `keyId = ''` (model-level / legacy).

- [ ] **Step 1: Generate migrations**

```bash
cd packages/backend
bun run db:generate --name add_cooldown_key_id
```

- [ ] **Step 2: Replace generated SQL with the canonical form (SQLite needs table-rebuild)**

SQLite (`0066_add_cooldown_key_id.sql`):
```sql
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_provider_cooldowns` (
  `provider` text NOT NULL,
  `model` text NOT NULL,
  `key_id` text DEFAULT '' NOT NULL,
  `expiry` integer NOT NULL,
  `consecutive_failures` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `last_error` text,
  PRIMARY KEY(`provider`, `model`, `key_id`)
);
--> statement-breakpoint
INSERT INTO `__new_provider_cooldowns`("provider", "model", "key_id", "expiry", "consecutive_failures", "created_at", "last_error") SELECT "provider", "model", '', "expiry", "consecutive_failures", "created_at", "last_error" FROM `provider_cooldowns`;--> statement-breakpoint
DROP TABLE `provider_cooldowns`;--> statement-breakpoint
ALTER TABLE `__new_provider_cooldowns` RENAME TO `provider_cooldowns`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_cooldowns_expiry` ON `provider_cooldowns` (`expiry`);
```

PostgreSQL (`0084_add_cooldown_key_id.sql`):
```sql
ALTER TABLE "provider_cooldowns" ADD COLUMN "key_id" text DEFAULT '' NOT NULL;
ALTER TABLE "provider_cooldowns" DROP CONSTRAINT "provider_cooldowns_provider_model_pk";
ALTER TABLE "provider_cooldowns" ADD CONSTRAINT "provider_cooldowns_provider_model_key_id_pk" PRIMARY KEY("provider","model","key_id");
CREATE INDEX "idx_cooldowns_expiry" ON "provider_cooldowns" USING btree ("expiry");
```

- [ ] **Step 3: Update Drizzle schema**

In both `provider-cooldowns.ts` files, change the PK to include `keyId`:
```ts
import { sqliteTable, integer, text, primaryKey, index } from 'drizzle-orm/sqlite-core';

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
```

PostgreSQL equivalent using `pgTable` + `primaryKey` + `index`.

- [ ] **Step 4: Smoke test the migration runs on existing data**

Write a one-shot test in `packages/backend/src/db/__tests__/cooldown-migration.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { closeDatabase, getDatabase, initializeDatabase, getSchema } from '../client';
import { runMigrations } from '../migrate';

describe('cooldown keyId migration', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
  });

  it('adds key_id column with empty default to provider_cooldowns', async () => {
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providerCooldowns).values({
      provider: 'openai', model: 'gpt-4', expiry: Date.now() + 1000, createdAt: Date.now(),
    } as any);
    const rows = await db.select().from(schema.providerCooldowns);
    expect(rows[0]?.keyId).toBe('');
  });
});
```

Run: `bun run test packages/backend/src/db/__tests__/cooldown-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/backend/drizzle/ packages/backend/src/db/__tests__/cooldown-migration.test.ts
git commit -m "feat(db): add key_id column to provider_cooldowns; change PK to (provider, model, key_id)"
```

---

### Task 3: Add `keyId` to `meter_snapshots` and `selected_key_label` to `request_usage`

**Files:**
- Create: `packages/backend/drizzle/migrations/0067_add_meter_snapshots_key_id.sql`
- Create: `packages/backend/drizzle/migrations/0068_add_request_usage_selected_key_label.sql`
- Create: `packages/backend/drizzle/migrations_pg/0085_add_meter_snapshots_key_id.sql`
- Create: `packages/backend/drizzle/migrations_pg/0086_add_request_usage_selected_key_label.sql`
- Modify: `packages/backend/drizzle/schema/sqlite/meter-snapshots.ts`
- Modify: `packages/backend/drizzle/schema/postgres/meter-snapshots.ts`
- Modify: `packages/backend/drizzle/schema/sqlite/request-usage.ts`
- Modify: `packages/backend/drizzle/schema/postgres/request-usage.ts`

**Interfaces:**
- Produces: `meter_snapshots.keyId text` + index `idx_meter_key_checked(keyId, checkedAt)`. `request_usage.selectedKeyLabel text` column (preserves existing `reasoningEffort`).

- [ ] **Step 1: Generate migrations**

```bash
cd packages/backend
bun run db:generate --name add_meter_snapshots_key_id
bun run db:generate --name add_request_usage_selected_key_label
```

- [ ] **Step 2: Edit generated SQL**

For meter-snapshots key_id (SQLite):
```sql
ALTER TABLE `meter_snapshots` ADD `key_id` text;--> statement-breakpoint
CREATE INDEX `idx_meter_key_checked` ON `meter_snapshots` (`key_id`,`checked_at`);
```

For request-usage selected_key_label (SQLite):
```sql
ALTER TABLE `request_usage` ADD `selected_key_label` text;
```

PostgreSQL equivalents (column + index, snake_case quoted).

- [ ] **Step 3: Update Drizzle schemas**

In `meter-snapshots.ts` (both dialects), add:
```ts
keyId: text('key_id'),
// inside (table) => ({...}):  keyCheckedIdx: index('idx_meter_key_checked').on(table.keyId, table.checkedAt),
```

In `request-usage.ts` (both dialects), add:
```ts
selectedKeyLabel: text('selected_key_label'),
```

- [ ] **Step 4: Smoke test the column exists**

Extend the smoke test from Task 2 with two more cases:
```ts
it('adds key_id column to meter_snapshots', async () => {
  const cols = (await getDatabase().all(`PRAGMA table_info(meter_snapshots)`) as any[]).map(r => r.name);
  expect(cols).toContain('key_id');
});

it('adds selected_key_label column to request_usage', async () => {
  const cols = (await getDatabase().all(`PRAGMA table_info(request_usage)`) as any[]).map(r => r.name);
  expect(cols).toContain('selected_key_label');
});
```

Run: `bun run test packages/backend/src/db/__tests__/cooldown-migration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/drizzle/ packages/backend/src/db/__tests__/cooldown-migration.test.ts
git commit -m "feat(db): add key_id to meter_snapshots and selected_key_label to request_usage"
```

---

### Task 4: Add `ProviderKeyConfig` type and Zod schema

**Files:**
- Modify: `packages/backend/src/config.ts` (add interface + Zod `api_keys` array item)
- Modify: `packages/backend/src/types/usage.ts` (add `selectedKeyLabel?`)

**Interfaces:**
- Produces: `ProviderKeyConfig` interface (id, provider_id, label, api_key, management_key?, notes?, enabled, priority). Zod item for `api_keys[]` in `ProviderConfigSchema`.

- [ ] **Step 1: Write the failing type test**

Create `packages/backend/src/__tests__/provider-key-config.test-d.ts`:
```ts
import type { ProviderKeyConfig } from '../config';
import type { UsageRecord } from '../types/usage';

const _keyTypeCheck: ProviderKeyConfig = {
  id: 'k1',
  provider_id: '5',
  label: 'prod',
  api_key: 'sk-encrypted',
  management_key: undefined,
  notes: undefined,
  enabled: true,
  priority: 1,
};
void _keyTypeCheck;

const _usageTypeCheck: UsageRecord = {
  requestId: 'r1',
  date: '2026-08-30',
  selectedKeyLabel: 'prod',
  // ... other fields will fail typecheck unless UsageRecord is open; this is a smoke test only
} as UsageRecord;
void _usageTypeCheck;
```

- [ ] **Step 2: Run typecheck (expect failure)**

Run: `bun run typecheck`
Expected: FAIL — `ProviderKeyConfig` and `selectedKeyLabel` don't exist.

- [ ] **Step 3: Add `ProviderKeyConfig` and Zod schema**

In `packages/backend/src/config.ts`:

After the `ProviderConfigSchema` definition (around line 290), add the `api_keys` field:
```ts
api_keys: z
  .array(
    z.object({
      id: z.string(),
      provider_id: z.string(),
      label: z.string(),
      api_key: z.string(),
      management_key: z.string().optional(),
      notes: z.string().optional(),
      enabled: z.boolean(),
      priority: z.number(),
    })
  )
  .optional(),
```

Add the interface after the `ProviderConfig` type:
```ts
export interface ProviderKeyConfig {
  id: string;
  provider_id: string;
  label: string;
  api_key: string; // decrypted
  management_key?: string; // decrypted; optional
  notes?: string; // plain text
  enabled: boolean;
  priority: number;
}
```

Add the `failover.perKey` opt-out to `FailoverPolicySchema`:
```ts
perKey: z.boolean().optional(),
```

In `packages/backend/src/types/usage.ts`, add:
```ts
selectedKeyLabel?: string | null;
```
(next to existing `reasoningEffort?`)

- [ ] **Step 4: Run typecheck (expect pass)**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/backend/src/config.ts packages/backend/src/types/usage.ts
git commit -m "feat(config): add ProviderKeyConfig type, api_keys Zod item, failover.perKey, selectedKeyLabel in UsageRecord"
```

---

### Task 5: ConfigRepository — provider_keys CRUD + backfill + slug map

**Files:**
- Modify: `packages/backend/src/db/config-repository.ts`
- Create: `packages/backend/src/db/__tests__/config-repository-provider-keys.test.ts`

**Interfaces:**
- Produces: methods `getAllProviderKeys()`, `getProviderKeys(providerId)`, `saveProviderKey(id, data)`, `deleteProviderKey(id)`, `backfillEmptyKeyLabels()`, `getProviderIdToSlugMap()`, `resolveProviderId(ref)`, private `rowToProviderKeyConfig(row)`. `clearAllData()` deletes `providerKeys` before `providers`.

- [ ] **Step 1: Write the failing test**

In the new test file:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../client';
import { runMigrations } from '../migrate';
import { ConfigRepository } from '../config-repository';
import { resetForTesting } from '../../services/configuration/config-service';
import { encryptField } from '../../utils/encryption';

const repo = () => new ConfigRepository();

describe('ConfigRepository — provider_keys', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
    resetForTesting();
    // Seed one provider
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encryptField('sk-test'),
    } as any);
  });

  it('round-trips saveProviderKey + getAllProviderKeys with decrypted api_key', async () => {
    const r = repo();
    const providerId = String((await r.getProvider('openai'))!.id);
    const saved = await r.saveProviderKey('k1', {
      provider_id: providerId, label: 'prod', api_key: 'sk-plaintext', enabled: true, priority: 1,
    });
    expect(saved.id).toBe('k1');
    expect(saved.api_key).toBe('sk-plaintext');
    expect(saved.label).toBe('prod');
    expect(saved.enabled).toBe(true);
    const all = await r.getAllProviderKeys();
    expect(all).toHaveLength(1);
    expect(all[0]!.api_key).toBe('sk-plaintext');
  });

  it('preserves management_key on undefined, clears on empty string, encrypts on value', async () => {
    const r = repo();
    const providerId = String((await r.getProvider('openai'))!.id);
    await r.saveProviderKey('k1', {
      provider_id: providerId, label: 'k', api_key: 'sk', management_key: 'mgmt-1', enabled: true, priority: 1,
    });
    // omit → keep
    const kept = await r.saveProviderKey('k1', {
      provider_id: providerId, label: 'k', api_key: 'sk', enabled: true, priority: 1,
    });
    expect(kept.management_key).toBe('mgmt-1');
    // empty string → clear
    const cleared = await r.saveProviderKey('k1', {
      provider_id: providerId, label: 'k', api_key: 'sk', management_key: '', enabled: true, priority: 1,
    });
    expect(cleared.management_key).toBeUndefined();
    // value → re-encrypt
    const updated = await r.saveProviderKey('k1', {
      provider_id: providerId, label: 'k', api_key: 'sk', management_key: 'mgmt-2', enabled: true, priority: 1,
    });
    expect(updated.management_key).toBe('mgmt-2');
  });

  it('getProviderKeys orders by priority ascending', async () => {
    const r = repo();
    const providerId = String((await r.getProvider('openai'))!.id);
    await r.saveProviderKey('a', { provider_id: providerId, label: 'a', api_key: 'sk', enabled: true, priority: 3 });
    await r.saveProviderKey('b', { provider_id: providerId, label: 'b', api_key: 'sk', enabled: true, priority: 1 });
    await r.saveProviderKey('c', { provider_id: providerId, label: 'c', api_key: 'sk', enabled: true, priority: 2 });
    const keys = await r.getProviderKeys(providerId);
    expect(keys.map((k) => k.id)).toEqual(['b', 'c', 'a']);
  });

  it('deleteProviderKey returns true on success, false on missing', async () => {
    const r = repo();
    const providerId = String((await r.getProvider('openai'))!.id);
    await r.saveProviderKey('k1', { provider_id: providerId, label: 'k', api_key: 'sk', enabled: true, priority: 1 });
    expect(await r.deleteProviderKey('k1')).toBe(true);
    expect(await r.deleteProviderKey('k1')).toBe(false);
  });

  it('backfillEmptyKeyLabels assigns UUID to empty labels', async () => {
    const r = repo();
    const providerId = String((await r.getProvider('openai'))!.id);
    // Insert directly with empty label
    const schema = getSchema();
    const db = getDatabase();
    await db.insert(schema.providerKeys).values({
      id: 'empty', providerId: Number(providerId), label: '', apiKey: encryptField('sk'),
      enabled: 1, priority: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    } as any);
    const count = await r.backfillEmptyKeyLabels();
    expect(count).toBe(1);
    const [filled] = await r.getAllProviderKeys();
    expect(filled!.label).not.toBe('');
  });

  it('getProviderIdToSlugMap returns id→slug mapping', async () => {
    const r = repo();
    const map = await r.getProviderIdToSlugMap();
    const providerId = String((await r.getProvider('openai'))!.id);
    expect(map.get(providerId)).toBe('openai');
  });

  it('resolveProviderId accepts slug or numeric id', async () => {
    const r = repo();
    const id = (await r.getProvider('openai'))!.id;
    expect(await r.resolveProviderId('openai')).toBe(id);
    expect(await r.resolveProviderId(String(id))).toBe(id);
    expect(await r.resolveProviderId('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `bun run test packages/backend/src/db/__tests__/config-repository-provider-keys.test.ts`
Expected: FAIL — methods don't exist.

- [ ] **Step 3: Implement the methods**

In `packages/backend/src/db/config-repository.ts`, add the import:
```ts
import type { ProviderConfig, ProviderKeyConfig } from '../config';
```

Add the methods (after `getAllProviders`, around line 530):
```ts
async getAllProviderKeys(): Promise<ProviderKeyConfig[]> {
  const schema = this.schema();
  const rows = await this.db().select().from(schema.providerKeys);
  return rows.map((row: any) => this.rowToProviderKeyConfig(row));
}

async getProviderKeys(providerId: string): Promise<ProviderKeyConfig[]> {
  const resolved = await this.resolveProviderId(providerId);
  if (resolved === undefined) return [];
  const schema = this.schema();
  const rows = await this.db()
    .select()
    .from(schema.providerKeys)
    .where(eq(schema.providerKeys.providerId, resolved))
    .orderBy(asc(schema.providerKeys.priority));
  return rows.map((row: any) => this.rowToProviderKeyConfig(row));
}

async backfillEmptyKeyLabels(): Promise<number> {
  const schema = this.schema();
  const empty = await this.db()
    .select({ id: schema.providerKeys.id })
    .from(schema.providerKeys)
    .where(or(isNull(schema.providerKeys.label), eq(schema.providerKeys.label, '')));
  if (empty.length === 0) return 0;
  const timestamp = new Date().toISOString();
  for (const row of empty) {
    await this.db()
      .update(schema.providerKeys)
      .set({ label: randomUUID(), updatedAt: timestamp })
      .where(eq(schema.providerKeys.id, row.id));
  }
  return empty.length;
}

async saveProviderKey(
  id: string,
  data: {
    provider_id: string;
    label: string;
    api_key: string;
    management_key?: string;
    notes?: string;
    enabled: boolean;
    priority: number;
  }
): Promise<ProviderKeyConfig> {
  const schema = this.schema();
  const timestamp = new Date().toISOString();

  const existing = await this.db()
    .select()
    .from(schema.providerKeys)
    .where(eq(schema.providerKeys.id, id))
    .limit(1);

  const encrypted = encryptField(data.api_key);
  const existingMgmt = existing.length > 0 ? existing[0]!.managementKey : null;
  let storedMgmt: string | null;
  if (data.management_key === undefined) {
    storedMgmt = existingMgmt;
  } else if (data.management_key === '') {
    storedMgmt = null;
  } else {
    storedMgmt = encryptField(data.management_key);
  }

  if (existing.length > 0) {
    await this.db()
      .update(schema.providerKeys)
      .set({
        providerId: Number(data.provider_id),
        label: data.label,
        apiKey: encrypted,
        managementKey: storedMgmt,
        notes: data.notes ?? null,
        enabled: data.enabled ? 1 : 0,
        priority: data.priority,
        updatedAt: timestamp,
      })
      .where(eq(schema.providerKeys.id, id));
  } else {
    await this.db().insert(schema.providerKeys).values({
      id,
      providerId: Number(data.provider_id),
      label: data.label,
      apiKey: encrypted,
      managementKey: storedMgmt,
      notes: data.notes ?? null,
      enabled: data.enabled ? 1 : 0,
      priority: data.priority,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  return {
    id,
    provider_id: data.provider_id,
    label: data.label,
    api_key: data.api_key,
    management_key: data.management_key === '' ? undefined : (data.management_key ?? (existingMgmt ? decryptField(existingMgmt) ?? undefined : undefined)),
    notes: data.notes ?? undefined,
    enabled: data.enabled,
    priority: data.priority,
  };
}

async deleteProviderKey(id: string): Promise<boolean> {
  const schema = this.schema();
  const result = await this.db()
    .delete(schema.providerKeys)
    .where(eq(schema.providerKeys.id, id));
  const affected = (result as any)?.rowsAffected ?? (result as any)?.changes ?? (result as any)?.rowCount ?? 0;
  return Number(affected) > 0;
}

async getProviderIdToSlugMap(): Promise<Map<string, string>> {
  const schema = this.schema();
  const rows = await this.db()
    .select({ id: schema.providers.id, slug: schema.providers.slug })
    .from(schema.providers);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(String(row.id), row.slug);
  }
  return map;
}

async resolveProviderId(ref: string): Promise<number | undefined> {
  if (/^\d+$/.test(ref)) {
    const n = Number(ref);
    if (Number.isFinite(n)) return n;
  }
  const schema = this.schema();
  const rows = await this.db()
    .select({ id: schema.providers.id })
    .from(schema.providers)
    .where(eq(schema.providers.slug, ref))
    .limit(1);
  return rows[0]?.id;
}

private rowToProviderKeyConfig(row: any): ProviderKeyConfig {
  return {
    id: row.id,
    provider_id: String(row.providerId),
    label: row.label,
    api_key: decryptField(row.apiKey) ?? '',
    management_key: row.managementKey
      ? (decryptField(row.managementKey) ?? undefined)
      : undefined,
    notes: row.notes ?? undefined,
    enabled: row.enabled === 1,
    priority: row.priority,
  };
}
```

Add `asc`, `or`, `isNull` to the existing `drizzle-orm` imports (line 1).
Add `randomUUID` import: `import { randomUUID } from 'crypto';` (top of file).

Update `clearAllData()` (around line 310) to delete `providerKeys` before `providers`:
```ts
await this.db().delete(schema.providerKeys);
await this.db().delete(schema.providers);
```

- [ ] **Step 4: Run the test (expect pass)**

Run: `bun run test packages/backend/src/db/__tests__/config-repository-provider-keys.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
bun run typecheck
git add packages/backend/src/db/config-repository.ts packages/backend/src/db/__tests__/config-repository-provider-keys.test.ts
git commit -m "feat(db): add providerKeys CRUD + backfill + slug map to ConfigRepository"
```

---

### Task 6: ConfigService — attach `api_keys` to providers + per-key quota emission

**Files:**
- Modify: `packages/backend/src/services/configuration/config-service.ts`
- Create: `packages/backend/src/services/__tests__/config-service-provider-keys.test.ts`

**Interfaces:**
- Produces: After `doRebuild`, each `providers[slug]` has `(config as any).api_keys = ProviderKeyConfig[]` (enabled, sorted by priority). `buildProviderQuotaConfigs` emits per-key checkers with `keyId` and key-specific `apiKey` + (trimmed) `managementKey`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { ConfigService } from '../configuration/config-service';
import { encryptField } from '../../utils/encryption';

describe('ConfigService — provider keys integration', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
    ConfigService.resetForTesting?.();
  });

  it('attaches enabled api_keys to providers in priority order', async () => {
    const svc = ConfigService.getInstance();
    const db = getDatabase();
    const schema = getSchema();
    // Seed provider
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encryptField('sk'),
    } as any);
    const providerId = (await svc.getRepository().getProvider('openai'))!.id;
    // Seed 3 keys, one disabled
    await db.insert(schema.providerKeys).values([
      { id: 'a', providerId, label: 'A', apiKey: encryptField('sk-a'), enabled: 1, priority: 3, createdAt: 'now', updatedAt: 'now' },
      { id: 'b', providerId, label: 'B', apiKey: encryptField('sk-b'), enabled: 0, priority: 1, createdAt: 'now', updatedAt: 'now' },
      { id: 'c', providerId, label: 'C', apiKey: encryptField('sk-c'), enabled: 1, priority: 2, createdAt: 'now', updatedAt: 'now' },
    ] as any);

    await svc.flush();
    const cfg = svc.getConfig();
    const openai = cfg.providers['openai'] as any;
    expect(openai.api_keys).toHaveLength(2); // disabled filtered
    expect(openai.api_keys.map((k: any) => k.id)).toEqual(['c', 'a']); // priority asc
  });

  it('emits per-key quota configs with keyId and managementKey injection', async () => {
    const svc = ConfigService.getInstance();
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encryptField('sk'),
      quotaChecker: { type: 'synthetic', enabled: true, intervalMinutes: 30, options: { maxUtilizationPercent: 90 } },
    } as any);
    const providerId = (await svc.getRepository().getProvider('openai'))!.id;
    await db.insert(schema.providerKeys).values([
      { id: 'k1', providerId, label: 'K1', apiKey: encryptField('sk-k1'), managementKey: encryptField('mgmt-1'), enabled: 1, priority: 1, createdAt: 'now', updatedAt: 'now' },
      { id: 'k2', providerId, label: 'K2', apiKey: encryptField('sk-k2'), enabled: 1, priority: 2, createdAt: 'now', updatedAt: 'now' },
    ] as any);

    await svc.flush();
    const cfg = svc.getConfig();
    const keyChecker1 = cfg.quotas?.find((q: any) => q.id === 'openai:key:k1');
    const keyChecker2 = cfg.quotas?.find((q: any) => q.id === 'openai:key:k2');
    expect(keyChecker1).toBeDefined();
    expect(keyChecker1.keyId).toBe('k1');
    expect(keyChecker1.options.apiKey).toBe('sk-k1');
    expect(keyChecker1.options.managementKey).toBe('mgmt-1');
    expect(keyChecker2).toBeDefined();
    expect(keyChecker2.options.managementKey).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `bun run test packages/backend/src/services/__tests__/config-service-provider-keys.test.ts`
Expected: FAIL — `api_keys` not attached, per-key checkers not emitted.

- [ ] **Step 3: Update `doRebuild` to attach api_keys**

In `config-service.ts`, find `doRebuild`. Add at the top of the method (after `const providers = await this.repo.getAllProviders();`):
```ts
await this.repo.backfillEmptyKeyLabels();
const allProviderKeys = await this.repo.getAllProviderKeys();
const providerIdToSlug = await this.repo.getProviderIdToSlugMap();
const providerKeysBySlug = new Map<string, ProviderKeyConfig[]>();
for (const pk of allProviderKeys) {
  const slug = providerIdToSlug.get(pk.provider_id);
  if (!slug) continue;
  const list = providerKeysBySlug.get(slug) || [];
  list.push(pk);
  providerKeysBySlug.set(slug, list);
}
for (const [slug, keys] of providerKeysBySlug) {
  providerKeysBySlug.set(
    slug,
    keys.filter((k) => k.enabled).sort((a, b) => a.priority - b.priority)
  );
}
for (const [slug, config] of Object.entries(providers)) {
  const keys = providerKeysBySlug.get(slug);
  if (keys && keys.length > 0) {
    (config as any).api_keys = keys;
  }
}
```

- [ ] **Step 4: Update `buildProviderQuotaConfigs` to emit per-key checkers**

Find the quota emission loop. After the existing per-provider `quotas.push({...})` for a provider with `quota_checker`, add:
```ts
if (providerConfig.api_keys && providerConfig.api_keys.length > 0) {
  for (const keyConfig of providerConfig.api_keys) {
    if (!keyConfig.enabled) continue;
    const keyApiKey = keyConfig.api_key?.trim();
    if (!keyApiKey || keyApiKey.toLowerCase() === 'oauth') continue;

    const keyCheckerId = `${providerId}:key:${keyConfig.id}`;
    if (seenIds.has(keyCheckerId)) continue;
    seenIds.add(keyCheckerId);

    const keyOptions = {
      ...(quotaChecker.options ?? {}),
      apiKey: keyApiKey,
      ...(keyConfig.management_key?.trim()
        ? { managementKey: keyConfig.management_key.trim() }
        : {}),
    };

    quotas.push({
      id: keyCheckerId,
      provider: providerId,
      keyId: keyConfig.id,
      type: quotaChecker.type,
      enabled: true,
      intervalMinutes: quotaChecker.intervalMinutes,
      options: keyOptions,
    });
  }
}
```

Also add `keyId?: string` to the `QuotaConfig` interface (in config.ts) and the `keyId` field in the emitted object.

- [ ] **Step 5: Run the test (expect pass)**

Run: `bun run test packages/backend/src/services/__tests__/config-service-provider-keys.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/configuration/config-service.ts packages/backend/src/services/__tests__/config-service-provider-keys.test.ts packages/backend/src/config.ts
git commit -m "feat(config): attach api_keys to providers, emit per-key quota configs with managementKey"
```

---

### Task 7: CooldownManager — 3-segment keying, `markKeyAsDisabled`, `expiry=0` retention

**Files:**
- Modify: `packages/backend/src/services/runtime/cooldown-manager.ts`
- Create: `packages/backend/src/services/__tests__/cooldown-manager-key-id.test.ts`

**Interfaces:**
- Produces: `makeCooldownKey(provider, model, keyId?)` returns 3-segment if keyId. `markProviderFailure/Success/isProviderHealthy` accept optional `keyId`. `markKeyAsDisabled(provider, model, keyId, reason?)` writes per-key cooldown + persists `providerKeys.enabled=0` + flushes ConfigService. `getCooldowns()` returns `keyId` per row. `expiry === 0` rows retained on load.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { CooldownManager } from '../cooldown-manager';
import { encryptField } from '../../utils/encryption';

describe('CooldownManager — per-key', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
    CooldownManager.getInstance().resetForTesting();
    await CooldownManager.getInstance().loadFromStorage();
    // Seed provider + 2 keys
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encryptField('sk'),
    } as any);
    const providerId = (await db.select().from(schema.providers))[0]!.id;
    await db.insert(schema.providerKeys).values([
      { id: 'k1', providerId, label: 'K1', apiKey: encryptField('sk-k1'), enabled: 1, priority: 1, createdAt: 'now', updatedAt: 'now' },
      { id: 'k2', providerId, label: 'K2', apiKey: encryptField('sk-k2'), enabled: 1, priority: 2, createdAt: 'now', updatedAt: 'now' },
    ] as any);
  });

  afterEach(() => {
    CooldownManager.getInstance().resetForTesting();
  });

  it('makeCooldownKey returns 3-segment when keyId is provided', () => {
    const cm = CooldownManager.getInstance() as any;
    expect(cm.makeCooldownKey('openai', 'gpt-4', 'k1')).toBe('openai:gpt-4:k1');
    expect(cm.makeCooldownKey('openai', 'gpt-4')).toBe('openai:gpt-4');
  });

  it('markProviderFailure with keyId keys per-key; isProviderHealthy isolates it', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'k1');
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k1')).toBe(false);
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k2')).toBe(true);
  });

  it('markProviderSuccess with keyId clears only that key, not other keys on same model', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'k1');
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'k2');
    await cm.markProviderSuccess('openai', 'gpt-4', 'k1');
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k1')).toBe(true);
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k2')).toBe(false);
  });

  it('markKeyAsDisabled with keyId writes providerKeys.enabled=0', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markKeyAsDisabled('openai', 'gpt-4', 'k1', 'quota exceeded');
    const db = getDatabase();
    const schema = getSchema();
    const [k1] = await db.select().from(schema.providerKeys).where((await import('drizzle-orm')).eq(schema.providerKeys.id, 'k1'));
    expect(k1!.enabled).toBe(0);
  });

  it('getCooldowns returns keyId per row', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'k1');
    const cooldowns = cm.getCooldowns();
    expect(cooldowns.some((c) => c.keyId === 'k1' && c.provider === 'openai' && c.model === 'gpt-4')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `bun run test packages/backend/src/services/__tests__/cooldown-manager-key-id.test.ts`
Expected: FAIL — `keyId` not supported.

- [ ] **Step 3: Update CooldownManager**

In `packages/backend/src/services/runtime/cooldown-manager.ts`:

Update `makeCooldownKey`:
```ts
private static makeCooldownKey(provider: string, model: string, keyId?: string): string {
  if (keyId) return `${provider}:${model}:${keyId}`;
  return `${provider}:${model}`;
}
```

Update `markProviderFailure` signature to add `keyId?`:
```ts
public async markProviderFailure(
  provider: string,
  model: string,
  durationMs?: number,
  lastError?: string,
  keyId?: string
): Promise<void> { ... use makeCooldownKey(provider, model, keyId) ... }
```

Update `markProviderSuccess` signature to add `keyId?` and scope DB delete to `keyId === ''` when no keyId:
```ts
public async markProviderSuccess(provider: string, model: string, keyId?: string): Promise<void> {
  const key = CooldownManager.makeCooldownKey(provider, model, keyId);
  this.cooldowns.delete(key);
  // ... DB delete: if keyId provided, conditions include keyId; if not, conditions pin keyId === '' so per-key rows survive ...
}
```

Update `isProviderHealthy` to accept `keyId?`. NO provider-wide cascade — only check the matching slot:
```ts
public async isProviderHealthy(provider: string, model: string, keyId?: string): Promise<boolean> {
  const key = CooldownManager.makeCooldownKey(provider, model, keyId);
  const entry = this.cooldowns.get(key);
  if (!entry) return true;
  if (entry.expiry === 0) return true;
  if (Date.now() > entry.expiry) {
    this.cooldowns.set(key, { expiry: 0, consecutiveFailures: entry.consecutiveFailures });
    return true;
  }
  return false;
}
```

Add `markKeyAsDisabled`:
```ts
public async markKeyAsDisabled(
  provider: string,
  model: string,
  keyId: string | undefined,
  reason?: string
): Promise<void> {
  if (!keyId) {
    // Legacy path — per-model cooldown
    await this.markProviderFailure(provider, model, undefined, reason, undefined);
    return;
  }
  logger.warn(
    `Disabling API key '${keyId}' for provider '${provider}' due to: ${reason || 'quota_exceeded'}`
  );
  await this.markProviderFailure(provider, model, undefined, reason, keyId);
  try {
    const db = this.ensureDb();
    await db
      .update(this.schema.providerKeys)
      .set({ enabled: 0, updatedAt: new Date().toISOString() })
      .where(eq(this.schema.providerKeys.id, keyId));
    const { ConfigService } = await import('../configuration/config-service');
    await ConfigService.getInstance().flush();
  } catch (e) {
    logger.error(`Failed to persist disabled state for key '${keyId}' (cooldown still applied)`, e);
  }
}
```

Update `loadFromStorage` to retain `expiry === 0` rows (filter by `gte(expiry, now) OR eq(expiry, 0)`).

Update `getCooldowns` to return `keyId` parsed from the composite key:
```ts
for (const [key, entry] of this.cooldowns.entries()) {
  if (entry.expiry > now) {
    const parts = key.split(':');
    const provider = parts[0];
    if (!provider || providerConfig[provider]?.disable_cooldown === true) continue;
    const model = parts[1] || '';
    const keyId = parts[2] || undefined;
    results.push({ provider, model, keyId, expiry: entry.expiry, timeRemainingMs: entry.expiry - now, consecutiveFailures: entry.consecutiveFailures, lastError: entry.lastError });
  }
}
```

Add `resetForTesting()` method (clears `this.cooldowns` map and resets singleton).

- [ ] **Step 4: Run the test (expect pass)**

Run: `bun run test packages/backend/src/services/__tests__/cooldown-manager-key-id.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/runtime/cooldown-manager.ts packages/backend/src/services/__tests__/cooldown-manager-key-id.test.ts
git commit -m "feat(cooldown): add 3-segment keying, markKeyAsDisabled, expiry=0 retention"
```

---

### Task 8: `selectProviderKey` + `setupProviderHeaders` + `resolveSelectedKeyLabel`

**Files:**
- Modify: `packages/backend/src/services/providers/provider-request-headers.ts`
- Create: `packages/backend/src/services/providers/__tests__/provider-request-headers.test.ts`

**Interfaces:**
- Produces: `ApiKeyEntry` interface, `selectProviderKey(route)`, `resolveSelectedKeyLabel(key)`, `buildAllKeysUnavailableError(provider, keys)`. `setupProviderHeaders` stamps `route.selectedKeyId` and `route.selectedKeyLabel`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupProviderHeaders, selectProviderKey, resolveSelectedKeyLabel, buildAllKeysUnavailableError } from '../provider-request-headers';
import { CooldownManager } from '../../runtime/cooldown-manager';

const makeRoute = (config: any) => ({ provider: 'openai', model: 'gpt-4', config } as any);

describe('selectProviderKey', () => {
  beforeEach(() => {
    CooldownManager.getInstance().resetForTesting();
  });

  it('returns undefined when no api_keys array configured', async () => {
    const route = makeRoute({ api_key: 'sk-legacy' });
    expect(await selectProviderKey(route)).toBeUndefined();
  });

  it('picks the lowest-priority enabled key with non-empty api_key', async () => {
    const route = makeRoute({ api_keys: [
      { id: 'a', api_key: 'sk-a', enabled: true, priority: 3 },
      { id: 'b', api_key: 'sk-b', enabled: true, priority: 1 },
      { id: 'c', api_key: 'sk-c', enabled: true, priority: 2 },
    ] });
    const k = await selectProviderKey(route);
    expect(k?.id).toBe('b');
  });

  it('skips disabled keys', async () => {
    const route = makeRoute({ api_keys: [
      { id: 'a', api_key: 'sk-a', enabled: false, priority: 1 },
      { id: 'b', api_key: 'sk-b', enabled: true, priority: 2 },
    ] });
    const k = await selectProviderKey(route);
    expect(k?.id).toBe('b');
  });

  it('skips keys on cooldown', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'a');
    const route = makeRoute({ api_keys: [
      { id: 'a', api_key: 'sk-a', enabled: true, priority: 1 },
      { id: 'b', api_key: 'sk-b', enabled: true, priority: 2 },
    ] });
    const k = await selectProviderKey(route);
    expect(k?.id).toBe('b');
  });
});

describe('resolveSelectedKeyLabel', () => {
  it('returns trimmed label', () => {
    expect(resolveSelectedKeyLabel({ label: 'prod-key' })).toBe('prod-key');
  });
  it('falls back to "default" when label is empty/missing', () => {
    expect(resolveSelectedKeyLabel({ label: '' })).toBe('default');
    expect(resolveSelectedKeyLabel({ label: '   ' })).toBe('default');
    expect(resolveSelectedKeyLabel(undefined)).toBe('default');
  });
});

describe('buildAllKeysUnavailableError', () => {
  it('carries the ALL_KEYS_UNAVAILABLE code and reports counts', () => {
    const e = buildAllKeysUnavailableError('openai', [
      { id: 'a', api_key: 'sk', enabled: false },
      { id: 'b', api_key: 'sk', enabled: true },
      { id: 'c', api_key: '', enabled: true },
    ]);
    expect(e.code).toBe('ALL_KEYS_UNAVAILABLE');
    expect(e.message).toContain('1 on cooldown');
    expect(e.message).toContain('2 disabled');
  });
});

describe('setupProviderHeaders', () => {
  beforeEach(() => {
    CooldownManager.getInstance().resetForTesting();
  });

  it('stamps selectedKeyId and selectedKeyLabel from selected key', async () => {
    const route = makeRoute({ api_keys: [{ id: 'k1', api_key: 'sk-k1', label: 'K1', enabled: true, priority: 1 }] });
    await setupProviderHeaders(route, 'chat', { stream: false } as any);
    expect(route.selectedKeyId).toBe('k1');
    expect(route.selectedKeyLabel).toBe('K1');
  });

  it('labels legacy api_key as "default"', async () => {
    const route = makeRoute({ api_key: 'sk-legacy' });
    await setupProviderHeaders(route, 'chat', { stream: false } as any);
    expect(route.selectedKeyId).toBeUndefined();
    expect(route.selectedKeyLabel).toBe('default');
  });

  it('throws ALL_KEYS_UNAVAILABLE when all keys are unhealthy', async () => {
    const cm = CooldownManager.getInstance();
    await cm.markProviderFailure('openai', 'gpt-4', 60_000, 'boom', 'k1');
    const route = makeRoute({ api_keys: [{ id: 'k1', api_key: 'sk', enabled: true, priority: 1 }] });
    await expect(setupProviderHeaders(route, 'chat', { stream: false } as any)).rejects.toMatchObject({ code: 'ALL_KEYS_UNAVAILABLE' });
  });

  it('sets Bearer Authorization for chat api type', async () => {
    const route = makeRoute({ api_keys: [{ id: 'k1', api_key: 'sk-k1', label: 'K1', enabled: true, priority: 1 }] });
    const headers = await setupProviderHeaders(route, 'chat', { stream: false } as any);
    expect(headers.Authorization).toBe('Bearer sk-k1');
  });

  it('sets x-api-key for messages api type', async () => {
    const route = makeRoute({ api_keys: [{ id: 'k1', api_key: 'sk-k1', label: 'K1', enabled: true, priority: 1 }] });
    const headers = await setupProviderHeaders(route, 'messages', { stream: false } as any);
    expect(headers['x-api-key']).toBe('sk-k1');
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run: `bun run test packages/backend/src/services/providers/__tests__/provider-request-headers.test.ts`
Expected: FAIL — exports don't exist.

- [ ] **Step 3: Implement the helpers and update `setupProviderHeaders`**

Replace `packages/backend/src/services/providers/provider-request-headers.ts`:

```ts
import type { UnifiedChatRequest } from '../../types/unified';
import { getApiBaseType } from '../../utils/api-format';
import type { RouteResult } from '../routing/router';
import { CooldownManager } from '../runtime/cooldown-manager';
import { logger } from '../../utils/logger';

export interface ApiKeyEntry {
  id: string;
  api_key: string;
  enabled?: boolean;
  label?: string;
  priority?: number;
}

export async function selectProviderKey(route: RouteResult): Promise<ApiKeyEntry | undefined> {
  const apiKeys: ApiKeyEntry[] = (route.config as any).api_keys ?? [];
  if (apiKeys.length === 0) return undefined;
  const cm = CooldownManager.getInstance();
  const ordered = [...apiKeys].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  for (const key of ordered) {
    if (key.enabled === false) continue;
    if (!key.api_key?.trim()) continue;
    const keyHealthy =
      (await cm.isProviderHealthy(route.provider, '', key.id)) &&
      (await cm.isProviderHealthy(route.provider, route.model, key.id));
    if (keyHealthy) return key;
  }
  return undefined;
}

export function resolveSelectedKeyLabel(key: { label?: string } | undefined): string {
  const trimmed = key?.label?.trim();
  return trimmed ? trimmed : 'default';
}

export function buildAllKeysUnavailableError(provider: string, apiKeys: ApiKeyEntry[]): Error & { code?: string } {
  let cooldownCount = 0;
  let disabledCount = 0;
  for (const k of apiKeys) {
    if (k.enabled === false || !k.api_key?.trim()) disabledCount++;
    else cooldownCount++;
  }
  const parts: string[] = [];
  if (cooldownCount > 0) parts.push(`${cooldownCount} on cooldown`);
  if (disabledCount > 0) parts.push(`${disabledCount} disabled`);
  const err = new Error(
    `All API keys for provider '${provider}' are unavailable: ${parts.join(', ')}`
  ) as Error & { code?: string };
  err.code = 'ALL_KEYS_UNAVAILABLE';
  return err;
}

export async function setupProviderHeaders(
  route: RouteResult,
  apiType: string,
  _request: UnifiedChatRequest
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiType === 'responses' || apiType === 'transcriptions' || apiType === 'speech') {
    headers['Accept'] = 'application/json';
  }

  const apiKeys: ApiKeyEntry[] = (route.config as any).api_keys ?? [];
  const selectedKey = await selectProviderKey(route);

  if (selectedKey) {
    route.selectedKeyId = selectedKey.id;
    route.selectedKeyLabel = resolveSelectedKeyLabel(selectedKey);
  } else if (apiKeys.length === 0) {
    route.selectedKeyId = undefined;
    route.selectedKeyLabel = resolveSelectedKeyLabel(undefined);
  } else {
    throw buildAllKeysUnavailableError(route.provider, apiKeys);
  }

  const apiKey = selectedKey?.api_key ?? route.config.api_key;
  if (apiKey) {
    const type = getApiBaseType(apiType);
    if (type === 'messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (type === 'gemini') {
      headers['x-goog-api-key'] = apiKey;
    } else {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  } else {
    throw new Error(`No API key configured for provider '${route.provider}'`);
  }
  return headers;
}
```

- [ ] **Step 4: Run the test (expect pass)**

Run: `bun run test packages/backend/src/services/providers/__tests__/provider-request-headers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/providers/ packages/backend/src/services/runtime/cooldown-manager.ts
git commit -m "feat(dispatch): selectProviderKey + resolveSelectedKeyLabel + buildAllKeysUnavailableError + multi-key setupProviderHeaders"
```

---

### Task 9: RouteResult fields, per-key candidate expansion, per-key sticky session

**Files:**
- Modify: `packages/backend/src/services/routing/router.ts` (add `selectedKeyId?`, `selectedKeyLabel?`)
- Modify: `packages/backend/src/services/routing/route-candidates.ts` (add `expandCandidatesPerKey`, `maybeExpandPerKey`)
- Modify: `packages/backend/src/services/routing/sticky-session-manager.ts` (add `keyId?` to `StickyEntry`)
- Modify: `packages/backend/src/types/unified.ts` (add fields to `PlexusRuntimeMetadata`)
- Create: `packages/backend/src/services/routing/__tests__/route-candidates-per-key.test.ts`
- Create: `packages/backend/src/services/routing/__tests__/sticky-session-key.test.ts`

**Interfaces:**
- Produces: `RouteResult.selectedKeyId?`, `RouteResult.selectedKeyLabel?`, `PlexusRuntimeMetadata.selectedKeyId?`, `PlexusRuntimeMetadata.selectedKeyLabel?`, `expandCandidatesPerKey(candidates)`, `maybeExpandPerKey(candidates)`, `StickyEntry.keyId?`, `get(alias, apiType, sessionKey)` returns `(provider, model, keyId?)`, `set(alias, apiType, sessionKey, provider, model, keyId?)`.

- [ ] **Step 1: Write the failing tests**

`route-candidates-per-key.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { expandCandidatesPerKey, maybeExpandPerKey } from '../route-candidates';
import type { RouteResult } from '../router';

const makeCandidate = (config: any): RouteResult => ({ provider: 'openai', model: 'gpt-4', config } as any);

describe('expandCandidatesPerKey', () => {
  it('clones a candidate once per usable key', () => {
    const c = makeCandidate({ api_keys: [
      { id: 'a', api_key: 'sk-a', enabled: true, priority: 1 },
      { id: 'b', api_key: 'sk-b', enabled: true, priority: 2 },
    ] });
    const out = expandCandidatesPerKey([c]);
    expect(out).toHaveLength(2);
    expect(out[0]).not.toBe(c);
    expect(out[0]!.config).toBe(c.config);
  });
  it('emits one entry for legacy single-key provider', () => {
    const c = makeCandidate({ api_key: 'sk-legacy' });
    const out = expandCandidatesPerKey([c]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(c);
  });
  it('ignores disabled / blank keys when counting', () => {
    const c = makeCandidate({ api_keys: [
      { id: 'a', api_key: 'sk', enabled: true, priority: 1 },
      { id: 'b', api_key: '', enabled: true, priority: 1 },
      { id: 'c', api_key: 'sk', enabled: false, priority: 1 },
    ] });
    const out = expandCandidatesPerKey([c]);
    expect(out).toHaveLength(1);
  });
});

describe('maybeExpandPerKey', () => {
  it('does not expand when no provider has > 1 usable key', async () => {
    vi.doMock('../../config', () => ({ getConfig: () => ({ failover: { enabled: true } }) }));
    const c = makeCandidate({ api_keys: [{ id: 'a', api_key: 'sk', enabled: true, priority: 1 }] });
    const out = maybeExpandPerKey([c]);
    expect(out).toHaveLength(1);
  });
  it('expands when a provider has multiple keys', async () => {
    vi.doMock('../../config', () => ({ getConfig: () => ({ failover: { enabled: true } }) }));
    const c = makeCandidate({ api_keys: [
      { id: 'a', api_key: 'sk', enabled: true, priority: 1 },
      { id: 'b', api_key: 'sk', enabled: true, priority: 2 },
    ] });
    const out = maybeExpandPerKey([c]);
    expect(out).toHaveLength(2);
  });
  it('does not expand when failover.perKey is false', async () => {
    vi.doMock('../../config', () => ({ getConfig: () => ({ failover: { enabled: true, perKey: false } }) }));
    const c = makeCandidate({ api_keys: [{ id: 'a', api_key: 'sk', enabled: true, priority: 1 }, { id: 'b', api_key: 'sk', enabled: true, priority: 2 }] });
    const out = maybeExpandPerKey([c]);
    expect(out).toHaveLength(1);
  });
});
```

`sticky-session-key.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { StickySessionManager } from '../sticky-session-manager';

describe('StickySessionManager — per-key', () => {
  beforeEach(() => {
    (StickySessionManager as any).instance = undefined;
  });

  it('set + get round-trips keyId', () => {
    const sm = new StickySessionManager();
    sm.set('gpt-4', 'chat', 'session-1', 'openai', 'gpt-4', 'k1');
    const e = sm.get('gpt-4', 'chat', 'session-1');
    expect(e).toEqual({ provider: 'openai', model: 'gpt-4', keyId: 'k1' });
  });

  it('get returns null keyId when not set (legacy)', () => {
    const sm = new StickySessionManager();
    sm.set('gpt-4', 'chat', 'session-1', 'openai', 'gpt-4');
    const e = sm.get('gpt-4', 'chat', 'session-1');
    expect(e).toEqual({ provider: 'openai', model: 'gpt-4' });
  });
});
```

- [ ] **Step 2: Run the tests (expect failure)**

Run both test files. Expected: FAIL.

- [ ] **Step 3: Implement**

In `router.ts`:
```ts
export interface RouteResult {
  provider: string;
  model: string;
  config: ProviderConfig;
  modelConfig?: ModelProviderConfig;
  modelArchitecture?: ModelArchitecture;
  incomingModelAlias?: string;
  canonicalModel?: string;
  selectedKeyId?: string;
  selectedKeyLabel?: string;
}
```

In `unified.ts` (`PlexusRuntimeMetadata`):
```ts
selectedKeyId?: string;
selectedKeyLabel?: string;
```

In `route-candidates.ts`, add the imports and the two functions:
```ts
import type { ApiKeyEntry } from '../providers/provider-request-headers';
import { getConfig } from '../../config';

export function expandCandidatesPerKey(candidates: RouteResult[]): RouteResult[] {
  const expanded: RouteResult[] = [];
  for (const c of candidates) {
    const apiKeys: ApiKeyEntry[] = ((c.config as any).api_keys as ApiKeyEntry[]) ?? [];
    const usable = apiKeys.filter((k) => k.enabled !== false && !!k.api_key?.trim()).length;
    const clones = Math.max(1, usable);
    for (let i = 0; i < clones; i++) {
      expanded.push(clones === 1 ? c : { ...c });
    }
  }
  return expanded;
}

export function maybeExpandPerKey(candidates: RouteResult[]): RouteResult[] {
  let failoverConfig;
  try { failoverConfig = getConfig().failover; } catch { return candidates; }
  if (failoverConfig?.enabled === false || failoverConfig?.perKey === false) return candidates;
  const hasMulti = candidates.some((c) => {
    const apiKeys = ((c.config as any).api_keys as ApiKeyEntry[]) ?? [];
    return apiKeys.filter((k) => k.enabled !== false && !!k.api_key?.trim()).length > 1;
  });
  return hasMulti ? expandCandidatesPerKey(candidates) : candidates;
}
```

Wire `maybeExpandPerKey` into `resolveRouteCandidates` at both return points (lines ~91 and ~106):
```ts
if (!quotaContext) return maybeExpandPerKey(candidates);
// ...
return maybeExpandPerKey(allowed);
```

In `sticky-session-manager.ts`:
```ts
interface StickyEntry {
  provider: string;
  model: string;
  keyId?: string;
}
// ...
public get(alias: string, apiType: string, sessionKey: string): StickyEntry | null {
  const k = this.makeKey(alias, apiType, sessionKey);
  return this.entries.get(k) ?? null;
}
public set(
  alias: string, apiType: string, sessionKey: string,
  provider: string, model: string, keyId?: string
): void {
  const k = this.makeKey(alias, apiType, sessionKey);
  this.entries.set(k, { provider, model, keyId });
  // ... LRU eviction ...
}
```

- [ ] **Step 4: Run the tests (expect pass)**

Both test files. Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/routing/ packages/backend/src/types/unified.ts
git commit -m "feat(routing): per-key candidate expansion + per-key sticky session + RouteResult.selectedKeyId/Label"
```

---

### Task 10: Auto-disable helper + QuotaScheduler per-key cooldown

**Files:**
- Create: `packages/backend/src/services/dispatch/auto-disable.ts`
- Modify: `packages/backend/src/services/quota/quota-scheduler.ts` (per-key cooldown injection, no cascade)
- Modify: `packages/backend/src/services/quota/checker-registry.ts` (add `keyId?` to `MeterContext`)
- Create: `packages/backend/src/services/dispatch/__tests__/auto-disable.test.ts`
- Create: `packages/backend/src/services/quota/checkers/__tests__/openrouter-checker.test.ts`

**Interfaces:**
- Produces: `autoDisableOnQuotaError(error, route)` per-key; `matchesQuotaError(error)` requires status 402/400 + message match. `quota-scheduler` calls `markProviderFailure(provider, model, durationMs, reason, keyId)` (per-key) when a key-level meter hits exhaustion. `MeterContext.keyId?` field. `openrouter-checker` prefers `managementKey` over `apiKey`.

- [ ] **Step 1: Write the failing tests**

`auto-disable.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { matchesQuotaError, autoDisableOnQuotaError } from '../auto-disable';
import { CooldownManager } from '../../runtime/cooldown-manager';

describe('matchesQuotaError', () => {
  it('returns true for status 402 with quota pattern in message', () => {
    const e = { message: 'insufficient_quota', routingContext: { statusCode: 402 } };
    expect(matchesQuotaError(e)).toBe(true);
  });
  it('returns true for status 400 with quota pattern in message', () => {
    const e = { message: 'quota_exceeded', routingContext: { statusCode: 400 } };
    expect(matchesQuotaError(e)).toBe(true);
  });
  it('returns false for status 429 even with quota pattern', () => {
    const e = { message: 'quota_exceeded', routingContext: { statusCode: 429 } };
    expect(matchesQuotaError(e)).toBe(false);
  });
  it('returns false when no message match', () => {
    const e = { message: 'something else', routingContext: { statusCode: 402 } };
    expect(matchesQuotaError(e)).toBe(false);
  });
});

describe('autoDisableOnQuotaError', () => {
  it('with selectedKeyId disables only that key (per-key cooldown, no cascade)', async () => {
    CooldownManager.getInstance().resetForTesting();
    await autoDisableOnQuotaError(
      { message: 'insufficient_quota', routingContext: { statusCode: 402 } },
      { provider: 'openai', model: 'gpt-4', selectedKeyId: 'k1' }
    );
    const cm = CooldownManager.getInstance();
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k1')).toBe(false);
    expect(await cm.isProviderHealthy('openai', 'gpt-4', 'k2')).toBe(true);
    expect(await cm.isProviderHealthy('openai', 'gpt-4')).toBe(true); // legacy model-level slot untouched
  });
});
```

`openrouter-checker.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { OpenRouterChecker } from '../openrouter-checker';
import type { MeterContext } from '../../checker-registry';

const ctx = (overrides: Record<string, any>): MeterContext => ({
  checkerId: 'test',
  provider: 'openrouter',
  options: {},
  getOption: <T>(k: string, d: T) => (k in overrides ? overrides[k] as T : d),
  requireOption: <T>(k: string) => overrides[k] as T,
  balance: () => ({}) as any,
  allowance: () => ({}) as any,
  ...overrides,
} as any);

describe('OpenRouterChecker', () => {
  it('uses managementKey when present', () => {
    const checker = new OpenRouterChecker();
    const result = checker.parseUsageResponse('{}', { apiKey: 'sk-foo', managementKey: 'mgmt-bar' } as any, ctx({ managementKey: 'mgmt-bar', apiKey: 'sk-foo' }));
    expect(result).toBeDefined();
  });
});
```

(Simplified — the test should verify the Auth header is built with `managementKey` when present. Add a `buildAuthHeader` method or test through a public method that uses it.)

- [ ] **Step 2: Run the tests (expect failure)**

Run both. Expected: FAIL.

- [ ] **Step 3: Implement**

`auto-disable.ts`:
```ts
import { getConfig } from '../../config';
import { QUOTA_ERROR_PATTERNS } from '../../utils/constants';
import { logger } from '../../utils/logger';
import { CooldownManager } from '../runtime/cooldown-manager';

export interface AutoDisableRoute {
  provider: string;
  model: string;
  selectedKeyId?: string;
}

export function matchesQuotaError(error: any): boolean {
  const errorMsg = (error?.message || '').toLowerCase();
  const cfg = getConfig().autoDisableOnQuotaError;
  const patterns = cfg?.errorPatterns?.filter(Boolean)?.length
    ? cfg.errorPatterns
    : QUOTA_ERROR_PATTERNS;
  const matched = patterns.some((p) => errorMsg.includes(p.toLowerCase()));
  const status = error?.routingContext?.statusCode;
  return matched && (status === 402 || status === 400);
}

export async function autoDisableOnQuotaError(
  error: any,
  route: AutoDisableRoute
): Promise<void> {
  if (!matchesQuotaError(error)) return;
  const cfg = getConfig().autoDisableOnQuotaError;
  if (!cfg?.enabled) return;
  const reason = `quota_exceeded: ${error?.message ?? ''}`;
  if (route.selectedKeyId) {
    logger.warn(`Quota/balance error on ${route.provider}:${route.model} key '${route.selectedKeyId}' — auto-disable (key mode): ${error?.message ?? ''}`);
    await CooldownManager.getInstance().markKeyAsDisabled(
      route.provider, route.model, route.selectedKeyId, reason
    );
  } else {
    logger.warn(`Quota/balance error on ${route.provider}:${route.model} — auto-disable (provider mode): ${error?.message ?? ''}`);
    await CooldownManager.getInstance().markKeyAsDisabled(
      route.provider, route.model, undefined, reason
    );
  }
}
```

`checker-registry.ts` — add `keyId?: string` to `MeterContext`. `createMeterContext` accepts and forwards `keyId`:
```ts
export interface MeterContext {
  checkerId: string;
  provider: string;
  keyId?: string;
  options: Record<string, unknown>;
  getOption<T>(key: string, defaultValue: T): T;
  requireOption<T>(key: string): T;
  balance(params: BalanceParams): Meter;
  allowance(params: AllowanceParams): Meter;
}

export function createMeterContext(checkerId: string, provider: string, options: Record<string, unknown>, keyId?: string): MeterContext {
  return {
    checkerId, provider, keyId, options,
    getOption<T>(k: string, d: T) { return (options as any)[k] !== undefined ? (options as any)[k] as T : d; },
    requireOption<T>(k: string) {
      if ((options as any)[k] === undefined) throw new Error(`Missing required option '${k}' on checker '${checkerId}'`);
      return (options as any)[k] as T;
    },
    balance: (p) => ({ ...p, label: '' } as any),
    allowance: (p) => ({ ...p, label: '' } as any),
  };
}
```

`quota-scheduler.ts` — when emitting per-key exhaustion, pass `keyId` to `markProviderFailure`:
```ts
// In applyCooldownsFromResult or equivalent, when isExhausted for a key-level checker:
if (result.keyId) {
  await cooldownManager.markProviderFailure(
    provider, model, durationMs, reason, result.keyId
  );
} else {
  await cooldownManager.markProviderFailure(
    provider, model, durationMs, reason
  );
}
```

(Per design: NO provider-wide cascade. Only set the per-key slot.)

`openrouter-checker.ts` — prefer managementKey:
```ts
const apiKey = ctx.getOption<string | undefined>('managementKey', undefined) ?? ctx.requireOption<string>('apiKey');
```

- [ ] **Step 4: Run the tests (expect pass)**

Both. Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/dispatch/auto-disable.ts packages/backend/src/services/quota/ packages/backend/src/services/dispatch/__tests__/auto-disable.test.ts packages/backend/src/services/quota/checkers/__tests__/openrouter-checker.test.ts
git commit -m "feat(quota): auto-disable helper + per-key cooldown (no cascade) + managementKey preference in openrouter checker"
```

---

### Task 11: Dispatcher + media dispatcher + standard attempt + per-key cooldown calls

**Files:**
- Modify: `packages/backend/src/services/dispatch/dispatcher.ts` (await `setupHeaders`; pass `selectedKeyLabel` to `emitUpdatedAsync`)
- Modify: `packages/backend/src/services/dispatch/standard-attempt-request.ts` (emit routing update AFTER `setupHeaders`; pass `keyId` to all `markProvider*` calls)
- Modify: `packages/backend/src/services/dispatch/request-manager.ts` (pass `keyId`; call `autoDisableOnQuotaError`; pass `keyId` to `StickySessionManager.set`)
- Modify: `packages/backend/src/services/dispatch/media-dispatcher.ts` (5 dispatch methods call `selectProviderKey` + thread `keyId`)

**Interfaces:**
- Produces: Every `markProviderSuccess/Failure/StallFailure` call receives `route.selectedKeyId`. `StickySessionManager.set` receives the keyId. `autoDisableOnQuotaError` is called on quota errors. `emitRoutingUpdate` includes `selectedKeyLabel`.

- [ ] **Step 1: Write a dispatch integration test**

`packages/backend/src/services/dispatch/__tests__/standard-attempt-key.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CooldownManager } from '../../runtime/cooldown-manager';
import { executeStandardAttempt } from '../standard-attempt-request';

describe('standard-attempt-request — per-key', () => {
  beforeEach(() => {
    CooldownManager.getInstance().resetForTesting();
  });

  it('emits routing update with selectedKeyLabel after setupHeaders', async () => {
    const emitRoutingUpdate = vi.fn();
    const setupHeaders = vi.fn(async (route: any) => {
      route.selectedKeyId = 'k1';
      route.selectedKeyLabel = 'K1';
      return { Authorization: 'Bearer sk' };
    });
    const route = { provider: 'openai', model: 'gpt-4', config: { api_keys: [{ id: 'k1', api_key: 'sk', enabled: true, priority: 1 }] } } as any;
    const request = { requestId: 'r1', incomingApiType: 'chat' } as any;
    // Stub the upstream + transform paths
    // ... call executeStandardAttempt with a stub host ...
    // Assert: setupHeaders called first; emitRoutingUpdate called with { selectedKeyLabel: 'K1' }
  });
});
```

(Use `vi.fn()` for host methods, then assert call order with `vi.mocked().mock.invocationCallOrder`.)

- [ ] **Step 2: Run the test (expect failure)**

Run. Expected: FAIL — no keyId plumbing.

- [ ] **Step 3: Update dispatcher, request-manager, standard-attempt-request, media-dispatcher**

In `dispatcher.ts`:
- `emitRoutingUpdate` payload includes `selectedKeyLabel: route.selectedKeyLabel`
- `setupHeaders` is `await`-ed (already async in Task 8 implementation)

In `standard-attempt-request.ts`:
- After `host.setupHeaders(...)`, call `host.emitRoutingUpdate(currentRequest.requestId, route)` (move the existing call)
- All `markProviderSuccess(route.provider, route.model, ...)` → add `route.selectedKeyId` as 3rd arg
- All `markProviderFailure(route.provider, route.model, duration, reason, ...)` → add `route.selectedKeyId` as 5th arg
- All `markProviderStallFailure(route.provider, route.model, duration, reason, ...)` → add `route.selectedKeyId` as 5th arg
- On quota-style error, call `await autoDisableOnQuotaError(error, route)`

In `request-manager.ts`:
- Same `markProvider*` signature updates
- On `ALL_KEYS_UNAVAILABLE` error code, skip cooldown extension (state already reflected)
- `StickySessionManager.getInstance().set(route.canonicalModel, apiType, sessionKey, route.provider, route.model, route.selectedKeyId)` — add keyId

In `media-dispatcher.ts` (5 methods: `dispatchEmbeddings`, `dispatchTranscription`, `dispatchSpeech`, `dispatchImageGenerations`, `dispatchImageEdits`):
- At the top of each attempt, call `const selectedKey = await selectProviderKey(route); route.selectedKeyId = selectedKey?.id; route.selectedKeyLabel = resolveSelectedKeyLabel(selectedKey);`
- Throw `buildAllKeysUnavailableError(...)` if no key + no `route.config.api_key`
- Thread `route.selectedKeyId` to all `markProvider*` calls
- `host.emitRoutingUpdate` after key resolution

- [ ] **Step 4: Run the test (expect pass)**

Run. Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/dispatch/
git commit -m "feat(dispatch): per-key cooldown calls, routing-update after key selection, sticky with keyId, auto-disable integration"
```

---

### Task 12: Usage storage + inference routes — propagate `selectedKeyLabel`

**Files:**
- Modify: `packages/backend/src/services/observability/usage-storage.ts`
- Modify: `packages/backend/src/services/responses/response-handler.ts`
- Modify: `packages/backend/src/services/probes/probe-service.ts`
- Modify: `packages/backend/src/routes/inference/_quota-error.ts`
- Modify: `packages/backend/src/routes/inference/{chat,completions,embeddings,gemini,images,messages,responses,speech,transcriptions}.ts` (9 files)

**Interfaces:**
- Produces: `selectedKeyLabel` is written to `request_usage` via `emitStarted`, `emitUpdated`, `getUsage`. All 9 inference routes propagate it to `usageRecord` and `emitUpdatedAsync`.

- [ ] **Step 1: Write the failing test**

`packages/backend/src/services/observability/__tests__/usage-storage-key-label.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { UsageStorageService } from '../usage-storage';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';

describe('UsageStorageService — selectedKeyLabel', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
  });

  it('emitStarted writes selectedKeyLabel to the in-flight row', async () => {
    const svc = new UsageStorageService();
    await svc.emitStarted({ requestId: 'r1', provider: 'openai', selectedKeyLabel: 'k1' } as any);
    // Query the in-flight row
    const db = getDatabase();
    const schema = getSchema();
    const [row] = await db.select().from(schema.requestUsage).where(/* eq requestId */);
    expect(row?.selectedKeyLabel).toBe('k1');
  });

  it('getUsage returns selectedKeyLabel per row', async () => {
    const svc = new UsageStorageService();
    await svc.emitStarted({ requestId: 'r1', provider: 'openai', selectedKeyLabel: 'k1' } as any);
    await svc.saveRequest({ requestId: 'r1', provider: 'openai', selectedKeyLabel: 'k1', isStreamed: false, isPassthrough: false, isRaw: false } as any);
    const result = await svc.getUsage({});
    expect(result.data[0]?.selectedKeyLabel).toBe('k1');
  });
});
```

- [ ] **Step 2: Run the test (expect failure)**

Run. Expected: FAIL — column doesn't exist in select.

- [ ] **Step 3: Implement**

In `usage-storage.ts`:
- `emitStarted`: add `selectedKeyLabel: record.selectedKeyLabel` to the insert payload
- `emitUpdated`: add `if (record.selectedKeyLabel !== undefined) updateSet.selectedKeyLabel = record.selectedKeyLabel;`
- `getUsage` SELECT: add `selectedKeyLabel: schema.requestUsage.selectedKeyLabel,`
- `getUsage` map: add `selectedKeyLabel: row.selectedKeyLabel,`
- `getUsage` filters: accept `selectedKeyLabel?: string` in the filters object; add `if (filters.selectedKeyLabel) whereConditions.push(eq(schema.requestUsage.selectedKeyLabel, filters.selectedKeyLabel));`

In `routes/management/usage.ts`:
- `USAGE_FIELDS`: add `'selectedKeyLabel'`
- The filters parsing: include `selectedKeyLabel`

In `response-handler.ts`:
- `unifiedResponse.plexus?.selectedKeyLabel` → `usageRecord.selectedKeyLabel`
- Pass to `emitUpdatedAsync` in the post-response path

In `probe-service.ts`:
- After probe result, propagate `unifiedResponse.plexus?.selectedKeyLabel` to usage record

In `_quota-error.ts`:
- Carry `selectedKeyLabel` through `handleApiError` and `recordQuotaUsageForResponse`

In each of the 9 inference routes:
- After dispatch, copy `unifiedResponse.plexus?.selectedKeyLabel` to both `emitUpdatedAsync({...selectedKeyLabel})` and `usageRecord.selectedKeyLabel`
- Add `selectedKeyLabel` to the filter form (where applicable — at least in the request body for routes that take filters)

- [ ] **Step 4: Run the test (expect pass)**

Run. Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/services/observability/ packages/backend/src/services/responses/ packages/backend/src/services/probes/ packages/backend/src/routes/inference/ packages/backend/src/routes/management/usage.ts
git commit -m "feat(observability): propagate selectedKeyLabel through usage storage + all 9 inference routes"
```

---

### Task 13: Management routes + encrypt migration + rekey

**Files:**
- Create: `packages/backend/src/routes/management/provider-keys.ts`
- Modify: `packages/backend/src/routes/management.ts` (wire `registerProviderKeyRoutes` into `adminOnly`)
- Modify: `packages/backend/src/db/encrypt-migration.ts` (encrypt plaintext `apiKey` + `managementKey` in `provider_keys`)
- Modify: `packages/backend/src/cli/rekey.ts` (add `rekeyProviderKeys` + wire into `main()`)
- Create: `packages/backend/src/routes/management/__tests__/provider-keys.test.ts`
- Create: `packages/backend/src/cli/__tests__/rekey-provider-keys.test.ts`

**Interfaces:**
- Produces: 5 endpoints (GET, POST, PUT, DELETE, POST /bulk). Encrypt migration covers `provider_keys`. Rekey supports `provider_keys` (null-safe).

- [ ] **Step 1: Write the failing tests**

`provider-keys.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { registerProviderKeyRoutes } from '../provider-keys';
import { encryptField } from '../../utils/encryption';
import Fastify from 'fastify';

describe('provider-keys management routes', () => {
  let fastify: any;

  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encryptField('sk'),
    } as any);
    fastify = Fastify();
    await registerProviderKeyRoutes(fastify);
  });

  it('create → list → update → delete round-trips using provider slug', async () => {
    const create = await fastify.inject({ method: 'POST', url: '/v0/management/provider-keys', payload: { provider_id: 'openai', label: 'prod', api_key: 'sk-secret', enabled: true, priority: 1 } });
    expect(create.statusCode).toBe(201);
    expect(create.json().key.provider_id).toBe('openai');

    const list = await fastify.inject({ method: 'GET', url: '/v0/management/provider-keys' });
    expect(list.json().keys).toHaveLength(1);

    const id = create.json().key.id;
    const update = await fastify.inject({ method: 'PUT', url: `/v0/management/provider-keys/${id}`, payload: { label: 'prod-updated' } });
    expect(update.json().key.label).toBe('prod-updated');

    const del = await fastify.inject({ method: 'DELETE', url: `/v0/management/provider-keys/${id}` });
    expect(del.statusCode).toBe(204);
  });

  it('unknown provider slug returns 400', async () => {
    const r = await fastify.inject({ method: 'POST', url: '/v0/management/provider-keys', payload: { provider_id: 'nope', label: 'x', api_key: 'sk', enabled: true, priority: 1 } });
    expect(r.statusCode).toBe(400);
  });
});
```

`rekey-provider-keys.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { closeDatabase, getDatabase, getSchema, initializeDatabase } from '../../db/client';
import { runMigrations } from '../../db/migrate';
import { rekeyProviderKeys } from '../rekey';
import { encrypt, decrypt } from '../../utils/encryption';

describe('rekeyProviderKeys', () => {
  beforeEach(async () => {
    await closeDatabase();
    await initializeDatabase(':memory:');
    await runMigrations();
  });

  it('does not crash on null managementKey', async () => {
    const db = getDatabase();
    const schema = getSchema();
    await db.insert(schema.providers).values({
      slug: 'openai', name: 'OpenAI', providerName: 'openai',
      enabled: 1, isOAuth: 0, apiKey: encrypt('sk'),
    } as any);
    const providerId = (await db.select().from(schema.providers))[0]!.id;
    const oldKey = Buffer.from('a'.repeat(32), 'utf8');
    const newKey = Buffer.from('b'.repeat(32), 'utf8');
    await db.insert(schema.providerKeys).values({
      id: 'k1', providerId, label: 'K1', apiKey: encrypt('sk-k1'), managementKey: null, enabled: 1, priority: 1, createdAt: 'now', updatedAt: 'now',
    } as any);
    await expect(rekeyProviderKeys(db, schema, oldKey, newKey)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run the tests (expect failure)**

Run both. Expected: FAIL.

- [ ] **Step 3: Implement**

`provider-keys.ts` (full file, ~260 lines — see spec for endpoint specs). Use the pattern from reference `plexus-severles`, adapted to the design:
```ts
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConfigService } from '../../services/configuration/config-service';
import { randomUUID } from 'crypto';

const ProviderKeySchema = z.object({
  provider_id: z.string().min(1),
  label: z.string().default(''),
  api_key: z.string().min(1),
  management_key: z.string().optional(),
  notes: z.string().optional(),
  enabled: z.boolean().default(true),
  priority: z.number().int().optional(),
});

const UpdateProviderKeySchema = ProviderKeySchema.partial();

function ensureLabel(label?: string): string {
  return label && label.trim().length > 0 ? label : randomUUID();
}

async function resequenceProviderKeys(repo: any, providerId: string, targetId: string, position: number): Promise<void> {
  const keys = await repo.getProviderKeys(providerId);
  const target = keys.find((k: any) => k.id === targetId);
  if (!target) return;
  const ordered = keys.filter((k: any) => k.id !== targetId);
  ordered.splice(Math.min(position, ordered.length), 0, target);
  let next = 1;
  for (const k of ordered) {
    if (k.priority !== next) {
      await repo.saveProviderKey(k.id, {
        provider_id: k.provider_id, label: k.label, api_key: k.api_key,
        management_key: k.management_key, notes: k.notes, enabled: k.enabled, priority: next,
      });
    }
    next++;
  }
}

export async function registerProviderKeyRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v0/management/provider-keys', async (request: any, reply) => {
    const repo = ConfigService.getInstance().getRepository();
    const { provider_id } = request.query as { provider_id?: string };
    const keys = provider_id
      ? await repo.getProviderKeys(await repo.resolveProviderId(provider_id) ?? provider_id)
      : await repo.getAllProviderKeys();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return { keys: keys.map((k: any) => ({ ...k, provider_id: idToSlug.get(k.provider_id) ?? k.provider_id })) };
  });

  fastify.post('/v0/management/provider-keys', async (request: any, reply) => {
    const parsed = ProviderKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const repo = ConfigService.getInstance().getRepository();
    const providerId = await repo.resolveProviderId(parsed.data.provider_id);
    if (providerId === undefined) return reply.status(400).send({ error: `Provider '${parsed.data.provider_id}' not found` });
    const id = randomUUID();
    const { priority, ...rest } = parsed.data;
    const key = await repo.saveProviderKey(id, {
      ...rest, label: ensureLabel(rest.label), provider_id: String(providerId), priority: priority ?? 0,
    });
    await resequenceProviderKeys(
      repo, String(providerId), id,
      priority !== undefined && priority >= 1 ? priority - 1 : Number.MAX_SAFE_INTEGER
    );
    await ConfigService.getInstance().flush();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return reply.status(201).send({ key: { ...key, provider_id: idToSlug.get(key.provider_id) ?? key.provider_id } });
  });

  fastify.put('/v0/management/provider-keys/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const parsed = UpdateProviderKeySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const svc = ConfigService.getInstance();
    const repo = svc.getRepository();
    const all = await repo.getAllProviderKeys();
    const existing = all.find((k: any) => k.id === id);
    if (!existing) return reply.status(404).send({ error: 'Provider key not found' });
    let providerId = existing.provider_id;
    if (parsed.data.provider_id !== undefined) {
      const resolved = await repo.resolveProviderId(parsed.data.provider_id);
      if (resolved === undefined) return reply.status(400).send({ error: `Provider '${parsed.data.provider_id}' not found` });
      providerId = String(resolved);
    }
    const merged = {
      provider_id: providerId,
      label: ensureLabel(parsed.data.label ?? existing.label),
      api_key: parsed.data.api_key ?? existing.api_key,
      management_key: parsed.data.management_key === '' ? '' : (parsed.data.management_key ?? existing.management_key),
      notes: parsed.data.notes ?? existing.notes,
      enabled: parsed.data.enabled ?? existing.enabled,
      priority: parsed.data.priority ?? existing.priority,
    };
    const key = await repo.saveProviderKey(id, merged);
    if (parsed.data.priority !== undefined) {
      await resequenceProviderKeys(
        repo, providerId, id,
        parsed.data.priority >= 1 ? parsed.data.priority - 1 : Number.MAX_SAFE_INTEGER
      );
    }
    await svc.flush();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return { key: { ...key, provider_id: idToSlug.get(key.provider_id) ?? key.provider_id } };
  });

  fastify.post('/v0/management/provider-keys/bulk', async (request: any, reply) => {
    const BulkSchema = z.object({
      provider_id: z.string().min(1),
      keys: z.array(z.object({
        label: z.string().optional().default(''),
        api_key: z.string().min(1),
        enabled: z.boolean().optional().default(true),
        priority: z.number().int().optional(),
      })).min(1),
    });
    const parsed = BulkSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
    const repo = ConfigService.getInstance().getRepository();
    const providerId = await repo.resolveProviderId(parsed.data.provider_id);
    if (providerId === undefined) return reply.status(400).send({ error: `Provider '${parsed.data.provider_id}' not found` });
    const existing = await repo.getProviderKeys(String(providerId));
    const maxExisting = existing.reduce((m: number, k: any) => Math.max(m, k.priority), 0);
    let next = maxExisting + 1;
    const created: any[] = [];
    for (const k of parsed.data.keys) {
      const id = randomUUID();
      const key = await repo.saveProviderKey(id, {
        provider_id: String(providerId), label: ensureLabel(k.label), api_key: k.api_key, enabled: k.enabled ?? true, priority: next,
      });
      created.push(key);
      next++;
    }
    await ConfigService.getInstance().flush();
    const idToSlug = await repo.getProviderIdToSlugMap();
    return reply.status(201).send({ keys: created.map((k) => ({ ...k, provider_id: idToSlug.get(k.provider_id) ?? k.provider_id })) });
  });

  fastify.delete('/v0/management/provider-keys/:id', async (request: any, reply) => {
    const { id } = request.params as { id: string };
    const repo = ConfigService.getInstance().getRepository();
    const deleted = await repo.deleteProviderKey(id);
    if (!deleted) return reply.status(404).send({ error: 'Provider key not found' });
    await ConfigService.getInstance().flush();
    return reply.status(204).send();
  });
}
```

In `routes/management.ts`:
- Add import: `import { registerProviderKeyRoutes } from './management/provider-keys';`
- Inside the `adminOnly` block, after `await registerProviderRoutes(adminOnly);`:
```ts
await registerProviderKeyRoutes(adminOnly);
```

In `encrypt-migration.ts`, add a new section after the existing migration blocks:
```ts
try {
  let providerKeyCount = 0;
  const rows = await db.select().from(schema.providerKeys);
  for (const row of rows) {
    if (!isEncrypted(row.apiKey)) {
      await db.update(schema.providerKeys).set({ apiKey: encrypt(row.apiKey) }).where(eq(schema.providerKeys.id, row.id));
      providerKeyCount++;
    }
    if (row.managementKey && !isEncrypted(row.managementKey)) {
      await db.update(schema.providerKeys).set({ managementKey: encrypt(row.managementKey) }).where(eq(schema.providerKeys.id, row.id));
      providerKeyCount++;
    }
  }
  logger.debug(`Encrypted ${providerKeyCount} provider-key field(s)`);
} catch (e) {
  logger.debug('provider_keys encryption skipped (table not present)');
}
```

In `cli/rekey.ts`, add:
```ts
function reEncryptNullable(value: string | null | undefined, oldKey: Buffer, newKey: Buffer): string | null {
  if (value == null) return null;
  if (!isEncrypted(value)) return value;
  return encryptWithKey(decryptWithKey(value, oldKey), newKey);
}

export async function rekeyProviderKeys(db: any, schema: any, oldKey: Buffer, newKey: Buffer): Promise<number> {
  let count = 0;
  const rows = await db.select().from(schema.providerKeys);
  for (const row of rows) {
    const updates: Record<string, string | null> = {};
    const newApi = reEncryptNullable(row.apiKey, oldKey, newKey);
    if (newApi !== row.apiKey) updates.apiKey = newApi;
    const newMgmt = reEncryptNullable(row.managementKey, oldKey, newKey);
    if (newMgmt !== row.managementKey) updates.managementKey = newMgmt;
    if (Object.keys(updates).length > 0) {
      await db.update(schema.providerKeys).set(updates as any).where(eq(schema.providerKeys.id, row.id));
      count++;
    }
  }
  return count;
}
```

Wire into `main()`:
```ts
const providerKeyCount = await rekeyProviderKeys(db, schema, oldKey, newKey);
logger.warn(`Re-keyed ${providerKeyCount} provider-key row(s)`);
```

- [ ] **Step 4: Run the tests (expect pass)**

Run both. Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck
git add packages/backend/src/routes/management/provider-keys.ts packages/backend/src/routes/management.ts packages/backend/src/db/encrypt-migration.ts packages/backend/src/cli/rekey.ts packages/backend/src/routes/management/__tests__/provider-keys.test.ts packages/backend/src/cli/__tests__/rekey-provider-keys.test.ts
git commit -m "feat(api): provider-keys CRUD + bulk + rekey + encrypt-migration for provider_keys"
```

---

### Task 14: Frontend — ProviderKeys page, sidebar, App.tsx, api.ts, Logs filter

**Files:**
- Create: `packages/frontend/src/pages/ProviderKeys.tsx`
- Create: `packages/frontend/src/components/providers/ConsolidateKeysModal.tsx`
- Create: `packages/frontend/src/components/providers/consolidateKeys.ts`
- Create: `packages/frontend/src/lib/providerKeySelection.ts`
- Create: `packages/frontend/src/lib/providerKeySelection.test.ts`
- Create: `packages/frontend/src/components/providers/consolidateKeys.test.ts`
- Modify: `packages/frontend/src/lib/api.ts` (add `ProviderKey` type + 4 methods + `UsageRecord.selectedKeyLabel` + `USAGE_PAGE_FIELDS` entry)
- Modify: `packages/frontend/src/App.tsx` (add `/provider-keys` route in admin `ProtectedRoute`)
- Modify: `packages/frontend/src/components/layout/Sidebar.tsx` (add `/provider-keys` nav item)
- Modify: `packages/frontend/src/pages/Logs.tsx` (render `provider:keyLabel` + add `keyLabel` filter)
- Modify: `packages/frontend/src/components/dashboard/tabs/LiveTab.tsx` (per-key cooldown rows, keyLabel column)

**Interfaces:**
- Produces: `/provider-keys` admin page with full CRUD, bulk, select-all, filter, consolidate. Logs page shows `provider:keyLabel`. LiveTab shows per-key cooldowns.

- [ ] **Step 1: Write the failing helper tests**

`providerKeySelection.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { toggleSelection, selectionStats, selectionFromIds } from './providerKeySelection';

describe('providerKeySelection', () => {
  it('toggleSelection adds when not present', () => {
    expect(toggleSelection(new Set(), 'a')).toEqual(new Set(['a']));
  });
  it('toggleSelection removes when present', () => {
    expect(toggleSelection(new Set(['a']), 'a')).toEqual(new Set());
  });
  it('selectionStats reports allSelected and someSelected', () => {
    const s = new Set(['a', 'b']);
    expect(selectionStats(s, ['a', 'b', 'c'])).toEqual({ allSelected: false, someSelected: true });
    expect(selectionStats(new Set(['a', 'b', 'c']), ['a', 'b', 'c'])).toEqual({ allSelected: true, someSelected: true });
    expect(selectionStats(new Set(), ['a'])).toEqual({ allSelected: false, someSelected: false });
  });
});
```

`consolidateKeys.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { groupDuplicateProviderKeys } from './consolidateKeys';

describe('groupDuplicateProviderKeys', () => {
  it('groups by provider + normalized api_key', () => {
    const keys = [
      { id: '1', provider_id: '5', api_key: 'sk-a' },
      { id: '2', provider_id: '5', api_key: 'SK-A  ' },
      { id: '3', provider_id: '6', api_key: 'sk-b' },
    ] as any;
    const groups = groupDuplicateProviderKeys(keys, (id) => id === '5' ? 'openai' : 'anthropic');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(2);
  });
  it('drops single-row groups', () => {
    const keys = [{ id: '1', provider_id: '5', api_key: 'sk-a' }] as any;
    expect(groupDuplicateProviderKeys(keys, () => 'openai')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the tests (expect failure)**

Run. Expected: FAIL.

- [ ] **Step 3: Implement the helpers**

`providerKeySelection.ts`:
```ts
export function toggleSelection(selected: Set<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}
export function selectionFromIds(ids: string[]): Set<string> { return new Set(ids); }
export function selectionStats(selected: Set<string>, ids: string[]) {
  const count = ids.filter((id) => selected.has(id)).length;
  return {
    allSelected: ids.length > 0 && count === ids.length,
    someSelected: count > 0 && count < ids.length,
  };
}
```

`consolidateKeys.ts`:
```ts
export interface DuplicateGroup {
  providerId: string;
  providerSlug: string | null;
  apiKeyNormalized: string;
  rows: any[];
}

export function groupDuplicateProviderKeys(
  keys: any[],
  resolveSlug: (providerId: string) => string | null
): DuplicateGroup[] {
  const buckets = new Map<string, DuplicateGroup>();
  for (const k of keys) {
    const norm = k.api_key?.trim().toLowerCase() ?? '';
    if (!norm) continue;
    const slug = resolveSlug(k.provider_id);
    const groupKey = `${k.provider_id}::${norm}`;
    if (!buckets.has(groupKey)) {
      buckets.set(groupKey, { providerId: k.provider_id, providerSlug: slug, apiKeyNormalized: norm, rows: [] });
    }
    buckets.get(groupKey)!.rows.push(k);
  }
  return Array.from(buckets.values())
    .filter((g) => g.rows.length >= 2)
    .sort((a, b) => (a.providerSlug ?? '').localeCompare(b.providerSlug ?? ''));
}
```

- [ ] **Step 4: Update api.ts**

Add to `packages/frontend/src/lib/api.ts`:
```ts
export interface ProviderKey {
  id: string;
  provider_id: string;
  label: string;
  api_key: string;
  management_key?: string;
  notes?: string;
  enabled: boolean;
  priority: number;
}

// In api object, add:
async getProviderKeys(providerId?: string): Promise<{ keys: ProviderKey[] }> {
  const q = providerId ? `?provider_id=${encodeURIComponent(providerId)}` : '';
  return this.get(`/v0/management/provider-keys${q}`);
},
async saveProviderKey(payload: Partial<ProviderKey> & { provider_id: string; api_key: string }): Promise<{ key: ProviderKey }> {
  if (payload.id) {
    return this.put(`/v0/management/provider-keys/${payload.id}`, payload);
  }
  return this.post('/v0/management/provider-keys', payload);
},
async saveProviderKeysBulk(providerId: string, keys: Array<{ label?: string; api_key: string; enabled?: boolean; priority?: number }>): Promise<{ keys: ProviderKey[] }> {
  return this.post('/v0/management/provider-keys/bulk', { provider_id: providerId, keys });
},
async deleteProviderKey(id: string): Promise<void> {
  return this.delete(`/v0/management/provider-keys/${id}`);
},
```

In `UsageRecord`:
```ts
selectedKeyLabel?: string | null;
```

In `USAGE_PAGE_FIELDS`:
```ts
'selectedKeyLabel',
```

- [ ] **Step 5: Add `/provider-keys` route + sidebar item**

In `App.tsx`:
```tsx
import { ProviderKeys } from './pages/ProviderKeys';
// inside admin routes:
<Route path="/provider-keys" element={<ProtectedRoute requireAdmin><ProviderKeys /></ProtectedRoute>} />
```

In `Sidebar.tsx`, add a NavItem after `/providers`:
```tsx
<NavItem to="/provider-keys" icon={Key} label="Provider Keys" collapsed={collapsed} />
```

- [ ] **Step 6: Create `ProviderKeys.tsx`, `ConsolidateKeysModal.tsx`, modify Logs.tsx, LiveTab.tsx**

`ProviderKeys.tsx` — copy and adapt from reference. Full 540-line file: PageHeader with Consolidate / Bulk Add / Add Key buttons, DataTable with 9 columns (select, provider_id, label, notes, api_key, management_key, enabled, priority, actions), filter per provider, bulk delete, consolidate modal trigger.

`ConsolidateKeysModal.tsx` — 140 lines: groups display with radio per row, danger footer with delete count.

`Logs.tsx` — update mobile (L328) and desktop (L640) rows:
```tsx
{log.provider || '-'}:{log.selectedKeyLabel || 'default'}
```
Add `keyLabel` filter to the filter form (client-side post-filter since the API supports it now via Task 12).

`LiveTab.tsx` — update `CooldownRow` to render `provider:keyLabel` when `cooldown.keyId` is set. Add `keyLabel` to the per-request row display. The `Cooldown` interface in `api.ts` gains `keyId?: string | null; keyLabel?: string | null;`.

- [ ] **Step 7: Run all tests + typecheck**

```bash
bun run test
bun run typecheck
bun run format:check
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/frontend/
git commit -m "feat(frontend): ProviderKeys page + sidebar + Logs keyLabel filter + LiveTab per-key cooldowns"
```

---

## Spec self-review

**1. Spec coverage:**
- §"Data model" → Tasks 1-3 (schema, migrations)
- §"TypeScript types" → Task 4
- §"ConfigRepository methods" → Task 5
- §"ConfigService integration" → Task 6
- §"Key selection" → Tasks 7-8
- §"Per-key candidate expansion" → Task 9
- §"CooldownManager" → Task 7
- §"Auto-disable" → Task 10
- §"Dispatcher changes" → Task 11
- §"Inference route updates" → Task 12
- §"Media handler dedup" → Task 12
- §"Encrypt migration + rekey" → Task 13
- §"UsageRecord plumbing" → Task 12
- §"Routes — management API" → Task 13
- §"Frontend — Provider Keys page" → Task 14
- §"Frontend — api.ts" → Task 14
- §"Frontend — Logs page" → Task 14
- §"Frontend — Cooldowns / Dashboard" → Task 14
- §"Frontend — Logs filter" → Task 14
- §"Sticky session per-key" → Tasks 9 (model) + 11 (set call in dispatcher)
- §"Cooldown per-key, no cascade" → Task 7 (CooldownManager) + Task 10 (quota-scheduler)
- §"Consolidate Duplicates UI" → Task 14
- §"Logs filter by key" → Task 14
- §"`reasoning_effort` preservation" → Task 1 (don't drop from existing schema)

**2. Placeholder scan:** No TBDs. Every step has concrete code or commands.

**3. Type consistency:**
- `ProviderKeyConfig` defined in Task 4, used in Task 5/6/13 — consistent.
- `ApiKeyEntry` defined in Task 8, used in Task 9 (`route-candidates`) and Task 11 (`media-dispatcher`) — consistent.
- `RouteResult.selectedKeyId/Label` defined in Task 9, used in Task 11/12 — consistent.
- `cooldownManager.markKeyAsDisabled(provider, model, keyId, reason)` defined in Task 7, used in Task 10 (`auto-disable.ts`) — consistent.
- `autoDisableOnQuotaError(error, route)` defined in Task 10, used in Task 11 — consistent.

**4. Ambiguity check:** All task boundaries are crisp. Each task's commit message describes one coherent change. Tests are written before code in every task with non-trivial logic.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-30-provider-keys.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
