# agent-platform

Minimal AWS CDK stack that wires an HTTP API Gateway POST /chat route to a Lambda function backed by Claude Sonnet 4.5 on Amazon Bedrock.

## Prerequisites

- AWS CLI configured (`aws configure` or env vars)
- Node.js 20+
- AWS CDK CLI: `npm install -g aws-cdk`

## Deploy

```bash
# 1. Install dependencies
cd agent-platform
npm install

# 2. Bootstrap your AWS account/region (once per account+region)
cdk bootstrap

# 3. Deploy
cdk deploy

# The deploy output will print the API endpoint, e.g.:
# ChatStack.ApiUrl = https://abc123.execute-api.us-east-1.amazonaws.com
```

## Enable Claude Sonnet 4.5 in Bedrock

Before your first call you must request model access in the AWS Console:

1. Open **Amazon Bedrock** → **Model access** in your target region.
2. Find **Claude Sonnet 4.5** (Anthropic) and click **Request access**.
3. Wait for status to change to **Access granted** (usually immediate for Anthropic models).

## Test

```bash
API_URL=https://<your-api-id>.execute-api.<region>.amazonaws.com

curl -X POST "$API_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello! What can you do?"}'
```

Expected response:

```json
{"reply": "Hello! I'm Claude, an AI assistant made by Anthropic..."}
```

## Tear down

```bash
cdk destroy
```
