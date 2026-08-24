/**
 * Clipboard and crypto utility that handles secure and non-secure contexts.
 *
 * The Clipboard API (navigator.clipboard) and crypto.randomUUID() are only available
 * in secure contexts (HTTPS or localhost). In non-secure HTTP contexts, we provide
 * fallbacks that work everywhere.
 */

/**
 * Check if clipboard operations are available in the current context.
 * Returns true if either the modern Clipboard API (HTTPS/localhost) or
 * the legacy execCommand fallback (HTTP) is available.
 */
export const isClipboardAvailable = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  if (!!navigator.clipboard) return true;
  // Legacy fallback: document.execCommand('copy') works in HTTP contexts
  return typeof document !== 'undefined' && typeof document.execCommand === 'function';
};

/**
 * Check if we're in a secure context where clipboard operations work.
 */
export const isSecureContext = (): boolean => {
  // @ts-ignore - secureContext may not be defined in older browsers
  return typeof window !== 'undefined' && (window.isSecureContext ?? true);
};

/**
 * Get a user-friendly message explaining why clipboard is unavailable.
 * With the execCommand fallback, this should rarely be needed.
 */
export const getClipboardUnavailableMessage = (): string => {
  return 'Copy not available in this browser';
};

/**
 * Copy text to clipboard using a temporary textarea and execCommand.
 * Works in non-secure contexts (HTTP) where navigator.clipboard is unavailable.
 */
const copyWithExecCommand = (text: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;

  // Prevent scrolling and make invisible
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  document.body.appendChild(textarea);
  textarea.select();

  let success = false;
  try {
    success = document.execCommand('copy');
  } catch {
    success = false;
  }

  document.body.removeChild(textarea);
  return success;
};

/**
 * Attempt to copy text to clipboard.
 * Tries the modern Clipboard API first (HTTPS/localhost),
 * then falls back to execCommand for non-secure contexts (HTTP).
 */
export const copyToClipboard = async (text: string): Promise<boolean> => {
  // Try modern Clipboard API first (secure contexts)
  if (typeof navigator !== 'undefined' && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy fallback
    }
  }

  // Legacy fallback for non-secure contexts (HTTP)
  return copyWithExecCommand(text);
};

/**
 * Generate a UUID v4 using crypto.getRandomValues().
 * Works in both secure (HTTPS) and non-secure (HTTP) contexts.
 * Falls back to Math.random() if crypto is unavailable.
 */
export const generateUUID = (): string => {
  // Use crypto.getRandomValues if available (works in all contexts including HTTP)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);

    // Set version (4) and variant (2) bits per RFC 4122
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 10

    // Convert to hex string with dashes
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Fallback to Math.random() - not cryptographically secure but sufficient for API keys
  // when running in very old browsers without crypto support
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};
