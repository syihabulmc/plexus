import { logger } from '../../utils/logger';
import { getDatabase, getSchema } from '../../db/client';
import { lt, eq, sql, and, desc, gte, gt, or } from 'drizzle-orm';
import { getConfig } from '../../config';
import { DebugManager } from '../observability/debug-manager';
import { getCurrentRequestId } from '../observability/request-context';
import { DEADLINE_EXPIRED_PATTERNS } from '../../utils/constants';

export interface Target {
  provider: string;
  model: string;
}

interface CooldownEntry {
  expiry: number;
  consecutiveFailures: number;
  lastError?: string;
}

export class CooldownManager {
  private static instance: CooldownManager;
  private cooldowns: Map<string, CooldownEntry> = new Map();
  private db: ReturnType<typeof getDatabase> | null = null;
  private schema: any = null;

  private constructor() {}

  public static getInstance(): CooldownManager {
    if (!CooldownManager.instance) {
      CooldownManager.instance = new CooldownManager();
    }
    return CooldownManager.instance;
  }

  /** For testing only */
  public static resetForTesting(): void {
    CooldownManager.instance = undefined as any;
  }

  private ensureDb() {
    if (!this.db) {
      this.db = getDatabase();
      this.schema = getSchema();
    }
    return this.db;
  }

  public async loadFromStorage() {
    try {
      const db = this.ensureDb();
      const now = Date.now();

      // Purge truly expired rows (0 < expiry < now). Rows with expiry === 0
      // are retained failure counts (cooldown already lapsed) and must survive
      // a restart so escalation continues from the saved count.
      await db
        .delete(this.schema.providerCooldowns)
        .where(
          and(
            lt(this.schema.providerCooldowns.expiry, now),
            gt(this.schema.providerCooldowns.expiry, 0)
          )
        );

      const rows = await db
        .select()
        .from(this.schema.providerCooldowns)
        .where(
          or(
            gte(this.schema.providerCooldowns.expiry, now),
            eq(this.schema.providerCooldowns.expiry, 0)
          )
        );

      this.cooldowns.clear();
      for (const row of rows) {
        const keyId = (row as any).keyId || undefined;
        const key = CooldownManager.makeCooldownKey(row.provider, row.model || '', keyId);
        this.cooldowns.set(key, {
          expiry: row.expiry,
          consecutiveFailures: row.consecutiveFailures || 0,
          lastError: row.lastError ?? undefined,
        });
      }
      logger.debug(`Loaded ${this.cooldowns.size} active cooldowns from storage`);
      await this.pruneDisabledProviders();
    } catch (e) {
      logger.error('Failed to load cooldowns from storage', e);
    }
  }

  /**
   * Cooldown in-memory key. 3-segment when keyId is set (per-key cooldown),
   * 2-segment otherwise (legacy single-key / model-level cooldown). The
   * PK on provider_cooldowns is (provider, model, key_id) so the DB and
   * in-memory representations align.
   */
  private static makeCooldownKey(provider: string, model: string, keyId?: string): string {
    if (keyId) return `${provider}:${model}:${keyId}`;
    return `${provider}:${model}`;
  }

  private isCooldownDisabledForProvider(provider: string): boolean {
    try {
      const config = getConfig();
      return config.providers?.[provider]?.disable_cooldown === true;
    } catch {
      return false;
    }
  }

  private isStallCooldownEnabledForProvider(provider: string): boolean {
    try {
      const config = getConfig();
      if (config.providers?.[provider]?.stall_cooldown === true) return true;
      return config.stall?.stallCooldown === true;
    } catch {
      return false;
    }
  }

  public async markProviderStallFailure(
    provider: string,
    model: string,
    lastError?: string,
    keyId?: string
  ): Promise<void> {
    if (!this.isStallCooldownEnabledForProvider(provider)) {
      logger.debug(
        `Skipping stall cooldown for provider '${provider}' model '${model}' (stall_cooldown not enabled)`
      );
      return;
    }
    await this.markProviderFailure(provider, model, undefined, lastError, keyId);
  }

  private async pruneDisabledProviders(): Promise<void> {
    const keysToDelete: string[] = [];

    for (const key of this.cooldowns.keys()) {
      const provider = key.split(':')[0];
      if (provider && this.isCooldownDisabledForProvider(provider)) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cooldowns.delete(key);
    }

    if (keysToDelete.length > 0) {
      const providers = [...new Set(keysToDelete.map((k) => k.split(':')[0]))];
      try {
        const db = this.ensureDb();
        for (const provider of providers) {
          await db
            .delete(this.schema.providerCooldowns)
            .where(eq(this.schema.providerCooldowns.provider, provider));
        }
        logger.debug(`Pruned cooldowns for disable_cooldown providers: ${providers.join(', ')}`);
      } catch (e) {
        logger.error('Failed to prune disabled provider cooldowns from DB', e);
      }
    }
  }

