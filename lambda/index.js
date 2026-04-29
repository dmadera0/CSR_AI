/**
 * ============================================================
 * lambda/index.js  –  Lambda Handler (Phase 2: KB-Grounded Chat)
 * ============================================================
 *
 * Phase 2 adds a Retrieval-Augmented Generation (RAG) pattern:
 *
 *   Request arrives
 *       ↓
 *   1. RETRIEVE  – query the Bedrock Knowledge Base for the top-5
 *                  text chunks most relevant to the user's question
 *       ↓
 *   2. AUGMENT   – inject those chunks into a system prompt that
 *                  tells Claude to answer ONLY from that context
 *       ↓
 *   3. GENERATE  – call Claude (InvokeModel) with the grounded prompt
 *       ↓
 *   4. FLAG      – if Demo couldn't find an answer, write the
 *                  question to DynamoDB for content-team review
 *       ↓
 *   Response returned
 *
 * WHY RAG?
 *   Without RAG, Claude answers from its general training data — it
 *   knows nothing about Demosite specifically. RAG gives it a
 *   "cheat sheet" of relevant facts pulled from our KB documents,
 *   so it can answer Demosite-specific questions accurately without
 *   making things up ("hallucinating").
 *
 * RUNTIME NOTE:
 *   AWS Node.js 20 Lambda runtime ships with the full AWS SDK v3,
 *   so all `require('@aws-sdk/...')` calls below work without
 *   bundling a local node_modules folder.
 */

// ── Bedrock Runtime: InvokeModel (Claude) ────────────────────────
// Used in Step 3 (GENERATE) — sends the grounded prompt to Claude
// and returns the full text response.
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// ── Bedrock Agent Runtime: Retrieve (Knowledge Base) ─────────────
// Used in Step 1 (RETRIEVE) — sends the user question to the
// Knowledge Base and returns the top-N most relevant text chunks.
//
// NOTE: This is a DIFFERENT client from BedrockRuntimeClient.
//   BedrockRuntimeClient     → calls AI models directly (Claude, Titan)
//   BedrockAgentRuntimeClient → calls Knowledge Bases, Agents, and
//                               the RAG pipeline
const { BedrockAgentRuntimeClient, RetrieveCommand } = require('@aws-sdk/client-bedrock-agent-runtime');

// ── DynamoDB: PutItem (Unknown Question Log) ──────────────────────
// Used in Step 4 (FLAG) — writes the unanswered question to our
// UnknownQuestions table so the content team can review it.
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');

// ──────────────────────────────────────────────────────────────────
// Create all clients OUTSIDE the handler (warm-start optimization)
// ──────────────────────────────────────────────────────────────────
// Clients created at module load time are reused across warm Lambda
// invocations, avoiding repeated TLS handshakes and credential lookups.
// See Phase 1 comments for a full explanation of warm vs cold starts.
const bedrockClient      = new BedrockRuntimeClient({ region: 'us-east-1' });
const agentRuntimeClient = new BedrockAgentRuntimeClient({ region: 'us-east-1' });
const dynamoClient       = new DynamoDBClient({ region: 'us-east-1' });

// ── Constants ─────────────────────────────────────────────────────
// Model ID for Claude Sonnet 4.5 via cross-region inference profile.
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// Environment variables injected by CDK at deploy time.
// These are strings set in chat-stack.ts under `environment: { ... }`.
// process.env is Node's way of reading environment variables.
//
// KNOWLEDGE_BASE_ID    — the Bedrock KB ID (e.g. "ABCDE12345")
// UNKNOWN_QUESTIONS_TABLE — the DynamoDB table name (e.g. "UnknownQuestions")
const KNOWLEDGE_BASE_ID        = process.env.KNOWLEDGE_BASE_ID;
const UNKNOWN_QUESTIONS_TABLE  = process.env.UNKNOWN_QUESTIONS_TABLE;

