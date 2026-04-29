/**
 * ============================================================
 * lambda/index.js  –  Lambda Handler (Phase 3: Conversation Memory)
 * ============================================================
 *
 * Phase 3 adds conversation memory on top of Phase 2's RAG pattern.
 * The full request lifecycle is now:
 *
 *   Request arrives  { sessionId?, message }
 *       ↓
 *   0. SESSION     – use the client's sessionId, or generate a new UUID
 *       ↓
 *   1. HISTORY     – query DynamoDB for the last 5 messages in this
 *                    session (if the session is < 30 min old)
 *       ↓
 *   2. RETRIEVE    – query the Bedrock Knowledge Base for the top-5
 *                    text chunks most relevant to the current message
 *       ↓
 *   3. AUGMENT     – inject KB chunks into the system prompt
 *       ↓
 *   4. GENERATE    – call Claude with system prompt + full message
 *                    history (past turns + current user message)
 *       ↓
 *   5. PERSIST     – write the user message and assistant reply to
 *                    DynamoDB (conversation history + unknown-Q log)
 *       ↓
 *   Response: { sessionId, reply, unknown_question, sources_used }
 *
 * WHY MEMORY MATTERS:
 *   Without memory, every request is stateless. "What about the Pro
 *   Plan you mentioned?" fails because Claude has no idea what was
 *   said before. Storing the last few turns in DynamoDB and feeding
 *   them back to Claude makes the conversation feel continuous.
 *
 * RUNTIME NOTE:
 *   AWS Node.js 20 Lambda runtime ships with the full AWS SDK v3,
 *   so all `require('@aws-sdk/...')` calls work without bundling a
 *   local node_modules folder in the Lambda deployment package.
 */

// ── SDK Imports ───────────────────────────────────────────────────

