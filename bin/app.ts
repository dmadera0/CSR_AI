#!/usr/bin/env node
/**
 * ============================================================
 * bin/app.ts  –  CDK Application Entry Point
 * ============================================================
 *
 * This file is the STARTING POINT for the AWS CDK CLI.
 * When you run `cdk deploy` or `cdk synth`, the CDK CLI
 * executes THIS file first via `npx ts-node bin/app.ts`.
 *
 * Think of a CDK App like a blueprint manager for an entire
 * cloud environment. Inside the app you register one or more
 * "Stacks" (groups of related AWS resources). CDK converts
 * each Stack into a CloudFormation template — a JSON document
 * AWS reads to know what infrastructure to create.
 *
 * In CSR_AI we have exactly one Stack: ChatStack.
 * It contains our Lambda function, API Gateway, and IAM policy.
 */

// aws-cdk-lib is the main CDK library. It provides the App class,
// which is the root container every CDK program must create first.
// Without an App, CDK has no context in which to synthesize stacks.
import * as cdk from 'aws-cdk-lib';

// Import our custom stack from lib/chat-stack.ts.
// ChatStack defines all the AWS resources that get created.
import { ChatStack } from '../lib/chat-stack';

// ---------------------------------------------------------------
// Create the CDK App — the root of all stacks
// ---------------------------------------------------------------
// new cdk.App() must be called before any Stack is instantiated.
// It sets up the synthesis engine that converts TypeScript into
// CloudFormation JSON during `cdk synth` / `cdk deploy`.
const app = new cdk.App();

// ---------------------------------------------------------------
// Register ChatStack with the App
// ---------------------------------------------------------------
// Arguments:
//   app          – the parent App (required, registers this stack)
//   'ChatStack'  – the logical ID → becomes the CloudFormation stack name
//   { env: ... } – which AWS account and region to deploy to
//
// WHY env: { account, region }?
//   Without this, the stack is "environment-agnostic" — CDK cannot
//   perform environment-specific lookups (e.g. resolve a VPC ID or
//   check region-specific service availability). Some CDK features
//   simply will not work. Always set env for real deployments.
//
// WHY CDK_DEFAULT_ACCOUNT / CDK_DEFAULT_REGION?
//   These environment variables are injected automatically by the
//   CDK CLI based on the AWS profile you configured with
//   `aws configure` (or AWS_PROFILE / AWS_DEFAULT_REGION env vars).
//
//   In other words:
//     CDK_DEFAULT_ACCOUNT = the account ID tied to your AWS credentials
//     CDK_DEFAULT_REGION  = the region you set in `aws configure`
//
//   This means you do NOT hard-code "123456789012" or "us-east-1"
//   into source code — the correct values are injected at deploy
//   time from your local AWS CLI configuration.
//
// COMMON GOTCHA: If CDK_DEFAULT_ACCOUNT is undefined, it usually
//   means you forgot `aws configure` or your credentials are expired.
//   Run `aws sts get-caller-identity` to verify credentials work.
new ChatStack(app, 'ChatStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT, // Your 12-digit AWS account ID
    region:  process.env.CDK_DEFAULT_REGION,  // e.g. "us-east-1"
  },
});