  /** For testing only */
  public static resetInstance(): void {
    CooldownManager.instance = undefined as any;
  }

  /**
   * Calculate exponential backoff duration using formula:
   * C(n) = min(C_max, C_0 * 2^n)
   *
   * Where:
   * - n = consecutive failures (0-indexed, so first failure is n=0)
   * - C_0 = initial cooldown in milliseconds
   * - C_max = max cooldown in milliseconds
   */
  private calculateCooldownDuration(consecutiveFailures: number): number {
    try {
      const config = getConfig();
      const cooldownConfig = config.cooldown;
      const initialMinutes = cooldownConfig?.initialMinutes ?? 2;
      const maxMinutes = cooldownConfig?.maxMinutes ?? 300;

      const initialMs = initialMinutes * 60 * 1000;
      const maxMs = maxMinutes * 60 * 1000;

      // C(n) = min(C_max, C_0 * 2^n)
      const exponentialMs = initialMs * Math.pow(2, consecutiveFailures);
      const durationMs = Math.min(maxMs, exponentialMs);

      return durationMs;
    } catch (e) {
      // Fallback if config not loaded yet
      const initialMs = 2 * 60 * 1000; // 2 minutes
      const maxMs = 300 * 60 * 1000; // 5 hours
      const exponentialMs = initialMs * Math.pow(2, consecutiveFailures);
      return Math.min(maxMs, exponentialMs);
    }
  }

  public async markProviderFailure(
    provider: string,
    model: string,
    durationMs?: number,
    lastError?: string,
    keyId?: string
  ): Promise<void> {
    if (this.isCooldownDisabledForProvider(provider)) {
      logger.debug(
        `Skipping cooldown for provider '${provider}' model '${model}' (disable_cooldown=true)`
      );
      return;
    }

    if (
      lastError &&
      DEADLINE_EXPIRED_PATTERNS.some((p) => lastError.toLowerCase().includes(p.toLowerCase()))
    ) {
      logger.debug(
        `Skipping cooldown for provider '${provider}' model '${model}' (deadline expired error)`
      );
      return;
    }

    const key = CooldownManager.makeCooldownKey(provider, model, keyId);
    const existingEntry = this.cooldowns.get(key);
    const consecutiveFailures = (existingEntry?.consecutiveFailures || 0) + 1;

    // Calculate duration using exponential backoff if not provided (e.g., from 429 parser)
    const duration = durationMs || this.calculateCooldownDuration(consecutiveFailures - 1);
    const expiry = Date.now() + duration;

    this.cooldowns.set(key, { expiry, consecutiveFailures, lastError });

    // In capture-on-error mode, persist the triggering request's debug trace.
    // Resolved from the async-local context since this path has no requestId;
    // no-op when the mode is off or outside a request context (e.g. probes).
    DebugManager.getInstance().markForcePersist(getCurrentRequestId());

    const keySuffix = keyId ? ` key '${keyId}'` : '';
    logger.warn(
      `Provider '${provider}' model '${model}'${keySuffix} placed on cooldown for ${duration / 1000}s ` +
        `(failure #${consecutiveFailures}) until ${new Date(expiry).toISOString()}`
    );

    try {
      const db = this.ensureDb();
      await db
        .insert(this.schema.providerCooldowns)
        .values({
          provider,
          model,
          keyId: keyId ?? '',
          expiry,
          consecutiveFailures,
          createdAt: Date.now(),
          lastError: lastError ?? null,
        })
        .onConflictDoUpdate({
          target: [
            this.schema.providerCooldowns.provider,
            this.schema.providerCooldowns.model,
            this.schema.providerCooldowns.keyId,
          ],
          set: {
            expiry,
            consecutiveFailures,
            lastError: lastError ?? null,
          },
        });
    } catch (e) {
      logger.error(`Failed to persist cooldown for ${provider}:${model}`, e);
    }
  }

  public async markProviderSuccess(provider: string, model: string, keyId?: string): Promise<void> {
    const key = CooldownManager.makeCooldownKey(provider, model, keyId);
    const existingEntry = this.cooldowns.get(key);

    if (!existingEntry) {
      // No cooldown entry, nothing to reset
      return;
    }

    // Reset consecutive failures to 0 and remove the entry entirely
    this.cooldowns.delete(key);

    if (existingEntry.consecutiveFailures > 0) {
      const keySuffix = keyId ? ` key '${keyId}'` : '';
      logger.info(
        `Provider '${provider}' model '${model}'${keySuffix} succeeded - resetting failure count (was ${existingEntry.consecutiveFailures})`
      );
    }

    try {
      const db = this.ensureDb();
      // When no keyId is given, only clear the row where key_id === '' (the
      // model-level slot) so we don't accidentally wipe per-key cooldowns
      // (which live at the same (provider, model) but with a non-empty keyId).
      const conditions = [
        eq(this.schema.providerCooldowns.provider, provider),
        eq(this.schema.providerCooldowns.model, model),
      ];
      if (keyId) {
        conditions.push(eq(this.schema.providerCooldowns.keyId, keyId));
      } else {
        conditions.push(eq(this.schema.providerCooldowns.keyId, ''));
      }
      await db
        .delete(this.schema.providerCooldowns)
        .where(and(...conditions));
    } catch (e) {
      logger.error(`Failed to clear cooldown for ${provider}:${model}`, e);
    }
  }

