/**
 * uuid.js — UUID v4 generator
 *
 * Uses the browser's built-in crypto.randomUUID() when available
 * (Chrome 92+, Firefox 95+, Safari 15.4+, all modern browsers).
 * Falls back to a Math.random()-based implementation for any older
 * browsers that might still embed this widget.
 */
export function generateUUID() {
  // crypto.randomUUID() is cryptographically strong and requires no
  // external library. Available in all browsers released since 2021.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // Fallback: RFC 4122 v4 UUID using Math.random().
  // Not cryptographically secure but sufficient for session IDs.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
