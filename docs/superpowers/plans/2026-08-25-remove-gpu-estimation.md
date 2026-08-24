# Remove GPU Estimation Features (Energy, Memory, Latency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the three GPU-based estimation features — energy calculator, memory estimation (tensor parallelism / concurrency), and latency estimation (prefill/decode TPS) — along with every input chain (GPU profiles + model architecture), output (kW/h accounting), and consumer, leaving the repo green and docs consistent.

**Architecture:** Delete top-down from leaf consumers to shared root so the repo keeps compiling after every task: frontend UI first, then the backend estimation core and its callers, then config/DB schema, then the HF model-params chain, then the shared module, then docs. DB columns are removed from the Drizzle schema only; migration artifacts are generated for validation but never committed (CI generates them post-merge).

**Tech Stack:** Bun, Fastify, Drizzle ORM (SQLite + Postgres), Zod, React (Tailwind v4), openapi docs (Redocly).

**Spec:** Collaborative scope agreed in brainstorming: remove `kwhUsed` accounting entirely (including provider-reported energy) and remove the whole `model_architecture` / HuggingFace model-params chain. `neuralwatt-checker.ts` is a quota checker reading `kwh_used` from the provider subscription payload — **out of scope, keep it**.

## Global Constraints

- **Migration rules (from `db-schema-migrations` skill):** edit schema `.ts` files in `packages/backend/drizzle/schema/{sqlite,postgres}/`. Validate with `bun run generate-migrations --name remove_gpu_estimation`. Do NOT commit created migration artifacts (pre-commit hook blocks them; CI generates after merge). NEVER edit existing migration files.
- **Tests:** unit tests in `__tests__/` beside source; run with `bun run test` (commands run from repo root: `bun run test` = backend tests). `bun test` direct is blocked.
- **Verification:** `bun run typecheck`, `bun run test`, `bun run format:check` at repo root after every task. Frontend build: `bun run build:frontend`.
- **Frontend verify (AGENTS.md):** any user-visible change must be driven in a real browser via the `frontend-testing` skill before the PR. Final task covers this.
- **Never use `--no-verify`. Commit only when the executor is explicitly asked.**
- **Working tree:** the branch currently carries in-progress MCP/CLI removal. Commit that coherent work first (Task 0) so this plan's commits stay isolated.

---

### Task 0: Baseline and branch isolation

**Files:**
- Directories: `.` (repo root)

- [ ] **Step 1: Commit or set aside the in-progress MCP/CLI removal**

Run:
```bash
git status --short | head -60
```
If the MCP/CLI deletions look coherent (they are the branch topic `chore/remove-cli-and-mcp`), commit them:

```bash
git add -A && git commit -m "chore: continue MCP/CLI removal (working tree cleanup)"
```
If the user wants this plan applied separately, create a branch first from `main`:
```bash
git switch main && git checkout -b chore/remove-gpu-estimation
```
Otherwise work on the current branch.

- [ ] **Step 2: Record a green baseline**

