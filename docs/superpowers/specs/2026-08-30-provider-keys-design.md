# Provider Keys — Design Spec

**Date:** 2026-08-30
**Status:** Draft
**Author:** Brainstorming session
**Target repo:** `F:/SYIHAB/plexus` (upstream Plexus, no provider-keys feature)
**Reference implementation:** `F:/SYIHAB/plexus-severles` (fork that developed the feature)

---

## Goal

Add **per-provider API key management** to Plexus so a single provider (OpenAI, Anthropic, OpenRouter, etc.) can be configured with **multiple API keys**, each acting as a **first-class identity** for routing, cooldowns, quota tracking, and observability.

The user-stated requirement: **each key must be treated like a different provider** for cooldown, log dashboard, and quota displays. So when you have two OpenAI keys, you see them as two distinct cooldown rows, two distinct log entries, and two distinct quota meters — not collapsed under a single "openai" bucket.

This design **improves** on the reference implementation (`plexus-severles`) by:

1. **Treating every key as a fully independent provider** for all UI surfaces (cooldowns, dashboard, logs) — not just as a sub-row of its parent provider.
2. **Unifying the dashboard model** so per-key breakdowns appear at the same level as per-provider breakdowns, not nested under them.
3. **Preserving `reasoning_effort`** from upstream `plexus` (the reference fork dropped it).
4. **Avoiding the gradual drift** that the reference implementation accumulated through 30+ commits — we ship a coherent v1.
5. **Including the `provider_keys` page in the main admin nav** as a top-level section (the reference has it under "Configuration", which buries it).

---

## Background

Currently, `plexus` (upstream) supports a **single `api_key` per provider**. The user must rotate keys by editing config and restarting. There is no failover, no per-key quota, and no per-key visibility in logs.

`plexus-severles` (the fork) developed a 7-plan, 30-commit feature over 2026-08-03 → 2026-08-05 that adds this. The fork works, but the implementation grew organically with several fix-up commits (`8aeb3b11`, `e088733e`, `0e794609`, `53db40ba`) that signal accumulated design debt. The user's instruction is to "make it better" — we use the fork as reference, not as a verbatim copy.

---

## Non-Goals (YAGNI)