// Bedrock Runtime: InvokeModel — sends the prompt to Claude and
// returns the full generated response (non-streaming).
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// Bedrock Agent Runtime: Retrieve — queries the Knowledge Base with
// the user's message and returns the most relevant text chunks.
// This is a DIFFERENT client from BedrockRuntimeClient:
//   BedrockRuntimeClient     → AI models (Claude, Titan)
//   BedrockAgentRuntimeClient → Knowledge Bases, Agents
const { BedrockAgentRuntimeClient, RetrieveCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

// DynamoDB: PutItem (write a message) and QueryCommand (read history).
// QueryCommand is new in Phase 3 — lets us fetch all messages for a
// given sessionId ordered by the timestamp sort key.
const { DynamoDBClient, PutItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');

// ── Clients — created OUTSIDE the handler for warm-start reuse ────
//
// Lambda reuses the same process for back-to-back requests. Code at
// module level runs once on cold start and is then frozen/thawed.
// Clients created here reuse existing TLS connections and cached
// credentials across warm invocations — avoiding repeated handshake
// overhead that would add 50–200 ms per request.
const bedrockClient      = new BedrockRuntimeClient({ region: 'us-east-1' });
const agentRuntimeClient = new BedrockAgentRuntimeClient({ region: 'us-east-1' });
const dynamoClient       = new DynamoDBClient({ region: 'us-east-1' });

// ── Constants ─────────────────────────────────────────────────────

// Claude Sonnet 4.5 via cross-region inference profile. The "us."
// prefix tells Bedrock to route across US availability zones for
// higher resilience — required for this model tier.
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Environment variables injected by CDK at deploy time (chat-stack.ts).
// process.env reads these strings at Lambda startup.
const KNOWLEDGE_BASE_ID       = process.env.KNOWLEDGE_BASE_ID;
const UNKNOWN_QUESTIONS_TABLE = process.env.UNKNOWN_QUESTIONS_TABLE;
const CONVERSATION_TABLE_NAME = process.env.CONVERSATION_TABLE_NAME;

// Session timeout: if the most recent message in a session is older
// than 30 minutes, treat the session as expired and start fresh.
// The client can also start a new session by sending a new UUID.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes in milliseconds

// Maximum number of prior messages to load from DynamoDB.
// Loading 5 messages gives Claude ~2-3 conversation turns of context
// without bloating the prompt to the point where it slows things down
// or costs significantly more to process.
const HISTORY_LIMIT = 5;

// TTL constants (in seconds, as DynamoDB requires).
const THIRTY_DAYS_S  = 30 * 24 * 60 * 60;  // conversation history TTL
const NINETY_DAYS_S  = 90 * 24 * 60 * 60;  // unknown-question log TTL

// ── System Prompt Template ────────────────────────────────────────
//
// Demo's "personality card". The {{retrieved_chunks}} placeholder is
// replaced at runtime with KB content fetched for the current message.
// The `system` field is processed before the conversation history,
// giving Claude its ground rules before reading any messages.
const SYSTEM_PROMPT_TEMPLATE = `You are Demo, Demosite's cheerful and professional customer service assistant. You are eager to help and always maintain a positive, friendly tone while being accurate and professional.

KNOWLEDGE BASE:
{{retrieved_chunks}}

INSTRUCTIONS:
- Answer questions ONLY using the information in the Knowledge Base above
- Be cheery, warm, and eager to please in every response
- If the answer is not in the Knowledge Base, say: 'Great question! That's something I want to make sure I get exactly right for you. Please reach out to our support team at support@demosite.com and they will be happy to help!' Then set unknown_question: true in your response metadata.
- NEVER negotiate prices or offer discounts. If asked, say: 'I appreciate you asking! Our prices are set to reflect the quality and value we deliver. I am not able to modify pricing, but I would love to help you find the perfect product within your needs!'
- Never make up information not in the Knowledge Base
- Always end your response by offering additional help`;

// ──────────────────────────────────────────────────────────────────
// Handler: AWS Lambda calls this on every API Gateway request
// ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  // ── Step 0: Parse request — extract sessionId and message ────────
  //
  // The request body is a JSON string in event.body.
  // Expected shape: { "sessionId": "...", "message": "..." }
  //
  // sessionId is OPTIONAL — the client passes it on turn 2+ to
  // continue an existing session. On the very first message, the
  // client either generates a UUID itself or omits the field and
  // the server generates one below. Either way the sessionId is
  // echoed back in the response so the client can use it next time.
  let message, sessionId;
  try {
    const body = JSON.parse(event.body || '{}');
    message   = body.message;
    sessionId = body.sessionId || generateUUID();

    if (!message || typeof message !== 'string') {
      return respond(400, { error: 'Request body must include a "message" string.' });
    }
    // Validate that a client-supplied sessionId looks like a UUID.
    // This prevents accidental injection of arbitrary strings as keys.
    if (body.sessionId && typeof body.sessionId !== 'string') {
      return respond(400, { error: 'sessionId must be a string.' });
    }
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  // ── Step 1: HISTORY — Load prior conversation turns ──────────────
  //
  // Query DynamoDB for the last HISTORY_LIMIT messages in this session.
  // These are returned oldest-first so they can be appended directly
  // to Claude's messages array in chronological order.
  //
  // GRACEFUL DEGRADATION: If the query fails (network error, table
  // not yet created, permissions issue) we log the error and continue
  // with an empty history. Claude will answer without prior context
  // rather than returning an error to the user.
  const conversationHistory = await loadConversationHistory(sessionId, dynamoClient);

  // ── Step 2: RETRIEVE — Query the Knowledge Base ──────────────────
  //
  // Send the current user message to the KB. The KB converts it to a
  // vector, searches the S3 Vectors index, and returns the top-5 most
  // semantically similar text chunks from the Demosite docs.
  //
  // NOTE: We intentionally use only the CURRENT message as the search
  // query, not the full conversation. The KB's vector search is
  // designed for single-query lookup — feeding it a multi-turn
  // conversation string degrades retrieval accuracy.
  let retrievedChunks = [];
  let sourcesUsed = 0;

  try {
    const retrieveCommand = new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: { text: message },
      retrievalConfiguration: {
        vectorSearchConfiguration: { numberOfResults: 5 },
      },
    });

    const retrieveResponse = await agentRuntimeClient.send(retrieveCommand);

    retrievedChunks = (retrieveResponse.retrievalResults || [])
      .map(r => r.content?.text)
      .filter(t => t && t.trim().length > 0);

    sourcesUsed = retrievedChunks.length;

  } catch (retrieveErr) {
    // KB retrieve failed (not synced yet, or transient AWS error).
    // Degrade gracefully: Demo will redirect to support@demosite.com.
    console.warn('KB retrieve failed (KB may not be synced yet):', retrieveErr.message);
  }

  // ── Step 3: AUGMENT — Build the grounded system prompt ───────────
  //
  // Substitute the KB chunks into the system prompt template.
  // If the KB returned nothing, the placeholder text informs Claude
  // that the KB is empty, causing it to redirect to support email.
  const chunksText = retrievedChunks.length > 0
    ? retrievedChunks.join('\n\n---\n\n')
    : '[No relevant information found in the knowledge base for this query.]';

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{retrieved_chunks}}', chunksText);

  // ── Step 4: GENERATE — Call Claude with full conversation context ─
  //
  // buildConversationArray() prepends all loaded history turns BEFORE
  // the current user message, giving Claude the full conversation.
  //
  // Claude's Messages API processes them in order:
  //   [user: turn 1] [assistant: turn 1] ... [user: current]
  //
  // The `system` prompt is kept separate from the `messages` array —
  // Claude treats it as its standing instructions, not as part of
  // the conversation itself.
  try {
    const messages = buildConversationArray(conversationHistory, message);

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages,            // history + current message
    };

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await bedrockClient.send(command);

    // response.body is a Uint8Array — decode to UTF-8 string then parse.
    // The reply text lives at content[0].text in Anthropic's schema.
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply  = result.content?.[0]?.text ?? '';

    // ── Step 5: PERSIST — Save messages and flag unknowns ────────────
    //
    // Write the user message and Demo's reply to ConversationHistory
    // so the next request in this session can load them as history.
    //
    // We use a shared base timestamp so the user message is guaranteed
    // to sort before the assistant message within the same millisecond.
    // (timestamp + 1 for assistant ensures correct ascending order.)
    const baseTime = Date.now();
    await Promise.all([
      saveMessage(sessionId, 'user',      message, 0,           dynamoClient, baseTime),
      saveMessage(sessionId, 'assistant', reply,   sourcesUsed, dynamoClient, baseTime + 1),
    ]);

    // Detect unknown questions: the system prompt instructs Demo to
    // include "support@demosite.com" ONLY when the KB has no answer.
    const unknownQuestion = reply.includes('support@demosite.com');

    if (unknownQuestion) {
      // Emit a structured log line with a filterable prefix so the
      // content team can find these quickly in CloudWatch Log Insights:
      //   fields @message | filter @message like /UNKNOWN_QUESTION/
      console.log('UNKNOWN_QUESTION:', JSON.stringify({
        sessionId,
        message,
        timestamp: new Date().toISOString(),
      }));

      // Also persist to the UnknownQuestions audit table.
      try {
        const nowS = Math.floor(Date.now() / 1000);
        await dynamoClient.send(new PutItemCommand({
          TableName: UNKNOWN_QUESTIONS_TABLE,
          Item: {
            questionId: { S: generateUUID() },
            timestamp:  { S: new Date().toISOString() },
            question:   { S: message },
            sessionId:  { S: sessionId },
            ttl:        { N: String(nowS + NINETY_DAYS_S) },
          },
        }));
      } catch (dynamoErr) {
        // Non-critical — user still gets their response.
        console.error('DynamoDB write failed (UnknownQuestions):', dynamoErr.message);
      }
    }

    // Phase 3 response shape:
    //   sessionId        — echo back so the client uses it next time
    //   reply            — Demo's text response
    //   unknown_question — true when KB had no answer (email suggested)
    //   sources_used     — number of KB chunks Claude had access to
    return respond(200, {
      sessionId,
      reply,
      unknown_question: unknownQuestion,
      sources_used:     sourcesUsed,
    });

  } catch (err) {
    // Claude invocation failed. Never expose internal details to caller.
    console.error('Bedrock InvokeModel error:', err);
    return respond(502, {
      sessionId,
      error:            'Upstream model error.',
      detail:           err.message,
      unknown_question: false,
      sources_used:     sourcesUsed,
    });
  }
};

