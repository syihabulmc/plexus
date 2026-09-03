import type { UnifiedChatRequest } from '../../types/unified';
import { getApiBaseType } from '../../utils/api-format';
import type { RouteResult } from '../routing/router';
import { CooldownManager } from '../runtime/cooldown-manager';
import { logger } from '../../utils/logger';

/**
 * A single API key attached to a provider via the `api_keys` array on
 * `ProviderConfig`. Populated by ConfigService.doRebuild from the
 * `provider_keys` DB table (api_key + management_key decrypted).
 */
export interface ApiKeyEntry {
  id: string;
  api_key: string;
  enabled?: boolean;
  label?: string;
  priority?: number;
}

/**
 * Pick the first healthy key from `route.config.api_keys`. Sorts by
 * `priority` ascending (lower number = earlier in routing order). Skips
 * disabled keys, blank api_keys, and keys that are on cooldown. Returns
 * undefined when no keys are configured (legacy single api_key path) or
 * when all keys are unavailable.
 */
export async function selectProviderKey(route: RouteResult): Promise<ApiKeyEntry | undefined> {
  const apiKeys: ApiKeyEntry[] = (route.config.api_keys as ApiKeyEntry[] | undefined) ?? [];
  if (apiKeys.length === 0) return undefined;

  const cm = CooldownManager.getInstance();

  // Honor a pre-stamped sticky keyId (e.g. from Router sticky_session
  // hoisting) before the priority sort. Falls through to the priority
  // loop if the sticky key is missing, disabled, blank, or on cooldown.
  if (route.selectedKeyId) {
    const sticky = apiKeys.find((k) => k.id === route.selectedKeyId);
    if (
      sticky &&
      sticky.enabled !== false &&
      sticky.api_key?.trim() &&
      (await cm.isProviderHealthy(route.provider, route.model, sticky.id)) &&
      (await cm.isProviderHealthy(route.provider, '', sticky.id))
    ) {
      return sticky;
    }
  }

  // Defensive sort — config-service also sorts by priority, but the helper
  // re-sorts so it works regardless of caller. Stable sort: equal
  // priorities keep array order.
  const ordered = [...apiKeys].sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  for (const key of ordered) {
    if (key.enabled === false) continue;
    if (!key.api_key?.trim()) continue;
    // Per-key cooldown check across BOTH cooldown systems:
    //   - circuit-breaker (model=route.model): set by markProviderFailure
    //     on HTTP errors / timeouts
    //   - quota-scheduler (model=''): set by quota-scheduler when a meter
    //     hits exhaustion; the slot is `${provider}::${keyId}`
    // Per design there is no provider-wide cascade — per-key slot is
    // independent from other keys on the same provider.
    const cbHealthy = await cm.isProviderHealthy(
      route.provider,
      route.model,
      key.id
    );
    const quotaHealthy = await cm.isProviderHealthy(
      route.provider,
      '',
      key.id
    );
    if (cbHealthy && quotaHealthy) return key;
  }
  return undefined;
}

/**
 * Resolve the user-facing label of the selected key. Returns the trimmed
 * label, or `'default'` for the legacy single api_key path / unset label.
 * Coalescing all unknown sources to `'default'` is intentional: the Logs
 * page and the in-flight request_usage row always carry a non-empty label
 * for human readability.
 */
export function resolveSelectedKeyLabel(
  selectedKey: { label?: string } | undefined
): string {
  const trimmed = selectedKey?.label?.trim();
  return trimmed ? trimmed : 'default';
}

/**
 * Build the ALL_KEYS_UNAVAILABLE error thrown by `setupProviderHeaders`
 * when `api_keys` is configured but every key is unhealthy. The error
 * carries a stable `code` so callers can match it (instead of fragile
 * message matching) to skip cooldown extension (the failure is a
 * consequence of existing state, not a new failure).
 */
