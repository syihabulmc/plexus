import type { UnifiedChatRequest } from '../../types/unified';

interface StickyEntry {
  provider: string;
  model: string;
  // Per-key sticky: the conversation sticks to a specific API key, not just
  // a specific (provider, model) tuple. When the stored keyId is on
  // cooldown, the dispatcher's normal failover path rotates to the next
  // healthy key (and the sticky entry is updated to the new key). The
  // user's design intent is "treat each key as a different provider" so
  // per-key stickiness matches that model.
  keyId?: string;
}

/**
 * In-memory LRU mapping conversation session → (provider, model) for the last
 * successful dispatch on that session. Used by aliases with `sticky_session`
 * enabled so multi-turn requests prefer the same target for cache locality and
 * model-version consistency.
 *
 * Keyed by `${alias}:${apiType}:${sessionKey}` so two aliases or API wire
 * contracts sharing a conversation prefix cannot poison each other.
 *
 * No TTL. Bounded by MAX_ENTRIES with insertion-order LRU eviction (Map keeps
 * insertion order; `get` re-inserts to refresh recency).
 */
export class StickySessionManager {
  private static readonly MAX_ENTRIES = 10_000;
  private static instance: StickySessionManager;

  private entries: Map<string, StickyEntry> = new Map();

  public static getInstance(): StickySessionManager {
    if (!StickySessionManager.instance) {
      StickySessionManager.instance = new StickySessionManager();
    }
    return StickySessionManager.instance;
  }

  /**
   * Derive a session key for the request, or null when stickiness does not
   * apply (single-turn requests).
   *
   * - Responses API: prefer `previousResponseId` (already a stable chain id).
   * - Otherwise: hash the first two messages (system + first user, typically),
   *   which is constant-size work regardless of conversation length and is
   *   stable across turns of the same conversation.
   */
  public static computeSessionKey(req: UnifiedChatRequest): string | null {
    if (req.previousResponseId) {
      return `r:${req.previousResponseId}`;
    }
    if (!req.messages || req.messages.length < 2) {
      return null;
    }
    const anchor = JSON.stringify(req.messages.slice(0, 2));
    return `m:${Bun.hash(anchor).toString(16)}`;
  }

  private static makeKey(alias: string, apiType: string, sessionKey: string): string {
    return `${alias}:${apiType.trim().toLowerCase()}:${sessionKey}`;
  }

  public get(alias: string, apiType: string, sessionKey: string): StickyEntry | null {
    const key = StickySessionManager.makeKey(alias, apiType, sessionKey);
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Refresh recency: re-insert to move to tail.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  public set(
    alias: string,
    apiType: string,
    sessionKey: string,
    provider: string,
    model: string,
    keyId?: string
  ): void {
    const key = StickySessionManager.makeKey(alias, apiType, sessionKey);
    // Delete first so re-setting refreshes recency.
    this.entries.delete(key);
    this.entries.set(key, { provider, model, keyId });
    if (this.entries.size > StickySessionManager.MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /** Test helper. */
  public clear(): void {
    this.entries.clear();
  }

  /** Test helper. */
  public size(): number {
    return this.entries.size;
  }
}
