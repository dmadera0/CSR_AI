/**
 * api.js — fetch wrapper for the Demo chat API
 *
 * Handles the POST /chat call and maps network/HTTP errors to
 * user-friendly messages. All errors are thrown as Error objects
 * with a `code` property so the caller can distinguish error types.
 */

/**
 * sendMessage(apiUrl, sessionId, message)
 *
 * POSTs to <apiUrl>/chat with the user's message and the current
 * sessionId. Returns the parsed response JSON on success.
 *
 * Expected request:
 *   { sessionId: string, message: string }
 *
 * Expected response:
 *   { sessionId, reply, unknown_question, sources_used }
 *
 * Throws:
 *   Error with code = 'network_error'  — no internet / DNS failure
 *   Error with code = 'api_error'      — non-2xx HTTP response
 *   Error with code = 'parse_error'    — response is not valid JSON
 */
export async function sendMessage(apiUrl, sessionId, message) {
  let response;

  // ── Network call ───────────────────────────────────────────────
  // fetch() throws only on network-level failures (no internet, bad
  // hostname, CORS block before response). HTTP 4xx/5xx do NOT throw
  // here — they come through as response.ok === false below.
  try {
    response = await fetch(`${apiUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, message }),
    });
  } catch {
    // Network-level failure (offline, DNS error, CORS preflight fail).
    const err = new Error('Connection failed. Please check your internet and try again.');
    err.code = 'network_error';
    throw err;
  }

  // ── HTTP status check ──────────────────────────────────────────
  // API Gateway returns 4xx for bad requests, 5xx for server errors.
  // We surface a generic message — the raw status is available in
  // err.status if the caller needs it for debugging.
  if (!response.ok) {
    const err = new Error('Sorry, something went wrong. Please try again.');
    err.code = 'api_error';
    err.status = response.status;
    throw err;
  }

  // ── JSON parsing ───────────────────────────────────────────────
  // In the unlikely case the server returns non-JSON (e.g., a CloudFront
  // error page), we catch the parse failure and surface a clear message.
  let data;
  try {
    data = await response.json();
  } catch {
    const err = new Error('Sorry, something went wrong. Please try again.');
    err.code = 'parse_error';
    throw err;
  }

  return data;
}
