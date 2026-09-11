/**
 * Upstream request timeout utilities.
 *
 * Route-level timeout utilities.
 *
 * The route AbortController is reserved for client disconnects. Upstream
 * timeouts are resolved here but enforced per provider attempt in the
 * dispatcher so a timed-out provider can fail over without aborting the whole
 * route.
 */

import { getConfig } from '../config';
import { logger } from './logger';

/**
 * Resolve timeout settings for a route.
 *
 * The dispatcher calls `resolveTimeoutMs` after routing picks a provider.
 * Provider timeouts override the global default and may be shorter or longer.
 *
 * @param abortController The route's AbortController (the one passed to
 *   handleResponse for stream disconnect detection).
 * @param defaultTimeoutMs Override for the effective timeout in milliseconds.
 *   When null/undefined, the global default is used.
 * @returns The route signal plus a timeout resolver for provider attempts.
 */
export function wireUpstreamTimeout(
  abortController: AbortController,
  defaultTimeoutMs?: number | null
): { signal: AbortSignal; resolveTimeoutMs: (timeoutMs?: number | null) => number } {
  const config = getConfig();
  const globalTimeoutSeconds = config.timeout?.defaultSeconds ?? 300;
  const globalTimeoutMs = defaultTimeoutMs ?? globalTimeoutSeconds * 1000;

  return {
    signal: abortController.signal,
    resolveTimeoutMs: (providerTimeoutMs?: number | null) => providerTimeoutMs ?? globalTimeoutMs,
  };
}

/**
 * Observe an early socket closure before dispatch.
 *
 * Bun's node:http close/abort events are unreliable for streaming POST
 * responses. `bunHandle.closed` is useful telemetry, but it has produced
 * false positives for Codex Responses Lite traffic. That route can defer
 * cancellation while all other callers retain the existing abort behavior.
 *
 * Callers must call cleanup() after the dispatch completes (whether success
 * or failure) to stop the polling interval.
 */
export function wireEarlyDisconnectDetection(
  request: any,
  abortController: AbortController,
  requestId: string,
  deferSocketClose = false
): { cleanup: () => void } {
  const rawSocket = request?.raw?.socket;
  const symHandle = rawSocket
    ? Object.getOwnPropertySymbols(rawSocket).find((s: Symbol) => s.toString() === 'Symbol(handle)')
    : undefined;
  const bunHandle = symHandle ? rawSocket[symHandle] : null;

  if (!bunHandle) {
    // Can't detect disconnect without bunHandle (non-Bun runtime or no socket)
    return { cleanup: () => {} };
  }

  let cleanedUp = false;
  let poll: ReturnType<typeof setInterval> | null = setInterval(() => {
    if (cleanedUp) return;
    if (bunHandle.closed) {
      if (deferSocketClose) {
        logger.info(
          `Socket close observed for request ${requestId} before dispatch ` +
            '(source=bunHandle.closed); deferring upstream cancellation'
        );
      } else if (!abortController.signal.aborted) {
        logger.info(
          `Client disconnect observed for request ${requestId} before dispatch ` +
            '(source=bunHandle.closed); aborting upstream fetch'
        );
        abortController.abort(new DOMException('Client disconnected', 'AbortError'));
      }
      cleanedUp = true;
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    }
  }, 250);

  return {
    cleanup: () => {
      cleanedUp = true;
      if (poll) {
        clearInterval(poll);
        poll = null;
      }
    },
  };
}
