/**
 * App.jsx — root component, owns all widget state
 *
 * STATE:
 *   isOpen         — whether the chat window is visible
 *   messages       — array of { id, role, content, isStreaming?, isError? }
 *   isLoading      — true while the fetch is in flight (shows typing dots)
 *   sessionId      — UUID persisted in sessionStorage for this tab's session
 *   hasGreeted     — prevents re-showing the greeting if user closes/reopens
 *
 * CONVERSATION FLOW (per message):
 *   1. Append user's message to messages[] immediately (optimistic UI)
 *   2. Set isLoading = true  → typing indicator appears
 *   3. Await sendMessage(apiUrl, sessionId, text)
 *   4. Set isLoading = false → typing indicator disappears
 *   5. Append an assistant message with content = '' (empty bubble)
 *   6. Stream the reply text character-by-character into that bubble
 *      using setInterval every CHAR_INTERVAL_MS milliseconds
 *   7. When streaming completes, mark message isStreaming = false
 *
 * STREAMING INTERRUPT:
 *   If the user sends a new message while a previous reply is still
 *   streaming, abortStream() fast-forwards the current streaming
 *   message to its full content before starting the new request.
 *   This keeps the conversation coherent without visual glitches.
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import ChatBubble from './ChatBubble';
import ChatWindow from './ChatWindow';
import { sendMessage } from '../utils/api';
import { generateUUID } from '../utils/uuid';

// Milliseconds between each character during the streaming animation.
// 20ms ≈ 50 chars/second. Feels natural for short-to-medium answers.
// Increase for slower "typewriter" effect; decrease (or set to 0) to disable.
const CHAR_INTERVAL_MS = 20;

// sessionStorage key for the session ID. Cleared when the tab closes.
const SESSION_KEY = 'demo_chat_session_id';

function App({ config }) {
  const [isOpen,     setIsOpen]     = useState(false);
  const [messages,   setMessages]   = useState([]);
  const [isLoading,  setIsLoading]  = useState(false);
  const [sessionId,  setSessionId]  = useState(null);
  const [hasGreeted, setHasGreeted] = useState(false);

  // Ref to the active streaming interval so we can cancel it.
  const streamIntervalRef = useRef(null);
  // Ref to the full text of the message currently being streamed,
  // used by abortStream() to fast-forward without a React state read.
  const streamFullTextRef = useRef('');
  const streamMsgIdRef    = useRef(null);

  // ── Session init ──────────────────────────────────────────────
  // On mount, retrieve or generate the session ID. sessionStorage
  // persists only within the current tab — closing the tab starts
  // a fresh conversation, which is the desired behaviour.
  useEffect(() => {
    let sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = generateUUID();
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    setSessionId(sid);
  }, []);

  // ── Stream abort ──────────────────────────────────────────────
  // Immediately completes any in-progress character streaming.
  // Called before starting a new message so the conversation stays
  // consistent — no half-rendered assistant bubble left dangling.
  const abortStream = useCallback(() => {
    if (!streamIntervalRef.current) return;
    clearInterval(streamIntervalRef.current);
    streamIntervalRef.current = null;

    const fullText = streamFullTextRef.current;
    const msgId    = streamMsgIdRef.current;
    if (msgId && fullText) {
      setMessages(prev =>
        prev.map(m =>
          m.id === msgId ? { ...m, content: fullText, isStreaming: false } : m
        )
      );
    }
    streamFullTextRef.current = '';
    streamMsgIdRef.current    = null;
  }, []);

  // ── Character-by-character streaming ─────────────────────────
  // Reveals fullText one character every CHAR_INTERVAL_MS ms by
  // updating the target message's content slice in React state.
  // Returns a Promise that resolves when the last character is shown.
  const streamText = useCallback((fullText, msgId) => {
    streamFullTextRef.current = fullText;
    streamMsgIdRef.current    = msgId;

    return new Promise((resolve) => {
      let index = 0;
      streamIntervalRef.current = setInterval(() => {
        index += 1;
        const slice      = fullText.slice(0, index);
        const isDone     = index >= fullText.length;
        setMessages(prev =>
          prev.map(m =>
            m.id === msgId
              ? { ...m, content: slice, isStreaming: !isDone }
              : m
          )
        );
        if (isDone) {
          clearInterval(streamIntervalRef.current);
          streamIntervalRef.current = null;
          streamFullTextRef.current = '';
          streamMsgIdRef.current    = null;
          resolve();
        }
      }, CHAR_INTERVAL_MS);
    });
  }, []);

  // ── Open / close ──────────────────────────────────────────────
  const handleOpen = useCallback(() => {
    setIsOpen(true);
    // Show the greeting once, on the very first open.
    if (!hasGreeted && config.greetingMessage) {
      setHasGreeted(true);
      setMessages([{
        id:          generateUUID(),
        role:        'assistant',
        content:     config.greetingMessage,
        isStreaming: false,
      }]);
    }
  }, [hasGreeted, config.greetingMessage]);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    // Don't abort streaming — let it finish in the background so the
    // state is clean if the user reopens before it completes.
  }, []);

  // ── Send message ──────────────────────────────────────────────
  const handleSend = useCallback(async (text) => {
    if (!text || !sessionId) return;

    // If a prior reply is mid-stream, snap it to full text immediately.
    abortStream();

    // 1. Append user message right away (optimistic, no waiting).
    setMessages(prev => [...prev, {
      id:      generateUUID(),
      role:    'user',
      content: text,
    }]);

    // 2. Signal that we're waiting for a response.
    setIsLoading(true);

    try {
      // 3. POST to the chat API. The backend handles KB retrieval,
      //    conversation history, and Claude invocation.
      const data = await sendMessage(config.apiUrl, sessionId, text);

      // 4. Hide the typing indicator — we have the full response.
      setIsLoading(false);

      // 5. Add an empty assistant message that will be filled in below.
      const assistantMsgId = generateUUID();
      setMessages(prev => [...prev, {
        id:          assistantMsgId,
        role:        'assistant',
        content:     '',
        isStreaming: true,
        sources_used:     data.sources_used,
        unknown_question: data.unknown_question,
      }]);

      // 6. Stream the full reply character by character.
      await streamText(data.reply, assistantMsgId);

    } catch (err) {
      // Something went wrong (network, API, or parse error).
      // Log to console for debugging but show a friendly message.
      console.error('[DemoChat] API error:', err);
      setIsLoading(false);
      setMessages(prev => [...prev, {
        id:      generateUUID(),
        role:    'assistant',
        content: err.code === 'network_error'
          ? 'Connection failed. Please check your internet and try again.'
          : 'Sorry, something went wrong. Please try again.',
        isError: true,
      }]);
    }
  }, [sessionId, config.apiUrl, abortStream, streamText]);

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <ChatBubble
        isOpen={isOpen}
        isLoading={isLoading}
        position={config.position}
        primaryColor={config.primaryColor}
        onClick={isOpen ? handleClose : handleOpen}
      />

      {/* Chat window mounts/unmounts on open/close. React preserves
          state in the messages array (owned here in App) so the
          conversation is not lost when the window is toggled. */}
      {isOpen && (
        <ChatWindow
          messages={messages}
          isLoading={isLoading}
          config={config}
          onSend={handleSend}
          onClose={handleClose}
        />
      )}
    </>
  );
}

export default App;
