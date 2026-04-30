/**
 * MessageInput.jsx — sticky input bar at the bottom of the chat window
 *
 * Features:
 *   • Auto-growing textarea (up to 4 lines / 100px tall)
 *   • Enter to send, Shift+Enter for a newline
 *   • Send button disabled when empty or when API call is in flight
 *   • Send button color switches to primaryColor when there is text
 *   • Keyboard accessibility: focus styles, aria-labels
 */
import React, { useState, useRef, useCallback } from 'react';

// Paper-plane send icon
function SendIcon() {
  return (
    <svg
      width="15" height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

function MessageInput({ onSend, isLoading, primaryColor }) {
  const [text, setText] = useState('');
  const textareaRef = useRef(null);

  // Resize the textarea to fit its content, capped at 100px (~4 lines).
  const resizeTextarea = useCallback((el) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 100)}px`;
  }, []);

  const handleChange = useCallback((e) => {
    setText(e.target.value);
    resizeTextarea(e.target);
  }, [resizeTextarea]);

  // Submit on Enter (without Shift). Shift+Enter inserts a newline.
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }, [text, isLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed);
    setText('');
    // Reset height after clearing text
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [text, isLoading, onSend]);

  const canSend = text.trim().length > 0 && !isLoading;

  return (
    <div className="dcw-input-area">
      <textarea
        ref={textareaRef}
        className="dcw-input"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="Type a message…"
        rows={1}
        disabled={isLoading}
        aria-label="Type your message"
        autoComplete="off"
      />
      <button
        className={`dcw-send-btn${canSend ? ' dcw-send-btn--active' : ''}`}
        style={canSend ? { backgroundColor: primaryColor } : undefined}
        onClick={submit}
        disabled={!canSend}
        aria-label="Send message"
      >
        <SendIcon />
      </button>
    </div>
  );
}

export default MessageInput;
