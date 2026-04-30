/**
 * styles.js — complete widget CSS as a JS string
 *
 * Exported as a string so index.jsx can inject it into <head> as a
 * <style> tag. This keeps the widget fully self-contained — no
 * external stylesheet for the customer to host.
 *
 * All classes are prefixed dcw- (DemoChat Widget) to avoid clashing
 * with any CSS on the customer's page.
 *
 * High-specificity selectors (#demo-chat-widget-root .dcw-*) ensure
 * the widget's styles win against generic resets and base styles the
 * host page may have, without needing !important everywhere.
 */
export const STYLES = `
/* ── Widget root container ──────────────────────────────────── */
/* position:fixed + zero size means the container itself takes up no
   space and passes all pointer events through to the page underneath.
   The actual bubble and window use their own position:fixed. */
#demo-chat-widget-root {
  position: fixed;
  top: 0;
  left: 0;
  width: 0;
  height: 0;
  z-index: 2147483640;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
               'Helvetica Neue', Arial, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #1e293b;
  -webkit-font-smoothing: antialiased;
}

/* Re-enable pointer events on all actual widget elements */
#demo-chat-widget-root * {
  box-sizing: border-box;
  pointer-events: auto;
}

/* ── Floating bubble ────────────────────────────────────────── */
#demo-chat-widget-root .dcw-bubble {
  position: fixed;
  bottom: 24px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18), 0 2px 4px rgba(0, 0, 0, 0.10);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  z-index: 2147483647;
  padding: 0;
  outline: none;
}
#demo-chat-widget-root .dcw-bubble:hover {
  transform: scale(1.07);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.22);
}
#demo-chat-widget-root .dcw-bubble:active {
  transform: scale(0.96);
}
#demo-chat-widget-root .dcw-bubble:focus-visible {
  outline: 3px solid rgba(37, 99, 235, 0.5);
  outline-offset: 3px;
}
#demo-chat-widget-root .dcw-bubble--right { right: 24px; }
#demo-chat-widget-root .dcw-bubble--left  { left: 24px;  }

/* Pulse animation — shown while API call is in flight */
#demo-chat-widget-root .dcw-bubble--pulse {
  animation: dcw-pulse 1.8s ease-in-out infinite;
}
@keyframes dcw-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0.50); }
  70%  { box-shadow: 0 0 0 12px rgba(37, 99, 235, 0); }
  100% { box-shadow: 0 0 0 0 rgba(37, 99, 235, 0); }
}

/* ── Chat window ────────────────────────────────────────────── */
#demo-chat-widget-root .dcw-window {
  position: fixed;
  bottom: 92px;
  width: 350px;
  height: 500px;
  background: #ffffff;
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.15), 0 4px 20px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2147483646;
  animation: dcw-slide-up 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}
#demo-chat-widget-root .dcw-window--right { right: 24px; }
#demo-chat-widget-root .dcw-window--left  { left: 24px;  }

@keyframes dcw-slide-up {
  from { opacity: 0; transform: translateY(20px) scale(0.97); }
  to   { opacity: 1; transform: translateY(0)    scale(1);    }
}

/* ── Header ─────────────────────────────────────────────────── */
#demo-chat-widget-root .dcw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 14px;
  color: #ffffff;
  flex-shrink: 0;
  user-select: none;
}
#demo-chat-widget-root .dcw-header-info {
  display: flex;
  align-items: center;
  gap: 10px;
}
#demo-chat-widget-root .dcw-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.22);
  flex-shrink: 0;
}
#demo-chat-widget-root .dcw-agent-name {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}
#demo-chat-widget-root .dcw-agent-status {
  font-size: 11px;
  opacity: 0.88;
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 1px;
}
#demo-chat-widget-root .dcw-status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #4ade80;
  flex-shrink: 0;
}
#demo-chat-widget-root .dcw-close-btn {
  background: rgba(255, 255, 255, 0.18);
  border: none;
  border-radius: 8px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  color: #ffffff;
  transition: background 0.15s;
  flex-shrink: 0;
  padding: 0;
}
#demo-chat-widget-root .dcw-close-btn:hover {
  background: rgba(255, 255, 255, 0.30);
}

/* ── Messages area ──────────────────────────────────────────── */
#demo-chat-widget-root .dcw-messages {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #f8fafc;
  scroll-behavior: smooth;
}
#demo-chat-widget-root .dcw-messages::-webkit-scrollbar {
  width: 4px;
}
#demo-chat-widget-root .dcw-messages::-webkit-scrollbar-track {
  background: transparent;
}
#demo-chat-widget-root .dcw-messages::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 2px;
}

/* ── Individual messages ────────────────────────────────────── */
#demo-chat-widget-root .dcw-msg-row {
  display: flex;
  animation: dcw-fade-in 0.18s ease-out;
}
#demo-chat-widget-root .dcw-msg-row--user      { justify-content: flex-end; }
#demo-chat-widget-root .dcw-msg-row--assistant { justify-content: flex-start; }

@keyframes dcw-fade-in {
  from { opacity: 0; transform: translateY(5px); }
  to   { opacity: 1; transform: translateY(0);   }
}

#demo-chat-widget-root .dcw-msg-bubble {
  max-width: 82%;
  padding: 9px 13px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.55;
  word-break: break-word;
  overflow-wrap: break-word;
  border: 1px solid transparent;
}
/* User bubbles: solid primaryColor from inline style */
#demo-chat-widget-root .dcw-msg-bubble--user {
  border-radius: 16px 16px 4px 16px;
  color: #ffffff;
}
/* Assistant bubbles: light tint from inline style */
#demo-chat-widget-root .dcw-msg-bubble--assistant {
  border-radius: 16px 16px 16px 4px;
  color: #1e293b;
}
/* Error state */
#demo-chat-widget-root .dcw-msg-bubble--error {
  background: #fef2f2 !important;
  border-color: #fecaca !important;
  color: #b91c1c !important;
}

/* ── Markdown within messages ───────────────────────────────── */
#demo-chat-widget-root .dcw-msg-bubble strong { font-weight: 600; }
#demo-chat-widget-root .dcw-msg-bubble em     { font-style: italic; }
#demo-chat-widget-root .dcw-msg-bubble ul     { margin: 5px 0; padding-left: 18px; }
#demo-chat-widget-root .dcw-msg-bubble li     { margin: 3px 0; }
#demo-chat-widget-root .dcw-msg-bubble a {
  color: #2563eb;
  text-decoration: underline;
}
#demo-chat-widget-root .dcw-msg-bubble--user a { color: rgba(255,255,255,0.88); }
#demo-chat-widget-root .dcw-msg-bubble pre.dcw-code {
  background: #1e293b;
  color: #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12px;
  font-family: 'Cascadia Code', 'Fira Code', Consolas, 'Courier New', monospace;
  margin: 6px 0 0;
  white-space: pre;
  line-height: 1.5;
}
#demo-chat-widget-root .dcw-msg-bubble code.dcw-inline-code {
  background: rgba(0, 0, 0, 0.08);
  padding: 1px 5px;
  border-radius: 4px;
  font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace;
  font-size: 12px;
}
#demo-chat-widget-root .dcw-msg-bubble--user code.dcw-inline-code {
  background: rgba(255, 255, 255, 0.22);
}

/* ── Typing indicator ───────────────────────────────────────── */
#demo-chat-widget-root .dcw-typing-row {
  display: flex;
  justify-content: flex-start;
}
#demo-chat-widget-root .dcw-typing {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 10px 14px;
  background: #e2e8f0;
  border-radius: 16px 16px 16px 4px;
}
#demo-chat-widget-root .dcw-typing span {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #94a3b8;
  animation: dcw-bounce 1.3s ease-in-out infinite;
}
#demo-chat-widget-root .dcw-typing span:nth-child(2) { animation-delay: 0.18s; }
#demo-chat-widget-root .dcw-typing span:nth-child(3) { animation-delay: 0.36s; }
@keyframes dcw-bounce {
  0%, 60%, 100% { transform: translateY(0);   }
  30%           { transform: translateY(-6px); }
}

/* ── Input area ─────────────────────────────────────────────── */
#demo-chat-widget-root .dcw-input-area {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  background: #ffffff;
  border-top: 1px solid #e2e8f0;
  flex-shrink: 0;
}
#demo-chat-widget-root .dcw-input {
  flex: 1;
  resize: none;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  padding: 9px 12px;
  font-size: 14px;
  font-family: inherit;
  color: #1e293b;
  background: #f8fafc;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
  line-height: 1.45;
  min-height: 40px;
  max-height: 100px;
  overflow-y: auto;
}
#demo-chat-widget-root .dcw-input:focus {
  border-color: #2563eb;
  background: #ffffff;
}
#demo-chat-widget-root .dcw-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
#demo-chat-widget-root .dcw-input::placeholder { color: #94a3b8; }
#demo-chat-widget-root .dcw-send-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: none;
  background: #e2e8f0;
  color: #94a3b8;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s, color 0.15s, transform 0.12s;
  padding: 0;
}
/* Active state: primary color injected via inline style in component */
#demo-chat-widget-root .dcw-send-btn.dcw-send-btn--active {
  color: #ffffff;
}
#demo-chat-widget-root .dcw-send-btn.dcw-send-btn--active:hover {
  filter: brightness(0.9);
  transform: scale(1.05);
}
#demo-chat-widget-root .dcw-send-btn.dcw-send-btn--active:active {
  transform: scale(0.95);
}
#demo-chat-widget-root .dcw-send-btn:disabled {
  cursor: not-allowed;
}

/* ── Mobile: full-screen overlay ────────────────────────────── */
@media (max-width: 480px) {
  #demo-chat-widget-root .dcw-window {
    bottom: 0 !important;
    left: 0 !important;
    right: 0 !important;
    width: 100% !important;
    height: 100% !important;
    max-height: 100dvh;
    border-radius: 0;
  }
  #demo-chat-widget-root .dcw-bubble--right { right: 16px; bottom: 16px; }
  #demo-chat-widget-root .dcw-bubble--left  { left: 16px;  bottom: 16px; }
}

/* ── Tablet: slightly larger window ─────────────────────────── */
@media (min-width: 481px) and (max-width: 768px) {
  #demo-chat-widget-root .dcw-window { width: 380px; height: 560px; }
}
`;