export function buildAllKeysUnavailableError(
  provider: string,
  apiKeys: ApiKeyEntry[]
): Error & { code?: string } {
  let cooldownCount = 0;
  let disabledCount = 0;
  for (const k of apiKeys) {
    if (k.enabled === false || !k.api_key?.trim()) {
      disabledCount++;
    } else {
      cooldownCount++;
    }
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

/**
 * Build the HTTP headers for the upstream call. When the provider has
 * `api_keys`, picks the first healthy key, stamps `route.selectedKeyId`
 * and `route.selectedKeyLabel`, and injects the key as the auth header
 * (Bearer / x-api-key / x-goog-api-key based on the api base type). When
 * the provider has no `api_keys`, falls back to the legacy single
 * `api_key` field with label `'default'`. Throws ALL_KEYS_UNAVAILABLE
 * when `api_keys` is non-empty but no key is healthy.
 */
export async function setupProviderHeaders(
  route: RouteResult,
  apiType: string,
  request: UnifiedChatRequest
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Set Accept header based on streaming
  if (request.stream) {
    headers['Accept'] = 'text/event-stream';
  } else {
    headers['Accept'] = 'application/json';
  }

  const apiKeys: ApiKeyEntry[] = (route.config.api_keys as ApiKeyEntry[] | undefined) ?? [];
  const selectedKey = await selectProviderKey(route);

  if (selectedKey) {
    route.selectedKeyId = selectedKey.id;
    route.selectedKeyLabel = resolveSelectedKeyLabel(selectedKey);
  } else if (apiKeys.length === 0) {
    // Legacy single api_key path. Clear stale keyId from any prior
    // attempt on the same route object.
    route.selectedKeyId = undefined;
    route.selectedKeyLabel = resolveSelectedKeyLabel(undefined);
  } else {
    // api_keys is configured but no key is healthy.
    logger.debug(
      `All ${apiKeys.length} API key(s) for provider '${route.provider}' are unavailable`
    );
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
      // Default to Bearer for Chat (OpenAI) and others
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
  } else {
    throw new Error(`No API key configured for provider '${route.provider}'`);
  }

  if (route.config.headers) {
    Object.assign(headers, route.config.headers);
  }

  // Forward cache routing headers for Responses API prompt caching.
  // These headers enable server-side cache routing at the upstream provider
  // (e.g. theclawbay, OpenAI). Without them, each request may land on a
  // different backend server, causing cache misses.
  if (request.cacheRoutingHeaders) {
    if (request.cacheRoutingHeaders.session_id) {
      // OpenAI's Codex backend deprecated the underscored header in favor of
      // the hyphenated form (more proxy-compatible); the old name is now
      // silently ignored upstream, so send the current one.
      headers['session-id'] = request.cacheRoutingHeaders.session_id;
    }
    if (request.cacheRoutingHeaders['x-client-request-id']) {
      headers['x-client-request-id'] = request.cacheRoutingHeaders['x-client-request-id'];
    }
    if (request.cacheRoutingHeaders['x-session-affinity']) {
      headers['x-session-affinity'] = request.cacheRoutingHeaders['x-session-affinity'];
    }
    if (request.cacheRoutingHeaders['x-session-id']) {
      headers['x-session-id'] = request.cacheRoutingHeaders['x-session-id'];
    }
    if (request.cacheRoutingHeaders['x-prompt-cache-isolation-key']) {
      headers['x-prompt-cache-isolation-key'] =
        request.cacheRoutingHeaders['x-prompt-cache-isolation-key'];
    }
    if (request.cacheRoutingHeaders['x-multi-turn-session-id']) {
      headers['x-multi-turn-session-id'] = request.cacheRoutingHeaders['x-multi-turn-session-id'];
    }
  }

  if (getApiBaseType(apiType) === 'messages' && request.anthropicBeta) {
    headers['anthropic-beta'] = request.anthropicBeta;
  }

  if (apiType.toLowerCase() === 'responses:lite') {
    headers['x-openai-internal-codex-responses-lite'] = 'true';
  }

  return headers;
}
