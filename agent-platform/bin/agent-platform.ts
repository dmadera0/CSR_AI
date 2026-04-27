#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChatStack } from '../lib/chat-stack';

const app = new cdk.App();
new ChatStack(app, 'ChatStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
