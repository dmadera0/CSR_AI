const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const client = new BedrockRuntimeClient({});
const MODEL_ID = 'anthropic.claude-sonnet-4-5-20250929-v1:0';

exports.handler = async (event) => {
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

  try {
    const payload = {
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      messages: [{ role: 'user', content: message }],
    };

    const command = new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(payload),
    });

    const response = await client.send(command);
    const result = JSON.parse(Buffer.from(response.body).toString('utf-8'));
    const reply = result.content?.[0]?.text ?? '';

    return respond(200, { reply });
  } catch (err) {
    console.error('Bedrock error:', err);
    return respond(502, { error: 'Upstream model error.', detail: err.message });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
