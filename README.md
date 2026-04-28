# CSR_AI — Serverless AI Chat Agent on AWS

A beginner-friendly AWS project that deploys a live AI chat endpoint
powered by Claude Sonnet 4.5 (Anthropic) via Amazon Bedrock.

Send a message over HTTP, get an AI-generated reply back. No servers
to manage — AWS handles everything.

---

## What This Project Does

When this stack is deployed, you get a public HTTPS URL. You `POST` a
JSON message to it, and Claude generates a reply. That's it.

Under the hood:

```
Your Browser / curl
      │
      │  POST /chat  {"message": "Hello!"}
      ▼
┌─────────────────────┐
│   API Gateway       │  ← Public HTTPS endpoint (the URL you get)
│   (HTTP API)        │
└────────┬────────────┘
         │  Forwards full HTTP request
         ▼
┌─────────────────────┐
│   AWS Lambda        │  ← Runs lambda/index.js on-demand
│   (Node.js 20)      │
└────────┬────────────┘
         │  InvokeModel API call
         ▼
┌─────────────────────┐
│   Amazon Bedrock    │  ← Managed AI model hosting
│   Claude Sonnet 4.5 │
└────────┬────────────┘
         │  Generated text reply
         ▼
┌─────────────────────┐
│   AWS Lambda        │  ← Packages the reply as an HTTP response
└────────┬────────────┘
         │  HTTP 200  {"reply": "Hello! I'm Claude..."}
         ▼
Your Browser / curl
```

---

## Prerequisites

Before you start, install and configure these tools on your computer:

### 1. Node.js 20 or later

Download from https://nodejs.org — choose the "LTS" version.

Verify it works:

```bash
node --version   # should print v20.x.x or higher
npm --version    # should print 10.x.x or higher
```

### 2. AWS CLI

The AWS command-line tool lets CDK talk to your AWS account.

Install it: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html

Verify it works:

```bash
aws --version    # should print aws-cli/2.x.x
```

### 3. AWS CDK CLI

CDK is the framework this project uses to define infrastructure as code.

```bash
npm install -g aws-cdk
cdk --version    # should print 2.x.x
```

### 4. An AWS Account

Sign up at https://aws.amazon.com if you don't have one. You will need
a credit card, but the free tier covers small-scale testing.

---

## Step-by-Step Setup

### Step 1 — Configure your AWS credentials

This tells the AWS CLI (and CDK) which account to deploy to.

```bash
aws configure
```

You will be prompted for:
- **AWS Access Key ID** — from your AWS Console → IAM → Users → Security credentials
- **AWS Secret Access Key** — created at the same time as the access key
- **Default region name** — enter `us-east-1` (where Bedrock Claude is available)
- **Default output format** — press Enter to accept `json`

Verify it worked:

```bash
aws sts get-caller-identity
# Expected output:
# {
#     "UserId": "AIDAXXXXXXXXXXXXXXXXX",
#     "Account": "123456789012",
#     "Arn": "arn:aws:iam::123456789012:user/your-username"
# }
```

If this fails, your credentials are wrong or expired. Go back to the
AWS Console and generate new access keys.

### Step 2 — Enable Claude Sonnet 4.5 in Amazon Bedrock

Bedrock requires you to explicitly request access to each AI model
before you can use it. This is a one-time step per account + region.

1. Open the AWS Console at https://console.aws.amazon.com
2. Make sure your region (top-right) is set to **US East (N. Virginia)** (`us-east-1`)
3. Search for **Amazon Bedrock** in the search bar
4. In the left sidebar, click **Model access**
5. Find **Claude Sonnet 4.5** (under Anthropic) and click **Request access**
6. Wait for the status to change to **Access granted** (usually instant)

**If you skip this step**, the Lambda will return:
```json
{"error": "Upstream model error.", "detail": "...ModelNotReadyException..."}
```

### Step 3 — Install Node.js dependencies

```bash
cd /path/to/CSR_AI
npm install
```

This downloads the CDK libraries listed in `package.json` into a
`node_modules/` folder (excluded from git by `.gitignore`).

### Step 4 — Bootstrap your AWS account (one-time)

CDK "bootstrapping" creates a small set of AWS resources (an S3 bucket
and IAM roles) that CDK uses internally to deploy stacks. You only need
to do this once per AWS account + region combination.

```bash
cdk bootstrap
# Expected output:
#  ✅  Environment aws://123456789012/us-east-1 bootstrapped.
```

### Step 5 — Deploy

```bash
cdk deploy
```

CDK will:
1. Synthesize the stack (convert TypeScript → CloudFormation JSON)
2. Show you a list of IAM changes and ask for confirmation — type `y`
3. Upload your Lambda code to S3
4. Create all the AWS resources (Lambda, API Gateway, IAM policy)
5. Print the API URL when done

Expected output at the end:

```
 ✅  ChatStack

Outputs:
ChatStack.ApiUrl = https://abc123.execute-api.us-east-1.amazonaws.com
```

Copy that URL — it's your API endpoint.

---

## Testing the API

Replace `YOUR_API_URL` with the URL from the deploy output.

