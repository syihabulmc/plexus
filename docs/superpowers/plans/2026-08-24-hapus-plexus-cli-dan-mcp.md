# Hapus Plexus CLI dan Semua Fitur MCP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menghapus seluruh package `packages/cli` (plexus-cli) dan seluruh subsistem fitur MCP dari codebase Plexus, sambil mempertahankan tabel DB MCP (skema Drizzle + migration tetap ada) dan sistem LLM-provider OAuth yang terpisah.

**Architecture:** Sub-sistem MCP terdiri dari 4 lapisan yang saling terkait: routes (`routes/mcp/*`, management routes mcp-*), services (`mcp-local`, `mcp-oauth`, `mcp-proxy`), repository/db helper (`db/mcp-*`), dan skema/type (`types/mcp.ts`, `shared/src/mcp.ts`, bagian `config.ts`, `db/types.ts`). CLI hidup di `packages/cli/` dengan wiring di root `package.json`, workflow CI, dan skill agent. Karena tabel DB dipertahankan, Drizzle schema `mcp*.ts`, blok `db/client.ts`, `encrypt-migration.ts` MCP section, dan `cli/rekey.ts` MCP section TIDAK dihapus. LLM-provider OAuth (`services/oauth/`, `routes/management/oauth.ts`, `registerBunOAuthFlows`) dan masking `transformers/oauth/masking/mcp-shape.ts` BUKAN fitur MCP — TIDAK disentuh. Urutan penghapusan reverse-topological: frontend → routes → management/config block → config-service/config-repository/config schema → services+db+types → docs/OpenAPI → CLI/tooling → verifikasi akhir, agar typecheck tetap hijau di setiap task.

**Tech Stack:** Bun, Fastify, Drizzle ORM, Zod, React (Tailwind v4), Vitest, Biome.

**Spec:** Design disetujui saat brainstorming 2026-08-24 (percakapan): hapus SEMUA MCP termasuk MCP OAuth IdP dan local process manager; PERTAHANKAN tabel DB (tidak ada migration drop); bersihkan docs, skill agent, dan workflow CI.

## Global Constraints

- **JANGAN** commit/push tanpa instruksi eksplisit dari user. (AGENTS.md)
- **JANGAN** edit atau buat file migration secara manual. Tidak ada migration baru dalam plan ini — tabel dipertahankan apa adanya. (AGENTS.md)
- **JANGAN** hapus file skema Drizzle `packages/backend/drizzle/schema/{sqlite,postgres}/mcp*.ts` — tabel dipertahankan.
- **JANGAN** hapus: `transformers/oauth/masking/mcp-shape.ts`, `services/oauth/**`, `routes/management/oauth.ts`, `cli/rekey.ts`, `cli/backup.ts`, `db/encrypt-migration.ts`, `types/responses.ts` (ResponsesMCPTool = OpenAI Responses API, bukan MCP gateway).
- Unit test backend ditulis dengan Vitest; jalankan dengan `bun run test` (bukan `bun test`). (AGENTS.md)
- Type check: `bun run typecheck`. Format: `bun run format:check` / `bun run format`. Lint: `bun run lint:check`.
- Verifikasi frontend setelah mengubah UI: pakai `frontend-testing` skill + dev stack (AGENTS.md) — plan ini hanya menghapus halaman/route/tipe, verifikasi typecheck + `bun run build:frontend` cukup karena tidak ada perubahan perilaku UI yang tersisa.
- Setelah seluruh task selesai, regenerasi `.repomap.txt` via `bun run generate:repomap` (AGENTS.md: repomap di-pre-push).

---

### Task 1: Hapus frontend MCP (halaman, route, tipe API, section Config)

**Files:**
- Delete: `packages/frontend/src/pages/Mcp.tsx`
- Modify: `packages/frontend/src/App.tsx` (import + route `/mcp`)
- Modify: `packages/frontend/src/lib/api.ts` (hapus 7 tipe MCP + 11 method MCP)
- Modify: `packages/frontend/src/pages/Config.tsx` (hapus section MCP OAuth config)

**Interfaces:**
- Consumes: — (task pertama, tidak ada dependensi)
- Produces: frontend tidak lagi mengimpor `McpPage`, tidak lagi mengekspor tipe/method `Mcp*` dari `api.ts`.

- [ ] **Step 1: Hapus file halaman MCP**

```bash
git rm packages/frontend/src/pages/Mcp.tsx
```

- [ ] **Step 2: Hapus import + route `/mcp` di App.tsx**

Buka `packages/frontend/src/App.tsx`. Hapus baris `import { McpPage } from './pages/Mcp';` (line 15). Hapus blok `<Route path="/mcp" ...>` berikut (≈ line 123-128):

```tsx
                <Route
                  path="/mcp"
                  element={
                    <ProtectedRoute requireAdmin>
                      <McpPage />
                    </ProtectedRoute>
                  }
                />
```

- [ ] **Step 3: Hapus tipe MCP di `lib/api.ts`**

Buka `packages/frontend/src/lib/api.ts`. Hapus blok tipe berikut (≈ line 266-362). Anchor unik: `export type McpServer = RemoteMcpServer | LocalMcpServer;` hingga penutup array-type `tokens: McpOAuthTokenRecord[];` yang terakhir. Hapus semua:
- `McpServer` / `RemoteMcpServer` / `LocalMcpServer`
- `McpServerKey`
- `LocalMcpRuntimeStatus`
- `McpLogRecord`
- `McpOAuthSettings`
- `McpOAuthTokenRecord`
- `McpOAuthClientRecord`

