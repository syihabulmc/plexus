import { getConfig } from '../../config';
import { QUOTA_ERROR_PATTERNS } from '../../utils/constants';
import { logger } from '../../utils/logger';
import { CooldownManager } from '../runtime/cooldown-manager';

/**
 * Minimal shape the auto-disable helper needs from the current dispatch
 * attempt. Matches RouteResult fields used here so callers can pass a
 * `route` argument directly without an extra adapter.
 */
export interface AutoDisableRoute {
  provider: string;
  model: string;
  /**
   * The provider key that was selected for the attempt (when multi-key
   * is configured). When present, auto-disable targets only that key —
   * other keys on the same provider are unaffected (per the per-key
   * cooldown design).
   */
  selectedKeyId?: string;
}

/**
 * Match a request error against the configured auto-disable patterns AND
 * status code. Returns true only when BOTH:
 *  - the error message contains at least one configured pattern (default
 *    `QUOTA_ERROR_PATTERNS` when none configured)
 *  - status code is 402 (Payment Required) or 400 (Bad Request — some
 *    providers return 400 for "credit balance is too low")
 *
 * Pattern match is case-insensitive substring. The status-code requirement
 * prevents transient 429 rate-limits from triggering a hard disable.
 */
export function matchesQuotaError(error: any): boolean {
  const errorMsg = (error?.message || '').toLowerCase();
  const cfg = getConfig().autoDisableOnQuotaError as
    | { enabled?: boolean; mode?: 'provider' | 'key'; errorPatterns?: string[] }
    | undefined;
  const patterns =
    cfg?.errorPatterns && cfg.errorPatterns.length > 0
      ? cfg.errorPatterns
      : QUOTA_ERROR_PATTERNS;
  const matchedPattern = patterns.some((p) => errorMsg.includes(p.toLowerCase()));
  const statusCode = error?.routingContext?.statusCode;
  // Real-world providers commonly return 429 with a quota-style message
  // (Anthropic: "credit balance is too low", OpenAI: billing/quota language,
  // OpenRouter: "purchase more credits"). Without 429 here, auto-disable
  // never fires for those providers. A bare 429 with no quota message
  // (pure rate-limit) still won't match because the pattern check fails.
  const isQuotaStatus =
    statusCode === 402 || statusCode === 400 || statusCode === 429;
  return matchedPattern && isQuotaStatus;
}

/**
 * Auto-disable a key (or the model-level fallback) when the quota pattern
 * matches. No-op when:
 *  - the error does not match the pattern
 *  - `autoDisableOnQuotaError.enabled` is false
 *  - the route has no selectedKeyId AND no legacy path applies
 *
 * Per design: per-key auto-disable is preferred. The fallback (no keyId)
 * writes a per-model cooldown — a provider-wide cascade is intentionally
 * NOT performed because the user's intent is "treat each key as a
 * different provider".
 */
export async function autoDisableOnQuotaError(
  error: any,
  route: AutoDisableRoute
): Promise<void> {
  if (!matchesQuotaError(error)) return;
  const cfg = getConfig().autoDisableOnQuotaError as
    | { enabled?: boolean; mode?: 'provider' | 'key' }
    | undefined;
  if (!cfg?.enabled) return;
  const reason = `quota_exceeded: ${error?.message ?? ''}`;
  if (route.selectedKeyId) {
    logger.warn(
      `Quota/balance error on ${route.provider}:${route.model} key '${route.selectedKeyId}' — auto-disable (key mode): ${error?.message ?? ''}`
    );
    await CooldownManager.getInstance().markKeyAsDisabled(
      route.provider,
      route.model,
      route.selectedKeyId,
      reason
    );
    return;
  }
  // Legacy fallback when no keyId was selected. Per design this is the
  // per-model path, not a provider-wide cascade.
  logger.warn(
    `Quota/balance error on ${route.provider}:${route.model} — auto-disable (legacy model mode): ${error?.message ?? ''}`
  );
  await CooldownManager.getInstance().markKeyAsDisabled(
    route.provider,
    route.model,
    undefined,
    reason
  );
}