```bash
curl -X POST "YOUR_API_URL/chat" \
  -H "Content-Type: application/json" \
  -d '{"message": "What is AWS Lambda in one sentence?"}'
```

Expected response:

```json
{
  "reply": "AWS Lambda is a serverless compute service that runs your code in response to events without requiring you to manage any servers."
}
```

---

## How It Works — Each AWS Service Explained

### AWS CDK (Cloud Development Kit)

CDK lets you describe AWS infrastructure using TypeScript instead of
clicking through the AWS Console. You write classes, CDK converts them
to CloudFormation templates, and CloudFormation creates the real AWS
resources. The big win: your infrastructure is code — it can be
reviewed, versioned, and reproduced.

### AWS Lambda

Lambda is a "serverless" compute service. You give it a function
(`lambda/index.js`), and AWS runs it whenever it's triggered (by an
API Gateway request, in our case). AWS automatically handles:
- Provisioning servers
- Scaling up for multiple simultaneous requests
- Scaling down to zero when idle

You pay only for the milliseconds your code actually runs.

### Amazon API Gateway (HTTP API)

API Gateway creates a public HTTPS URL that routes incoming HTTP
requests to Lambda. Without it, Lambda has no public address — it can
only be called from inside AWS. API Gateway also handles:
- TLS (HTTPS encryption)
- CORS preflight requests (so browsers can call it)
- Request/response routing (POST /chat → our Lambda)

### Amazon Bedrock

Bedrock is AWS's managed AI model hosting service. It gives you access
to foundation models (including Claude) via a simple API. You don't
need to set up GPU servers or manage model weights — AWS handles all
of that. You pay per token (per word-piece) generated.

### AWS IAM (Identity and Access Management)

IAM controls what each AWS service is allowed to do. Lambda runs under
an IAM "role" — an identity with a list of allowed actions. By default
Lambda can't touch anything. Our CDK stack grants it exactly two
permissions: `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream`
on the specific Claude model ARNs. Nothing else.

---

## What's Next — Roadmap

This project is Phase 1 of a multi-phase AI agent platform.

### Phase 2 — Streaming Responses
Replace the blocking `InvokeModelCommand` with
`InvokeModelWithResponseStream` so the reply appears token-by-token
(like ChatGPT's typing effect) instead of all at once after a delay.

### Phase 3 — Conversation Memory
Currently each request is stateless — Claude forgets the previous
message. Phase 3 adds a DynamoDB table to store conversation history
keyed by a session ID, so Claude can maintain context across turns.

### Phase 4 — Agent Tools (Function Calling)
Give Claude the ability to call external APIs (weather, databases,
search) by wiring up Bedrock's tool-use feature. Claude decides when
to call a tool, Lambda executes it, and Claude incorporates the result
into its reply.

### Phase 5 — Frontend
A React or Next.js chat UI that talks to the API Gateway endpoint,
with a real-time streaming interface, conversation history, and
authentication (Amazon Cognito).

---

## Troubleshooting

### "SignatureDoesNotMatch"

**Symptom:** `curl` returns a 403 error with "SignatureDoesNotMatch".

**Cause:** Your AWS credentials are wrong, expired, or the system clock
is more than 5 minutes off (AWS rejects requests with stale timestamps).

**Fix:**
1. Run `aws sts get-caller-identity` — if it fails, re-run `aws configure`
2. Check your system clock: `date` should show the current time
3. Re-generate access keys in the AWS Console if needed

---

### "not authorized to perform: bedrock:InvokeModel"

**Symptom:** Lambda returns a 502 with an AccessDeniedException mentioning
`bedrock:InvokeModel`.

**Cause:** The Lambda's IAM role does not have permission to call Bedrock.
This usually means the CDK stack was not fully deployed.

**Fix:**
1. Run `cdk deploy` again to make sure the IAM policy was applied
2. Check the CloudFormation console — look for failed resource events
3. Verify the IAM policy in the Lambda console: Configuration → Permissions → Execution role

---

### "Model use case details have not been submitted"

**Symptom:** Lambda returns a 502 mentioning `ModelNotReadyException` or
"use case details".

**Cause:** You haven't requested model access for Claude Sonnet 4.5 in
the Bedrock console yet.

**Fix:** Follow "Step 2 — Enable Claude Sonnet 4.5 in Amazon Bedrock" above.
Make sure you're in the **us-east-1** region when you do it.

---

### "Upstream model error" referencing us-east-2 or another region

**Symptom:** Lambda returns a 502, and the CloudWatch log shows a
`UnknownEndpoint` or `AccessDeniedException` for the wrong region.

**Cause:** The `BedrockRuntimeClient` is using the wrong region. The
Lambda function's deployment region (set in CDK) may differ from
`us-east-1` where model access was granted.

**Fix:** The `client` in `lambda/index.js` is hard-coded to
`{ region: 'us-east-1' }`. Make sure that line was not accidentally
removed or changed.

---

## Cleanup — Destroy All Resources

When you're done, delete everything to stop AWS charges:

```bash
cdk destroy
```

Type `y` when prompted. This deletes the Lambda, API Gateway, and IAM
policy created by `cdk deploy`. The bootstrap resources (S3 bucket and
IAM roles) are not deleted — they're tiny and cost pennies per month.
