/**
 * ============================================================
 * lib/chat-stack.ts  –  CDK Stack Definition
 * ============================================================
 *
 * A CDK "Stack" is a collection of AWS resources that are
 * deployed, updated, and deleted together as a single unit.
 * Under the hood, CDK converts this TypeScript class into a
 * CloudFormation template — a JSON document that describes
 * every AWS resource and how they connect.
 *
 * This stack creates three AWS resources:
 *   1. A Lambda function   — runs our chat code
 *   2. An IAM policy       — lets Lambda call Bedrock
 *   3. An HTTP API Gateway — exposes a public HTTPS endpoint
 *
 * You never call this file directly. The CDK App in bin/app.ts
 * instantiates it, and `cdk deploy` does the rest.
 */

// The main CDK library — gives us Stack, Duration, CfnOutput, etc.
import * as cdk from 'aws-cdk-lib';

// AWS Lambda constructs — lets us define Lambda functions in code.
import * as lambda from 'aws-cdk-lib/aws-lambda';

// IAM (Identity and Access Management) constructs — lets us grant
// permissions to AWS services so they can talk to each other.
import * as iam from 'aws-cdk-lib/aws-iam';

// API Gateway v2 (HTTP API) constructs — creates our public endpoint.
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';

// Integration helper that connects API Gateway routes to Lambda.
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';

// The base class for all CDK constructs (the building blocks of CDK).
import { Construct } from 'constructs';

// Node.js built-in for resolving file paths in an OS-agnostic way.
import * as path from 'path';

export class ChatStack extends cdk.Stack {
  /**
   * Every CDK Stack is a TypeScript class that extends cdk.Stack.
   * The constructor is where you define your AWS resources.
   *
   * @param scope  – the parent App (or another Stack)
   * @param id     – a logical name used internally by CloudFormation
   * @param props  – optional settings like env (account, region)
   */
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    // Always call super() first — this registers the stack with the
    // CDK App and sets up the CloudFormation template context.
    // Forgetting super() causes an immediate runtime error.
    super(scope, id, props);

