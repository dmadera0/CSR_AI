#!/usr/bin/env node

// Entry point for the CDK CLI. Running `cdk deploy` starts here.
import * as cdk from 'aws-cdk-lib';
import { ChatStack } from '../lib/chat-stack';

// Create the CDK app — the root container for all stacks.
const app = new cdk.App();

// Instantiate the ChatStack, binding it to whichever AWS account
// and region the CLI is currently authenticated to.
new ChatStack(app, 'ChatStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
