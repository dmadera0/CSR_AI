/**
 * ============================================================
 * lambda/index.js  –  Lambda Handler (Chat via Amazon Bedrock)
 * ============================================================
 *
 * This file is the code that AWS Lambda executes every time
 * someone sends a POST request to /chat via API Gateway.
 *
 * AWS Lambda is "serverless" compute — you upload code and AWS
 * runs it on-demand on its own servers. You pay only for the
 * milliseconds your function actually runs. No servers to patch,
 * no capacity to manage.
 *
 * RUNTIME NOTE:
 *   AWS's Node.js 20 managed runtime ships with AWS SDK v3
 *   pre-installed. That means we can `require('@aws-sdk/...')`
 *   without creating a package.json inside lambda/ or running
 *   `npm install`. Saves ~50 MB of deployment package size.
 */

// Pull out exactly what we need from the Bedrock SDK:
//
//   BedrockRuntimeClient — manages authentication, request signing
//                          (AWS SigV4), and HTTP connections to Bedrock.
//                          Created once and reused across invocations.
//
//   InvokeModelCommand   — the command object that describes a
//                          non-streaming model invocation request.
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// ---------------------------------------------------------------
// Create the Bedrock client OUTSIDE the handler
// ---------------------------------------------------------------
// CRITICAL PERFORMANCE DETAIL:
//   We create the client HERE, at module-load time, not inside
//   the handler function. Here is why this matters:
//
//   AWS Lambda reuses the same Node.js process for back-to-back
//   requests ("warm invocations"). Code at the top level of the
//   file runs only ONCE on the first request ("cold start"), then
//   the process is frozen and thawed for later requests.
//
//   If the client were inside the handler, it would be re-created
//   on EVERY request — paying the TLS handshake and credential
//   lookup cost each time. Keeping it outside means those costs
//   are paid once and the connection is reused for free.
//
// region: 'us-east-1'
//   We hard-code the region here because Bedrock foundation model
//   access is region-specific. Our IAM policy (in chat-stack.ts)
//   grants InvokeModel only for us-east-1 ARNs, so the client must
//   call the same region. Using {} (no region) would make the client
//   inherit the Lambda function's deployment region, which may differ
//   if the stack is ever redeployed in another region — causing
//   silent AccessDenied errors that are hard to debug.
const client = new BedrockRuntimeClient({ region: 'us-east-1' });

// The full model ID for Claude Sonnet 4.5 accessed via a
// cross-region inference profile. The "us." prefix tells Bedrock
// to automatically route the request across US availability zones
// for higher resilience — required for this model tier.
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

