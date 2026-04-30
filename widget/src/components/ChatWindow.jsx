/**
 * ChatWindow.jsx — the expanded chat panel
 *
 * Layout (flex column, fixed 350×500px on desktop):
 *   ┌─────────────────────────────────┐
 *   │ Header (avatar · name · close)  │
 *   ├─────────────────────────────────┤
 *   │                                 │
 *   │   MessageList (scrollable)      │
 *   │                                 │
 *   ├─────────────────────────────────┤
 *   │ MessageInput (textarea + send)  │
 *   └─────────────────────────────────┘
 *
 * The header background uses primaryColor so the brand colour is
 * prominent. The close button sits on the right side of the header.
 */
import React from 'react';
import MessageList from './MessageList';
import MessageInput from './MessageInput';

// Generic person silhouette for the agent avatar
function AvatarIcon() {
  return (
    <svg
      width="18" height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12z" />
      <path d="M12 14.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="15" height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChatWindow({ messages, isLoading, config, onSend, onClose }) {
  return (
    <div className={`dcw-window dcw-window--${config.position}`} role="dialog" aria-label="Chat with Demo">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="dcw-header" style={{ backgroundColor: config.primaryColor }}>
        <div className="dcw-header-info">
          {/* Agent avatar */}
          <div className="dcw-avatar">
            <AvatarIcon />
          </div>
          {/* Agent name + online indicator */}
          <div>
            <div className="dcw-agent-name">{config.agentName}</div>
            <div className="dcw-agent-status">
              <span className="dcw-status-dot" />
              Online
            </div>
          </div>
        </div>

        {/* Close button */}
        <button
          className="dcw-close-btn"
          onClick={onClose}
          aria-label="Close chat"
        >
          <CloseIcon />
        </button>
      </div>

      {/* ── Messages ───────────────────────────────────────────── */}
      <MessageList
        messages={messages}
        isLoading={isLoading}
        primaryColor={config.primaryColor}
      />

      {/* ── Input ──────────────────────────────────────────────── */}
      <MessageInput
        onSend={onSend}
        isLoading={isLoading}
        primaryColor={config.primaryColor}
      />
    </div>
  );
}

export default ChatWindow;
