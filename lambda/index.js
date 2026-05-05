/**
 * ============================================================
 * lambda/index.js  –  Lambda Handler (Phase 5: Multi-Tenant)
 * ============================================================
 *
 * Phase 5 adds multi-tenant support on top of Phase 3's conversation
 * memory. The full request lifecycle is now:
 *
 *   Request arrives  { tenant_id, session_id?, message }
 *       ↓
 *   0. TENANT    – look up the tenant row in DynamoDB to get the
 *                  Bedrock Knowledge Base ID for this customer
 *       ↓
 *   0b. SESSION  – build a prefixed session key: tenant_id#session_id
 *                  so each tenant's conversations are isolated
 *       ↓
 *   1. HISTORY   – query ConversationHistory for the last 5 messages
 *                  in this session (if session is < 30 min old)
 *       ↓
 *   2. RETRIEVE  – query THIS TENANT'S Bedrock Knowledge Base for the
 *                  top-5 chunks most relevant to the current message
 *       ↓
 *   3. AUGMENT   – inject KB chunks into the system prompt
 *       ↓
 *   4. GENERATE  – call Claude with system prompt + full conversation
 *       ↓
 *   5. PERSIST   – write user message + assistant reply to DynamoDB
 *       ↓
 *   Response: { session_id, reply, unknown_question, sources_used }
 *
 * MULTI-TENANCY DESIGN:
 *   Each customer ("tenant") has their own row in the Tenants table
 *   that maps their tenant_id to their Bedrock Knowledge Base ID.
 *   Conversation history is partitioned by prefixing every session key
 *   with the tenant_id, so Tenant A can never read Tenant B's history
 *   even if they generate identical session UUIDs.
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

// DynamoDB: PutItem (write a message), QueryCommand (read history),
// GetItemCommand (look up tenant row — new in Phase 5).
const { DynamoDBClient, PutItemCommand, QueryCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');

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
//
// TENANTS_TABLE:           Phase 5 — maps tenant_id → knowledge_base_id
// UNKNOWN_QUESTIONS_TABLE: Phase 2 — audit log for unanswered questions
// CONVERSATION_TABLE_NAME: Phase 3 — per-session conversation history
const TENANTS_TABLE           = process.env.TENANTS_TABLE;
const UNKNOWN_QUESTIONS_TABLE = process.env.UNKNOWN_QUESTIONS_TABLE;
const CONVERSATION_TABLE_NAME = process.env.CONVERSATION_TABLE_NAME;

// Session timeout: if the most recent message in a session is older
// than 30 minutes, treat the session as expired and start fresh.
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes in milliseconds

// Maximum number of prior messages to load from DynamoDB.
// 5 messages ≈ 2-3 full Q&A turns — enough context without bloating
// the Claude prompt or significantly increasing latency.
const HISTORY_LIMIT = 5;

// TTL constants (in seconds, as DynamoDB requires).
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;  // conversation history TTL
const NINETY_DAYS_S = 90 * 24 * 60 * 60;  // unknown-question log TTL

// ── System Prompt Template ────────────────────────────────────────
//
// Demo's "personality card". The {{retrieved_chunks}} placeholder is
// replaced at runtime with KB content fetched for the current message.
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

  // ── Step 0: Parse request — tenant_id, session_id, message ──────
  //
  // Phase 5 request shape (snake_case throughout to match REST norms):
  //   {
  //     "tenant_id":  "demosite",          ← required
  //     "session_id": "sess-abc-123",      ← optional; server generates if absent
  //     "message":    "What is your return policy?"
  //   }
  //
  // tenant_id identifies which customer is talking and which Bedrock
  // Knowledge Base to search. It is validated against the Tenants
  // table — unknown IDs get a 404 rather than silently falling through.
  //
  // session_id follows the same optional rules as before: omit on
  // the first turn, pass it back on subsequent turns to continue the
  // conversation. It is always echoed back in the response.
  let message, tenantId, sessionId, prefixedSessionId;
  try {
    const body = JSON.parse(event.body || '{}');
    console.log('REQUEST BODY:', JSON.stringify(body));
    
    message  = body.message;
    tenantId = body.tenantId || body.tenant_id;
    const rawSessionId = body.session_id || generateUUID();

    console.log('PARSED:', { message: !!message, tenantId, sessionId: !!rawSessionId });

    if (!message || typeof message !== 'string') {
      console.log('ERROR: message is required');
      return respond(400, { error: 'message is required.' });
    }
    if (!tenantId || typeof tenantId !== 'string') {
      console.log('ERROR: tenant_id is required');
      return respond(400, { error: 'tenant_id is required.' });
    }

    // The client always sees the short, unprefixed session ID.
    // Internally we prefix it with tenant_id for DynamoDB keys so
    // Tenant A and Tenant B never share a history partition even if
    // they happen to generate identical session UUIDs.
    sessionId         = rawSessionId;
    prefixedSessionId = `${tenantId}#${rawSessionId}`;

  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  // ── Step 0b: Look up tenant ──────────────────────────────────────
  //
  // A single GetItem call against the Tenants table returns the row
  // for this tenant_id. From it we extract the knowledge_base_id that
  // tells us which Bedrock KB to search in Step 2.
  //
  // Returns 404 for unknown tenant_ids so callers get a clear error
  // instead of a confusing 502 further down the call chain.
  //
  // Returns 503 for unexpected DynamoDB failures so the user knows
  // to retry rather than thinking their message was the problem.
  let tenant;
  try {
    tenant = await lookupTenant(tenantId, dynamoClient);
  } catch (err) {
    if (err.code === 'tenant_not_found') {
      return respond(404, { error: `Unknown tenant: '${tenantId}'. Check your tenant_id.` });
    }
    console.error('Tenant lookup failed:', err.message);
    return respond(503, { error: 'Service temporarily unavailable. Please try again.' });
  }

  // ── Step 1: HISTORY — Load prior conversation turns ──────────────
  //
  // Query ConversationHistory for the last HISTORY_LIMIT messages in
  // this session. Uses the PREFIXED key so history is tenant-isolated.
  //
  // GRACEFUL DEGRADATION: If the query fails we continue without
  // history — Claude answers fresh rather than the request failing.
  const conversationHistory = await loadConversationHistory(prefixedSessionId, dynamoClient);

  // ── Step 2: RETRIEVE — Query THIS TENANT'S Knowledge Base ────────
  //
  // Use the knowledge_base_id from the tenant row — not a hardcoded
  // environment variable. This is the core of multi-tenancy: each
  // customer's documents are isolated in their own KB.
  let retrievedChunks = [];
  let sourcesUsed = 0;

  try {
    console.log('RETRIEVE DEBUG:', {
      tenantId: tenantId,
      knowledgeBaseId: tenant.knowledgeBaseId,
      message: message
    });

    const retrieveCommand = new RetrieveCommand({
      knowledgeBaseId: tenant.knowledgeBaseId,  // per-tenant KB ID
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

    console.log('RETRIEVE RESPONSE:', {
      retrievalResultsCount: retrieveResponse.retrievalResults?.length || 0,
      retrievedChunks: retrievedChunks.length,
      chunks: retrievedChunks
    });

  } catch (retrieveErr) {
    // KB retrieve failed (not synced, wrong region, transient error).
    // Demo will redirect to support — better than a 502 to the user.
    console.warn('KB retrieve failed (KB may not be synced yet):', retrieveErr.message);
  }

  // ── Step 3: AUGMENT — Build the grounded system prompt ───────────
  //
  // Substitute the KB chunks into the system prompt template.
  const chunksText = retrievedChunks.length > 0
    ? retrievedChunks.join('\n\n---\n\n')
    : '[No relevant information found in the knowledge base for this query.]';

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{retrieved_chunks}}', chunksText);

  // ── Step 4: GENERATE — Call Claude with full conversation context ─
  try {
    const messages = buildConversationArray(conversationHistory, message);

    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    };

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await bedrockClient.send(command);

    // response.body is a Uint8Array — decode to UTF-8 string then parse.
    // The reply text lives at content[0].text in Anthropic's response schema.
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply  = result.content?.[0]?.text ?? '';

    // ── Step 5: PERSIST — Save messages and flag unknowns ────────────
    //
    // Write both the user message and Demo's reply to ConversationHistory
    // so the next request in this session can load them as history.
    // Uses the PREFIXED session key for tenant isolation.
    //
    // baseTime + 1 guarantees the assistant message sorts after the
    // user message even if both writes happen in the same millisecond.
    const baseTime = Date.now();
    await Promise.all([
      saveMessage(prefixedSessionId, 'user',      message, 0,           dynamoClient, baseTime),
      saveMessage(prefixedSessionId, 'assistant', reply,   sourcesUsed, dynamoClient, baseTime + 1),
    ]);

    // Detect unknown questions: the system prompt instructs Demo to
    // include "support@demosite.com" ONLY when the KB has no answer.
    const unknownQuestion = reply.includes('support@demosite.com');

    if (unknownQuestion) {
      // Structured CloudWatch log with filterable prefix:
      //   fields @message | filter @message like /UNKNOWN_QUESTION/
      console.log('UNKNOWN_QUESTION:', JSON.stringify({
        tenantId,
        sessionId: prefixedSessionId,
        message,
        timestamp: new Date().toISOString(),
      }));

      // Persist to the UnknownQuestions audit table.
      try {
        const nowS = Math.floor(Date.now() / 1000);
        await dynamoClient.send(new PutItemCommand({
          TableName: UNKNOWN_QUESTIONS_TABLE,
          Item: {
            questionId: { S: generateUUID() },
            timestamp:  { S: new Date().toISOString() },
            question:   { S: message },
            tenantId:   { S: tenantId },
            sessionId:  { S: prefixedSessionId },
            ttl:        { N: String(nowS + NINETY_DAYS_S) },
          },
        }));
      } catch (dynamoErr) {
        // Non-critical — user still gets their response.
        console.error('DynamoDB write failed (UnknownQuestions):', dynamoErr.message);
      }
    }

    // Phase 5 response shape — snake_case to match request format.
    // session_id is the SHORT, unprefixed ID so the client can pass
    // it back as-is on the next turn without knowing about the prefix.
    return respond(200, {
      session_id:       sessionId,
      reply,
      unknown_question: unknownQuestion,
      sources_used:     sourcesUsed,
    });

  } catch (err) {
    // Claude invocation failed. Never expose internal details to caller.
    console.error('Bedrock InvokeModel error:', err);
    return respond(502, {
      session_id:       sessionId,
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
// lookupTenant(tenantId, client)
// ─────────────────────────────────────────────────────────────────
// Fetches the tenant row from the Tenants table using GetItem.
//
// WHY GetItem (not Query)?
//   tenant_id is the partition key with no sort key, so each tenant
//   has exactly one row. GetItem retrieves it in a single O(1) round
//   trip without a scan — consistently under 5 ms at low scale.
//
// RETURNS:
//   { tenantId, companyName, knowledgeBaseId }
//
// THROWS:
//   err.code === 'tenant_not_found'   if the row doesn't exist
//   any other error                   on DynamoDB/network failures
//
// CACHING NOTE:
//   This function re-reads DynamoDB on every request. For high-traffic
//   deployments, wrap it in an in-memory LRU cache (60-second TTL) to
//   avoid paying for a GetItem call on every single chat message.
async function lookupTenant(tenantId, client) {
  const result = await client.send(new GetItemCommand({
    TableName: TENANTS_TABLE,
    Key: { tenant_id: { S: tenantId } },
  }));

  if (!result.Item) {
    const err = new Error(`Tenant '${tenantId}' not found.`);
    err.code = 'tenant_not_found';
    throw err;
  }

  const item = result.Item;

  // knowledge_base_id is required — a tenant row without it means
  // the account wasn't provisioned correctly.
  if (!item.knowledge_base_id?.S) {
    throw new Error(`Tenant '${tenantId}' has no knowledge_base_id configured.`);
  }

  return {
    tenantId:        item.tenant_id.S,
    companyName:     item.company_name?.S || tenantId,
    knowledgeBaseId: item.knowledge_base_id.S,
  };
}

// ─────────────────────────────────────────────────────────────────
// generateUUID()
// ─────────────────────────────────────────────────────────────────
// Returns a v4 UUID string (e.g. "550e8400-e29b-41d4-a716-446655440000").
//
// Used for:
//   • session_id  — uniquely identifies one chat session
//   • messageId   — uniquely identifies one message within a session
//   • questionId  — uniquely identifies one unknown-question log entry
//
// crypto.randomUUID() is built into Node.js 14.17+ — no npm package
// needed.
function generateUUID() {
  return require('crypto').randomUUID();
}

// ─────────────────────────────────────────────────────────────────
// loadConversationHistory(prefixedSessionId, client)
// ─────────────────────────────────────────────────────────────────
// Retrieves the last HISTORY_LIMIT (5) messages from this session.
//
// The prefixedSessionId is "{tenant_id}#{session_id}" — DynamoDB uses
// this as the partition key so each tenant's history is fully isolated
// even if two tenants have sessions with the same UUID.
//
// HOW IT WORKS:
//   Query with ScanIndexForward: false to get newest first, Limit: 5
//   stops after 5 items. reverse() restores chronological order.
//
// 30-MINUTE TIMEOUT:
//   If the newest message is older than SESSION_TIMEOUT_MS, return []
//   so Claude starts fresh instead of answering a stale context.
//
// GRACEFUL DEGRADATION:
//   Any failure returns [] — the chat continues without history.
async function loadConversationHistory(prefixedSessionId, client) {
  try {
    const result = await client.send(new QueryCommand({
      TableName:              CONVERSATION_TABLE_NAME,
      KeyConditionExpression: 'sessionId = :sid',
      ExpressionAttributeValues: {
        ':sid': { S: prefixedSessionId },
      },
      ScanIndexForward: false, // newest first
      Limit:            HISTORY_LIMIT,
    }));

    const items = result.Items || [];

    const messages = items.reverse().map(item => ({
      role:      item.role.S,
      content:   item.content.S,
      timestamp: Number(item.timestamp.N),
    }));

    // Session inactivity timeout check.
    if (messages.length > 0) {
      const lastTimestamp    = messages[messages.length - 1].timestamp;
      const sessionExpiredAt = lastTimestamp + SESSION_TIMEOUT_MS;
      if (Date.now() > sessionExpiredAt) {
        console.log(`Session ${prefixedSessionId} expired (>30 min inactive). Starting fresh.`);
        return [];
      }
    }

    return messages;

  } catch (err) {
    console.error('loadConversationHistory failed:', err.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────
// saveMessage(prefixedSessionId, role, content, sources, client, timestamp)
// ─────────────────────────────────────────────────────────────────
// Writes a single message to the ConversationHistory DynamoDB table.
//
// PARAMETERS:
//   prefixedSessionId — "{tenant_id}#{session_id}" (the partition key)
//   role              — "user" or "assistant"
//   content           — the full message text
//   sources           — number of KB chunks used (0 for user messages)
//   client            — the shared DynamoDBClient instance
//   timestamp         — millisecond epoch (caller controls so user and
//                       assistant messages always have distinct timestamps)
//
// TTL: each message expires 30 days after creation. DynamoDB deletes
//   it automatically — no cron job or manual purge needed.
async function saveMessage(prefixedSessionId, role, content, sources, client, timestamp) {
  const nowS = Math.floor(timestamp / 1000);

  try {
    await client.send(new PutItemCommand({
      TableName: CONVERSATION_TABLE_NAME,
      Item: {
        sessionId:  { S: prefixedSessionId },
        timestamp:  { N: String(timestamp) },
        messageId:  { S: generateUUID() },
        role:       { S: role },
        content:    { S: content },
        sources:    { N: String(sources) },
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
// Claude's Messages API requires an alternating sequence ending with
// a "user" turn. This function formats history into { role, content }
// pairs and appends the current user message at the end.
function buildConversationArray(loadedMessages, currentUserMessage) {
  const history = loadedMessages.map(msg => ({
    role:    msg.role,
    content: msg.content,
  }));
  return [...history, { role: 'user', content: currentUserMessage }];
}

// ─────────────────────────────────────────────────────────────────
// respond(statusCode, body)
// ─────────────────────────────────────────────────────────────────
// Builds an API Gateway HTTP API (v2) compatible response object.
// body MUST be a string — JSON.stringify handles the conversion.
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };
}