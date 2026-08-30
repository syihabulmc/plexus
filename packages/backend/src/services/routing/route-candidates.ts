import type { UnifiedChatRequest } from '../../types/unified';
import { applyKeyAccessPolicy } from './key-access-policy';
import { Router, type RouteResult } from './router';
import { QuotaEnforcer } from '../quota/quota-enforcer';
import { buildQuotaExceededError } from '../quota/quota-middleware';
import { getConfig } from '../../config';
import type { ApiKeyEntry } from '../providers/provider-request-headers';
import type { RetryAttemptRecord } from '../dispatch/dispatcher-types';

export type AppendSkippedAttempt = (
  retryHistory: RetryAttemptRecord[],
  route: RouteResult,
  reason: string,
  apiType?: string
) => void;

/**
 * Per-key failover via candidate expansion. When a provider has multiple
 * usable API keys, emit that many clones of its candidate so the
 * dispatcher's existing failover loop walks the keys before moving to a
 * different provider.
 *
 * Why this works without hot-path changes: `selectProviderKey` picks the
 * first HEALTHY key, and `markProviderFailure` mutates the in-memory
 * cooldown map synchronously (before any await). So when clone #1's key
 * fails with a retryable error, the loop re-enters clone #2,
 * `selectProviderKey` re-scans, sees the just-cooled key as unhealthy,
 * and returns the next one. Clones share the (read-only) `config` by
 * reference but are distinct objects so per-attempt mutation
 * (`selectedKeyId`/`selectedKeyLabel`, `retryHistory`) does not collide.
 *
 * A single usable key (or none, or the legacy single api_key field) is
 * left as one entry — no behavior change for the common case.
 */
export function expandCandidatesPerKey(candidates: RouteResult[]): RouteResult[] {
  const expanded: RouteResult[] = [];
  for (const candidate of candidates) {
    const apiKeys: ApiKeyEntry[] =
      (candidate.config.api_keys as ApiKeyEntry[] | undefined) ?? [];
    const usableCount = apiKeys.filter(
      (k) => k.enabled !== false && !!k.api_key?.trim()
    ).length;
    const clones = Math.max(1, usableCount);
    for (let i = 0; i < clones; i++) {
      expanded.push(clones === 1 ? candidate : { ...candidate });
    }
  }
  return expanded;
}

/**
 * Apply per-key expansion only when failover + perKey are enabled AND at
 * least one candidate has multiple usable keys. Otherwise returns the
 * list unchanged. `failover.perKey` is opt-out: on unless explicitly false.
 * `failover.enabled === false` skips expansion entirely. Defensive
 * `getConfig()` try/catch: a load failure or disabled flag means "don't
 * expand" (legacy single api_key path stays single).
 */
export function maybeExpandPerKey(candidates: RouteResult[]): RouteResult[] {
  let failoverConfig;
  try {
    failoverConfig = getConfig().failover;
  } catch {
    return candidates;
  }
  if (failoverConfig?.enabled === false || failoverConfig?.perKey === false) {
    return candidates;
  }
  const hasMultiKey = candidates.some((c) => {
    const apiKeys: ApiKeyEntry[] = (c.config.api_keys as ApiKeyEntry[] | undefined) ?? [];
    return apiKeys.filter((k) => k.enabled !== false && !!k.api_key?.trim()).length > 1;
  });
  return hasMultiKey ? expandCandidatesPerKey(candidates) : candidates;
}

/** Resolves usable targets for a request, including access, quota, and per-key expansion. */
export async function resolveRouteCandidates(
  request: UnifiedChatRequest,
  retryHistory: RetryAttemptRecord[],
  sessionKey: string | null,
  appendSkippedAttempt: AppendSkippedAttempt
): Promise<RouteResult[]> {
  let candidates = await Router.resolveCandidates(
    request.model,
    request.incomingApiType,
    sessionKey
  );

  // Fallback for direct/provider/model syntax and legacy single-route behavior.
  if (candidates.length === 0) {
    candidates = [await Router.resolve(request.model, request.incomingApiType)];
  }

  if (candidates.length === 0) {
    throw new Error(`No route candidates found for model '${request.model}'`);
  }

  const apiType = request.incomingApiType || 'chat';
  candidates = applyKeyAccessPolicy(request, candidates, apiType);

  const quotaContext = request.metadata?.plexus_metadata?.plexus_quota_context ?? null;
  if (!quotaContext) {
    return maybeExpandPerKey(candidates);
  }

  const { allowed, blocked } = QuotaEnforcer.filterCandidates(quotaContext, candidates);
  for (const { candidate, quota } of blocked) {
    appendSkippedAttempt(retryHistory, candidate, `quota_exceeded:${quota.quotaName}`, apiType);
  }

  if (allowed.length === 0) {
    throw buildQuotaExceededError(
      blocked.map((entry) => entry.quota),
      retryHistory
    );
  }

  return maybeExpandPerKey(allowed);
}
