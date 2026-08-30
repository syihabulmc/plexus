/**
 * Group provider keys by (provider_id, normalized api_key) so the
 * "Consolidate Duplicates" modal can ask the user to pick which row
 * to keep. Pure data — no React, no UI.
 */

export interface DuplicateGroup {
  providerId: string;
  providerSlug: string | null;
  apiKeyNormalized: string;
  rows: any[]; // ProviderKey[]
}

export function groupDuplicateProviderKeys(
  keys: any[],
  resolveSlug: (providerId: string) => string | null
): DuplicateGroup[] {
  const buckets = new Map<string, DuplicateGroup>();
  for (const k of keys) {
    const norm = (k.api_key ?? '').trim().toLowerCase();
    if (!norm) continue;
    const slug = resolveSlug(k.provider_id);
    const groupKey = `${k.provider_id}::${norm}`;
    if (!buckets.has(groupKey)) {
      buckets.set(groupKey, {
        providerId: k.provider_id,
        providerSlug: slug,
        apiKeyNormalized: norm,
        rows: [],
      });
    }
    buckets.get(groupKey)!.rows.push(k);
  }
  return Array.from(buckets.values())
    .filter((g) => g.rows.length >= 2)
    .sort((a, b) => (a.providerSlug ?? '').localeCompare(b.providerSlug ?? ''));
}
