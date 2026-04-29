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
    knowledgeBase.addS3DataSource({
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

    // ==============================================================
    // PHASE 1 — LAMBDA FUNCTION (updated with Phase 2 additions)
    // ==============================================================
    //
    // The Lambda function is defined AFTER the Knowledge Base and
    // DynamoDB table so we can pass their IDs as environment variables.
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
        // The KB ID that the Lambda passes to BedrockAgentRuntimeClient
        // when calling the Retrieve API.
        KNOWLEDGE_BASE_ID: knowledgeBase.knowledgeBaseId,

        // The DynamoDB table name for writing unknown question records.
        UNKNOWN_QUESTIONS_TABLE: unknownQuestionsTable.tableName,
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

    // ── DynamoDB PutItem ──────────────────────────────────────────
    //
    // grantWriteData() adds a PolicyStatement granting:
    //   Actions: dynamodb:PutItem, dynamodb:UpdateItem, dynamodb:DeleteItem, etc.
    //   Resource: <table ARN>
    //
    // The Lambda only calls PutItem, but grantWriteData is the CDK
    // convention for "write access" and is still scoped to this table.
    unknownQuestionsTable.grantWriteData(chatFn);

    // ==============================================================
    // PHASE 1 — HTTP API GATEWAY (unchanged)
    // ==============================================================

    // API Gateway creates the public HTTPS endpoint for POST /chat.
    // See Phase 1 comments in the original chat-stack.ts for details.
    const api = new apigwv2.HttpApi(this, 'ChatApi', {
      corsPreflight: {
        allowHeaders: ['Content-Type'],
        allowMethods: [apigwv2.CorsHttpMethod.POST],
        allowOrigins: ['*'],
      },
    });

    api.addRoutes({
      path: '/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ChatIntegration', chatFn),
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
  }
}