- **No random / load-balanced key selection.** Always first-by-priority, deterministic. (YAGNI — the user has not asked for load balancing; failover by cooldown is enough.)
- **No per-key checker type / interval override.** Per-key quota config reuses the provider's checker type and interval; only the credentials are per-key. (Same YAGNI — matches the reference's "Approach B".)
- **No key-level UI toggle on the keys page itself.** Keys page is CRUD only; live state (cooldowns, meters) lives on the Dashboard / Cooldowns page. (Reference's choice — confirmed.)
- **No OpenAPI spec change.** Both repos currently lack a `provider_keys` OpenAPI spec entry; not adding one in v1.
- **No deprecation of legacy `api_key`.** Legacy single-key path remains valid; `api_keys` is additive. (Reference's choice — confirmed.)
- **No key-level UI toggle on the keys page itself.** Keys page is CRUD only; live state (cooldowns, meters) lives on the Dashboard / Cooldowns page. (Reference's choice — confirmed.)
- **No bulk re-prioritization UI in v1.** Bulk insert is enough; per-key priority reorder via the existing PUT endpoint.

---

## Architecture

### Mental model

**A provider key is a first-class identity**, equivalent to a provider in the routing and observability layers. The only places where it differs from a top-level provider are:

1. **CRUD surface** — keys belong to a parent provider; you don't address them by a free-form slug.

Everywhere else — quota checker IDs, cooldown rows, log entries, dashboard breakdowns, metrics Prometheus labels, sticky session — keys are fully independent. **No cooldown cascade from per-key → provider-wide.** A quota hit on key-A leaves key-B untouched. **Sticky session is per-key** — a conversation that lands on key-A stays on key-A across turns (unless that key goes on cooldown, in which case it rotates to the next healthy key for that session, just like failover to a different provider).

### Data flow

```
Management UI
  └─ POST /v0/management/provider-keys  (id, provider_id, label, api_key, management_key?, notes?, enabled, priority)
       ↓
  ConfigRepository.saveProviderKey  (encrypts api_key + management_key, upserts row)
       ↓
  ConfigService.flush()  (rebuilds in-memory config; attaches api_keys[] to providers[slug])
       ↓
  ConfigService.buildProviderQuotaConfigs  (emits {provider}:key:{keyId} quota configs alongside {provider} ones)
       ↓
  QuotaScheduler  (background; runs per-checker; per-key exhaustion writes per-key cooldown, no cascade)
       ↓
  CooldownManager  (per-key circuit-breaker only — no provider-wide cascade)
       ↓
  Incoming request → resolveRouteCandidates → expandCandidatesPerKey
       ↓
  StickySessionManager.get(alias, apiType, sessionKey)  → returns (provider, model, keyId?)
       ↓
  Router hoists sticky candidate to position 0 (with the sticky keyId preferred)
       ↓
  Dispatcher → setupProviderHeaders → selectProviderKey(route)  (picks first healthy by priority; respects sticky)
       ↓
  Stamp route.selectedKeyId, route.selectedKeyLabel
       ↓
  emitRoutingUpdate  (writes label to in-flight request_usage row)
       ↓
  upstream call  (uses key.api_key as Authorization)
       ↓
  StickySessionManager.set(alias, apiType, sessionKey, provider, model, keyId)  (after success)
       ↓
  markProviderSuccess / markProviderFailure  (keyed by provider+model+keyId)
       ↓
  Usage record  (request_usage.selected_key_label column)
       ↓
  Logs page  (renders provider:keyLabel; filterable by keyLabel)
  Dashboard  (per-key meter rows, per-key cooldown rows)
  Metrics endpoint  (per-key Prometheus labels)
```

### Cooldown (per-key, no cascade)

The CooldownManager has two keying levels:

1. **Per-model** — `provider:model` (no keyId). Set by circuit-breaker failures that don't have a keyId (legacy single-key path).
2. **Per-key** — `provider:model:keyId`. Set by circuit-breaker failures from a multi-key attempt, and by `markKeyAsDisabled` on quota errors.

**No provider-wide cascade.** When quota-scheduler detects a key-level meter hitting exhaustion, it sets the per-key cooldown slot only — not the provider-wide slot. This means key-A's quota exhaustion does not block key-B's traffic on the same provider. Each key has its own quota state, its own cooldown, and its own health.

`isProviderHealthy(provider, model, keyId)` checks ONLY the matching slot. A per-key cooldown only blocks that key; a per-model cooldown (no keyId) only applies to legacy single-key providers.

The legacy `provider:` (empty model) key slot is kept for backward compat with upstream `plexus`'s quota-scheduler path, but the per-key quota-scheduler path no longer writes to it.

---

## Components

### 1. Database schema (3 new tables / 4 new columns)

#### `provider_keys` (new table)

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | UUID |
| `provider_id` | integer FK → `providers.id` ON DELETE CASCADE | |
| `label` | text NOT NULL DEFAULT '' | Auto-filled to UUID if empty on create |
| `api_key` | text NOT NULL | Encrypted (same `enc:v1:` format as everything else) |
| `management_key` | text NULL | Encrypted; optional (used by OpenRouter quota checks) |
| `notes` | text NULL | Plain text (NOT encrypted) |
| `enabled` | integer NOT NULL DEFAULT 1 | 0/1; flipped to 0 by `markKeyAsDisabled` |
| `priority` | integer NOT NULL DEFAULT 0 | Lower = earlier; sort key for `selectProviderKey` |
| `created_at` | text NOT NULL DEFAULT now() | |
| `updated_at` | text NOT NULL DEFAULT now() | |

Index: `idx_provider_keys_lookup` on `(provider_id, enabled, priority)`.

#### `provider_cooldowns` (modified)

Add `key_id` column, change PK to `(provider, model, key_id)`. The `key_id` defaults to `''` for provider-wide / model-level rows.

Migrations use the SQLite `PRAGMA foreign_keys=OFF; CREATE TABLE __new; INSERT…; DROP; RENAME` pattern (already used in the reference).

#### `meter_snapshots` (modified)

Add `key_id` text NULL + index `idx_meter_key_checked` on `(key_id, checked_at)`.

#### `request_usage` (modified)

Add `selected_key_label` text NULL. (Keep `reasoning_effort` from upstream — both columns.)

### 2. TypeScript types

#### `ProviderKeyConfig` (`config.ts`)

```ts
export interface ProviderKeyConfig {
  id: string;
  provider_id: string;
  label: string;
  api_key: string;            // decrypted
  management_key?: string;    // decrypted; optional
  notes?: string;             // plain
  enabled: boolean;
  priority: number;
}
```

Zod schema `api_keys: z.array(z.object({...})).optional()` on `ProviderConfigSchema`.

#### `RouteResult` (`services/routing/router.ts`)

Add `selectedKeyId?: string; selectedKeyLabel?: string;` to the existing interface.

#### `MeterContext` (`services/quota/checker-registry.ts`)

Add `keyId?: string;` field. `createMeterContext` forwards it.

#### `QuotaConfig` (`config.ts`)

Add `keyId?: string;` field. `QuotaConfigSchema` accepts it.

#### `UsageRecord` (`types/usage.ts`)

Add `selectedKeyLabel?: string | null;` (keep `reasoningEffort?` from upstream).

### 3. ConfigRepository methods (`db/config-repository.ts`)

- `getAllProviderKeys(): Promise<ProviderKeyConfig[]>` — returns decrypted
- `getProviderKeys(providerId: string): Promise<ProviderKeyConfig[]>` — by numeric ID, ordered by priority
- `saveProviderKey(id, data): Promise<ProviderKeyConfig>` — upsert; encrypts api_key; preserves management_key on undefined, clears on '', encrypts on value
- `deleteProviderKey(id): Promise<boolean>` — returns affected rows > 0
- `backfillEmptyKeyLabels(): Promise<number>` — sets UUID on empty labels (called from `doRebuild`)
- `getProviderIdToSlugMap(): Promise<Map<string, string>>` — numeric id → slug for API
- `resolveProviderId(ref: string): Promise<number | undefined>` — accepts slug or numeric id
- `rowToProviderKeyConfig(row)` — private; decrypts on read

`clearAllData()`: delete `provider_keys` BEFORE `providers` (FK order).

### 4. ConfigService integration (`services/configuration/config-service.ts`)

`doRebuild` (in this order):

1. `backfillEmptyKeyLabels()` — fills empty labels with UUIDs
2. `getAllProviderKeys()` + `getProviderIdToSlugMap()`
3. Group keys by slug; filter `enabled`; sort by `priority` ascending
4. Attach `(config as any).api_keys = keys` to each `providers[slug]`

`buildProviderQuotaConfigs`:

- Emit one provider-level checker (existing behavior) — `id = providerId`
- Emit one key-level checker per enabled key — `id = "${providerId}:key:${keyId}"`, with `keyId` and `keyOptions` containing the key's `apiKey` and (trimmed) `managementKey`

### 5. Key selection (`services/providers/provider-request-headers.ts`)

```ts
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
    const healthy =
      (await cm.isProviderHealthy(route.provider, '', key.id)) &&
      (await cm.isProviderHealthy(route.provider, route.model, key.id));
    if (healthy) return key;
  }
  return undefined;
}

export function resolveSelectedKeyLabel(key: { label?: string } | undefined): string {
  const trimmed = key?.label?.trim();
  return trimmed ? trimmed : 'default';
}

export function buildAllKeysUnavailableError(provider: string, apiKeys: ApiKeyEntry[]): Error & { code?: string } {
  let cooldownCount = 0, disabledCount = 0;
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
```

`setupProviderHeaders(route, apiType, request)`:

1. Call `selectProviderKey(route)`.
2. Stamp `route.selectedKeyId` and `route.selectedKeyLabel`.
3. If no key available and `api_keys` is non-empty, throw `buildAllKeysUnavailableError(...)`.
4. Fall back to legacy `route.config.api_key` when no array — label = `'default'`.
5. Inject the chosen api_key into `Authorization` / `x-api-key` / `x-goog-api-key` based on api base type.

### 6. Per-key candidate expansion (`services/routing/route-candidates.ts`)

```ts
export function expandCandidatesPerKey(candidates: RouteResult[]): RouteResult[] {
  const out: RouteResult[] = [];
  for (const c of candidates) {
    const apiKeys: ApiKeyEntry[] = ((c.config as any).api_keys as ApiKeyEntry[]) ?? [];
    const usable = apiKeys.filter((k) => k.enabled !== false && !!k.api_key?.trim()).length;
    const clones = Math.max(1, usable);
    for (let i = 0; i < clones; i++) {
      out.push(clones === 1 ? c : { ...c });
    }
  }
  return out;
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

Wire `maybeExpandPerKey` into `resolveRouteCandidates` at both return points.

Add `failover.perKey?: z.boolean()` to `FailoverPolicySchema` (opt-out; default = on).

### 7. CooldownManager (`services/runtime/cooldown-manager.ts`)

- `makeCooldownKey(provider, model, keyId?)`: 3-segment if keyId, else 2-segment.
- `markProviderFailure(provider, model, durationMs?, lastError?, keyId?)`: add optional `keyId`. Use 3-segment key.
- `markProviderSuccess(provider, model, keyId?)`: add optional `keyId`. DB delete must scope to `keyId === ''` when no keyId is provided (preserves per-key rows from circuit-breaker failures).
- `isProviderHealthy(provider, model, keyId?)`: add optional `keyId`. Check provider-wide first, then per-key.
- `getCooldowns()`: return `keyId` per row.
- `clearCooldown(provider?, model?)`: key-aware (delete both 2-segment and 3-segment matching keys).
- `markKeyAsDisabled(provider, model, keyId, reason?)`: if no keyId (legacy path), sets per-model cooldown; if keyId, sets per-key cooldown + persists `providerKeys.enabled = 0` + calls `ConfigService.flush()`.
- `getMaxCooldownMs()`: clamp quota-scheduler injected durations.

DB primary key: `(provider, model, key_id)`. On load, retain `expiry === 0` rows (failure count survives restart).

Defense-in-depth: `markProviderFailure` skips cooldown for `DEADLINE_EXPIRED_PATTERNS` (already in upstream `plexus` — keep).

### 8. Auto-disable helper (`services/dispatch/auto-disable.ts`)

```ts
export interface AutoDisableRoute {
  provider: string;
  model: string;
  selectedKeyId?: string;
}

export function matchesQuotaError(error: any): boolean {
  const msg = (error?.message || '').toLowerCase();
  const cfg = getConfig().autoDisableOnQuotaError;
  const patterns = cfg?.errorPatterns?.filter(Boolean)?.length
    ? cfg.errorPatterns
    : QUOTA_ERROR_PATTERNS;
  const matched = patterns.some((p) => msg.includes(p.toLowerCase()));
  const status = error?.routingContext?.statusCode;
  return matched && (status === 402 || status === 400);
}

export async function autoDisableOnQuotaError(error: any, route: AutoDisableRoute): Promise<void> {
  if (!matchesQuotaError(error)) return;
  const cfg = getConfig().autoDisableOnQuotaError;
  if (!cfg?.enabled) return;
  if (cfg.mode === 'provider' && !route.selectedKeyId) {
    // Legacy path: no keyId known, fall back to per-model cooldown
    await CooldownManager.getInstance().markKeyAsDisabled(
      route.provider, route.model, undefined, `quota_exceeded: ${error?.message ?? ''}`
    );
  } else if (route.selectedKeyId) {
    // Per-key disable (preferred when a key was selected)
    await CooldownManager.getInstance().markKeyAsDisabled(
      route.provider, route.model, route.selectedKeyId, `quota_exceeded: ${error?.message ?? ''}`
    );
  }
}
```

Call sites: `request-manager.ts`, `media-dispatcher.ts` (5 media paths), `standard-attempt-request.ts`.

### 9. Dispatcher changes

- `request-manager.ts`: thread `route.selectedKeyId` to all `markProviderSuccess` / `markProviderFailure` / `markProviderStallFailure` calls.
- `media-dispatcher.ts`: call `selectProviderKey` at the start of each of 5 dispatch methods; stamp `selectedKeyId` / `selectedKeyLabel`; pass `keyId` to cooldown.
- `standard-attempt-request.ts`: emit routing update AFTER `setupHeaders` resolves the key (so the in-flight row shows the real label, not 'default').
- `dispatcher.ts`: `emitRoutingUpdate` includes `selectedKeyLabel: route.selectedKeyLabel` in the `emitUpdatedAsync` payload.
- `dispatcher.ts`: dispatcher doesn't extend cooldown on `ALL_KEYS_UNAVAILABLE` errors (state is already reflected in cooldowns).

### 10. Inference route updates (9 files)

Each of `chat.ts`, `completions.ts`, `embeddings.ts`, `gemini.ts`, `images.ts`, `messages.ts`, `responses.ts`, `speech.ts`, `transcriptions.ts`:

- After dispatch, copy `unifiedResponse.plexus?.selectedKeyLabel` into both:
  - The `emitUpdatedAsync` call (so the in-flight row carries it)
  - The `usageRecord` (so the persisted row carries it)
- Handle the `ALL_KEYS_UNAVAILABLE` error code in the catch block (return 503 with explanatory body).

### 11. Media handlers — dedup catch blocks (`routes/inference/_quota-error.ts`)

Extract the duplicated 19-line catch block (from upstream `plexus` and reference `plexus-severles`) into `handleApiError(e, apiType, logMessage, usageRecord, usageStorage, requestId, startTime, reply)` and `recordQuotaUsageForResponse(...)`. All 5 media handlers call these.

### 12. Encrypt migration + rekey (`db/encrypt-migration.ts` + `cli/rekey.ts`)

- `encrypt-migration.ts`: encrypt plaintext `apiKey` and `managementKey` columns in `provider_keys` on startup if not already encrypted.
- `cli/rekey.ts`: add `rekeyProviderKeys(db, schema, oldKey, newKey)` — re-encrypts both `apiKey` and `managementKey`. Use the null-safe `reEncryptNullable` helper to avoid the null-crash bug fixed in reference commit `0e794609`. Wire into `main()`.

### 13. UsageRecord plumbing (`services/observability/usage-storage.ts`)

- `emitStarted`: write `selectedKeyLabel` to in-flight row.
- `emitUpdated`: include `selectedKeyLabel` in update SET.
- `getUsage` SELECT: add `selectedKeyLabel: schema.requestUsage.selectedKeyLabel`.
- `getUsage` mapping: add `selectedKeyLabel: row.selectedKeyLabel`.

### 14. Routes — management API

New file: `routes/management/provider-keys.ts` (260 lines, with these endpoints):

- `GET /v0/management/provider-keys?provider_id=<slug>`
- `POST /v0/management/provider-keys` (create; auto-fills label with UUID if empty; 201)
- `PUT /v0/management/provider-keys/:id` (partial update)
- `POST /v0/management/provider-keys/bulk` (create many; 201)
- `DELETE /v0/management/provider-keys/:id` (204)

`resequenceProviderKeys(repo, providerId, targetId, position)` — private helper that re-numbers priorities 1..N when a key is inserted or reordered.

Wire into `routes/management.ts` inside the `adminOnly` block (authenticate + requireAdmin preHandlers).

### 15. Frontend — Provider Keys page

New page: `pages/ProviderKeys.tsx` (540 lines). CRUD + bulk + filter per provider + checkbox select + delete selected + consolidate duplicates.

New components:
- `components/providers/ConsolidateKeysModal.tsx` (140 lines) — modal for choosing which duplicate to keep
- `components/providers/consolidateKeys.ts` (50 lines) — `groupDuplicateProviderKeys` helper
- `lib/providerKeySelection.ts` (20 lines) — selection set helpers

Add `/provider-keys` route to `App.tsx` (inside admin `ProtectedRoute`).
Add sidebar nav entry: `Key` icon, label "Provider Keys", positioned in the main admin section (top-level — not buried in "Configuration").

### 16. Frontend — api.ts type & method additions

- `interface ProviderKey { id; provider_id; label; api_key; management_key?; notes?; enabled; priority }`
- `api.getProviderKeys()`, `api.saveProviderKey()`, `api.saveProviderKeysBulk()`, `api.deleteProviderKey()`
- `UsageRecord.selectedKeyLabel?: string | null`
- `USAGE_PAGE_FIELDS` includes `'selectedKeyLabel'`

### 17. Frontend — Logs page

Render `${log.provider || '-'}:${log.selectedKeyLabel || 'default'}` in both mobile (L328) and desktop (L640) rows.

Add a `keyLabel` filter to the Logs filter form (optional, simple text filter — since the API doesn't currently support it, do client-side filter after fetching).

### 18. Sticky session per-key (`services/routing/sticky-session-manager.ts`)

`StickyEntry` gains `keyId?: string`. `set()` accepts an optional `keyId`; `get()` matches `(alias, apiType, sessionKey) → StickyEntry` and returns the stored `(provider, model, keyId)`. The router hoists the sticky pick to position 0 of the candidate list when one matches.

If the stored key is on cooldown when the next request arrives, the normal failover path runs — the sticky key is tried first (and skipped if unhealthy), then the other candidate clones are tried. Once a different key wins, the sticky entry is updated. So per-key sticky = "stay on the same key as long as it's healthy; if it goes on cooldown, failover to the next key for THIS session and stick there."

This is different from the reference implementation, which stuck at `(provider, model)` and let keys rotate silently. The user-stated intent — "treat each key as a different provider" — implies per-key stickiness, so the next turn of a Claude-Code conversation that landed on key-A stays on key-A (until key-A breaks).

The sticky keyId is stored in `StickySessionManager`'s in-memory map (already a singleton, persisted across the process lifetime — does not survive restarts, by design).

### 19. Frontend — Cooldowns / Dashboard

The user's requirement: **each key appears separately in the dashboard**.

- `api.Cooldown` interface gains `keyId?: string | null` and `keyLabel?: string | null` (populated by backend).
- The cooldowns list in the LiveTab / Cooldowns page renders one row per (provider, model, keyId) triple. The "Provider" column shows `provider:keyLabel` for key-level rows.
- The "Clear cooldown" action is per-row (not per-provider).
- The `ProviderKeys` page also surfaces disabled keys (read from `providerKeys` table via `getProviderKeys`) with a "Re-enable" button that calls PUT with `enabled: true`.
- (Optional, defer to v2) Per-key meter snapshot view on a dedicated `/quotas/:checkerId` page — already supported by `MeterCheckResult.keyId` plumbing; just needs UI.

### 20. Frontend — Logs filter

Add `keyLabel` to the Logs filter form. Backend filter support is a one-line addition to `usageStorage.getUsage` filters and `USAGE_FIELDS` whitelist — include in the same task as the Logs page change.

---

## Data flow examples

### Example 1: Create a new key

```
User clicks "Add Key" on /provider-keys
  ↓
Modal collects: provider=openai, label="prod-key-2", api_key="sk-...", management_key="" (optional), priority=2
  ↓
api.saveProviderKey({ provider_id: "openai", label: "prod-key-2", api_key: "sk-...", priority: 2 })
  ↓
POST /v0/management/provider-keys
  ↓
route handler:
  - resolveProviderId("openai") → 5
  - ensureLabel("prod-key-2") = "prod-key-2" (non-empty)
  - saveProviderKey(uuid, { provider_id: "5", label: "prod-key-2", api_key: "sk-...", priority: 2 })
      - encrypts api_key
      - INSERTs row
  - resequenceProviderKeys(5, newId, 1)  // position 1 = priority 2
  - configService.flush()  // rebuild cache
  ↓
Response: { key: { id, provider_id: "openai", label: "prod-key-2", ..., priority: 2 } }
  ↓
UI reloads; new key appears in table
```

### Example 2: Request hits a provider with 3 keys, key #2 on cooldown

```
Incoming request → Router.resolveCandidates → [openai:gpt-4, anthropic:claude-3, ...]
  ↓
applyKeyAccessPolicy → 3 candidates
  ↓
quota filter → 3 candidates
  ↓
maybeExpandPerKey → openai's candidate is cloned 3 times (one per key)
  → [openai:gpt-4 (key 1), openai:gpt-4 (key 2), openai:gpt-4 (key 3), anthropic:claude-3]
  ↓
Dispatch loop:
  Attempt 1: openai:gpt-4 (key 1)
    - selectProviderKey → priority-sorted: [1, 2, 3]; key 1 is healthy → use key 1
    - stamp route.selectedKeyId = "key-1", route.selectedKeyLabel = "key-1"
    - emitRoutingUpdate (writes "key-1" to in-flight row)
    - upstream call → 500 Internal Server Error
    - markProviderFailure("openai", "gpt-4", undefined, "...", "key-1") (per-key cooldown, keyId="key-1")
  Attempt 2: openai:gpt-4 (key 2)
    - selectProviderKey → key 1 now on cooldown; key 2 next by priority
    - stamp route.selectedKeyId = "key-2", route.selectedKeyLabel = "key-2"
    - upstream call → 200 OK
    - markProviderSuccess("openai", "gpt-4", "key-2")
  ↓
Response returned to client
  ↓
Usage record: request_usage { provider: "openai", selected_model_name: "gpt-4", selected_key_label: "key-2", ... }
```

### Example 3: All 3 keys exhausted, failover to next provider

```
Attempts 1-3: openai all keys fail
  Attempt 3 fails with ALL_KEYS_UNAVAILABLE
  ↓
Attempt 4: anthropic:claude-3
  - selectProviderKey → 1 key, healthy → use it
  - success
```

If all candidates exhausted, the dispatcher returns 503 with a body listing which providers/keys were tried.

### Example 4: Auto-disable on quota error (mode: 'key')

```
Attempt 1: openai:key-2
  - upstream returns 402 with body containing "insufficient_quota"
  - markProviderFailure(..., "key-2")
  - autoDisableOnQuotaError called:
    - matchesQuotaError → true (status 402, message matches QUOTA_ERROR_PATTERNS)
    - mode: 'key' → markKeyAsDisabled("openai", "gpt-4", "key-2", "quota_exceeded: insufficient_quota")
      - markProviderFailure("openai", "gpt-4", undefined, reason, "key-2") (per-key cooldown)
      - UPDATE provider_keys SET enabled = 0 WHERE id = "key-2"
      - ConfigService.flush() (rebuild; key-2 now filtered out of api_keys)
  ↓
Next request: selectProviderKey skips key-2 (enabled=false), uses key-1 or key-3
```

---

## Error handling

### Per-attempt errors

- `ALL_KEYS_UNAVAILABLE` (custom code, not a real HTTP status): thrown by `setupProviderHeaders` when `api_keys` is non-empty but no key is healthy. The dispatcher catches it, skips cooldown extension (state is already reflected in cooldowns), and moves to the next target.
- `DEADLINE_EXPIRED_PATTERNS`: defense-in-depth guard in `markProviderFailure` — skip cooldown for `'deadline expired'`, `'deadline_exceeded'`, `'deadline exceeded'` errors.

### Stream errors (OpenRouter 429 etc.)

Already implemented in upstream `plexus` (commit `12eda2ba`): `parseInitialStreamError` inspects the first chunk, `Retry-After` header parsed first, then `parseCooldownDurationForProvider`. Per-key cooldown stamped with the parsed duration. **No new work.**

### Auto-disable errors

`matchesQuotaError` requires BOTH a message pattern match AND `statusCode === 402 || 400`. So a 429 with "quota exceeded" in the body won't auto-disable (it'll go through normal circuit-breaker cooldown instead). This is intentional — auto-disable is for "the provider won't serve us anymore" (payment failure), not for "rate-limited us for a moment."

---

## Testing

### Unit tests (in `__tests__/` alongside source)

| File | Coverage |
|---|---|
| `services/providers/__tests__/provider-request-headers.test.ts` | selectProviderKey priority, cooldown skipping, disabled skipping, empty api_key, `ALL_KEYS_UNAVAILABLE` error code, label = 'default' for legacy |
| `services/routing/__tests__/route-candidates-per-key.test.ts` | expandCandidatesPerKey, maybeExpandPerKey, opt-out via `failover.perKey: false` |
| `services/runtime/__tests__/cooldown-manager.test.ts` | 3-segment key, expiry=0 retention, markProviderSuccess keyId scoping (per 8aeb3b11 fix), markKeyAsDisabled persists `enabled=0` and flushes ConfigService |
| `services/dispatch/__tests__/auto-disable.test.ts` | matchesQuotaError, mode: 'key' / 'provider', warn-log gating, status-code requirement |
| `services/__tests__/config-service.test.ts` | api_keys attached to providers, per-key quota configs emitted with correct keyId + keyOptions (apiKey + managementKey) |
| `db/__tests__/config-repository-provider-keys.test.ts` | saveProviderKey, getAllProviderKeys, getProviderKeys, deleteProviderKey, management_key round-trip, `backfillEmptyKeyLabels` |
| `cli/__tests__/rekey.test.ts` | rekeyProviderKeys null-crash, plaintext skip, both-fields update in single UPDATE |
| `routes/management/__tests__/provider-keys.test.ts` | full CRUD via Fastify `inject()`, slug-vs-numeric-id resolution, bulk, 404/400 paths |
| `services/dispatch/__tests__/standard-attempt-request.test.ts` | emitRoutingUpdate fires AFTER setupHeaders, includes selectedKeyLabel |
| `services/quota/checkers/__tests__/openrouter-checker.test.ts` | managementKey takes precedence over apiKey |
| `frontend/src/lib/providerKeySelection.test.ts` | toggleSelection, selectionStats edge cases |
| `frontend/src/components/providers/consolidateKeys.test.ts` | groupDuplicateProviderKeys (case-insensitive, trimmed, >= 2 rows per group) |

### Integration verification

Run the `frontend-testing` skill to boot the worktree-safe dev stack and drive the browser. Verify:

1. Add a key via UI → see it in the table
2. Disable a key → next request uses a different key
3. Force a key into cooldown → see "key-1 on cooldown" in the Cooldowns panel
4. Trigger a quota error → see the key flip to disabled
5. Logs page shows `provider:keyLabel` per row
6. Clear a per-key cooldown → request uses that key again

### Type check + format

`bun run typecheck` and `bun run format:check` must pass.

---

## Spec self-review

- **Placeholder scan:** No TBDs.
- **Internal consistency:** Architecture, components, data flow, and testing sections all align.
- **Scope check:** This is a large feature (10+ subsystems touched), but it's a coherent v1 — porting the whole thing at once avoids the 30-commit drift the reference accumulated. The implementation plan will break it into ordered tasks.
- **Ambiguity check:** Naming follows reference's lock-in convention (camelCase TS, snake_case DB/API). The reference's exact convention is documented in the conventions section.

---

## Design decisions (confirmed with user)

1. **Sticky session with keys** — **PER-KEY**. `StickyEntry.keyId?` is stored; next turn of the same session sticks to the same key (until that key goes on cooldown, then it rotates to the next healthy key for that session and sticks there).

2. **Cooldown cascade** — **PER-KEY, no cascade**. Quota exhausted on key-A only sets `${provider}:${model}:${keyA}`; key-B and other keys on the same provider are unaffected. `quota-scheduler` writes per-key cooldowns when a key-level checker detects exhaustion (not the provider-wide slot).

3. **Consolidate Duplicates UI** — include in v1.

4. **Logs filter by key** — include in v1.

5. **`reasoning_effort` preservation** — keep it (additive — upstream `plexus` had it, reference dropped it).

---

## Rollout

- All migrations are additive (new tables / new columns / new index). Existing data is preserved.
- Legacy single-`api_key` path remains valid. Users with no `provider_keys` rows see no behavior change.
- The `provider_keys` table is created empty. Users opt in by creating keys.
- ConfigService flushes immediately on every CRUD write, so changes are live without restart.
- `backfillEmptyKeyLabels` runs once at startup; idempotent.

No feature flag needed — the legacy path is the safe default for users who don't create any keys.

---

## What's deferred to v2

- Random / load-balanced key selection
- Per-key checker type / interval override
- Per-key sticky session
- Per-key meter snapshot UI (data is in `MeterCheckResult.keyId` already)
- Per-key Prometheus labels (currently grouped only by provider and model)
- OpenAPI spec for `/v0/management/provider-keys`