  public async isProviderHealthy(provider: string, model: string, keyId?: string): Promise<boolean> {
    // Per design: no provider-wide cascade. Per-key cooldowns are fully
    // independent. The check is purely the matching slot — a key on
    // cooldown does not block other keys of the same provider. The
    // provider-wide slot (model === '') is kept for the legacy quota
    // scheduler path and for callers that explicitly pass keyId === undefined.
    const key = CooldownManager.makeCooldownKey(provider, model, keyId);
    const entry = this.cooldowns.get(key);
    if (!entry) return true;

    // expiry === 0 means cooldown already expired — provider is eligible but failure count is retained
    if (entry.expiry === 0) return true;

    if (Date.now() > entry.expiry) {
      // Cooldown just expired — keep the failure count so the next failure escalates correctly,
      // but mark expiry as 0 so we stop treating it as actively cooling down.
      this.cooldowns.set(key, { expiry: 0, consecutiveFailures: entry.consecutiveFailures });

      try {
        const db = this.ensureDb();
        const conditions = [
          eq(this.schema.providerCooldowns.provider, provider),
          eq(this.schema.providerCooldowns.model, model),
        ];
        if (keyId) {
          conditions.push(eq(this.schema.providerCooldowns.keyId, keyId));
        } else {
          conditions.push(eq(this.schema.providerCooldowns.keyId, ''));
        }
        await db.delete(this.schema.providerCooldowns).where(and(...conditions));
      } catch (e) {
        logger.error(`Failed to remove expired cooldown for ${provider}:${model}`, e);
      }

      const keySuffix = keyId ? ` key '${keyId}'` : '';
      logger.info(`Provider '${provider}' model '${model}'${keySuffix} cooldown expired, marking as healthy`);
      return true;
    }

    return false;
  }

  public async filterHealthyTargets(targets: Target[]): Promise<Target[]> {
    const healthyTargets: Target[] = [];

    for (const target of targets) {
      const isHealthy = await this.isProviderHealthy(target.provider, target.model);
      if (isHealthy) {
        healthyTargets.push(target);
      }
    }

    return healthyTargets;
  }

  public async removeCooldowns(targets: Target[]): Promise<Target[]> {
    return this.filterHealthyTargets(targets);
  }

  public getCooldowns(): {
    provider: string;
    model: string;
    keyId?: string;
    expiry: number;
    timeRemainingMs: number;
    consecutiveFailures: number;
    lastError?: string;
  }[] {
    const now = Date.now();
    let providerConfig: Record<string, any> = {};
    try {
      providerConfig = getConfig().providers ?? {};
    } catch {
      // ignore — treat all providers as enabled
    }

    const results = [];
    for (const [key, entry] of this.cooldowns.entries()) {
      if (entry.expiry > now) {
        const parts = key.split(':');
        const provider = parts[0];
        if (!provider || providerConfig[provider]?.disable_cooldown === true) {
          continue;
        }
        const model = parts[1] || '';
        // 3-segment key is provider:model:keyId; 2-segment has no keyId
        const keyId = parts[2] || undefined;
        results.push({
          provider,
          model,
          keyId,
          expiry: entry.expiry,
          timeRemainingMs: entry.expiry - now,
          consecutiveFailures: entry.consecutiveFailures,
          lastError: entry.lastError,
        });
      }
    }
    return results;
  }

