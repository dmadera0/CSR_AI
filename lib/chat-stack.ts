/**
 * ============================================================
 * lib/chat-stack.ts  –  CDK Stack Definition (Phase 2)
 * ============================================================
 *
 * A CDK "Stack" is a collection of AWS resources that are
 * deployed, updated, and deleted together as a single unit.
 * Under the hood, CDK converts this TypeScript class into a
 * CloudFormation template — a JSON document that describes
 * every AWS resource and how they connect.
 *
 * PHASE 5 ADDITIONS (multi-tenant backend):
 *  11. Tenants               — DynamoDB table storing one row per customer,
 *                              mapping tenant_id → Bedrock Knowledge Base ID.
 *                              The Lambda reads this on every request to know
 *                              which KB to search and which session partition
 *                              to read/write for conversation history.
 *
 * PHASE 3 ADDITIONS (on top of Phase 2):
 *  10. ConversationHistory   — DynamoDB table storing the last N messages
 *                              per chat session so Claude can remember
 *                              what was said earlier in the conversation
 *
 * PHASE 2 ADDITIONS (on top of Phase 1):
 *   4. An S3 bucket          — stores the Demosite knowledge docs
 *   5. A BucketDeployment    — uploads docs to S3 on every deploy
 *   6. An S3 Vectors bucket  — the vector database (much cheaper than
 *                              OpenSearch Serverless, fully AWS-native)
 *   7. An S3 Vectors index   — the searchable vector index inside
 *                              the bucket (1024 dims for Titan Embed)
 *   8. A Bedrock KB          — indexes and searches the S3 docs using
 *                              the vector index above
 *   9. A DynamoDB table      — records questions Demo couldn't answer
 *                              so the team can improve coverage
 *
 * PHASE 1 RESOURCES (unchanged):
 *   1. Lambda function       — runs our chat code
 *   2. IAM policies          — grants least-privilege permissions
 *   3. HTTP API Gateway      — public HTTPS endpoint
 */

// Core CDK library — Stack, Duration, CfnOutput, RemovalPolicy, etc.
import * as cdk from 'aws-cdk-lib';

// Lambda constructs — define serverless functions in code.
import * as lambda from 'aws-cdk-lib/aws-lambda';

// IAM constructs — grant fine-grained permissions between services.
import * as iam from 'aws-cdk-lib/aws-iam';

// API Gateway v2 (HTTP API) — creates a public HTTPS endpoint.
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

// Wires API Gateway routes to Lambda functions.
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

// Standard S3 bucket — stores the knowledge base markdown files.
import * as s3 from 'aws-cdk-lib/aws-s3';

// Deploys local files to S3 automatically as part of `cdk deploy`.
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

// DynamoDB — a fully managed NoSQL database.
// We use it to log questions Demo couldn't answer for later review.
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// @cdklabs/generative-ai-cdk-constructs provides two namespaces we need:
//
//   bedrock    — high-level L2 constructs for Bedrock Knowledge Bases,
//                data sources, embedding models, etc.
//
//   s3vectors  — constructs for Amazon S3 Vectors (the new AWS-native
//                vector database). Cheaper and simpler than OpenSearch
//                Serverless — no server clusters to manage or pay for.
//
// WHY S3 VECTORS AND NOT OPENSEARCH?
//   Bedrock Knowledge Bases require a vector database to store and
//   search the embeddings it generates from your documents.
//   OpenSearch Serverless is the "old" default — it costs ~$175/month
//   even when idle. Amazon S3 Vectors (launched 2025) is a native AWS
//   alternative that stores vectors in S3-like buckets and charges only
//   for storage used (pennies for a small knowledge base like ours).
import { bedrock, s3vectors } from '@cdklabs/generative-ai-cdk-constructs';

// The base class for all CDK constructs.
import { Construct } from 'constructs';

// Node.js built-in for OS-agnostic file path resolution.
import * as path from 'path';