// ---------------------------------------------------------------
// Handler: the function AWS Lambda calls on every request
// ---------------------------------------------------------------
// AWS Lambda calls `exports.handler` automatically when the
// function is triggered. For API Gateway HTTP API integrations,
// the `event` parameter contains the full HTTP request:
//
//   event.body        – the raw request body as a STRING
//                       (API Gateway does NOT auto-parse JSON for you)
//   event.headers     – HTTP request headers (Content-Type, etc.)
//   event.requestContext.http.method – "POST", "GET", etc.
//
// The function must return an object that API Gateway can convert
// into an HTTP response (see the respond() helper below).
exports.handler = async (event) => {

  // --- Step 1: Parse and validate the request body ---
  //
  // API Gateway passes the raw HTTP body as a plain string in
  // event.body. We must parse it ourselves with JSON.parse().
  //
  // We wrap this in try/catch because:
  //   - If the caller sends malformed JSON (e.g. plain text instead
  //     of {"message":"hello"}), JSON.parse throws a SyntaxError.
  //   - If we don't catch that, Lambda crashes and returns a 502.
  //   - Returning a 400 instead tells the caller what they did wrong.
  let message;
  try {
    // event.body is null when the request has no body at all.
    // The '|| "{}"' fallback prevents JSON.parse(null) from throwing.
    const body = JSON.parse(event.body || '{}');

    // Extract the "message" field that the caller should have sent.
    message = body.message;

    // Reject requests that are missing the field, or where it is
    // not a plain string (e.g. a number, array, or nested object).
    if (!message || typeof message !== 'string') {
      return respond(400, { error: 'Request body must include a "message" string.' });
    }
  } catch {
    // JSON.parse threw — the body was not valid JSON at all.
    return respond(400, { error: 'Invalid JSON body.' });
  }

  // --- Step 2: Call Amazon Bedrock (Claude) ---
  try {
    // Build the Anthropic Messages API request payload.
    //
    // anthropic_version: 'bedrock-2023-05-31'
    //   Required by Bedrock's wrapper around the Anthropic API.
    //   Always use this exact string — it never changes. Omitting it
    //   causes a 400 "missing required parameter: anthropic_version".
    //
    // max_tokens: 1024
    //   The maximum number of "tokens" (word-pieces, ~0.75 words each)
    //   Claude may write in its reply. 1024 ≈ 750 English words.
    //   Higher values allow longer answers but cost more money and
    //   can push responses past Lambda's 30-second timeout.
    //
    // messages: [ { role, content } ]
    //   The conversation history as an array of turns.
    //   role:    "user"      = the human speaking
    //            "assistant" = Claude speaking
    //   content: the text of that turn
    //   For a one-shot Q&A we send a single user message.
    //   For multi-turn chat you would include the full history array.
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: message }],
    };

    // Wrap the payload in an InvokeModelCommand.
    //
    // modelId:      which Bedrock model to call
    // contentType:  the format we are sending ('application/json')
    // accept:       the format we want back ('application/json')
    // body:         the payload serialized to a string
    //               (Bedrock's API accepts raw bytes / strings, not objects)
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    // Send the command and wait for the complete response.
    // This is NON-STREAMING — Lambda blocks until Claude finishes
    // generating the entire reply before returning anything.
    // Streaming (InvokeModelWithResponseStream) would feel faster to
    // the user but requires extra wiring that is Phase 2 work.
    const response = await client.send(command);

    // Decode the response body.
    //
    // GOTCHA: response.body is a Uint8Array (raw binary bytes), NOT
    // a string. The AWS SDK uses binary for InvokeModel because models
    // can theoretically return any content type. We always get JSON,
    // so we convert:
    //   Uint8Array → Node.js Buffer → UTF-8 string → parsed JSON object
    //
    // The Anthropic response schema looks like this:
    //   {
    //     "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
    //     "type": "message",
    //     "role": "assistant",
    //     "content": [
    //       { "type": "text", "text": "Hello! I'm Claude..." }
    //     ],
    //     "stop_reason": "end_turn",
    //     "usage": { "input_tokens": 12, "output_tokens": 31 }
    //   }
    //
    // content[0].text is where the actual reply text lives.
    // The ?. (optional chaining) and ?? '' (nullish coalescing) guard
    // against unexpected shapes — e.g. if content is empty for a
    // filtered or safety-blocked response.
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply = result.content?.[0]?.text ?? '';

    return respond(200, { reply });

  } catch (err) {
    // Something went wrong calling Bedrock.
    //
    // console.error writes the full error object to AWS CloudWatch Logs.
    // You can view these logs in the AWS Console:
    //   CloudWatch → Log groups → /aws/lambda/ChatStack-ChatFunction-...
    // This is your primary debugging tool for Lambda errors.
    //
    // We return only a generic 502 to the caller. We never expose
    // raw error objects in HTTP responses because they can contain
    // internal ARNs, account IDs, or stack traces.
    // The err.message is included here for development convenience;
    // remove 'detail' before going to production.
    console.error('Bedrock error:', err);
    return respond(502, { error: 'Upstream model error.', detail: err.message });
  }
};

// ---------------------------------------------------------------
// respond() — build an API Gateway-compatible HTTP response
// ---------------------------------------------------------------
// API Gateway HTTP API (v2) expects Lambda to return exactly this
// object shape. If body is not a string, API Gateway returns a
// confusing 500 "malformed Lambda proxy response" error.
//
//   statusCode – the HTTP status code the caller receives
//                200 = success, 400 = bad request, 502 = upstream error
//   headers    – HTTP response headers (tells client this is JSON)
//   body       – the response payload, MUST be a string (not an object)
//
// JSON.stringify converts our plain object to the required string form.
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
