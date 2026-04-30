/**
 * ChatBubble.jsx — the floating circular button in the page corner
 *
 * Visible at all times. Shows a chat icon when closed, an X when open.
 * Pulses (CSS animation) while an API call is in flight so the user
 * knows Demo is thinking even without the chat window being open.
 */
import React from 'react';

// Chat icon (message bubble shape) — shown when widget is closed
function ChatIcon() {
  return (
    <svg
      width="22" height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

// Close icon (×) — shown when widget is open
function CloseIcon() {
  return (
    <svg
      width="20" height="20"
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

function ChatBubble({ isOpen, isLoading, position, primaryColor, onClick }) {
  // Build CSS class list.
  // dcw-bubble--pulse  → CSS keyframe animation while loading
  const classes = [
    'dcw-bubble',
    `dcw-bubble--${position}`,
    isLoading && !isOpen ? 'dcw-bubble--pulse' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      className={classes}
      style={{ backgroundColor: primaryColor }}
      onClick={onClick}
      aria-label={isOpen ? 'Close chat' : 'Open chat'}
      aria-expanded={isOpen}
    >
      {isOpen ? <CloseIcon /> : <ChatIcon />}
    </button>
  );
}

export default ChatBubble;