export class ChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ==============================================================
    // PHASE 2 — KNOWLEDGE BASE INFRASTRUCTURE
    // (created first so we can pass the KB ID to the Lambda below)
    // ==============================================================

    // ── 1. S3 Bucket: Knowledge Document Storage ─────────────────
    //
    // This is a regular S3 bucket that holds our five markdown files
    // (company-overview.md, products.md, etc.). Bedrock will read
    // these files and convert them into vector embeddings stored in
    // the S3 Vectors index below.
    //
    // versioned: true
    //   S3 keeps a history of every file version. Required by the
    //   Bedrock data source to detect document changes.
    //
    // blockPublicAccess: BLOCK_ALL
    //   Nobody on the internet can read this bucket directly. Only
    //   Bedrock's IAM role (granted below) can access the files.
    //
    // autoDeleteObjects + removalPolicy: DESTROY
    //   When you run `cdk destroy`, CDK deletes all files and the
    //   bucket itself. Handy for development — avoids orphaned S3
    //   buckets that cost money after the stack is gone.
    const knowledgeBucket = new s3.Bucket(this, 'DemositeKnowledgeBucket', {
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    // ── 2. BucketDeployment: Sync Local Files to S3 ──────────────
    //
    // Every time you run `cdk deploy`, this construct zips up the
    // knowledge-base/ folder and uploads it to the S3 bucket above.
    //
    // This means:
    //   - Adding or editing a .md file → re-deploy → S3 is updated
    //   - Then trigger a KB sync to re-embed the changed docs
    //   (see README for the sync command)
    //
    // Source.asset() tells CDK to look at the knowledge-base/ folder
    // relative to THIS file's location (lib/chat-stack.ts).
    new s3deploy.BucketDeployment(this, 'KnowledgeBaseDeployment', {
      sources: [s3deploy.Source.asset(path.join(__dirname, '../knowledge-base'))],
      destinationBucket: knowledgeBucket,
    });

    // ── 3. S3 Vector Bucket: The Vector Database ──────────────────
    //
    // Amazon S3 Vectors is a new AWS service (2025) that lets you
    // store and query high-dimensional vectors directly in S3-style
    // "buckets". It is the backbone of our Knowledge Base.
    //
    // Think of a VectorBucket like a database server. Inside it you
    // create one or more "indexes" (like tables) that hold the actual
    // vectors. Bedrock manages reading/writing to this bucket when it
    // indexes documents and when Lambda queries it at runtime.
    //
    // removalPolicy: DESTROY
    //   Tells CDK to delete this resource when `cdk destroy` runs.
    //
    // NOTE: Unlike the S3 knowledge bucket above (which uses CDK's built-in
    //   auto-delete mechanism), S3 Vectors does not support autoDeleteObjects
    //   without Docker. If `cdk destroy` fails because the vector bucket is
    //   not empty, delete its contents manually from the AWS Console:
    //   S3 Vectors → select the bucket → Delete all indexes → then destroy.
    const vectorBucket = new s3vectors.VectorBucket(this, 'DemositeVectorBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 4. S3 Vector Index: The Searchable Vector Index ───────────
    //
    // A VectorIndex is the actual search index within the VectorBucket.
    // Think of it like a table inside the database bucket.
    //
    // dimension: 1024
    //   The Amazon Titan Embed Text V2 model produces vectors with
    //   exactly 1024 numbers per document chunk. This dimension must
    //   match the model perfectly — wrong dimension → deploy error.
    //
    // distanceMetric: COSINE
    //   When searching for relevant chunks, Bedrock compares the
    //   query vector to stored vectors using cosine similarity.
    //   Cosine measures the angle between vectors (ignores magnitude),
    //   which works well for semantic text similarity.
    const vectorIndex = new s3vectors.VectorIndex(this, 'DemositeVectorIndex', {
      vectorBucket,
      dimension: 1024,
      distanceMetric: s3vectors.VectorIndexDistanceMetric.COSINE,
    });

    // ── 5. Bedrock Knowledge Base ─────────────────────────────────
    //
    // A Bedrock Knowledge Base is a managed pipeline that:
    //   1. Reads your documents from the S3 data source below
    //   2. Splits them into overlapping chunks of text
    //   3. Runs each chunk through the embedding model to get a vector
    //   4. Stores the vector + original text in the S3 Vector Index
    //
    // At query time, the Lambda sends a user question → the KB
    // converts it to a vector → searches the index for the N most
    // similar chunks → returns the text of those chunks.
    //
    // embeddingsModel: TITAN_EMBED_TEXT_V2_1024
    //   Amazon Titan Embed Text V2 is AWS's text embedding model.
    //   It converts a passage of text into a 1024-number vector that
    //   captures semantic meaning. Similar passages get similar
    //   vectors even if the exact words differ.
    //
    // vectorStore: vectorIndex
    //   Tells the KB to store embeddings in our S3 Vectors index
    //   instead of the default OpenSearch Serverless collection.
    //
    // name: 'demosite-knowledge-base'
    //   The human-readable name shown in the AWS Console.
    //   If you change this after deploying, a new KB is created.
    const knowledgeBase = new bedrock.VectorKnowledgeBase(this, 'DemositeKnowledgeBase', {
      embeddingsModel: bedrock.BedrockFoundationModel.TITAN_EMBED_TEXT_V2_1024,
      vectorStore: vectorIndex,
      name: 'demosite-knowledge-base',
      description: 'Demosite product catalog, services, policies, and FAQ for the Demo customer service agent.',
    });

    // ── 6. S3 Data Source: Connect Docs Bucket to Knowledge Base ──
    //
    // A data source tells Bedrock WHERE your documents live.
    // Adding this connects the KB to the S3 bucket so it knows which
    // files to read and embed when you trigger a sync.
    //
    // chunkingStrategy: DEFAULT
    //   Bedrock splits each markdown file into overlapping chunks of
    //   ~300 tokens each before embedding. The DEFAULT strategy picks
    //   reasonable overlap and chunk sizes automatically.
    //   Smaller chunks = more precise retrieval but more API calls.
    //   Larger chunks = more context per result but lower precision.
    // Capture the return value so uploadFn can pass its dataSourceId
    // to Bedrock's StartIngestionJob API after a file is uploaded.
    const dataSource = knowledgeBase.addS3DataSource({
      bucket: knowledgeBucket,
      dataSourceName: 'demosite-documents',
      chunkingStrategy: bedrock.ChunkingStrategy.DEFAULT,
    });

    // ── 7. DynamoDB Table: Unknown Question Log ───────────────────
    //
    // DynamoDB is AWS's fully managed NoSQL database. Each row is a
    // JSON document — no rigid schema required.
    //
    // WHY LOG UNKNOWN QUESTIONS?
    //   When Demo can't find an answer in the Knowledge Base, it tells
    //   the user to email support@demosite.com. We simultaneously log
    //   the question here so the content team can:
    //     - See what customers are asking that isn't covered
    //     - Add new documents to the knowledge base
    //     - Reduce the number of unsupported questions over time
    //
    // partitionKey: questionId (String)
    //   The primary unique identifier for each row. We generate a
    //   UUID in Lambda for each unanswered question.
    //
    // sortKey: timestamp (String)
    //   The secondary key within the same partition. Using timestamp
    //   lets us range-query (e.g. "all questions this week").
    //
    // timeToLiveAttribute: 'ttl'
    //   DynamoDB automatically deletes rows after the Unix timestamp
    //   stored in the 'ttl' field passes. We set TTL to 90 days so
    //   the table doesn't grow forever. Old data is deleted for free.
    //
    // billingMode: PAY_PER_REQUEST
    //   We pay only for the reads and writes we actually perform.
    //   No reserved capacity = no minimum cost. Perfect for low-
    //   traffic development projects.
    const unknownQuestionsTable = new dynamodb.Table(this, 'UnknownQuestionsTable', {
      partitionKey: { name: 'questionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── 8. DynamoDB Table: Conversation History ───────────────────
    //
    // WHY CONVERSATION MEMORY?
    //   Without memory, every message Demo receives is stateless — it
    //   has no idea what was said two turns ago. "What about my return?"
    //   makes no sense without the prior context. This table stores
    //   the recent messages for each session so Claude always has
    //   the full conversation when it generates the next reply.
    //
    // DATA MODEL:
    //   Each row is one message (user or assistant).
    //   Multiple rows share the same sessionId — one per conversation.
    //   We query by sessionId, ordered by timestamp, to reconstruct
    //   the conversation in chronological order.
    //
    // partitionKey: sessionId (String)
    //   Groups all messages in one conversation together. Every query
    //   targets a specific session, so sessionId is the partition key.
    //
    // sortKey: timestamp (Number)
    //   Within a session, messages are ordered by the millisecond
    //   timestamp at which they were written. DynamoDB always keeps
    //   items within a partition sorted by the sort key, making
    //   "give me messages for session X, newest first" very fast.
    //   Using Number (not String) ensures correct numeric ordering —
    //   String ordering would put "1000" before "200" alphabetically.
    //
    // timeToLiveAttribute: 'ttl'
    //   The Lambda writes a Unix timestamp (seconds) 30 days in the
    //   future into the 'ttl' field. DynamoDB silently deletes the
    //   row once that timestamp passes. Old conversations clean up
    //   automatically — no cron job or manual purge needed.
    //
    // billingMode: PAY_PER_REQUEST
    //   No minimum capacity charge. Cost scales with actual read/write
    //   volume. Perfect for a project that has bursts of usage
    //   separated by quiet periods.
    const conversationTable = new dynamodb.Table(this, 'ConversationHistory', {
      tableName: 'ConversationHistory',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── GSI: sessionId-timestamp-index ────────────────────────────
    //
    // A Global Secondary Index (GSI) is an additional index that lets
    // you query the table using a different key schema than the main
    // table's primary key.
    //
    // DESIGN NOTE: This GSI has the same partition key (sessionId)
    // and sort key (timestamp) as the main table. In practice that
    // means the main table index already supports all the queries we
    // need (query by sessionId, ordered by timestamp). The GSI is
    // included here per the project specification; it may be useful
    // later if the primary key schema changes (e.g., you add a userId
    // partition key and move sessionId to a GSI).
    //
    // projectionType: ALL
    //   The GSI stores a complete copy of every attribute (not just
    //   keys). This means queries against the GSI can return all
    //   fields without a second "GetItem" round-trip.
    //
    // DEPLOY-TIME NOTE: DynamoDB may raise a validation error if it
    // rejects a GSI whose key schema exactly mirrors the base table.
    // If `cdk deploy` fails with a GSI validation error, comment out
    // this block — the main table index supports all required queries.
    conversationTable.addGlobalSecondaryIndex({
      indexName: 'sessionId-timestamp-index',
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── 9. DynamoDB Table: Tenants ────────────────────────────────
    //
    // One row per customer. The Lambda reads this table on every chat
    // request to find which Bedrock Knowledge Base belongs to the
    // tenant sending the request.
    //
    // partitionKey: tenant_id (String)
    //   A short, memorable ID chosen at account creation time
    //   (e.g. "demosite", "acme-corp"). Callers include this in
    //   every chat request so the Lambda knows whose KB to use.
    //   Stored in snake_case to match the REST API field naming.
    //
    // No sort key — tenant_id is globally unique so a single-key
    // table is sufficient. Lookups are GetItem (O(1)), not Query.
    //
    // removalPolicy: DESTROY
    //   Safe for development. Change to RETAIN before going live
    //   so tenant records survive a `cdk destroy`.
    const tenantsTable = new dynamodb.Table(this, 'Tenants', {
      tableName:    'Tenants',
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GSI: look up a tenant by email for the duplicate-email check at signup.
    // A Scan would be O(n) and slow as tenant count grows; the GSI keeps
    // it a constant-time GetItem equivalent regardless of table size.
    tenantsTable.addGlobalSecondaryIndex({
      indexName:      'email-index',
      partitionKey:   { name: 'email', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ==============================================================
    // PHASE 1 — LAMBDA FUNCTION (updated through Phase 5)
    // ==============================================================
    //
    // The Lambda function is defined AFTER ALL DynamoDB tables so
    // every table name is resolved before it is injected as an env var.
    // Environment variables are the standard way to pass configuration
    // from CDK infrastructure code to Lambda runtime code.

    const chatFn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),

      // 30 s: Bedrock KB retrieve + Claude generate can take up to ~15 s.
      // Give enough headroom so neither step hits the timeout.
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,

      // Environment variables are key-value strings passed to the
      // Lambda's process.env. The values are resolved at deploy time
      // from CDK token references (e.g. knowledgeBase.knowledgeBaseId),
      // not hard-coded strings — so they stay correct across deployments.
      environment: {
        // Phase 5: KNOWLEDGE_BASE_ID is gone. The Lambda now looks up the
        // correct KB ID dynamically from the Tenants table on each request,
        // using the tenant_id the caller sends in the request body.
        // This is what makes the handler multi-tenant.

        // The DynamoDB table name for tenant → KB ID lookups.
        TENANTS_TABLE: tenantsTable.tableName,

        // The DynamoDB table name for writing unknown question records.
        UNKNOWN_QUESTIONS_TABLE: unknownQuestionsTable.tableName,

        // The DynamoDB table name for reading/writing conversation history.
        // Session keys are now prefixed with tenant_id to prevent any
        // cross-tenant data leakage: "{tenant_id}#{session_id}"
        CONVERSATION_TABLE_NAME: conversationTable.tableName,
      },
    });

    // ==============================================================
    // IAM POLICIES — Least-Privilege Permissions
    // ==============================================================
    //
    // Each policy grants the Lambda's execution role permission to
    // call a specific AWS API on a specific resource. We never use
    // wildcard actions (action: '*') or wildcard resources (resource: '*').

    // ── Bedrock InvokeModel ───────────────────────────────────────
    //
    // Grants permission to call Claude via Bedrock's InvokeModel API.
    // The two ARNs cover:
    //   1. The base foundation model (direct invocation)
    //   2. The cross-region inference profile ("us." prefix = routes
    //      across US availability zones for higher availability)
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
          `arn:aws:bedrock:us-east-1:078232195170:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        ],
      })
    );

    // ── Bedrock Retrieve (Knowledge Base) ─────────────────────────
    //
    // grantRetrieve() adds a PolicyStatement granting:
    //   Action: bedrock:Retrieve
    //   Resource: <knowledgeBase ARN>
    //
    // Without this, the Lambda gets AccessDeniedException when it
    // calls the BedrockAgentRuntime Retrieve API.
    knowledgeBase.grantRetrieve(chatFn);

    // ── DynamoDB: Tenants (read-only) ─────────────────────────────
    //
    // grantReadData() grants GetItem, BatchGetItem, Query, and Scan.
    // The Lambda only calls GetItem (one lookup per request), but
    // CDK's standard read grant keeps the code idiomatic.
    // Write access is intentionally NOT granted — tenant rows are
    // seeded manually or by a future admin API, never by the chat
    // handler itself.
    tenantsTable.grantReadData(chatFn);

    // ── DynamoDB: UnknownQuestions (write-only) ───────────────────
    //
    // grantWriteData() grants PutItem, UpdateItem, DeleteItem, and
    // BatchWriteItem on the table. The Lambda only calls PutItem but
    // this is CDK's standard "write" grant and stays scoped to this
    // table's ARN.
    unknownQuestionsTable.grantWriteData(chatFn);

    // ── DynamoDB: ConversationHistory (read + write) ──────────────
    //
    // The conversation table needs TWO kinds of access:
    //
    //   PutItem   — write each new user message and assistant reply
    //   Query     — read the session's recent message history before
    //               each Claude call so it has conversation context
    //   BatchGetItem — available for future bulk-read operations
    //
    // We grant both via specific actions rather than the broad
    // grantReadWriteData() to keep permissions as narrow as possible.
    //
    // The second resource entry ("<tableArn>/index/*") is required for
    // Query calls that target the GSI (sessionId-timestamp-index)
    // instead of the main table index. Without it, GSI queries return
    // AccessDeniedException even though the table ARN is allowed.
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'dynamodb:PutItem',      // write new messages
          'dynamodb:Query',        // read session history
          'dynamodb:BatchGetItem', // future bulk reads
        ],
        resources: [
          conversationTable.tableArn,              // main table
          `${conversationTable.tableArn}/index/*`, // all GSIs
        ],
      })
    );

    // ==============================================================
    // AUTH LAMBDA + LAYER
    // ==============================================================

    // ── Lambda Layer: auth dependencies ───────────────────────────
    //
    // A Lambda Layer is a zip of extra files unpacked into /opt/ in the
    // execution environment. Node.js resolves require() against
    // /opt/nodejs/node_modules/ automatically, so auth.js can call
    // `require('bcryptjs')` without bundling it in the main package.
    //
    // Layer contents: bcryptjs + @aws-sdk/client-s3vectors
    //
    // PRE-DEPLOY: run the following once before `cdk deploy`:
    //   cd layers/auth-deps/nodejs && npm install && cd ../../..
    const authDepsLayer = new lambda.LayerVersion(this, 'AuthDepsLayer', {
      layerVersionName: 'auth-deps',
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/auth-deps')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_20_X],
      description: 'bcryptjs + @aws-sdk/client-s3vectors for the signup handler',
    });

    // ── Auth Lambda ────────────────────────────────────────────────
    //
    // Kept separate from chatFn so it can carry wider IAM permissions
    // (Bedrock create*, S3 Vectors create*, iam:PassRole) without
    // granting those sensitive rights to the chat handler.
    // Principle of least privilege: each function has only what it needs.
    const authFn = new lambda.Function(this, 'AuthFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,

      // 'auth.handler' → Lambda looks for auth.js in the deployment
      // package and calls exports.handler. Both index.js and auth.js
      // live in the same lambda/ folder, so one Code.fromAsset bundles both.
      handler: 'auth.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),

      // Generous timeout: CreateKnowledgeBase + CreateDataSource together
      // can take up to ~20 s on Bedrock's first call.
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      layers: [authDepsLayer],

      environment: {
        // DynamoDB table for reading (email check) and writing (new tenant).
        TENANTS_TABLE: tenantsTable.tableName,

        // IAM execution role that Bedrock assumes when managing the KB.
        // New tenant KBs reuse the role CDK created for the Demosite KB —
        // all KBs need the same permissions (embed model + S3 + S3 Vectors).
        KB_ROLE_ARN: knowledgeBase.role.roleArn,

        // Shared S3 Vectors bucket: each tenant gets their own index inside.
        VECTOR_BUCKET_NAME: vectorBucket.vectorBucketName,

        // Docs bucket: tenant uploads land under tenant-docs/{tenantId}/.
        DOCS_BUCKET_NAME: knowledgeBucket.bucketName,
      },
    });

    // ── IAM: Tenants table (read + write) ─────────────────────────
    // Read  — QueryCommand on email-index GSI (duplicate email check)
    // Write — PutItemCommand to insert the new tenant row
    tenantsTable.grantReadWriteData(authFn);

    // ── IAM: Bedrock create permissions ───────────────────────────
    // CreateKnowledgeBase and CreateDataSource cannot be scoped to a
    // specific resource ARN — AWS requires '*' for all create actions.
    authFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:CreateKnowledgeBase',
          'bedrock:CreateDataSource',
          'bedrock:TagResource',
        ],
        resources: ['*'],
      })
    );

    // ── IAM: PassRole ──────────────────────────────────────────────
    // When authFn calls CreateKnowledgeBase it passes KB_ROLE_ARN so
    // Bedrock can assume that role. Lambda must have iam:PassRole on
    // that specific ARN or AWS rejects the call with AccessDenied.
    authFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions:   ['iam:PassRole'],
        resources: [knowledgeBase.role.roleArn],
      })
    );

    // ── IAM: S3 Vectors (create + inspect per-tenant index) ───────
    // CreateIndex — provisioned once per signup
    // GetIndex, ListIndexes — confirm the index exists before KB creation
    authFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          's3vectors:CreateIndex',
          's3vectors:GetIndex',
          's3vectors:ListIndexes',
        ],
        resources: [
          vectorBucket.vectorBucketArn,
          `${vectorBucket.vectorBucketArn}/index/*`,
        ],
      })
    );

    // ── IAM: S3 docs bucket (read-only for auth handler) ──────────
    // authFn doesn't upload files itself, but the Bedrock data source
    // it creates needs to list the tenant prefix during first sync.
    knowledgeBucket.grantRead(authFn);

    // ── Login Lambda (POST /auth/login) ────────────────────────────
    // Authenticates tenants by email + password, returns tenant_id + KB ID.
    // Kept separate from authFn so it carries only the minimal permissions
    // it needs (read-only on Tenants) rather than inheriting authFn's
    // broad Bedrock/S3 Vectors create permissions.
    const loginFn = new lambda.Function(this, 'LoginFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'login.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      layers: [authDepsLayer],
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
      },
    });

    // ── IAM: Tenants table (read-only) ─────────────────────────────
    // loginFn only reads — it queries email-index to find the tenant,
    // then reads the password_hash to verify credentials.
    // Write access is intentionally omitted (login never mutates data).
    tenantsTable.grantReadData(loginFn);

    // ── Upload Lambda (POST /upload) ───────────────────────────────
    // Handles multipart file uploads, stores in S3 under tenant-docs/{tenantId}/,
    // triggers KB ingestion job automatically.
    //
    // memorySize: 512 — larger than the chat Lambda because this handler
    // parses a multipart body and buffers file bytes in memory before
    // writing to S3. 256 MB is enough for text files but PDF/DOCX files
    // can be several MB; 512 MB keeps us well inside Lambda's limits.
    const uploadFn = new lambda.Function(this, 'UploadFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'upload.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      layers: [authDepsLayer],
      environment: {
        DOCS_BUCKET_NAME:  knowledgeBucket.bucketName,
        TENANTS_TABLE:     tenantsTable.tableName,
        // knowledgeBaseId + dataSourceId are both required by
        // Bedrock's StartIngestionJob API — one identifies the KB,
        // the other identifies which data source to re-index.
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,
        DATA_SOURCE_ID:    dataSource.dataSourceId,   // fixed: .dataSourceId not .id
      },
    });

    // ── IAM: S3 write (upload documents) ───────────────────────────
    knowledgeBucket.grantPut(uploadFn);

    // ── IAM: DynamoDB read (tenant lookup) ─────────────────────────
    tenantsTable.grantReadData(uploadFn);

    // ── IAM: Bedrock (start ingestion) ─────────────────────────────
    // StartIngestionJob cannot be restricted to a specific resource ARN
    // at the action level — AWS requires '*' for this operation.
    uploadFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions:   ['bedrock:StartIngestionJob'],
        resources: ['*'],
      })
    );

    // ==============================================================
    // ADMIN LAMBDA — Owner dashboard (GET /admin/tenants, PUT /admin/tenants/{tenantId})
    // ==============================================================

    const adminFn = new lambda.Function(this, 'AdminFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'admin.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        TENANTS_TABLE: tenantsTable.tableName,
      },
    });

    // Scan (list all) + UpdateItem (edit tenant fields)
    tenantsTable.grantReadWriteData(adminFn);

    // ==============================================================
    // PHASE 1 — HTTP API GATEWAY (unchanged)
    // ==============================================================

    // API Gateway creates the public HTTPS endpoint for POST /chat.
    // See Phase 1 comments in the original chat-stack.ts for details.
    const api = new apigwv2.HttpApi(this, 'ChatApi', {
      corsPreflight: {
        allowHeaders: ['Content-Type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        allowOrigins: ['*'],
      },
    });

    api.addRoutes({
      path: '/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ChatIntegration', chatFn),
    });

    // POST /auth/signup — public, no API key required.
    // The global corsPreflight config on this HttpApi automatically applies
    // to all routes, so no extra CORS setup is needed here.
    api.addRoutes({
      path: '/auth/signup',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('AuthIntegration', authFn),
    });

    // POST /auth/login — public, returns tenant_id + knowledge_base_id.
    // NOTE: the original snippet used REST API syntax (apigateway.LambdaIntegration
    // + api.root.addMethod). This API Gateway is HTTP API v2 (apigwv2.HttpApi),
    // so the correct integration is HttpLambdaIntegration + api.addRoutes().
    api.addRoutes({
      path: '/auth/login',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('LoginIntegration', loginFn),
    });

    // POST /upload — accepts multipart file uploads, stores in S3, triggers
    // Bedrock ingestion. VERSION_2_0 payload format is required so API Gateway
    // passes the raw base64-encoded body (instead of a parsed event) which the
    // Lambda can decode and stream directly to S3.
    // NOTE: the original snippet used apigwv2.HttpLambdaIntegration — that class
    // lives in the `integrations` import namespace, not `apigwv2`.
    api.addRoutes({
      path: '/upload',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('UploadIntegration', uploadFn, {
        payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
      }),
    });

    // GET  /admin/tenants            — list all tenants
    // PUT  /admin/tenants/{tenantId} — update a tenant record
    // VERSION_2_0 so routeKey and pathParameters are available in the event.
    const adminIntegration = new integrations.HttpLambdaIntegration('AdminIntegration', adminFn, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    api.addRoutes({
      path: '/admin/tenants',
      methods: [apigwv2.HttpMethod.GET],
      integration: adminIntegration,
    });
    api.addRoutes({
      path: '/admin/tenants/{tenantId}',
      methods: [apigwv2.HttpMethod.PUT],
      integration: adminIntegration,
    });

    // ==============================================================
    // STACK OUTPUTS — Printed by `cdk deploy`
    // ==============================================================

    // The API base URL — append /chat to get the full endpoint.
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'HTTP API endpoint — POST to /chat',
    });

    // The Knowledge Base ID — needed to trigger a sync after deploy.
    // After deploying, run:
    //   aws bedrock-agent start-ingestion-job \
    //     --knowledge-base-id <this value> \
    //     --data-source-id <data source id from console>
    new cdk.CfnOutput(this, 'KnowledgeBaseId', {
      value: knowledgeBase.knowledgeBaseId,
      description: 'Bedrock Knowledge Base ID — use to trigger a sync after deploy',
    });

    // The ConversationHistory table name — useful for querying via
    // the AWS Console or CLI to verify messages are being stored.
    new cdk.CfnOutput(this, 'ConversationTableName', {
      value: conversationTable.tableName,
      description: 'DynamoDB table storing conversation history per session',
    });

    // The Tenants table name — seed one row per customer after deploying.
    // See README for the aws dynamodb put-item command to add a tenant.
    new cdk.CfnOutput(this, 'TenantsTableName', {
      value: tenantsTable.tableName,
      description: 'DynamoDB Tenants table — seed a row here for each customer',
    });

    // Full URL for the signup endpoint — open public/signup.html and
    // set API_URL to the ApiUrl output value; this endpoint is derived
    // from the same API Gateway so both values share the same base URL.
    new cdk.CfnOutput(this, 'SignupEndpoint', {
      value: `${api.apiEndpoint}/auth/signup`,
      description: 'POST /auth/signup — public signup endpoint',
    });
  }
}
