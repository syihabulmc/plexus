/**
 * Marks a provider whose upstream URL is resolved through OAuth at request time.
 * OAuth placeholders are not dispatchable endpoints.
 */
export function isOAuthPlaceholderUrl(value: string): boolean {
  return value.trim().toLowerCase().startsWith('oauth://');
}
