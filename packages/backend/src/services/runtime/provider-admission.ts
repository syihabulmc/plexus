import type { RouteResult } from '../routing/router';
import { CooldownManager } from './cooldown-manager';
import { ConcurrencyTracker } from './concurrency-tracker';
import type { ApiKeyEntry } from '../providers/provider-request-headers';

export type ProviderAdmission =
  | { admitted: true; release: () => void }
  | { admitted: false; reason: string };

/**
 * Checks whether a provider can accept a request and reserves its concurrency
 * slot. Call `release` exactly once after an admitted attempt completes.
 *
 * For multi-key providers the model-level cooldown gate (which
 * `handleProviderError` historically wrote without a keyId) does not
 * reflect a per-key reality — one bad key could lock out every sibling.
 * When `api_keys` is configured we instead require only that at least one
 * key is healthy on its per-key slot, mirroring the `selectProviderKey`
 * check. The legacy single-`api_key` path keeps the existing behavior.
 */
export async function admitProvider(route: RouteResult): Promise<ProviderAdmission> {
  const cm = CooldownManager.getInstance();
  const apiKeys: ApiKeyEntry[] | undefined = route.config.api_keys as
    | ApiKeyEntry[]
    | undefined;

  if (apiKeys && apiKeys.length > 0) {
    let hasHealthyKey = false;
    for (const key of apiKeys) {
      if (key.enabled === false) continue;
      if (!key.api_key?.trim()) continue;
      const cbHealthy = await cm.isProviderHealthy(route.provider, route.model, key.id);
      const quotaHealthy = await cm.isProviderHealthy(route.provider, '', key.id);
      if (cbHealthy && quotaHealthy) {
        hasHealthyKey = true;
        break;
      }
    }
    if (!hasHealthyKey) {
      return {
        admitted: false,
        reason: `Provider ${route.provider}/${route.model} is on cooldown (all ${apiKeys.length} key(s) unavailable)`,
      };
    }
  } else {
    // Legacy single api_key path. Keep the model-level gate so a global
    // outage still blocks dispatch.
    const healthy = await cm.isProviderHealthy(route.provider, route.model);
    if (!healthy) {
      return {
        admitted: false,
        reason: `Provider ${route.provider}/${route.model} is on cooldown`,
      };
    }
  }

  const acquired = ConcurrencyTracker.getInstance().acquire(route.provider, route.model);
  if (!acquired) {
    return {
      admitted: false,
      reason: `Provider ${route.provider}/${route.model} concurrency limit exceeded`,
    };
  }

  let released = false;
  return {
    admitted: true,
    release: () => {
      if (!released) {
        released = true;
        ConcurrencyTracker.getInstance().release(route.provider, route.model);
      }
    },
  };
}