  /**
   * Hard-disable a provider key. Used by the auto-disable helper when a
   * quota error matches a configured pattern. The key is removed from
   * routing by:
   *  1. Setting the per-key cooldown (so `selectProviderKey` skips it)
   *  2. Persisting `providerKeys.enabled = 0` in the DB
   *  3. Calling `ConfigService.flush()` so the in-memory `api_keys` array
   *     is rebuilt without the disabled key.
   *
   * Per-key disable (keyId provided) does NOT cascade to other keys of
   * the same provider. The legacy path (no keyId) falls back to a
   * per-model cooldown.
   */
  public async markKeyAsDisabled(
    provider: string,
    model: string,
    keyId: string | undefined,
    reason?: string
  ): Promise<void> {
    if (!keyId) {
      // Legacy path: no keyId known. Fall back to per-model cooldown
      // (no DB-side disable, no ConfigService flush — keeps the existing
      // behavior for users without multi-key providers).
      await this.markProviderFailure(provider, model, undefined, reason, undefined);
      return;
    }
    logger.warn(
      `Disabling API key '${keyId}' for provider '${provider}' due to: ${reason || 'quota_exceeded'}`
    );
    await this.markProviderFailure(provider, model, undefined, reason, keyId);
    try {
      const db = this.ensureDb();
      const schema = this.schema as any;
      if (schema.providerKeys) {
        await db
          .update(schema.providerKeys)
          .set({ enabled: 0, updatedAt: new Date().toISOString() })
          .where(eq(schema.providerKeys.id, keyId));
        // Rebuild config cache so the disabled key disappears from
        // `route.config.api_keys` and from the quota emission. Imported
        // lazily to avoid a circular module reference at load time.
        const { ConfigService } = await import('../configuration/config-service');
        await ConfigService.getInstance().flush();
      }
    } catch (e) {
      logger.error(
        `Failed to persist disabled state for key '${keyId}' (cooldown still applied)`,
        e
      );
    }
  }

  public async clearKeyCooldown(
    provider: string,
    model: string,
    keyId: string
  ): Promise<void> {
    if (!keyId) {
      // Defensive: a missing keyId is a no-op here, not a model-level
      // cascade. Use `clearCooldown(provider, model)` for the model-level
      // slot.
      return;
    }
    const targetKey = CooldownManager.makeCooldownKey(provider, model, keyId);
    const existed = this.cooldowns.delete(targetKey);
    if (existed) {
      logger.info(
        `Manually cleared per-key cooldown for provider '${provider}' model '${model}' key '${keyId}'`
      );
    }
    try {
      const db = this.ensureDb();
      await db
        .delete(this.schema.providerCooldowns)
        .where(
          and(
            eq(this.schema.providerCooldowns.provider, provider),
            eq(this.schema.providerCooldowns.model, model),
            eq(this.schema.providerCooldowns.keyId, keyId)
          )
        );
    } catch (e) {
      logger.error(
        `Failed to delete per-key cooldown for ${provider}:${model}:${keyId}`,
        e
      );
    }
  }

  public async clearCooldown(provider?: string, model?: string): Promise<void> {
    if (provider && model) {
      // Per-key cooldowns (3-segment key like `${provider}:${model}:${keyId}`)
      // are NOT cleared by an admin "clear cooldowns" action — the admin
      // UI's intent is to clear the per-model slot only. Per-key rows
      // are removed by `markKeyAsDisabled` (which writes providerKeys.enabled
      // = 0 and flushes) or by `clearKeyCooldown` below. This prevents
      // accidentally wiping per-key circuit-breaker state when a model
      // is cleared.
      const keysToDelete = Array.from(this.cooldowns.keys()).filter(
        (key) => key === `${provider}:${model}`
      );
      keysToDelete.forEach((key) => this.cooldowns.delete(key));
      logger.info(
        `Manually cleared model-level cooldown for provider '${provider}' model '${model}' (${keysToDelete.length} total)`
      );
      try {
        const db = this.ensureDb();
        await db
          .delete(this.schema.providerCooldowns)
          .where(
            and(
              eq(this.schema.providerCooldowns.provider, provider),
              eq(this.schema.providerCooldowns.model, model),
              eq(this.schema.providerCooldowns.keyId, '')
            )
          );
      } catch (e) {
        logger.error(`Failed to delete cooldowns for ${provider}:${model}`, e);
      }
    } else if (provider) {
      // Same protection for the provider-wide clear: per-key rows are
      // preserved.
      const keysToDelete = Array.from(this.cooldowns.keys()).filter(
        (key) => key === `${provider}:` || key === `${provider}:`
      );
      keysToDelete.forEach((key) => this.cooldowns.delete(key));
      logger.info(
        `Manually cleared model-level cooldowns for provider '${provider}' (${keysToDelete.length} total)`
      );
      try {
        const db = this.ensureDb();
        await db
          .delete(this.schema.providerCooldowns)
          .where(
            and(
              eq(this.schema.providerCooldowns.provider, provider),
              eq(this.schema.providerCooldowns.keyId, '')
            )
          );
      } catch (e) {
        logger.error(`Failed to delete cooldowns for ${provider}`, e);
      }
    } else {
      this.cooldowns.clear();
      logger.info('Manually cleared all cooldowns');
      try {
        const db = this.ensureDb();
        await db.delete(this.schema.providerCooldowns);
      } catch (e) {
        logger.error('Failed to delete all cooldowns', e);
      }
    }
  }
}