// ── System Prompt Template ────────────────────────────────────────
// This is Demo's "personality card". It tells Claude:
//   - Who it is (Demo, Demosite's assistant)
//   - What facts it is allowed to use (only the KB chunks)
//   - How to behave when it doesn't know the answer
//   - What to say when someone asks for a discount
//
// The {{retrieved_chunks}} placeholder is replaced at runtime with
// the actual text retrieved from the Bedrock Knowledge Base.
// Using a template string here makes the substitution easy.
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
// Handler: called by Lambda on every API Gateway request
// ──────────────────────────────────────────────────────────────────
exports.handler = async (event) => {

  // ── Step 0: Parse and validate the request ──────────────────────
  //
  // Same as Phase 1 — API Gateway passes the raw HTTP body as a
  // string in event.body. We parse it and validate the message field.
  let message;
  try {
    const body = JSON.parse(event.body || '{}');
    message = body.message;
    if (!message || typeof message !== 'string') {
      return respond(400, { error: 'Request body must include a "message" string.' });
    }
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  // ── Step 1: RETRIEVE — Query the Knowledge Base ─────────────────
  //
  // We send the user's raw message as the retrieval query. The KB:
  //   1. Converts the query to a vector using Titan Embed V2
  //   2. Searches the S3 Vectors index for the 5 nearest vectors
  //   3. Returns the original text chunks that produced those vectors
  //
  // numberOfResults: 5
  //   Return the top 5 most relevant chunks. More chunks = more
  //   context for Claude but more tokens consumed and slower response.
  //   5 is a good balance for a small knowledge base like ours.
  //
  // IMPORTANT: We wrap this in try/catch because:
  //   - The KB might not be synced yet (documents not embedded)
  //   - Temporary AWS service errors can happen
  //   - In either case, we degrade gracefully: call Claude without
  //     KB context rather than returning a 502 error to the user.
  let retrievedChunks = [];
  let sourcesUsed = 0;

  try {
    const retrieveCommand = new RetrieveCommand({
      knowledgeBaseId: KNOWLEDGE_BASE_ID,
      retrievalQuery: {
        text: message,   // the user's question becomes the search query
      },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: 5,   // return the top 5 most relevant chunks
        },
      },
    });

    const retrieveResponse = await agentRuntimeClient.send(retrieveCommand);

    // retrievalResults is an array of result objects.
    // Each result has: content.text (the raw text chunk),
    //                  score (relevance score 0-1),
    //                  location (the S3 source file it came from).
    //
    // We extract only the text — Claude doesn't need the scores.
    // The ?. (optional chaining) handles the case where content or
    // text is missing (e.g. an empty KB or malformed result).
    retrievedChunks = (retrieveResponse.retrievalResults || [])
      .map(result => result.content?.text)
      .filter(text => text && text.trim().length > 0);  // remove empty chunks

    sourcesUsed = retrievedChunks.length;

  } catch (retrieveErr) {
    // Log the error server-side but don't fail the request.
    // Demo will respond with general knowledge and be directed to
    // support if it doesn't know — a better experience than a 502.
    console.warn('KB retrieve failed (KB may not be synced yet):', retrieveErr.message);
    // retrievedChunks stays [] — the system prompt will have an
    // empty knowledge base section, causing Demo to redirect to support.
  }

  // ── Step 2: AUGMENT — Build the Grounded System Prompt ──────────
  //
  // Replace the {{retrieved_chunks}} placeholder with the actual
  // chunks we got from the Knowledge Base.
  //
  // If no chunks were found (empty KB or retrieve error), the KNOWLEDGE
  // BASE section will contain the "no results" message. Claude will
  // then follow the INSTRUCTIONS and redirect to support@demosite.com.
  const chunksText = retrievedChunks.length > 0
    ? retrievedChunks.join('\n\n---\n\n')  // join chunks with a separator
    : '[No relevant information found in the knowledge base for this query.]';

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{retrieved_chunks}}', chunksText);

  // ── Step 3: GENERATE — Call Claude with the Grounded Prompt ─────
  //
  // The `system` field in the Anthropic Messages API is Claude's
  // "instruction manual". It's processed before the user message
  // and shapes how Claude interprets and responds to everything.
  //
  // Keeping the system prompt separate from the user message is
  // important: it lets Claude distinguish between "what I've been
  // instructed to do" vs "what the user is asking me."
  try {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,   // ← NEW in Phase 2: grounding instructions
      messages: [{ role: 'user', content: message }],
    };

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await bedrockClient.send(command);

    // Decode Uint8Array → string → parse JSON → extract text.
    // See Phase 1 comments for a full explanation of this conversion.
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply = result.content?.[0]?.text ?? '';

    // ── Step 4: FLAG — Detect and Log Unknown Questions ───────────
    //
    // We detect unknown questions by checking whether Demo included
    // "support@demosite.com" in its reply. Our system prompt instructs
    // Demo to mention this email ONLY when the Knowledge Base doesn't
    // contain the answer — so its presence is a reliable signal.
    //
    // WHY THIS APPROACH?
    //   We could ask Claude to return structured JSON with an
    //   `unknown_question` boolean, but that adds complexity and can
    //   fail if Claude doesn't follow the JSON format precisely.
    //   Checking for the support email is simpler and equally reliable
    //   for our use case.
    const unknownQuestion = reply.includes('support@demosite.com');

    if (unknownQuestion) {
      // ── Log to CloudWatch ───────────────────────────────────────
      // console.log writes to AWS CloudWatch Logs automatically.
      // The 'UNKNOWN_QUESTION:' prefix makes it easy to filter:
      //   CloudWatch → Log Insights → filter by 'UNKNOWN_QUESTION:'
      console.log('UNKNOWN_QUESTION:', JSON.stringify({
        message,
        timestamp: new Date().toISOString(),
      }));

      // ── Write to DynamoDB ───────────────────────────────────────
      // Store the question in the UnknownQuestions table so the
      // content team can review it and add missing KB documents.
      //
      // DynamoDB's raw PutItemCommand requires each attribute value
      // to be wrapped in a type descriptor:
      //   { S: 'string value' }   for strings
      //   { N: '123' }            for numbers (sent as strings!)
      //
      // WHY N AS A STRING?
      //   DynamoDB uses a text-based wire format internally. Numbers
      //   must be sent as strings and DynamoDB parses them server-side.
      //
      // ttl: 90 days from now, expressed as a Unix timestamp (seconds
      //   since Jan 1 1970). DynamoDB reads this number and auto-deletes
      //   the row after that timestamp passes. Formula:
      //   Math.floor(Date.now() / 1000)  = current time in seconds
      //   + 90 * 24 * 60 * 60           = 90 days in seconds
      //
      // crypto.randomUUID() is built into Node.js 20 — no extra package.
      // It generates a v4 UUID (e.g. "3f5a9e12-...") for the questionId.
      try {
        const { randomUUID } = require('crypto');
        const now = Math.floor(Date.now() / 1000);
        const ninetyDaysInSeconds = 90 * 24 * 60 * 60;

        await dynamoClient.send(new PutItemCommand({
          TableName: UNKNOWN_QUESTIONS_TABLE,
          Item: {
            questionId: { S: randomUUID() },
            timestamp:  { S: new Date().toISOString() },
            question:   { S: message },
            ttl:        { N: String(now + ninetyDaysInSeconds) },
          },
        }));
      } catch (dynamoErr) {
        // DynamoDB write failure is non-critical. The user still gets
        // a response. Log the error but don't fail the request.
        console.error('DynamoDB write failed:', dynamoErr.message);
      }
    }

    // ── Return the response ──────────────────────────────────────────
    //
    // Phase 2 response shape (expanded from Phase 1):
    //   reply            – Demo's text response (same as before)
    //   unknown_question – true if the KB didn't contain the answer
    //   sources_used     – number of KB chunks Claude had access to
    //
    // The additional fields let the frontend show contextual UI:
    //   e.g. highlight the "contact support" message in a different
    //   colour, or show a "based on N sources" footer.
    return respond(200, {
      reply,
      unknown_question: unknownQuestion,
      sources_used: sourcesUsed,
    });

  } catch (err) {
    // Claude invocation failed. Log full error to CloudWatch.
    // Return only a generic message to the caller — never expose
    // internal ARNs, account IDs, or stack traces in HTTP responses.
    console.error('Bedrock InvokeModel error:', err);
    return respond(502, {
      error: 'Upstream model error.',
      detail: err.message,
      unknown_question: false,
      sources_used: sourcesUsed,
    });
  }
};

// ──────────────────────────────────────────────────────────────────
// respond() — build an API Gateway-compatible HTTP response
// ──────────────────────────────────────────────────────────────────
// API Gateway requires:
//   { statusCode: number, headers: object, body: string }
// body MUST be a string (JSON.stringify converts our object to one).
// statusCode matters: 200 = success, 400 = bad input, 502 = upstream error.
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
