import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Construct } from 'constructs';
import * as path from 'path';

export class ChatStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // --- Lambda function ---
    // Deploys lambda/index.js as a Node.js 20 function.
    // 30-second timeout accommodates Bedrock's first-token latency.
    const chatFn = new lambda.Function(this, 'ChatFunction', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',           // file: index.js, export: handler
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });

    // --- Bedrock IAM policy ---
    // Grants the Lambda's execution role permission to invoke the specific
    // Claude Sonnet 4.5 foundation model. Scoped to the exact model ARN
    // rather than bedrock:* to follow least-privilege.
    chatFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: [
          `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0`,
        ],
      })
    );

    // --- HTTP API Gateway ---
    // Creates a lightweight HTTP API (not REST API) — lower cost and latency.
    // CORS preflight is configured here so browsers can call the endpoint directly.
    const api = new apigwv2.HttpApi(this, 'ChatApi', {
      corsPreflight: {
        allowHeaders: ['Content-Type'],
        allowMethods: [apigwv2.CorsHttpMethod.POST],
        allowOrigins: ['*'],
      },
    });

    // --- Route: POST /chat ---
    // Connects the route to the Lambda via a proxy integration.
    // The full HTTP event (headers, body, method) is forwarded to the function.
    api.addRoutes({
      path: '/chat',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrations.HttpLambdaIntegration('ChatIntegration', chatFn),
    });

    // --- Stack output ---
    // Printed by `cdk deploy` — copy this URL to use in curl / your client.
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.apiEndpoint,
      description: 'HTTP API endpoint — POST /chat',
    });
  }
}