// ══════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// generateUUID()
// ─────────────────────────────────────────────────────────────────
// Returns a v4 UUID string (e.g. "550e8400-e29b-41d4-a716-446655440000").
//
// Used for:
//   • sessionId  — uniquely identifies one chat session
//   • messageId  — uniquely identifies one message within a session
//   • questionId — uniquely identifies one unknown-question log entry
//
// crypto.randomUUID() is built into Node.js 14.17+ — no npm package
// needed. It generates a cryptographically random UUID so collisions
// are astronomically unlikely.
function generateUUID() {
  return require('crypto').randomUUID();
}

// ─────────────────────────────────────────────────────────────────
// loadConversationHistory(sessionId, client)
// ─────────────────────────────────────────────────────────────────
// Retrieves the last HISTORY_LIMIT (5) messages from this session.
//
// HOW IT WORKS:
//   DynamoDB Query uses the sessionId partition key to find all
//   messages that belong to this session. ScanIndexForward: false
//   returns them newest-first (descending timestamp). Limit: 5 stops
//   after 5 items so we don't read the entire session history.
//   We then reverse() the result to restore chronological order
//   (oldest first) before feeding it to Claude.
//
// WHY 5 MESSAGES?
//   Five messages ≈ 2–3 full Q&A turns. Enough context for continuity
//   without bloating the Claude prompt with stale conversation.
//
// 30-MINUTE TIMEOUT:
//   If the newest loaded message is older than SESSION_TIMEOUT_MS
//   we return an empty array. This treats the session as expired —
//   Demo answers fresh without memory of the earlier conversation.
//   The client can also start a new session by generating a new UUID.
//
// GRACEFUL DEGRADATION: If the DynamoDB query fails for any reason
//   (permissions, table not created, network error) we log the error
//   and return [] so the chat continues without history rather than
//   crashing with a 502.
async function loadConversationHistory(sessionId, client) {
  try {
    const result = await client.send(new QueryCommand({
      TableName:              CONVERSATION_TABLE_NAME,
      // KeyConditionExpression filters by the partition key.
      // :sid is a placeholder replaced by ExpressionAttributeValues.
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: {
        ':sid': { S: sessionId },
      },
      // Return newest items first so Limit: 5 gives the 5 most recent.
      // We'll reverse below to restore chronological order.
      ScanIndexForward: false,
      Limit:            HISTORY_LIMIT,
    }));

    const items = result.Items || [];

    // Convert DynamoDB's typed format { S: '...' } / { N: '...' }
    // into plain objects that are easier to work with.
    const messages = items.reverse().map(item => ({
      role:      item.role.S,
      content:   item.content.S,
      timestamp: Number(item.timestamp.N),
    }));

    // 30-minute inactivity timeout check.
    // If the most recent message is older than SESSION_TIMEOUT_MS,
    // the session has gone cold — return empty to start fresh.
    if (messages.length > 0) {
      const lastTimestamp    = messages[messages.length - 1].timestamp;
      const sessionExpiredAt = lastTimestamp + SESSION_TIMEOUT_MS;
      if (Date.now() > sessionExpiredAt) {
        console.log(`Session ${sessionId} expired (last activity >30 min ago). Starting fresh.`);
        return [];
      }
    }

    return messages;

  } catch (err) {
    // Log to CloudWatch but don't crash. The conversation continues
    // without history rather than returning an error to the user.
    console.error('loadConversationHistory failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// saveMessage(sessionId, role, content, sources, client, timestamp)
// ─────────────────────────────────────────────────────────────────
// Writes a single message to the ConversationHistory DynamoDB table.
//
// PARAMETERS:
//   sessionId  — which session this message belongs to (partition key)
//   role       — "user" or "assistant"
//   content    — the text of the message
//   sources    — number of KB chunks used (0 for user messages)
//   client     — the shared DynamoDBClient instance
//   timestamp  — millisecond epoch timestamp (caller controls this so
//                user and assistant messages within the same request
//                are guaranteed to have distinct, ordered timestamps)
//
// WHAT CAN GO WRONG:
//   • IAM permission missing (dynamodb:PutItem) → AccessDeniedException
//   • Table not yet created (deploy in progress) → ResourceNotFoundException
//   • Network timeout → TimeoutError
//   All failures are logged and swallowed — the user's response is
//   not blocked by a history-write failure.
//
// TTL:
//   Each message expires 30 days after it is written. DynamoDB
//   deletes it silently in the background — no manual purge needed.
//   This prevents the table from growing forever for abandoned sessions.
async function saveMessage(sessionId, role, content, sources, client, timestamp) {
  const nowS = Math.floor(timestamp / 1000); // convert ms → seconds for TTL

  try {
    await client.send(new PutItemCommand({
      TableName: CONVERSATION_TABLE_NAME,
      Item: {
        // Primary key — together sessionId + timestamp uniquely identifies
        // every message. DynamoDB stores all items with the same sessionId
        // in the same partition, sorted by timestamp automatically.
        sessionId:  { S: sessionId },
        timestamp:  { N: String(timestamp) }, // Number in DynamoDB must be sent as string

        // Non-key attributes stored with each message.
        messageId:  { S: generateUUID() },    // unique ID for this individual message
        role:       { S: role },              // "user" or "assistant"
        content:    { S: content },           // the full message text
        sources:    { N: String(sources) },   // KB chunks used (0 for user msgs)

        // TTL: Unix timestamp (seconds) 30 days from now.
        // DynamoDB will auto-delete this item after this timestamp passes.
        ttl:        { N: String(nowS + THIRTY_DAYS_S) },
      },
    }));
    return true;

  } catch (err) {
    console.error(`saveMessage failed (role=${role}):`, err.message);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────
// buildConversationArray(loadedMessages, currentUserMessage)
// ─────────────────────────────────────────────────────────────────
// Assembles the `messages` array that gets sent to Claude.
//
// Claude's Messages API expects an alternating sequence:
//   [user, assistant, user, assistant, ..., user]
//
// The array must always END with a "user" message (the current one).
// It must NEVER have two consecutive messages with the same role —
// Claude returns an error if it does.
//
// Our DynamoDB history already alternates correctly because we write
// user + assistant as a pair after every response. The function
// simply maps the stored objects to Claude's { role, content } format
// and appends the current user message at the end.
//
// EXAMPLE OUTPUT for 2 prior turns + current message:
//   [
//     { role: "user",      content: "What is the return policy?" },
//     { role: "assistant", content: "Standard Plan: 30 days..." },
//     { role: "user",      content: "What about the Pro Plan?" },
//     { role: "assistant", content: "Pro Plan gives you 60 days..." },
//     { role: "user",      content: "Can I get a discount?"  },  ← current
//   ]
function buildConversationArray(loadedMessages, currentUserMessage) {
  // Map loaded messages to Claude's format (drop timestamp — not needed).
  const history = loadedMessages.map(msg => ({
    role:    msg.role,
    content: msg.content,
  }));

  // Append the current user message as the final item.
  return [...history, { role: 'user', content: currentUserMessage }];
}

// ─────────────────────────────────────────────────────────────────
// respond(statusCode, body)
// ─────────────────────────────────────────────────────────────────
// Builds an API Gateway HTTP API (v2) compatible response object.
//
// API Gateway requires exactly this shape:
//   { statusCode: number, headers: object, body: string }
//
// body MUST be a string — API Gateway returns a 500 "malformed
// Lambda proxy response" error if body is an object.
// JSON.stringify converts the object to the required string format.
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}
