import { logger } from '../../utils/logger';
import { getConfig } from '../../config';

export interface ConcurrencySnapshot {
  providers: Record<string, number>;
  targets: Record<string, number>;
}

/**
 * Internal sentinel used when a call site has no real `keyId` to attribute
 * the slot to (e.g. the legacy single `api_key` path, or callers that
 * haven't yet run key selection). Real key ids come from the
 * `provider_keys` DB table and are user-defined, so a leading-underscore
 * sentinel cannot collide with a real id.
 */
const LEGACY_KEY_SENTINEL = '__legacy__';

export class ConcurrencyTracker {
  private static instance: ConcurrencyTracker;
  // Per-key provider slots: key = `${provider}|${keyId}`. Aggregating the
  // values across all keyIds for a provider gives the legacy "total
  // in-flight for this provider" reading that the router filter and
  // getSnapshot expect.
  private providerCounts = new Map<string, number>();
  // Per-key target slots: key = `${provider}/${model}|${keyId}`.
  private providerModelCounts = new Map<string, number>();

  private constructor() {}

  public static getInstance(): ConcurrencyTracker {
    if (!ConcurrencyTracker.instance) {
      ConcurrencyTracker.instance = new ConcurrencyTracker();
    }
    return ConcurrencyTracker.instance;
  }

  /** For testing only */
  public static resetForTesting(): void {
    ConcurrencyTracker.instance = undefined as any;
  }

  /**
   * Attempt to acquire a concurrency slot for the given provider+model+key.
   * The slot is per-key so that multi-key providers (3 keys, maxConcurrency=1)
   * can have one in-flight request per key — without this, candidate clones
   * targeting different keys would collide on a single shared slot.
   *
   * Returns true if acquired, false if the per-key provider-wide or
   * per-key model-specific limit would be exceeded.
   */
  public acquire(provider: string, model: string, keyId?: string): boolean {
    const config = getConfig();
    const providerConfig = config.providers[provider];
    if (!providerConfig) {
      // Provider not found — shouldn't happen in normal flow, but be permissive
      return true;
    }

    const providerLimit = providerConfig.maxConcurrency;
    const modelConfig =
      !Array.isArray(providerConfig.models) && providerConfig.models
        ? providerConfig.models[model]
        : undefined;
    const modelLimit = modelConfig?.maxConcurrency;

    const safeKey = keyId ?? LEGACY_KEY_SENTINEL;
    const providerSlot = `${provider}|${safeKey}`;
    const modelSlot = `${provider}/${model}|${safeKey}`;

    if (providerLimit != null) {
      const current = this.providerCounts.get(providerSlot) || 0;
      if (current >= providerLimit) {
        logger.debug(
          `ConcurrencyTracker: provider '${provider}' key '${safeKey}' limit ${providerLimit} reached (${current} in-flight)`
        );
        return false;
      }
    }

    if (modelLimit != null) {
      const current = this.providerModelCounts.get(modelSlot) || 0;
      if (current >= modelLimit) {
        logger.debug(
          `ConcurrencyTracker: target '${provider}/${model}' key '${safeKey}' limit ${modelLimit} reached (${current} in-flight)`
        );
        return false;
      }
    }

    this.providerCounts.set(providerSlot, (this.providerCounts.get(providerSlot) || 0) + 1);
    this.providerModelCounts.set(modelSlot, (this.providerModelCounts.get(modelSlot) || 0) + 1);
    return true;
  }

  /**
   * Release a concurrency slot. Safe to call multiple times for the same
   * provider/model/key — subsequent calls are no-ops.
   */
  public release(provider: string, model: string, keyId?: string): void {
    const safeKey = keyId ?? LEGACY_KEY_SENTINEL;
    const providerSlot = `${provider}|${safeKey}`;
    const modelSlot = `${provider}/${model}|${safeKey}`;

    const providerCount = Math.max(
      0,
      (this.providerCounts.get(providerSlot) || 0) - 1
    );
    if (providerCount === 0) {
      this.providerCounts.delete(providerSlot);
    } else {
      this.providerCounts.set(providerSlot, providerCount);
    }

    const modelCount = Math.max(0, (this.providerModelCounts.get(modelSlot) || 0) - 1);
    if (modelCount === 0) {
      this.providerModelCounts.delete(modelSlot);
    } else {
      this.providerModelCounts.set(modelSlot, modelCount);
    }
  }

  public getProviderCount(provider: string): number {
    // Aggregate across all keyIds for this provider. Preserves the legacy
    // "total in-flight for this provider" reading that the router's
    // concurrency filter relies on.
    const prefix = `${provider}|`;
    let total = 0;
    for (const [k, v] of this.providerCounts.entries()) {
      if (k.startsWith(prefix)) total += v;
    }
    return total;
  }

  public getTargetCount(provider: string, model: string): number {
    const prefix = `${provider}/${model}|`;
    let total = 0;
    for (const [k, v] of this.providerModelCounts.entries()) {
      if (k.startsWith(prefix)) total += v;
    }
    return total;
  }

  public getSnapshot(): ConcurrencySnapshot {
    // Aggregate per provider and per provider/model across all keyIds so
    // the existing shape (`{ providers: {p1: N}, targets: {'p1/m1': N} }`)
    // is preserved for consumers (management routes, metrics).
    const providers: Record<string, number> = {};
    const targets: Record<string, number> = {};
    for (const [k, v] of this.providerCounts.entries()) {
      const provider = k.slice(0, k.indexOf('|'));
      providers[provider] = (providers[provider] || 0) + v;
    }
    for (const [k, v] of this.providerModelCounts.entries()) {
      const pipeIdx = k.indexOf('|');
      const combo = k.slice(0, pipeIdx);
      targets[combo] = (targets[combo] || 0) + v;
    }
    return { providers, targets };
  }
}