- [ ] **Step 4: Hapus method MCP di `lib/api.ts`**

Dipisahkan menjadi 3 blok method (anchor unik masing-masing):
1. `getMcpServers:` (≈ line 2981) sampai `deleteMcpServer:` berakhir (≈ line 3028) — CRUD server.
2. `getMcpServerKeys:` (≈ line 3030) sampai `restartMcpServer:` berakhir (≈ line 3106) — keys + runtime control.
3. `getMcpLogs:` (≈ line 3107) sampai akhir method (≈ line 3126) — logs.
4. `getMcpOAuthClients:` (≈ line 3128) sampai akhir `revokeMcpOAuthToken:` (≈ line 3146) — MCP OAuth management.

Hapus keempat blok tersebut sepenuhnya.

- [ ] **Step 5: Hapus section MCP OAuth di `Config.tsx`**

Buka `packages/frontend/src/pages/Config.tsx`. Anchor unik:
1. Import: `import type { CompactionSettings, McpOAuthSettings } from '../lib/api';` → ganti menjadi `import type { CompactionSettings } from '../lib/api';`
2. `const DEFAULT_MCP_OAUTH_CONFIG: McpOAuthSettings = {` — hapus konstanta (≈ line 130).
3. State: `const [mcpOAuthConfig, setMcpOAuthConfig]`, `mcpOAuthLoaded`, `mcpOAuthSaving`, `mcpOAuthIssuerInput` (≈ line 218-221), dan `issuerValidation`/`isMcpOAuthValid` (≈ line 237-238).
4. `loadMcpOAuthConfig` (≈ line 575-588) dan `handleSaveMcpOAuth` (≈ line 679-695) — hapus kedua callback beserta seluruh JSX yang merender field/indikator validasi MCP OAuth. Caranya: jalankan grep `grep -n "mcpOAuth\|McpOAuth" packages/frontend/src/pages/Config.tsx` dan hapus SEMUA baris yang muncul (termasuk UI `<Switch>`/`<Input>` untuk issuer), lalu cek tidak ada referensi tersisa.

- [ ] **Step 6: Verifikasi**

```bash
bun run typecheck
```
Expected: PASS (tidak ada error).

