/**
 * MessageList.jsx — scrollable conversation history
 *
 * Renders each message as a styled bubble. Automatically scrolls to
 * the newest message whenever messages or isLoading changes.
 *
 * Message bubble rules:
 *   • User messages   → right-aligned, primaryColor background
 *   • Assistant messages → left-aligned, light tint of primaryColor
 *   • Error messages  → red tint (dcw-msg-bubble--error CSS class)
 *   • Streaming messages → content grows character-by-character;
 *     dangerouslySetInnerHTML re-renders on every character update
 *
 * While isLoading is true (API call in flight) a "typing…" indicator
 * with three bouncing dots is appended below the messages.
 */
import React, { useEffect, useRef } from 'react';
import { renderMarkdown } from '../utils/markdown';

// ── Typing indicator ──────────────────────────────────────────────
function TypingIndicator() {
  return (
    <div className="dcw-typing-row" aria-label="Demo is typing" role="status">
      <div className="dcw-typing">
        <span /><span /><span />
      </div>
    </div>
  );
}

// ── Single message bubble ─────────────────────────────────────────
function MessageBubble({ message, primaryColor }) {
  const isUser  = message.role === 'user';
  const isError = message.isError === true;

  // Compute inline style for background colour:
  //   User      → solid primaryColor
  //   Assistant → 10% opacity tint + 25% opacity border
  //   Error     → handled entirely by CSS class, no inline style
  let bubbleStyle = {};
  if (!isError) {
    if (isUser) {
      bubbleStyle = { backgroundColor: primaryColor };
    } else {
      // Convert hex to rgba for the tint. If primaryColor is a named
      // color or rgb() string this falls back gracefully (transparent bg).
      bubbleStyle = {
        backgroundColor: `${primaryColor}1a`, // ~10% opacity
        borderColor:      `${primaryColor}40`, // ~25% opacity
      };
    }
  }

  // Build class list
  const bubbleClass = [
    'dcw-msg-bubble',
    isUser  ? 'dcw-msg-bubble--user'      : 'dcw-msg-bubble--assistant',
    isError ? 'dcw-msg-bubble--error'     : '',
  ]
    .filter(Boolean)
    .join(' ');

  // Render message content as safe HTML (markdown → HTML via renderMarkdown).
  // During character-by-character streaming the content string grows by one
  // character per tick, so this renders on every tick — that is intentional.
  return (
    <div className={`dcw-msg-row dcw-msg-row--${isUser ? 'user' : 'assistant'}`}>
      <div
        className={bubbleClass}
        style={bubbleStyle}
        // renderMarkdown escapes all HTML before applying transformations,
        // so this is safe — it only ever emits our known-safe tag set.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
      />
    </div>
  );
}

// ── Message list ──────────────────────────────────────────────────
function MessageList({ messages, isLoading, primaryColor }) {
  const bottomRef = useRef(null);

  // Scroll to the bottom whenever a new message appears or the typing
  // indicator is toggled. smooth gives a nice feel; instant could be
  // used if performance becomes an issue on very long conversations.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <div className="dcw-messages" role="log" aria-live="polite" aria-label="Chat messages">
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          primaryColor={primaryColor}
        />
      ))}

      {/* Show "typing…" dots while waiting for the API response */}
      {isLoading && <TypingIndicator />}

      {/* Invisible anchor that scrollIntoView targets */}
      <div ref={bottomRef} />
    </div>
  );
}

export default MessageList;
