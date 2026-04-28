// AWS SDK v3 is pre-installed in the Node.js 20 managed runtime,
// so no lambda/package.json is needed.
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

// Client is created once outside the handler so it is reused across
// warm invocations (connection pooling, credential caching).
const client = new BedrockRuntimeClient({});
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

exports.handler = async (event) => {

  // --- Parse and validate the request body ---
  // API Gateway passes the raw HTTP body as event.body (a string).
  // We expect { message: string }; anything else gets a 400.
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

  // --- Call Bedrock ---
  try {
    // Build the Anthropic Messages API payload.
    // anthropic_version is required by the Bedrock wrapper.
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: message }],
    };

    // InvokeModelCommand sends the payload to the model and waits
    // for the complete response (non-streaming).
    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await client.send(command);

    // response.body is a Uint8Array — decode it, then parse the JSON.
    // The text reply lives at content[0].text in the Anthropic response schema.
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply = result.content?.[0]?.text ?? '';

    return respond(200, { reply });

  } catch (err) {
    // Log the full error server-side (visible in CloudWatch Logs),
    // but return only a generic 502 to the caller to avoid leaking internals.
    console.error('Bedrock error:', err);
    return respond(502, { error: 'Upstream model error.', detail: err.message });
  }
};

// --- Helper: build an API Gateway-compatible HTTP response ---
function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
