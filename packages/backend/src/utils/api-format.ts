export interface ApiFormat {
  type: string;
  subtype?: string;
}

export type ApiAccess = string | ApiFormat;

export function apiAccessToKey(access: ApiAccess): string {
  if (typeof access === 'string') return access.trim().toLowerCase();

  const type = access.type.trim().toLowerCase();
  const subtype = access.subtype?.trim().toLowerCase();
  return subtype ? `${type}:${subtype}` : type;
}

export function normalizeApiAccessList(access: readonly ApiAccess[] | undefined): string[] {
  if (!access) return [];
  return access.map(apiAccessToKey).filter(Boolean);
}

export function getApiBaseType(apiType: string): string {
  return apiType.trim().toLowerCase().split(':', 1)[0] || '';
}

export function getApiSubtype(apiType: string): string | undefined {
  const normalized = apiType.trim().toLowerCase();
  const separator = normalized.indexOf(':');
  return separator === -1 ? undefined : normalized.slice(separator + 1) || undefined;
}

export function isApiSubtype(apiType: string | undefined): boolean {
  return !!apiType && getApiSubtype(apiType) !== undefined;
}

/**
 * Target protocols able to serve an incoming `images` request. Providers
 * advertise these through `access_via` (or have them inferred from
 * `api_base_url`); the router and the per-target API type selection both
 * filter against this single list.
 */
export const IMAGE_TARGET_API_TYPES = [
  'chat',
  'gemini',
  'openai-images',
  'openrouter-images',
  'codex-images',
] as const;

const IMAGE_TARGET_API_TYPE_SET: ReadonlySet<string> = new Set(IMAGE_TARGET_API_TYPES);

/** True when `apiType`'s base type can serve an incoming `images` request. */
export function isImageTargetApiType(apiType: string): boolean {
  return IMAGE_TARGET_API_TYPE_SET.has(getApiBaseType(apiType));
}