    // ==============================================================
    // 1. LAMBDA FUNCTION
    // ==============================================================
    //
    // AWS Lambda is a "serverless" function service. You upload code,
    // AWS runs it on-demand, and you pay only for the milliseconds
    // your code actually executes — no servers to manage or patch.
    //
    // lambda.Code.fromAsset() tells CDK to zip up the lambda/ folder
    // and upload it to S3 during `cdk deploy`. That zip becomes the
    // function's deployment package.
    const chatFn = new lambda.Function(this, 'ChatFunction', {

      // runtime: which language + version to use inside the container.
      // NODEJS_20_X = Node.js 20 on Amazon Linux 2023.
      // We choose Node.js 20 because AWS bundles the full AWS SDK v3
      // in this runtime — our lambda/index.js can require() Bedrock
      // without needing its own package.json or node_modules folder.
      runtime: lambda.Runtime.NODEJS_20_X,

      // handler: "<filename>.<exportedFunction>"
      // 'index.handler' tells Lambda to look for index.js and call
      // the exported function named 'handler'. This must exactly
      // match `exports.handler` in lambda/index.js — a typo here
      // causes a "Handler not found" error at runtime.
      handler: 'index.handler',

      // code: where the function's source lives on disk.
      // path.join(__dirname, '../lambda') gives the absolute path to
      // the lambda/ folder relative to THIS file (lib/chat-stack.ts).
      // __dirname is always the directory of the currently running
      // file — more reliable than a bare '../lambda' relative path.
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),

      // timeout: how long Lambda waits before force-killing the function.
      // Amazon Bedrock (Claude) typically responds in 2–10 seconds but
      // can take up to ~20 s for long outputs. 30 s gives us headroom.
      // Set this too low (e.g. 3 s) and Lambda returns a 504 timeout
      // before Claude finishes generating a reply.
      timeout: cdk.Duration.seconds(30),

      // memorySize: RAM allocated to the function (in MB).
      // AWS ties CPU allocation to memory — more RAM = more CPU.
      // 256 MB comfortably handles our JSON parsing and API calls.
      // The default (128 MB) causes noticeably slower cold starts.
      memorySize: 256,
    });

    // ==============================================================
    // 2. IAM POLICY — Grant Lambda permission to call Bedrock
    // ==============================================================
    //
    // IAM (Identity and Access Management) is AWS's permission system.
    // Every AWS service runs under an "IAM role" — an identity with a
    // list of allowed actions. Lambda automatically gets its own role,
    // but by default that role can't touch ANY other service.
    //
    // Without this policy, calling Bedrock returns:
    //   "AccessDeniedException: is not authorized to perform: bedrock:InvokeModel"
    //
    // WHY LEAST-PRIVILEGE (not bedrock:* or Resource: *)?
    //   We only grant the exact actions we need (InvokeModel,
    //   InvokeModelWithResponseStream) on the exact model ARNs we use.
    //   If Lambda were compromised, an attacker could not pivot to other
    //   Bedrock models or other AWS services. Broad wildcards are the #1
    //   source of accidental privilege escalation in AWS accounts.
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({

        // The specific Bedrock API operations Lambda is allowed to call.
        // InvokeModel                  — non-streaming call (what we use now)
        // InvokeModelWithResponseStream — streaming call (for future Phase 2)
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],

        // The exact AWS resource ARNs this permission applies to.
        // ARN = Amazon Resource Name, the unique identifier for any resource.
        //
        // First ARN:  the base foundation model registered in us-east-1
        // Second ARN: the cross-region inference profile
        //             ("us." prefix = Bedrock routes across US AZs for
        //              higher availability — required for this model)
        //
        // Both must be listed because the inference profile is a separate
        // resource from the underlying foundation model. If you omit either
        // ARN you get an AccessDeniedException for that specific resource.
        resources: [
          `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
          `arn:aws:bedrock:us-east-1:078232195170:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
        ],
      })
    );

    // ==============================================================
    // 3. HTTP API GATEWAY
    // ==============================================================
    //
    // API Gateway is a managed service that creates a public HTTPS
    // endpoint and routes incoming HTTP requests to your Lambda.
    // Without it, your Lambda has no public URL — it can only be
    // invoked directly from inside AWS.
    //
    // WHY HTTP API (v2) INSTEAD OF REST API (v1)?
    //   AWS offers two flavors of API Gateway:
    //     REST API (v1): feature-rich, complex, ~$3.50 / million requests
    //     HTTP API (v2): simpler, faster, ~$1.00 / million requests (~70% cheaper)
    //   For a basic Lambda proxy, HTTP API is the right choice. REST API
    //   makes sense only when you need features like request validation,
    //   WAF integration, or usage plans with API keys.
    //
    // corsPreflight:
    //   CORS (Cross-Origin Resource Sharing) is a browser security
    //   policy. When JavaScript on one domain (e.g. localhost:3000)
    //   calls an API on a DIFFERENT domain (e.g. your AWS URL), the
    //   browser sends a "preflight" OPTIONS request to check if it's
    //   allowed. Without this config every browser-based request fails:
    //     "CORS policy: No 'Access-Control-Allow-Origin' header present"
    //   Note: curl and Postman are NOT browsers and ignore CORS entirely.
    //
    //   allowOrigins: ['*'] — any domain may call this API.
    //   This is fine for development. In production, restrict to your
    //   app's real domain (e.g. 'https://myapp.com') to prevent abuse.
    const api = new apigwv2.HttpApi(this, 'ChatApi', {
      corsPreflight: {
        allowHeaders: ['Content-Type'],              // browsers must send this header
        allowMethods: [apigwv2.CorsHttpMethod.POST], // only POST is allowed
        allowOrigins: ['*'],                         // any domain can call this API
      },
    });

    // ==============================================================
    // 4. ROUTE: POST /chat → Lambda
    // ==============================================================
    //
    // A "route" maps a specific HTTP method + URL path pair to a
    // backend. Here we wire POST /chat → our Lambda function.
    //
    // HttpLambdaIntegration uses "proxy integration": the full HTTP
    // request (path, method, headers, query string, body) is packaged
    // into the Lambda event object. The Lambda's return value becomes
    // the HTTP response. This keeps things simple — Lambda controls
    // everything about the response (status code, headers, body).
    api.addRoutes({
      path: '/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ChatIntegration', chatFn),
    });

    // ==============================================================
    // 5. STACK OUTPUT — Print the API URL after deployment
    // ==============================================================
    //
    // CfnOutput defines a key-value pair that CloudFormation prints
    // to the terminal when `cdk deploy` finishes. You'll see:
    //
    //   Outputs:
    //     ChatStack.ApiUrl = https://abc123.execute-api.us-east-1.amazonaws.com
    //
    // Copy that URL and append /chat to get the full endpoint:
    //   https://abc123.execute-api.us-east-1.amazonaws.com/chat
    //
    // api.apiEndpoint is the base HTTPS URL — no trailing slash, no path.
    // Without CfnOutput you'd have to dig through the AWS Console to
    // find the URL every time you deploy.
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'HTTP API endpoint — append /chat to use it',
    });
  }
}
