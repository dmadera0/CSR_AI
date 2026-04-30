/**
 * markdown.js — lightweight markdown-to-HTML renderer
 *
 * No external dependencies. Handles the subset of markdown that
 * Claude commonly uses in customer service responses:
 *   • Code blocks (``` ... ```)
 *   • Inline code (` ... `)
 *   • Bold (**text**) and italic (*text*)
 *   • Links ([text](url) and bare https:// URLs)
 *   • Unordered lists (- item or * item)
 *   • Line breaks
 *
 * XSS SAFETY:
 *   All user-supplied text is HTML-escaped before any transformation.
 *   Code content is escaped separately before being wrapped in <code>.
 *   Only a known-safe set of HTML tags is ever emitted.
 *   Links always include rel="noopener noreferrer".
 */

// Escape HTML special characters to prevent XSS injection.
// Applied to all non-code text before markdown transformations.
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * renderMarkdown(text) → HTML string
 *
 * Returns safe HTML ready for dangerouslySetInnerHTML.
 * Empty or null input returns an empty string.
 *
 * ALGORITHM:
 *   1. Extract code blocks and inline code — store as placeholders.
 *      (This prevents the code content from being touched by later steps.)
 *   2. HTML-escape the remaining plain text.
 *   3. Apply markdown transformations (bold, italic, links, lists).
 *   4. Convert newlines to <br>.
 *   5. Restore the placeholders with the real (pre-escaped) HTML.
 */
export function renderMarkdown(text) {
  if (!text) return '';

  const placeholders = [];

  // ── Step 1a: Extract fenced code blocks ────────────────────────
  // Matches ```optional-lang\ncode\n``` — the language tag is ignored
  // since we don't include a syntax highlighting library.
  let result = text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, code) => {
    const escaped = escapeHtml(code.trim());
    placeholders.push(`<pre class="dcw-code"><code>${escaped}</code></pre>`);
    return `\x01${placeholders.length - 1}\x01`;
  });

  // ── Step 1b: Extract inline code ───────────────────────────────
  // Matches `code` — must come after code block extraction so that
  // backticks inside ``` blocks are already removed from the string.
  result = result.replace(/`([^`\n]+)`/g, (_, code) => {
    const escaped = escapeHtml(code);
    placeholders.push(`<code class="dcw-inline-code">${escaped}</code>`);
    return `\x01${placeholders.length - 1}\x01`;
  });

  // ── Step 2: Escape remaining HTML ──────────────────────────────
  // Placeholder markers (\x01 digits \x01) only contain ASCII digits,
  // so they pass through escapeHtml unaffected.
  result = escapeHtml(result);

  // ── Step 3: Markdown transformations ───────────────────────────
  result = result
    // Bold: **text** → <strong>
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    // Italic: *text* → <em>  (skip ** already consumed above)
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    // Markdown links: [label](https://...)
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    )
    // Bare https:// URLs not already inside an href or placeholder
    .replace(
      /(^|[^"'=\x01])(https?:\/\/[^\s<>"]+)/g,
      (_, pre, url) =>
        `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    )
    // Bullet list items: lines starting with - or *
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>')
    // Numbered list items: lines starting with 1. 2. etc.
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    // Wrap consecutive <li>…</li> blocks in a <ul>
    .replace(/((?:<li>.*?<\/li>(?:<br>|\\n)?)+)/g, '<ul>$1</ul>');

  // ── Step 4: Line breaks ─────────────────────────────────────────
  // Convert \n to <br>. Double newlines (paragraphs) become two <br>.
  result = result.replace(/\n/g, '<br>');

  // ── Step 5: Restore code placeholders ──────────────────────────
  result = result.replace(/\x01(\d+)\x01/g, (_, i) => placeholders[Number(i)]);

  return result;
}