```bash
grep -rn "Mcp\|mcp" packages/frontend/src --include="*.tsx" --include="*.ts" | grep -v node_modules
```
Expected: hanya tersisa match yang tidak terkait MCP gateway (mis. `formatMs`, `fetchMcp` — jika ada, evaluasi manual; tidak boleh ada referensi ke `McpPage`, `McpServer`, `McpOAuthSettings`, `getMcpServers`, `revokeMcpOAuthToken`).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(frontend): remove MCP page, route, and API surface"
```

---

### Task 2: Hapus backend routes MCP + wiring index.ts/management.ts/backup.ts

**Files:**
- Delete: `packages/backend/src/routes/mcp/` (seluruh direktori: `index.ts`, `plexus.ts`, `__tests__/*`)
- Delete: `packages/backend/src/routes/management/mcp-logs.ts`
- Delete: `packages/backend/src/routes/management/mcp-oauth.ts`
- Modify: `packages/backend/src/index.ts`
- Modify: `packages/backend/src/routes/management.ts`
- Modify: `packages/backend/src/routes/management/backup.ts`

**Interfaces:**
- Consumes: Task 1 (frontend bersih)
- Produces: `registerMcpRoutes` / `registerMcpLogRoutes` / `registerMcpOAuthManagementRoutes` tidak lagi dipanggil; `McpUsageStorageService` tidak lagi di-instantiate/di-pass di `index.ts`;

- [ ] **Step 1: Hapus direktori routes MCP dan management MCP routes**

```bash
git rm -r packages/backend/src/routes/mcp
git rm packages/backend/src/routes/management/mcp-logs.ts packages/backend/src/routes/management/mcp-oauth.ts
```

- [ ] **Step 2: Bersihkan `index.ts`**

Buka `packages/backend/src/index.ts`. Hapus baris-baris berikut (anchor unik):
- `import { registerMcpRoutes } from './routes/mcp';` (line 56)
- `import { McpUsageStorageService } from './services/mcp-proxy/mcp-usage-storage';` (line 58)
- `import { runMcpKeyMigration } from './db/mcp-key-migration';` (line 64)
- `import { mcpProcessManager } from './services/mcp-local/mcp-process-manager';` (line 66)
- `const mcpUsageStorage = new McpUsageStorageService();` (line 140)
- `await runMcpKeyMigration();` (line 168) — argument: tabel DB dipertahankan, migration key-MCP tidak lagi dibutuhkan karena tidak ada kode yang membaca tabel.
- `await registerMcpRoutes(fastify, mcpUsageStorage);` (line 317)
- Di pemanggilan `registerManagementRoutes(...)` (line 330-338): hapus argumen `mcpUsageStorage,` sehingga signature menjadi `(fastify, usageStorage, dispatcher, probeService, quotaScheduler, quotaEnforcer)`.
- `await mcpProcessManager.stopAll();` (line 456) — ada di dalam handler `shutdown` (setelah `quotaScheduler.stop();`, sebelum `await fastify.close();`). Hapus SATU baris itu saja; baris sekitarnya (`quotaScheduler.stop()`, `fastify.close()`) tetap dipertahankan.

- [ ] **Step 3: Bersihkan `routes/management.ts`**

Buka `packages/backend/src/routes/management.ts`.
1. Hapus import: `import { registerMcpLogRoutes } from './management/mcp-logs';` (line 15), `import { registerMcpOAuthManagementRoutes } from './management/mcp-oauth';` (line 16), `import { McpUsageStorageService } from '../services/mcp-proxy/mcp-usage-storage';` (line 31).
2. Hapus parameter `mcpUsageStorage?: McpUsageStorageService,` dari signature `registerManagementRoutes` (line 39) — lakukan juga untuk semua baris yang menyinggung param ini.
3. Hapus blok kondisional (line 113-116):
```ts
      if (mcpUsageStorage) {
        await registerMcpLogRoutes(adminOnly, mcpUsageStorage);
      }
      await registerMcpOAuthManagementRoutes(adminOnly);
```
4. Ubah panggilan `await registerBackupRoutes(adminOnly, usageStorage, mcpUsageStorage);` menjadi `await registerBackupRoutes(adminOnly, usageStorage);`.

- [ ] **Step 4: Bersihkan `routes/management/backup.ts`**

Buka `packages/backend/src/routes/management/backup.ts`.
1. Hapus import: `import type { McpUsageStorageService } from '../../services/mcp-proxy/mcp-usage-storage';`
2. Hapus parameter `mcpUsageStorage?: McpUsageStorageService` dari signature `registerBackupRoutes` (jadikan `usageStorage?: UsageStorageService` saja).
3. Hapus blok `let successMcp = true; ... }` dari handler `DELETE /v0/management/logs/reset` (anchor: `let successMcp`), dan ubah kondisional `if (!successUsage || !successErrors || !successDebug || !successMcp)` → `if (!successUsage || !successErrors || !successDebug)` beserta object log yang menghilangkan `successMcp`.

- [ ] **Step 5: Verifikasi typecheck + grep residu**

```bash
bun run typecheck
```
Expected: PASS. PERHATIAN: `routes/management/config.ts` masih mengimpor dari `services/mcp-local` dan `services/mcp-proxy` — itu diselesaikan di Task 3; typecheck diharapkan masih hijau karena services tersebut belum dihapus.

```bash
grep -rn "registerMcpRoutes\|registerMcpLogRoutes\|registerMcpOAuthManagementRoutes" packages/backend/src --include="*.ts" | grep -v node_modules
```
Expected: tidak ada hasil.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(backend): remove MCP gateway routes and MCP management routes"
```

---

### Task 3: Hapus blok MCP di `routes/management/config.ts`

**Files:**
- Modify: `packages/backend/src/routes/management/config.ts`

**Interfaces:**
- Consumes: Task 2
- Produces: `config.ts` management tidak lagi mengekspos `/v0/management/mcp-servers*`, `/v0/management/mcp-enabled`, tidak lagi mengimpor `validateServerName`, `mcpProcessManager`, `McpKeyCreateSchema`, `McpServerConfigSchema`, tidak lagi punya `serializeMcpKey`, `mcpServerCount`.

- [ ] **Step 1: Hapus imports terkait MCP**

Buka `packages/backend/src/routes/management/config.ts`. Hapus:
- `McpServerConfigSchema,` dari import-blok `../../config` (line 7)
- `import { validateServerName } from '../../services/mcp-proxy/mcp-proxy-service';` (line 21)
- `import { mcpProcessManager } from '../../services/mcp-local/mcp-process-manager';` (line 22)
- `import { McpKeyCreateSchema } from '@plexus/shared';` (line 27)

- [ ] **Step 2: Hapus `serializeMcpKey`**

Hapus seluruh fungsi `serializeMcpKey(key: {...})` (≈ line 60-68) — ini satu-satunya pemakai `decryptField`? Periksa: `decryptField` dipakai juga di tempat lain di file itu; jika tidak, tidak masalah, `decryptField` adalah util backend lain. Jangan hapus utilitasnya.

- [ ] **Step 3: Hapus `mcpServerCount` dari status**

Di handler `GET /v0/management/config/status` (line 163-177), hapus baris `mcpServerCount: Object.keys(config.mcpServers ?? config.mcp_servers ?? {}).length,` dan jangan lupa hapus koma di baris sebelumnya (`quotaCount`).

- [ ] **Step 4: Hapus seluruh blok MCP servers + mcp-enabled**

Hapus seluruh blok mulai dari komentar `// ─── MCP Servers ──────────────────────────────────────────────────` (sebelum line 1098) hingga penutup route `PATCH /v0/management/config/mcp-enabled` (berakhir sebelum komentar `// ─── Quota Checker Types ──────────────────────────────────────────`). Ini mencakup:
- `GET/PUT/PATCH/DELETE /v0/management/mcp-servers[...]` (1098-1280)
- `GET/PATCH /v0/management/config/mcp-enabled` (1285-1310)

Pindahkan baris `fastify.get('/v0/management/quota-checker-types', ...)` dan seterusnya agar menyambung langsung setelah blok vision-descriptor yang mendahului blok MCP.

- [ ] **Step 5: Verifikasi**

```bash
bun run typecheck
```
Expected: PASS.

```bash
grep -n "mcp" packages/backend/src/routes/management/config.ts
```
Expected: tidak ada hasil.

- [ ] **Step 6: Commit**

```bash
git add packages/backend/src/routes/management/config.ts
git commit -m "feat(backend): remove MCP server management and mcp-enabled routes"
```

---

### Task 4: Hapus MCP dari config-service, config-repository, config schema, shared, db/types, backup-service

**Files:**
- Modify: `packages/backend/src/services/configuration/config-service.ts`
- Modify: `packages/backend/src/db/config-repository.ts`
- Modify: `packages/backend/src/config.ts`
- Modify: `packages/shared/src/index.ts`
- Delete: `packages/shared/src/mcp.ts`
- Modify: `packages/backend/src/db/types.ts`
- Modify: `packages/backend/src/services/configuration/backup-service.ts`
- Modify: `packages/backend/src/src` n/a

**Interfaces:**
- Consumes: Task 3 (management/config.ts bersih)
- Produces: `ConfigService`/`ConfigRepository` tanpa method `Mcp*`; `config.ts` tanpa `McpOAuthConfigSchema`/`mcpOAuth`/`mcp_servers`/`McpServerConfig`; `@plexus/shared` tanpa export `Mcp*`; `db/types.ts` tanpa `McpRequestUsage`/`McpDebugLog`; `BackupService` tanpa field `mcp_servers`/`mcp_keys`/`mcp_request_usage`/`mcp_debug_logs`.

**Perhatian:** metode `getAllMcpServers`/`saveMcpServer`/`deleteMcpServer`/`getMcpServerKeys`/`getAllMcpKeys`/`addMcpServerKey`/`batchInsertMcpKeys`/`deleteMcpServerKey`/`clearMcpServerKeyCooldown`/`getMcpOAuthConfig` dihapus dari `ConfigRepository`; metode `saveMcpServer`/`deleteMcpServer` serta blok export/getConfig MCP dihapus dari `ConfigService`.

- [ ] **Step 1: Bersihkan `config-service.ts`**

Buka `packages/backend/src/services/configuration/config-service.ts`.
1. Hapus import `McpServerConfig` (dari block import type — ≈ line 10, cek dengan `grep -n "McpServerConfig"`).
2. Hapus metode `saveMcpServer` (≈ line 302-306) dan `deleteMcpServer` (≈ line 308-311).
3. Dalam `exportConfig` (≈ line 400-411): hapus `const mcpServers = await this.repo.getAllMcpServers();`, `const mcpKeys = await this.repo.getAllMcpKeys();`, dan key `mcp_servers: mcpServers,` / `mcp_keys: mcpKeys,` dari objek hasil.
4. Dalam `getConfig` (≈ line 499-530): hapus `const mcpServers = await this.repo.getAllMcpServers();`, `const mcpOAuth = await this.repo.getMcpOAuthConfig();`, dan key `mcpOAuth`, `mcpServers:`, `mcp_servers:` dari objek yang dikembalikan.

- [ ] **Step 2: Bersihkan `config-repository.ts`**

Buka `packages/backend/src/db/config-repository.ts`.
1. Hapus `McpOAuthConfig,` dari import `../../config` (line 24) dan `McpKeyConfig`/`McpOAuthConfig`/`McpServerConfig` dari semua import type lain (`grep -n "McpKeyConfig\|McpOAuthConfig\|McpServerConfig" packages/backend/src/db/config-repository.ts` untuk menemukan semua baris import).
2. Hapus interface `McpKeyConfig` (≈ line 263-?) — seluruh bloknya.
3. Hapus panggilan `await new McpOauthRepository().revokeTokensForKeyName(name);` di `deleteKey` (line 1331) dan `disableTimeBoundKey` (line 1344) — ganti dengan `// (MCP OAuth token revocation removed with MCP feature)` atau cukup hapus barisnya (tidak ada komen wajib).
4. Hapus metode: `getAllMcpServers` (1436), `saveMcpServer` (1481), `deleteMcpServer` (1549), `getMcpServerKeys` (1554), `getAllMcpKeys` (1574), `batchInsertMcpKeys` (1592), `addMcpServerKey` (1623), `deleteMcpServerKey` (1651), `clearMcpServerKeyCooldown` (1667), `getMcpOAuthConfig` (1827) — setiap metode beserta docstring-nya.
5. Hapus import `McpOauthRepository` dari `./mcp-oauth-repository` (`grep -n "mcp-oauth-repository" packages/backend/src/db/config-repository.ts`).

- [ ] **Step 3: Bersihkan `config.ts` (backend)**

Buka `packages/backend/src/config.ts`.
1. Hapus `import { McpServerConfigSchema } from '@plexus/shared';` (line 2? — cek dengan grep).
2. Hapus `export { McpServerConfigSchema } from '@plexus/shared';` (line 777).
3. Hapus `McpOAuthConfigSchema` (804-825) — seluruh definisinya.
4. Hapus baris `mcpOAuth: McpOAuthConfigSchema.optional(),` (828) dan `mcp_servers: z.record(z.string(), McpServerConfigSchema).optional(),` (829) dari `RawPlexusConfigSchema`.
5. Hapus `export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;` (850).
6. Hapus `mcpOAuth?: McpOAuthConfig;` (858) dan `mcpServers?: Record<string, McpServerConfig>;` (857) dari `PlexusConfig`.
7. Hapus `export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;` (884).
8. Cek residual: `grep -n "Mcp\|mcp" packages/backend/src/config.ts` → seharusnya tidak ada lagi (kecuali match yang tidak terkait, evaluasi manual).

- [ ] **Step 4: Hapus `shared/src/mcp.ts`**

```bash
git rm packages/shared/src/mcp.ts
```

Buka `packages/shared/src/index.ts`. Hapus `McpKeyCreateSchema,` dari blok export yang menyebutnya (line 57) dan `export type { McpKey, McpKeyCreate, McpServerConfig } from './mcp';` (line 63). Jika blok import/export `from './mcp'` menjadi kosong dari anggota lain, hapus seluruh blok `{ ... } from './mcp';` dan determinasi baris `} from './mcp';` (cek `grep -n "from './mcp'"`).

- [ ] **Step 5: Bersihkan `db/types.ts`**

Buka `packages/backend/src/db/types.ts`. Hapus:
- `export type McpRequestUsage = InferSelectModel<typeof schema.mcpRequestUsage>;` (line 11)
- `export type McpDebugLog = InferSelectModel<typeof schema.mcpDebugLogs>;` (line 12)
- `export type NewMcpRequestUsage = InferInsertModel<typeof schema.mcpRequestUsage>;` (line 19)
- `export type NewMcpDebugLog = InferInsertModel<typeof schema.mcpDebugLogs>;` (line 20)

Perhatian: jangan hapus `McpServerConfig`/`McpKeyConfig` dari `schema` di file ini jika file lain memakainya — cek dengan `grep -rn "McpKeyConfig\|McpServerConfig" packages/backend/src | grep -v "drizzle/schema"`.

- [ ] **Step 6: Bersihkan `backup-service.ts`**

Buka `packages/backend/src/services/configuration/backup-service.ts`. Anchor unik:
1. Hapus `McpKeyConfig` dari import `../../db/config-repository` (line 20).
2. Dari `ConfigBackupData`: hapus `mcp_servers: Record<string, unknown>;` (48) dan `mcp_keys?: McpKeyConfig[];` (49).
3. Dari objek `FULL_BACKUP_OPERATIONAL_METADATA`-ish: hapus blok `mcp_request_usage: { ... }` (237-241) dan `mcp_debug_logs: { ... }` (242-246) — hapus seluruh properti beserta nilainya.
4. Dari array `OPERATIONAL_TABLES` (274-275): hapus dua item `'mcp_request_usage',` dan `'mcp_debug_logs',`.
5. Dari `exportConfigBackup`: hapus `mcp_servers: configData.mcp_servers as Record<string, unknown>,` dan `mcp_keys: configData.mcp_keys as McpKeyConfig[],` (320-321).
6. Dari `restoreConfigBackup`: hapus blok `const mcpServers = data.data.mcp_servers as Record<string, any>;` dan loop restorasi MCP servers (442-…) — periksa dan hapus seluruh loop `for (const [name, config] of Object.entries(mcpServers))`.
7. Dari `getSchemaTableMap` (663): hapus dua baris `mcp_request_usage: schema.mcpRequestUsage,` dan `mcp_debug_logs: schema.mcpDebugLogs,` (679-680). Kerjakan SEMUA langkah ini — daftarnya eksplisit, bukan turunan dinamis, jadi tidak ada langkah "jika".

- [ ] **Step 7: Verifikasi**

```bash
bun run typecheck
```
Expected: PASS.

```bash
grep -rn "McpOAuthConfig\|McpKeyConfig\|McpServerConfig\|McpRequestUsage\|McpDebugLog\|getMcpOAuthConfig\|getAllMcpServers\|mcp_servers\|mcp_keys\|mcp_request_usage\|mcp_debug_logs\|MCP Servers" packages/backend/src --include="*.ts" | grep -v node_modules | grep -v "drizzle/schema"
```
Expected: tidak ada hasil. (Pengecualian diizinkan: `db/encrypt-migration.ts` dan `cli/rekey.ts` — lihat Global Constraints.)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(backend): remove MCP from config service, repository, schema, shared, backup"
```

---

### Task 5: Hapus services MCP, db MCP helper, dan types/mcp.ts

**Files:**
- Delete: `packages/backend/src/services/mcp-local/`
- Delete: `packages/backend/src/services/mcp-oauth/`
- Delete: `packages/backend/src/services/mcp-proxy/`
- Delete: `packages/backend/src/db/mcp-key-migration.ts`
- Delete: `packages/backend/src/db/mcp-oauth-repository.ts`
- Delete: `packages/backend/src/types/mcp.ts`

**Interfaces:**
- Consumes: Task 4 (semua konsumen config-level sudah bersih)
- Produces: tidak ada sisa file MCP di `src` (selain skema Drizzle dan crypt tooling yang memang dipertahankan).

- [ ] **Step 1: Hapus direktori services MCP dan file db/type MCP**

```bash
git rm -r packages/backend/src/services/mcp-local packages/backend/src/services/mcp-oauth packages/backend/src/services/mcp-proxy
git rm packages/backend/src/db/mcp-key-migration.ts packages/backend/src/db/mcp-oauth-repository.ts packages/backend/src/types/mcp.ts
```

- [ ] **Step 2: Hapus test yang tersisa untuk modul itu**

```bash
git rm packages/backend/src/services/mcp-oauth/__tests__/plexus-idp-provider.test.ts packages/backend/src/services/mcp-proxy/__tests__/mcp-proxy-service.test.ts packages/backend/src/db/__tests__/mcp-oauth-repository.test.ts packages/backend/src/db/__tests__/mcp-oauth-key-revocation.test.ts packages/backend/src/db/__tests__/mcp-key-migration.test.ts
```
(Direktori `__tests__` di dalam `mcp-local` tidak ada — jika ada file test lain di sana, hapus juga: cek `find packages/backend/src -path "*mcp*" -name "*.test.ts"`.)

- [ ] **Step 3: Verifikasi residu import**

```bash
bun run typecheck
```
Expected: PASS.

```bash
grep -rn "mcp-local\|mcp-oauth\|mcp-proxy\|mcp-key-migration\|mcp-usage-storage\|types/mcp" packages/backend/src --include="*.ts" | grep -v node_modules | grep -v "drizzle/schema"
```
Expected: tidak ada hasil.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(backend): remove MCP services, db helpers, and types"
```

---

### Task 6: Hapus docs dan OpenAPI MCP

**Files:**
- Delete: `docs/MCP.md`
- Delete: semua path OpenAPI MCP (daftar di Step 1)
- Delete: semua schema OpenAPI MCP (daftar di Step 1)
- Modify: `docs/openapi/openapi.yaml`
- Modify: `docs/openapi/components/schemas/Config.yaml`
- Modify: `docs/openapi/components/schemas/ConfigBackupEnvelope.yaml`
- Modify: `docs/CONFIGURATION.md`
- Modify: `docs/INSTALLATION.md`
- Regenerate: `packages/backend/src/assets/openapi.json` (via `bun run generate:openapi:asset`)

**Interfaces:**
- Consumes: Task 5
- Produces: OpenAPI bundle tanpa MCP; docs tanpa bab MCP.

- [ ] **Step 1: Hapus file path OpenAPI MCP**

```bash
git rm \
  docs/openapi/paths/mcp_plexus.yaml \
  docs/openapi/paths/mcp_{name}.yaml \
  docs/openapi/paths/.well-known_oauth-authorization-server.yaml \
  docs/openapi/paths/.well-known_oauth-protected-resource.yaml \
  docs/openapi/paths/oauth_authorize.yaml \
  docs/openapi/paths/oauth_register.yaml \
  docs/openapi/paths/oauth_token.yaml \
  docs/openapi/paths/v0_management_config_mcp-enabled.yaml \
  docs/openapi/paths/v0_management_mcp-logs.yaml \
  docs/openapi/paths/v0_management_mcp-logs_{requestId}.yaml \
  docs/openapi/paths/v0_management_mcp-servers.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_keys.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_keys_{keyId}.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_keys_{keyId}_clear-cooldown.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_process-logs.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_restart.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_start.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_status.yaml \
  docs/openapi/paths/v0_management_mcp-servers_{serverName}_stop.yaml
```

- [ ] **Step 2: Hapus file schema OpenAPI MCP + docs/MCP.md**

```bash
git rm \
  docs/openapi/components/schemas/LocalMcpRuntimeStatus.yaml \
  docs/openapi/components/schemas/McpServerConfig.yaml \
  docs/openapi/components/schemas/McpUsageRecord.yaml
git rm docs/MCP.md
```

- [ ] **Step 3: Bersihkan `docs/openapi/openapi.yaml`**

Buka `docs/openapi/openapi.yaml`. Hapus blok path berikut (hapus baris kunci path BESERTA baris `$ref:` di bawahnya) — kunci persisnya:

```yaml
  /mcp/{name}:
  /mcp/plexus:
  /.well-known/oauth-authorization-server:
  /.well-known/oauth-protected-resource/mcp/{name}:
  /oauth/authorize:
  /oauth/token:
  /oauth/register:
  /v0/management/config/mcp-enabled:
  /v0/management/mcp-servers:
  /v0/management/mcp-servers/{serverName}:
  /v0/management/mcp-servers/{serverName}/status:
  /v0/management/mcp-servers/{serverName}/start:
  /v0/management/mcp-servers/{serverName}/stop:
  /v0/management/mcp-servers/{serverName}/restart:
  /v0/management/mcp-servers/{serverName}/process-logs:
  /v0/management/mcp-servers/{serverName}/keys:
  /v0/management/mcp-servers/{serverName}/keys/{keyId}:
  /v0/management/mcp-servers/{serverName}/keys/{keyId}/clear-cooldown:
  /v0/management/mcp-logs:
  /v0/management/mcp-logs/{requestId}:
```

2. Hapus teks deskripsi yang menyebut MCP di bagian `info`/intro (baris ± 40-43, 338, 350-352) — ganti dengan kalimat yang tidak menyebut MCP.
3. Hapus referensi komponen `McpUsageRecord`, `McpServerConfig`, `LocalMcpRuntimeStatus` dari `components/schemas:` (jika ada `$ref` berbentuk `#/components/schemas/McpUsageRecord` di path lain — cek `grep -n "McpUsageRecord\|McpServerConfig\|LocalMcpRuntimeStatus" docs/openapi/openapi.yaml`).
4. Verifikasi: `grep -n "mcp" docs/openapi/openapi.yaml` → tersisa hanya match yang tidak terkait (evaluasi manual).

- [ ] **Step 4: Bersihkan `Config.yaml` dan `ConfigBackupEnvelope.yaml`**

Buka `docs/openapi/components/schemas/Config.yaml`:
- Hapus properti `mcp_servers:` (line 22) beserta sub-schema-nya.

Buka `docs/openapi/components/schemas/ConfigBackupEnvelope.yaml`:
- Hapus `mcp_servers` dari daftar `required` (line 31), properti `mcp_servers:` (line 51), dan jika ada `mcp_keys` juga.

- [ ] **Step 5: Bersihkan `docs/CONFIGURATION.md`**

Buka `docs/CONFIGURATION.md`. Hapus:
- Baris bullet `- **MCP Servers**: Configure MCP proxy endpoints` (line 47) dari ringkasan.
- Seluruh section `## MCP Servers` (≈ line 958-999, termasuk tabel endpoint dan bagian OAuth MCP) — perluas sampai sebelum section berikutnya.
- Baris tabel `| MCP Servers | headers |` (line 1085).
Verifikasi: `grep -n "MCP\|mcp" docs/CONFIGURATION.md` → tidak ada hasil MCP terkait.

- [ ] **Step 6: Bersihkan `docs/INSTALLATION.md`**

Buka `docs/INSTALLATION.md`. Hapus kalimat yang menyebut MCP (line 32: `The Docker image includes bunx and uvx so Plexus can run configured Local HTTP MCP servers inside the container.`) — jika hanya itu, hapus barisnya; jika menyisakan kalimat tidak utuh, sesuaikan.

- [ ] **Step 7: Regenerate OpenAPI asset**

```bash
bun run generate:openapi:asset
```
Expected: sukses, `packages/backend/src/assets/openapi.json` berubah (baris MCP hilang). Verifikasi:
```bash
grep -c "mcp" packages/backend/src/assets/openapi.json
```
Expected: 0 (atau hanya match incidental; evaluasi manual).

- [ ] **Step 8: Verifikasi typecheck + lint openapi**

```bash
bun run typecheck
bun run lint:openapi
```
Expected: keduanya PASS (lint:openapi boleh dijalankan; jika ada warning yang tidak terkait removal, catat dan lanjutkan).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "docs(openapi): remove MCP endpoints, schemas, and documentation"
```

---

### Task 7: Hapus CLI (packages/cli) + script root + skill agent + CI workflows

**Files:**
- Delete: `packages/cli/` (seluruh direktori)
- Delete: `scripts/sync-cli-skill.ts`
- Delete: `.agents/skills/plexus-cli/`
- Modify: `package.json` (hapus 8 script CLI)
- Modify: `AGENTS.md` (referensi plexus-cli)
- Modify: `.github/workflows/release.yml` (job `publish-cli`, step compile CLI, artifact upload, `needs`)
- Modify: `.github/workflows/dev-release.yml` (step compile CLI, artifact upload)
- Modify: `.agents/skills/plexus-rest-api/SKILL.md` (hapus "CLI Preference" + endpoint MCP)
- Modify: `.agents/skills/plexus-rest-api/references/endpoint-map.md` (hapus baris MCP)
- Modify: `.agents/skills/plexus-rest-api/evals/evals.json` (hapus/hapus-referensi eval MCP + CLI)
- Modify: `.agents/skills/frontend-testing/SKILL.md` (ganti refs plexus-cli → plexus-rest-api)

**Interfaces:**
- Consumes: Task 6
- Produces: tidak ada lagi script `plexuscli` / `compile:cli:*` / `sync:cli-skill`; tidak ada skill `plexus-cli`; tidak ada job compile/publish CLI di CI.

- [ ] **Step 1: Hapus package CLI, script sync, skill CLI**

```bash
git rm -r packages/cli
git rm scripts/sync-cli-skill.ts
git rm -r .agents/skills/plexus-cli
```

- [ ] **Step 2: Hapus script root di `package.json`**

Buka `package.json` root. Hapus baris/lini script berikut (cek juga koma):
- `"plexuscli": "bun run packages/cli/src/index.ts",`
- `"sync:cli-skill": "bun run scripts/sync-cli-skill.ts",`
- `"compile:cli:macos-amd64"`, `"compile:cli:macos-arm64"`, `"compile:cli:linux-amd64"`, `"compile:cli:linux-arm64"`, `"compile:cli:windows"` (5 baris compile)

- [ ] **Step 3: Perbarui `AGENTS.md`**

Buka `AGENTS.md`, baris 23:
```
- **DEBUGGING** Plexus instances: read and use the `plexus-cli` skill. ...
```
Ganti menjadi (tidak menyebut plexus-cli — pakai plexus-rest-api sebagai alternatif yang tersedia):
```
- **DEBUGGING** Plexus instances: read and use the `plexus-rest-api` skill. The worktree `.env` contains the relevant staging configuration. When the user specifies `staging`, use `PLEXUS_STAGING_URL` for the staging URL and `PLEXUS_ADMIN_KEY` for the admin key.
```

- [ ] **Step 4: Bersihkan workflow `release.yml`**

Buka `.github/workflows/release.yml`:
1. Hapus step "compile CLI binaries part" pada job build binaries (line 340-344: `bun run compile:cli:...` ×5).
2. Hapus langkah upload artifact `plexuscli-*` (line 355-359).
3. Hapus seluruh job `publish-cli:` (≈ line 485-529).
4. Hapus `publish-cli` dari daftar `needs:` job release (line 537).
5. Hapus asset `release/plexuscli-*` dari langkah release assets (line 556-559).
Gunakan grep `grep -n "cli\b\|publish-cli\|plexuscli" .github/workflows/release.yml` untuk memastikan tidak ada sisa.

- [ ] **Step 5: Bersihkan workflow `dev-release.yml`**

Buka `.github/workflows/dev-release.yml`: hapus step compile CLI (69-73) dan upload artifact (108-112). `grep -n "cli\|plexuscli"` → tidak ada sisa.

- [ ] **Step 6: Perbarui skill `plexus-rest-api`**

Buka `.agents/skills/plexus-rest-api/SKILL.md`:
1. Hapus section `## CLI Preference` (mulai baris "**Strongly prefer the `plexus-cli` skill.**" hingga sebelum heading berikutnya) — ganti dengan satu kalimat: `Use raw `curl` and `jq` management API calls. Do not assume local filesystem access to the Plexus data store when a management endpoint exists.`
2. Perbarui frontmatter `description:` — hapus kalimat "when plexus-cli is unavailable or cannot support a required operation".
3. Hapus bullet MCP (line 220-224) dari bagian kapan waktu tertentu (endpoint list): server CRUD + mcp-logs.

Buka `.agents/skills/plexus-rest-api/references/endpoint-map.md`: hapus baris 178-183 (list MCP servers CRUD + MCP logs) dan baris 188 (contoh payload `{"upstream_url":...}`) jika hanya terkait MCP.

Buka `.agents/skills/plexus-rest-api/evals/evals.json`:
- Hapus entri eval yang berisi "Create a disposable MCP server named eval-mcp-skill-test" (≈ line 66-67).
- Pada entri eval yang menyebut "Respond using the plexus-rest-api skill only when plexus-cli is unavailable" (≈ line 96) — ubah frasa menjadi tanpa "only when plexus-cli is unavailable" dan tanpa "plexus-cli" (mis. "Respond using the plexus-rest-api skill.").
- Verifikasi: `grep -n "plexus-cli\|mcp" .agents/skills/plexus-rest-api/` → tidak ada hasil.

- [ ] **Step 7: Perbarui skill `frontend-testing`**

Buka `.agents/skills/frontend-testing/SKILL.md`:
- Line 26: ganti "**plexus-cli** skill — inspects/seeds backend state through the management CLI..." menjadi "**plexus-rest-api** skill — inspects/seeds backend state through the management REST API...".
- Line 123 & 130: ganti semua "the plexus-cli skill" → "the plexus-rest-api skill".
- Line 166: ganti "via the plexus-cli skill" → "via the plexus-rest-api skill".
Verifikasi: `grep -n "plexus-cli" .agents/skills/frontend-testing/SKILL.md` → tidak ada hasil.

- [ ] **Step 8: Verifikasi**

```bash
bun run typecheck
```
Expected: PASS (workspaces tanpa `packages/cli` — pastikan tidak ada workspace lain yang mengimpor `@mcowger/plexus-cli` atau `packages/cli`).

```bash
grep -rn "plexus-cli\|plexuscli\|compile:cli\|sync:cli-skill" package.json AGENTS.md .github scripts .agents --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.ts" 2>/dev/null
```
Expected: tidak ada hasil.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(cli): remove plexus-cli package, scripts, skills, and CI jobs"
```

---

### Task 8: Verifikasi akhir (sweep residu + test + typecheck + format + repomap)

**Files:**
- Modify: `.repomap.txt` (via generate)
- Verify: seluruh tree

**Interfaces:**
- Consumes: Task 1-7
- Produces: repo bersih, semua test hijau, repomap terbaru.

- [ ] **Step 1: Sweep residu global**

```bash
grep -rni "plexus-cli\|plexuscli" . --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" --include="*.yml" --include="*.yaml" 2>/dev/null | grep -v node_modules | grep -v "\.git/"
```
Expected: tidak ada hasil yang relevan (false-positive incidental seperti `x-plexus-client` di test boleh tersisa — evaluasi manual; `@mcowger/...` di fixture codex-lite adalah nama pengguna GitHub untuk tool OAuth Codex, BUKAN plexus-cli — jangan dihapus).

```bash
grep -rni "\bmcp\b\|/mcp" packages/backend/src packages/frontend/src packages/shared/src docs scripts .agents .github --include="*.ts" --include="*.tsx" --include="*.md" --include="*.yaml" --include="*.yml" --include="*.json" 2>/dev/null | grep -v node_modules | grep -v "drizzle/schema"
```
Expected: hanya match yang merupakan: LLM OAuth (`services/oauth`), masking (`mcp-shape`), sklearn? tidak ada — evaluasi manual. **Jangan hapus** sisanya jika terkait LLM OAuth / Responses API / Claude masking.

- [ ] **Step 2: Typecheck + format + lint**

```bash
bun run typecheck
bun run format:check
bun run lint:check
```
Expected: semua PASS. Jika `format:check` gagal hanya karena file yang terformat tidak sesuai, jalankan `bun run format` lalu ulangi.

- [ ] **Step 3: Test penuh**

```bash
bun run test
```
Expected: PASS (semua test backend hijau). Jika ada test yang mengimpor MCP yang terlewat, hapus/update (kembali ke Task 5, Step 2).

- [ ] **Step 4: Build frontend**

```bash
bun run build:frontend
```
Expected: PASS (pastikan tidak ada import `Mcp.tsx` yang tersisa di bundle).

- [ ] **Step 5: Regenerasi repomap**

```bash
bun run generate:repomap
```
Expected: `.repomap.txt` ter-update — `packages/cli` dan simbol MCP (`registerMcpRoutes`, `McpProcessManager`, dst) hilang dari indeks.

- [ ] **Step 6: Review diff akhir**

```bash
git status
git diff --stat
```
Expected: daftar file terhapus/berubah sesuai task 1-7; tidak ada file migration yang berubah; tidak ada file `drizzle/schema/**/mcp*` yang terhapus.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: regenerate repomap after MCP and CLI removal"
```