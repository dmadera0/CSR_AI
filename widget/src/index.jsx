/**
 * index.jsx — widget entry point
 *
 * Vite builds this file with format: 'iife' and name: 'DemoChat'.
 * The resulting bundle assigns the exported { init } function to
 * window.DemoChat, so customers call: DemoChat.init({ ... })
 *
 * init() does three things:
 *   1. Validates the required config fields
 *   2. Injects the widget CSS into <head> (once, idempotent)
 *   3. Mounts the React app into a new <div> appended to <body>
 *
 * ISOLATION:
 *   The widget lives entirely inside #demo-chat-widget-root.
 *   All CSS classes are prefixed dcw- to avoid conflicts.
 *   Errors inside the widget are caught and logged — they never
 *   propagate to crash the host page.
 *
 * IDEMPOTENCY:
 *   Calling init() more than once is a no-op after the first call.
 *   A warning is logged so the customer can fix their embed code.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './components/App';
import { STYLES } from './styles';

// Track whether init() has already been called in this page session.
let isInitialized = false;

/**
 * init(userConfig)
 *
 * Required config:
 *   apiUrl   (string) — base URL of the chat API
 *
 * Optional config:
 *   tenantId       (string) — identifies the customer (default: 'default')
 *   primaryColor   (string) — hex brand colour (default: '#2563eb')
 *   agentName      (string) — display name shown in the header (default: 'Demo')
 *   greetingMessage(string) — first message on open (default: friendly greeting)
 *   position       ('left'|'right') — corner for the bubble (default: 'right')
 */
export function init(userConfig = {}) {
  // ── Guard: only initialize once ────────────────────────────────
  if (isInitialized) {
    console.warn('[DemoChat] init() was already called. Ignoring duplicate call.');
    return;
  }

  // ── Validate required fields ────────────────────────────────────
  // apiUrl is the only hard requirement — without it we cannot make
  // any API calls, so we fail loudly and early.
  if (!userConfig.apiUrl || typeof userConfig.apiUrl !== 'string') {
    console.error('[DemoChat] init() requires a valid apiUrl string.');
    return;
  }

  // ── Normalise config ────────────────────────────────────────────
  // Strip a trailing slash from apiUrl so callers can optionally
  // include one without breaking the `/chat` path concatenation.
  const config = {
    tenantId:        userConfig.tenantId        || 'default',
    apiUrl:          userConfig.apiUrl.replace(/\/$/, ''),
    primaryColor:    userConfig.primaryColor    || '#2563eb',
    agentName:       userConfig.agentName       || 'Demo',
    greetingMessage: userConfig.greetingMessage !== undefined
      ? userConfig.greetingMessage
      : 'Hi there! 👋 How can I help you today?',
    position:        userConfig.position === 'left' ? 'left' : 'right',
  };

  // ── Inject CSS ──────────────────────────────────────────────────
  // We write all widget styles as a JS string (styles.js) and inject
  // them as a <style> tag so the widget has zero external assets.
  // The id check makes this idempotent even if called from a SPA
  // that re-hydrates the page without a full reload.
  if (!document.getElementById('demo-chat-widget-styles')) {
    const styleEl = document.createElement('style');
    styleEl.id = 'demo-chat-widget-styles';
    styleEl.textContent = STYLES;
    document.head.appendChild(styleEl);
  }

  // ── Mount React ─────────────────────────────────────────────────
  // Create a dedicated container div so the widget never touches any
  // of the host page's existing DOM. All widget DOM lives inside here.
  const container = document.createElement('div');
  container.id = 'demo-chat-widget-root';
  document.body.appendChild(container);

  // createRoot is the React 18 API for concurrent rendering.
  // We don't need StrictMode in the production bundle.
  try {
    const root = createRoot(container);
    root.render(<App config={config} />);
    isInitialized = true;
  } catch (err) {
    // If React fails to mount (extremely rare), clean up the container
    // so the host page is not left with an orphaned div, and surface
    // a clear error to the customer's developer console.
    container.remove();
    console.error('[DemoChat] Failed to mount widget:', err);
  }
}