Run:
```bash
bun run typecheck
bun run test
```
Expected: PASS. If the working tree was mid-removal with red state, fix/commit it before proceeding — the executor must start from green.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: baseline before GPU estimation removal" || true
```
(Only if Step 1 didn't already commit everything.)

---

### Task 1: Frontend — remove energy, GPU-profile, and model-architecture UI

**Files:**
- Modify: `packages/frontend/src/components/providers/ProviderAdvancedEditor.tsx` (GPU dropdown ~1270-1335; custom GPU fields ~1475-1535; imports line 8)
- Delete: `packages/frontend/src/components/providers/ProviderGpuProfileEditor.tsx` (dead component — grep confirms zero imports)
- Modify: `packages/frontend/src/components/models/ModelBehaviorsEditor.tsx` (import line 6, usage line 129)
- Delete: `packages/frontend/src/components/models/ModelArchitectureEditor.tsx`
- Delete: `packages/frontend/src/components/TotalEnergyComparison.tsx`
- Modify: `packages/frontend/src/components/dashboard/tabs/UsageTab.tsx` (import line 40, energy state ~118-119, usage line 725)
- Modify: `packages/frontend/src/pages/Logs.tsx` (imports lines 19-24, energy display ~978-986)
- Modify: `packages/frontend/src/components/dashboard/tabs/LiveTab.tsx` (line 641 `kwhUsed: 0`)
- Modify: `packages/frontend/src/lib/format.ts` (lines 3, 253-280: `KWH_PER_SLICE`, `formatEnergy`, `formatSlices`)
- Modify: `packages/frontend/src/lib/api.ts` (types 147, 157, 242, 417, 523, 541, 551; aggregates 711, 784, 807, 822, 861, 1304, 1364, 1374-1387, 1450, 1463, 1474, 1488; request payloads 1174, 1989-1990, 2245)

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: `api.ts` `UsageRecord`/`UsageSummary`/`Provider`/`Alias` types without `kwhUsed`, `gpu_profile`, `model_architecture`; `format.ts` without energy helpers.

- [ ] **Step 1: Remove the GPU profile section from ProviderAdvancedEditor.tsx**

Delete the GPU profile dropdown block (starts at `{/* GPU Profile */}` / the label "GPU Profile", through the `select` mapped on `GPU_PROFILE_OPTIONS` around lines 1270-1335) and the *Custom GPU fields* block (starts at `{editingProvider.gpu_profile === 'custom' && (` around line 1488, through its closing `}` ~1530). Then remove line 8:

```ts
import { GPU_PROFILE_OPTIONS, resolveGpuParams } from '@plexus/shared';
```
and any handler lines that only served those blocks (`handleGpuProfile`, `handleGpuField`, etc. — run `bun run typecheck`, any unused-import/variable error names them).

- [ ] **Step 2: Delete the dead GPU profile component**

```bash
git rm packages/frontend/src/components/providers/ProviderGpuProfileEditor.tsx
```

- [ ] **Step 3: Remove ModelArchitectureEditor from alias editing**

In `ModelBehaviorsEditor.tsx` remove line 6:

```ts
import { ModelArchitectureEditor } from './ModelArchitectureEditor';
```
and the render at line 129:

```tsx
<ModelArchitectureEditor editingAlias={editingAlias} setEditingAlias={setEditingAlias} />
```
Then delete the component:
```bash
git rm packages/frontend/src/components/models/ModelArchitectureEditor.tsx
```

- [ ] **Step 4: Delete TotalEnergyComparison and its use**

```bash
git rm packages/frontend/src/components/TotalEnergyComparison.tsx
```
In `UsageTab.tsx` remove line 40 (`import { TotalEnergyComparison } from '../../TotalEnergyComparison';`), the `energySummary` state at lines 118-120, and the render at line 725:
```tsx
<TotalEnergyComparison totalKwh={energySummary?.totalKwhUsed} />
```

- [ ] **Step 5: Remove the energy toast-slices display from Logs.tsx**

Remove the energy block near lines 978-986 — the conditional line starting `log.kwhUsed != null && log.kwhUsed > 0 ? \`Energy: ${formatEnergy(log.kwhUsed)} ...` plus its wrapping `<span>`/tooltip style logic and the `kwhUsed` ternary on `cursor`. Remove imports at lines 19-24:
```ts
import { KWH_PER_SLICE, formatEnergy, formatSlices } from '../lib/format';  // line 19 = KWH_PER_SLICE, 22 = formatEnergy, 24 = formatSlices
```
(keep `formatDuration` and any other format imports).

- [ ] **Step 6: Remove energy helpers from format.ts**

Delete `KWH_PER_SLICE` (line 3), `formatEnergy` (lines 253-263), `formatSlices` (lines 265-280). Keep `formatDuration` — `TotalEnergyComparison` was its only other consumer, but confirm with: `grep -rn "formatDuration" packages/frontend/src --include=*.tsx --include=*.ts` — if other callers exist it stays, otherwise remove it too.

- [ ] **Step 7: Remove kwhUsed from LiveTab default record**

In `LiveTab.tsx` delete the `kwhUsed: 0,` line at 641 (part of the default live-record object).

- [ ] **Step 8: Remove GPU / model_architecture / kwhUsed from api.ts**

Remove all of the following (line anchors from current tree; re-locate via `grep -n`):
- `kwhUsed: number;` in usage-related interfaces (147, 157) and `kwhUsed?: number;` (523, 541)
- interface fields `gpu_profile?: string;` (242) and the `model_architecture?: { ... };` block (417)
- `totalKwhUsed: number;` in `UsageSummary` (551)
- `'kwhUsed'` in select-columns arrays (711, 1450)
- `kwhUsed: 0,` / `kwhUsed: point?.kwhUsed || 0,` / `kwhUsed: point.kwhUsed,` object literals (784, 807, 822, 861, 1304, 1364, 1463, 1474, 1488) and the accumulator `grouped[key].kwhUsed += record.kwhUsed || 0;` (822)
- the `getEnergySummary`/`getTotalEnergy` helper (1374-1387, returns `{ totalKwhUsed }`)
- alias write payload spread `...(alias.model_architecture && { model_architecture: alias.model_architecture }),` (1174) and `model_architecture: val.model_architecture,` (2245)
- provider write payload `...(provider.gpu_profile ? { gpu_profile: provider.gpu_profile } : {}),` (1989-1990)

- [ ] **Step 9: Verify**

Run:
```bash
bun run typecheck
bun run build:frontend
```
Expected: PASS, no references to removed identifiers. Grep to confirm zero survivors:
```bash
grep -rn "kwhUsed\|gpu_profile\|GPU_PROFILE\|model_architecture\|TotalEnergyComparison\|formatEnergy" packages/frontend/src --include=*.ts --include=*.tsx
```
Expected: no matches.

- [ ] **Step 10: Commit**

```bash
git add -A && git commit -m "feat(frontend): remove GPU estimation UI (energy, GPU profile, model architecture)"
```

---

### Task 2: Backend — delete the estimation core and all its callers

**Files:**
- Delete: `packages/backend/src/services/observability/inference-energy.ts`
- Delete: `packages/backend/src/services/__tests__/inference-energy.test.ts`
- Modify: `packages/backend/src/services/inspectors/usage-logging.ts` (imports 1, 16; fields 115-116; constructor params 129, 144; kwhUsed block 268-282)
- Modify: `packages/backend/src/services/responses/response-handler.ts` (403-404; kwhUsed block 782-795)
- Modify: `packages/backend/src/services/vision/vision-descriptor-service.ts` (import 14; block 226-233)
- Modify: `packages/backend/src/services/observability/usage-storage.ts` (674, 735; `recalculateEnergyForAlias` ~1080-1126)
- Modify: `packages/backend/src/services/dispatch/attempt-history.ts` (85-92)
- Modify: `packages/backend/src/types/unified.ts` (270-271)
- Modify: `packages/backend/src/types/usage.ts` (57)

**Interfaces:**
- Consumes: Task 1 removed frontend consumers. Shared `@plexus/shared` still exports GPU/model types (removed later in Task 6) — do not touch shared yet.
- Produces: `UsageRecord` typed without recomputing `kwhUsed`; `recalculateEnergyForAlias` method on `UsageStorageService` removed; `PlexusInferenceMetadata` (unified.ts) without `gpuParams`/`modelParams`.

- [ ] **Step 1: Delete the estimation module and its test**

```bash
git rm packages/backend/src/services/observability/inference-energy.ts
git rm packages/backend/src/services/__tests__/inference-energy.test.ts
```

- [ ] **Step 2: Strip energy from UsageInspector (usage-logging.ts)**

Remove imports of `ModelParams, GpuParams` type (line 1) and `estimateKwhUsed` (line 16). Remove fields (115-116):
```ts
  private modelParams: ModelParams;
  private gpuParams: GpuParams;
```
Remove constructor params `modelParams: ModelParams = DEFAULT_MODEL,` and `gpuParams: GpuParams = DEFAULT_GPU_PARAMS,` (129-130) — the default-arg semantics: these constructor lines are `modelParams: ModelParams = DEFAULT_MODEL,`. Delete them and the field assignments `this.modelParams = modelParams;` / `this.gpuParams = gpuParams;` (~144-146). Then delete the whole kwhUsed computation block (~268-282):

```ts
        const energyKwh = Number(reconstructed.providerReportedEnergy.energy_kwh);
        if (!isNaN(energyKwh) && energyKwh >= 0) {
          this.usageRecord.kwhUsed = Number(energyKwh.toFixed(10));
        } else {
          this.usageRecord.kwhUsed = estimateKwhUsed(
            ...,
            this.modelParams,
            this.gpuParams
          );
        }
```
(Exact text from lines 268-282 — delete it wholesale; the `this.usageRecord` object keeps no `kwhUsed` write anywhere.)

- [ ] **Step 3: Strip energy from response-handler.ts**

At lines 403-404 the inspector is constructed with GPU/model params — remove the last two arguments so construction matches the new `UsageInspector` signature:
```ts
      unifiedResponse.plexus?.gpuParams ?? DEFAULT_GPU_PARAMS,
      unifiedResponse.plexus?.modelParams ?? DEFAULT_MODEL,
```
Delete lines 782-795 — the `providerReportedEnergy` reconstruction and the `estimateKwhUsed(..., plexusGpuParams)` fallback writing `usageRecord.kwhUsed`. Remove now-unused imports: `DEFAULT_GPU_PARAMS`, `DEFAULT_MODEL`, `estimateKwhUsed` (check line 18-30 import block; `bun run typecheck` names any stragglers).

- [ ] **Step 4: Strip energy from vision-descriptor-service.ts**

Remove import line 14 (`import { estimateKwhUsed } from '../observability/inference-energy';`). Remove lines 226-233 — the inverted block that computed `usageRecord.kwhUsed = estimateKwhUsed(...)` and its `DEFAULT_MODEL` / `DEFAULT_GPU_PARAMS` fallbacks (the surrounding descriptor content-building stays; only the kwhUsed assignment and its closures go).

- [ ] **Step 5: Remove recalculateEnergyForAlias from usage-storage.ts**

Remove the `kwhUsed: schema.requestUsage.kwhUsed,` (674) and `kwhUsed: row.kwhUsed,` (735) keys from the record serializer/reader. Remove the entire `recalculateEnergyForAlias` method: locate by `grep -n "recalculateEnergyForAlias\|estimateKwhUsed\|resolveModelParams" packages/backend/src/services/observability/usage-storage.ts` — delete the method body (the batch loop spanning ~1080-1126 shown below) plus its `readOnly` column selector including `kwhUsed` and the now-unused imports (`DEFAULT_GPU_PARAMS`, `estimateKwhUsed`, `resolveModelParams`, `eq` if unused elsewhere):

```ts
      recalculateEnergyForAlias(
        aliasId: string,
        modelArchitecture: ModelArchitecture,
        providerGpuParams?: Record<string, GpuParams>
      ) {
        // ... batch update loop setting kwhUsed (lines ~1080-1126)
      }
```

- [ ] **Step 6: Strip gpuParams/modelParams from attempt history annotation**

In `attempt-history.ts` remove lines 85-92 (the `gpuParams: {...}` object and `modelParams: resolveModelParams(finalRoute.modelArchitecture),`). Remove now-unused imports (`DEFAULT_GPU_PARAMS`, `resolveModelParams`). `finalRoute.modelArchitecture`/`config.gpu_*` reads disappear with the lines.

- [ ] **Step 7: Strip gpuParams/modelParams from unified.ts and kwhUsed from usage.ts**

In `packages/backend/src/types/unified.ts` remove lines 270-271:
```ts
    gpuParams?: import('@plexus/shared').GpuParams;
    modelParams?: import('@plexus/shared').ModelParams;
```
In `packages/backend/src/types/usage.ts` remove line 57 (`kwhUsed?: number | null;`).

- [ ] **Step 8: Verify**

Run:
```bash
bun run typecheck
bun run test
```
Expected: PASS. Grep for survivors:
```bash
grep -rn "estimateKwhUsed\|calculateInferenceFootprint\|getInferenceFootprint\|inference-energy\|recalculateEnergyForAlias\|DEFAULT_GPU_PARAMS" packages/backend/src --include=*.ts
```
Expected: no matches outside `neuralwatt-checker.ts`'s own payload field comments (that file uses `kwh_used` from provider data — leave it). If `usage-logging.test.ts` / `response-handler` tests assert `kwhUsed`, update those assertions to delete the energy assertions (the record shape no longer includes the field).

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(backend): remove energy/memory/latency estimation and kwhUsed writes"
```

---

### Task 3: Backend — remove kwhUsed aggregation from usage and metrics routes

**Files:**
- Modify: `packages/backend/src/routes/management/usage.ts` (44; 325, 345, 368, 386, 398, 411, 425, 436)
- Modify: `packages/backend/src/routes/management/metrics.ts` (202, 218, 236, 256, 441, 454, 504, 557, 694, 748)
- Modify: `packages/backend/src/routes/management/__tests__/usage-summary.test.ts` (34-110)
- Modify: `packages/backend/drizzle/schema/sqlite/request-usage.ts` (61)
- Modify: `packages/backend/drizzle/schema/postgres/request-usage.ts` (60)

**Interfaces:**
- Consumes: `UsageRecord` without `kwhUsed` (Task 2).
- Produces: `GET /v0/management/usage/summary` and energy metrics time-series responses without `kwhUsed`/`totalKwhUsed`/energy series keys.

- [ ] **Step 1: Remove kwhUsed from usage routes**

In `management/usage.ts`:
- line 44: remove `'kwhUsed',` from the select-columns array
- lines 325, 345, 368: remove the `kwhUsed: sql<number>\`COALESCE(SUM(...kwhUsed), 0)\`,` keys from summary/series/today objects
- lines 386, 398: remove `kwhUsed: 0,` fallback keys
- line 411: remove `kwhUsed: toNumber(row.kwhUsed),`
- lines 425, 436: remove `totalKwhUsed: toNumber(...)` / `kwhUsed: toNumber(...)` from the stats response (keep other totals)

- [ ] **Step 2: Remove kwhUsed from metrics routes**

In `management/metrics.ts`, for every line in the list (202, 218, 236, 256, 441, 454, 504, 557, 694, 748), remove the `kwhUsed:` aggregate/datum key. Lines 694/748 are inside per-alias energy data points — remove just the `kwhUsed` datum so the builder emits the same series minus energy.

- [ ] **Step 3: Update usage-summary tests**

In `routes/management/__tests__/usage-summary.test.ts`, change the test "aggregates kwhUsed in summary series buckets" to "aggregates token totals in summary series buckets": remove every `kwhUsed` fixture value (55, 66, 77), the `kwhUsed` expectations on series buckets and `today` (104-110), and the `series`/`totalKwhUsed` type fields (89-91). The endpoints now return tokens/requests; assert those instead.

- [ ] **Step 4: Remove the DB column from the Drizzle schema**

Remove `kwhUsed: real('kwh_used'),` from:
- `packages/backend/drizzle/schema/sqlite/request-usage.ts` (line 61)
- `packages/backend/drizzle/schema/postgres/request-usage.ts` (line 60)

- [ ] **Step 5: Validate migration generation (do NOT commit artifacts)**

Run:
```bash
bun run generate-migrations --name remove_gpu_estimation
```
Expected: generates a migration dropping `kwh_used` from `request_usage` (sqlite + postgres). Review the SQL reads `ALTER TABLE ... DROP COLUMN kwh_used`. Leave the generated files in place; the pre-commit hook will keep them out of the commit.

- [ ] **Step 6: Verify and commit**

Run:
```bash
bun run typecheck
bun run test
```
Expected: PASS. Commit:
```bash
git add -A && git commit -m "feat(backend): drop kwh_used from usage/metrics aggregation and DB schema"
```

---

### Task 4: Backend — remove GPU + model_architecture config, repository logic, and provider/alias DB columns

**Files:**
- Modify: `packages/backend/src/config.ts` (import 5; 308-315; 649; 941-963)
- Modify: `packages/backend/src/db/config-repository.ts` (import 25; 459; 714-752; 1006; 1154)
- Modify: `packages/backend/src/routes/management/config.ts` (import 22; 86-135; 326-328; 364-366)
- Modify: `packages/backend/drizzle/schema/sqlite/providers.ts` (35-40)
- Modify: `packages/backend/drizzle/schema/postgres/providers.ts` (45-50)
- Modify: `packages/backend/drizzle/schema/sqlite/model-aliases.ts` (15)
- Modify: `packages/backend/drizzle/schema/postgres/model-aliases.ts` (34)

**Interfaces:**
- Consumes: `@plexus/shared` still exports `VALID_GPU_PROFILES`/`resolveGpuParams` (removed Task 6) — this task stops importing them.
- Produces: `ProviderConfig` without `gpu_profile`/`gpu_*` fields; `ModelConfig` without `model_architecture`; repository rows without the columns.

- [ ] **Step 1: Remove config zod fields (config.ts)**

Remove lines 308-315:
```ts
    // GPU Profile settings — gpu_profile is a display hint (e.g. 'H100', 'custom').
    gpu_profile: z.enum(VALID_GPU_PROFILES as unknown as [string, ...string[]]).optional(),
    gpu_ram_gb: z.number().positive().optional(),
    gpu_bandwidth_tb_s: z.number().positive().optional(),
    gpu_flops_tflop: z.number().positive().optional(),
    gpu_power_draw_watts: z.number().positive().optional(),
```
Remove the `model_architecture: z...` block at line 649 (find its closing via the enclosing schema object — it's the only `model_architecture` key in the file). Remove lines 941-963 (the `gpu_profile` → numeric-fields backfill using `resolveGpuParams`). Remove import line 5:
```ts
import { resolveGpuParams, VALID_GPU_PROFILES } from '@plexus/shared';
```

- [ ] **Step 2: Remove repository GPU/model_architecture persistence (config-repository.ts)**

Remove line 459: `gpuProfile: config.gpu_profile ?? null,` from the provider insert. Remove the read/backfill block 714-752 (rows `gpuProfile`/`gpu_*` → config `gpu_profile`/`gpu_*` with `resolveGpuParams`). Remove line 1006: `modelArchitecture: config.model_architecture ? toJson(config.model_architecture) : null,` and line 1154: `...(row.modelArchitecture ? { model_architecture: parseJson(row.modelArchitecture) } : {}),`. Remove import line 25: `import { resolveGpuParams } from '@plexus/shared';`.

- [ ] **Step 3: Remove management config GPU/energy helpers (routes/management/config.ts)**

Remove the import line 22 (`import type { GpuParams, ModelArchitecture } from '@plexus/shared';`). Delete the helper `buildProviderGpuParamsMap` (86-110) and `recalculateEnergyIfChanged` (116-135). Remove the call sites: at lines 326-328 and 364-366 delete the trailing `result.data.model_architecture, buildProviderGpuParamsMap(configService)` argument pairs from `recalculateEnergyIfChanged(...)` (the whole call disappears with the helper — so remove the call lines entirely, including the surrounding `if` that only existed for the recalc).

- [ ] **Step 4: Drop GPU columns from providers schema**

Remove lines 35-40 from `drizzle/schema/sqlite/providers.ts`:
```ts
    // gpu_profile is kept as a display hint; the 4 numeric fields are the source of truth.
    gpuProfile: text('gpu_profile'), // GPU profile name (e.g. 'H100', 'custom') — display hint only
    gpuRamGb: real('gpu_ram_gb'), // RAM in GB
    gpuBandwidthTbS: real('gpu_bandwidth_tb_s'), // Bandwidth in TB/s
    gpuFlopsTflop: real('gpu_flops_tflop'), // FLOPS in TFLOP
    gpuPowerDrawWatts: integer('gpu_power_draw_watts'), // Power draw in watts
```
and the identical block (lines 45-50) from `drizzle/schema/postgres/providers.ts`.

- [ ] **Step 5: Drop model_architecture from model-aliases schema**

Remove the `modelArchitecture` column:
- `drizzle/schema/sqlite/model-aliases.ts` line 15 (`modelArchitecture: text('model_architecture'), // JSON: override for total_params, ...`)
- `drizzle/schema/postgres/model-aliases.ts` line 34 (`modelArchitecture: jsonb('model_architecture'), // override for total_params, ...`)

- [ ] **Step 6: Validate migration generation (do NOT commit artifacts)**

Run:
```bash
bun run generate-migrations --name remove_gpu_estimation
```
Expected: migrations dropping `gpu_profile`, `gpu_ram_gb`, `gpu_bandwidth_tb_s`, `gpu_flops_tflop`, `gpu_power_draw_watts` from `providers` and `model_architecture` from `model_aliases`. Do not commit artifacts.

- [ ] **Step 7: Verify and commit**

```bash
bun run typecheck
bun run test
```
Fix any config tests asserting `gpu_profile`/`model_architecture` (grep `gpu_profile\|model_architecture` under `packages/backend/src/**/__tests__` — remove the assertions; the zod schema no longer accepts them). Expected: PASS. Commit:
```bash
git add -A && git commit -m "feat(config): remove gpu_profile/gpu fields and model_architecture from config, DB, and routes"
```

---

### Task 5: Backend — remove HuggingFace model-params fetching

**Files:**
- Delete: `packages/backend/src/services/models/huggingface-model-fetcher.ts`
- Delete: `packages/backend/src/services/__tests__/huggingface-model-fetcher.test.ts`
- Modify: `packages/backend/src/routes/management/models.ts` (import 3; route ~68-87)

**Interfaces:**
- Consumes: shared `model-params` still exported (removed Task 6).
- Produces: `GET /v0/management/models/huggingface/{modelId}` and its test removed; the remaining `/v0/management/pi/*` model-browsing endpoints untouched.

- [ ] **Step 1: Remove the fetcher and its test**

```bash
git rm packages/backend/src/services/models/huggingface-model-fetcher.ts
git rm packages/backend/src/services/__tests__/huggingface-model-fetcher.test.ts
```
If `model-metadata-manager.ts` or any other file imports the fetcher, remove those imports too (verify: `grep -rn "huggingface-model-fetcher" packages/backend/src` → no matches after).

- [ ] **Step 2: Remove the huggingface model-params route**

In `routes/management/models.ts` remove import line 3:
```ts
import { HuggingFaceModelFetcher } from '../../services/models/huggingface-model-fetcher';
```
Delete the route block `fastify.get('.../huggingface/{modelId}', ...)` (~68-128, containing the `fetcher.getModelParams(modelId)` call at 87). Keep the `/v0/management/pi/providers` (130) and `/v0/management/pi/models` (142) registers and anything else that doesn't touch the fetcher. If the import block at lines 4-9 (`getModelParams` etc.) becomes unused, remove those identifiers too.

- [ ] **Step 3: Verify**

```bash
bun run typecheck
bun run test
grep -rn "huggingface-model-fetcher\|getModelParams" packages/backend/src --include=*.ts
```
Expected: PASS, no survivors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat(backend): remove HuggingFace model-params fetcher and route"
```

---

### Task 6: Shared — delete the GPU and model-params modules

**Files:**
- Delete: `packages/shared/src/gpu-profiles.ts`
- Delete: `packages/shared/src/model-params.ts`
- Delete: `packages/shared/test/model-params.test.ts`
- Modify: `packages/shared/src/types.ts` (1-51: `GpuParams`, `ModelParams`, `InferenceFootprint`, `GpuProfileOption`; keep everything else)
- Modify: `packages/shared/src/index.ts` (re-exports)

**Interfaces:**
- Consumes: every backend/frontend consumer removed in Tasks 1-5 (verify below).
- Produces: `@plexus/shared` with no GPU/model-estimation types or functions.

- [ ] **Step 1: Confirm zero remaining consumers**

```bash
grep -rn "gpu-profiles\|model-params\|GpuParams\|ModelParams\|InferenceFootprint\|GpuProfileOption\|GPU_PRESETS\|resolveGpuParams\|DTYPE_SIZES\|resolveDtypeSize\|inferDataType" packages --include=*.ts --include=*.tsx | grep -v "node_modules"
```
Expected: matches only in `packages/shared/src` itself (and `neuralwatt-checker.ts` which references `ModelParams`? — check: if `neuralwatt-checker.ts` imports `ModelParams`, leave a minimal statement; the quota checker reads provider payload `kwh_used` and should not depend on the shared model type — if it does, inline a local type). Any hit elsewhere must be removed first (go back to the owning task).

- [ ] **Step 2: Delete the modules**

```bash
git rm packages/shared/src/gpu-profiles.ts
git rm packages/shared/src/model-params.ts
git rm packages/shared/test/model-params.test.ts
```

- [ ] **Step 3: Remove the estimation types from types.ts**

Delete `GpuParams` (lines 1-11), `ModelParams` (13-25), `InferenceFootprint` (27-38), and `GpuProfileOption` (40-51) interface declarations (the `/** ... */` doc comments above them included). Keep all other types in the file.

- [ ] **Step 4: Clean index.ts re-exports**

Open `packages/shared/src/index.ts` and remove: the `GpuParams, ModelParams, InferenceFootprint, GpuProfileOption` type imports (3-5), the `VALID_GPU_PROFILES, GPU_PROFILE_OPTIONS, DEFAULT_GPU_PARAMS, resolveGpuParams` value re-exports (14-18), the `export type { GpuProfileName, GpuProfileType }` line (20), and any `model-params` / `DTYPE_SIZES` re-exports (check current export list — lines 14-20 of the file; keep every unrelated export intact).

- [ ] **Step 5: Verify**

```bash
bun run typecheck
bun run test
```
Expected: PASS. Typecheck across all workspaces confirms no dangling imports.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(shared): remove gpu-profiles, model-params, and estimation types"
```

---

### Task 7: Docs — openapi.yaml and generated asset

**Files:**
- Modify: `docs/openapi/components/schemas/ProviderConfig.yaml` (270-289)
- Modify: `docs/openapi/components/schemas/AliasConfig.yaml` (232-235)
- Modify: `docs/openapi/components/schemas/UsageRecord.yaml` (83; 234-241)
- Modify: `docs/openapi/components/schemas/UsageSummary.yaml` (34-36, 53, 82)
- Delete: `docs/openapi/paths/v0_management_models_huggingface_{modelId}.yaml`
- Modify: `docs/openapi/paths/v0_management_aliases_{slug}.yaml` (42-43, 146-147)
- Modify: `docs/openapi/paths/v0_management_aliases.yaml` (11)
- Modify: `docs/openapi/paths/v0_management_providers_{slug}.yaml` (96-97)
- Modify: `docs/openapi/paths/v0_management_providers.yaml` (13)
- Modify: `packages/backend/src/assets/openapi.json` (generated — do not hand-edit)
- Modify: `docs/openapi/openapi.yaml` (any `$ref` to the deleted path/fields)

**Interfaces:**
- Consumes: all code removals.
- Produces: OpenAPI spec matching the new API surface; `docs/openapi.yaml` bundle (generated) and `packages/backend/src/assets/openapi.json` (generated, committed — this one is a committed asset per git status).

- [ ] **Step 1: Update config/alias/usage schemas**

- `ProviderConfig.yaml`: remove the `gpu_profile` property (270) and the `gpu_ram_gb`/`gpu_bandwidth_tb_s`/`gpu_flops_tflop`/`gpu_power_draw_watts` property block (~276-289).
- `AliasConfig.yaml`: remove the `model_architecture` property + description (232-235).
- `UsageRecord.yaml`: remove the `kwhUsed` property (234-241) and the model_architecture mention in `canonicalModelName`'s description (83).
- `UsageSummary.yaml`: remove `kwhUsed`/`totalKwhUsed` properties (34-36, 53, 82) from the summary and per-bucket shapes.

- [ ] **Step 2: Update paths**

- Delete `docs/openapi/paths/v0_management_models_huggingface_{modelId}.yaml` (`git rm`).
- `v0_management_aliases_{slug}.yaml`: remove the "If you change `model_architecture`, the system recalculates estimated energy usage" descriptions on PUT (42-43) and PATCH (146-147), and the `model_architecture` request-schema references if any.
- `v0_management_aliases.yaml` (11): remove the `model_architecture` summary bullet.
- `v0_management_providers_{slug}.yaml` (96-97): remove the `with_gpu_profile` example/tag.
- `v0_management_providers.yaml` (13): remove the "GPU profile fields for energy estimation" bullet.
- `docs/openapi/openapi.yaml`: drop the `$ref` entry for the deleted path file and any now-dangling schema fields.

- [ ] **Step 3: Regenerate committed OpenAPI assets**

Run:
```bash
bun run generate:openapi:asset
bun run lint:openapi
```
Expected: `packages/backend/src/assets/openapi.json` regenerated without the removed fields; Redocly lint PASS. Commit both the regenerated asset and the source YAML edits.

- [ ] **Step 4: Verify and commit**

```bash
bun run typecheck
```
Expected: PASS (schema routes unaffected). Commit:
```bash
git add -A && git commit -m "docs: remove GPU estimation fields and huggingface model-params endpoint from OpenAPI"
```

---

### Task 8: Final verification — tests, format, and browser check

**Files:**
- Directories: `packages/*` (no code changes expected — verification only)

- [ ] **Step 1: Full automated verification**

Run:
```bash
bun run typecheck
bun run test
bun run format:check
bun run lint:check
```
Expected: all PASS. If `format:check` flags the edited files, run `bun run format` and amend the last commit.

- [ ] **Step 2: Confirm the removal is complete — no stale references anywhere**

```bash
grep -rn "kwhUsed\|kwh_used\|gpu_profile\|gpu_ram_gb\|GPU_PRESETS\|GPU_PROFILE_OPTIONS\|model_architecture\|estimateKwhUsed\|resolveGpuParams\|TotalEnergy\|inference-energy\|huggingface/{modelId}" packages docs --include=*.{ts,tsx,yaml,json} | grep -v "node_modules" | grep -v "assets/openapi.json"
```
Expected: `neuralwatt-checker.ts` may still reference provider payload `kwh_used` — confirm it's the quota checker's own `kwh_used` field (keep). Everything else: no matches.

- [ ] **Step 3: Browser verification of the frontend (AGENTS.md mandate)**

Read the `frontend-testing` skill, boot the worktree-safe dev stack (`bun run dev:agent`), and in a real browser confirm: provider advanced editor no longer shows a GPU profile dropdown or custom GPU fields; the alias editor no longer shows the model-architecture panel; the Usage tab no longer shows the energy comparison card; the Logs request detail no longer shows the toast-slices energy line. Fix anything that still references the removed config (e.g., leftover default config files in the dev environment: check `ls` of any `config.*` populated by `populate-dev`).

- [ ] **Step 4: Final commit (if Step 1 or 3 produced fixes) and report**

```bash
git add -A && git commit -m "chore: final cleanup after GPU estimation removal"   # only if there are changes
```
Report: files deleted, test/typecheck/format results, and the browser-verification outcome.