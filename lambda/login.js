/**
 * lambda/login.js  –  Login Handler
 * ====================================
 * Route: POST /auth/login
 *
 * Authenticates an existing tenant by email + password.
 * Returns tenant_id and knowledge_base_id on success so the caller
 * knows which KB to route subsequent chat requests to.
 *
 * Flow:
 *   1. Validate email + password fields
 *   2. Query Tenants table via email-index GSI (O(1), not a Scan)
 *   3. Compare submitted password against bcrypt hash
 *   4. Return tenant credentials on match, 401 on mismatch
 *
 * Dependencies (provided via authDepsLayer):
 *   bcryptjs — bcrypt.compare() for password verification
 */

const bcrypt = require('bcryptjs');
// QueryCommand targets the email-index GSI — constant-time lookup
// regardless of how many tenants are in the table.
// ScanCommand was the original approach but scans the entire table
// and becomes slower/more expensive as tenant count grows.
const { DynamoDBClient, QueryCommand } = require('@aws-sdk/client-dynamodb');

const dynamo = new DynamoDBClient({ region: 'us-east-1' });

const TENANTS_TABLE = process.env.TENANTS_TABLE;

exports.handler = async (event) => {
  console.log('Login handler invoked');
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { email, password } = body;

    if (!email || !password) {
      return respond(400, { error: 'Missing email or password' });
    }

    console.log('Login attempt for:', email);

    // Use the email-index GSI instead of a full-table Scan.
    // The GSI is defined in chat-stack.ts on the Tenants table.
    const queryResult = await dynamo.send(new QueryCommand({
      TableName:              TENANTS_TABLE,
      IndexName:              'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': { S: email } },
      Limit: 1,
    }));

    if (!queryResult.Items || queryResult.Items.length === 0) {
      return respond(401, { error: 'Invalid email or password' });
    }

    const tenant           = queryResult.Items[0];
    const tenant_id        = tenant.tenant_id.S;
    const password_hash    = tenant.password_hash.S;
    const company_name     = tenant.company_name.S;
    const knowledge_base_id = tenant.knowledge_base_id.S;

    console.log('Tenant found:', tenant_id);

    const passwordMatch = await bcrypt.compare(password, password_hash);
    if (!passwordMatch) {
      return respond(401, { error: 'Invalid email or password' });
    }

    console.log('Password verified for:', tenant_id);

    return respond(200, {
      success: true,
      tenant_id,
      company_name,
      knowledge_base_id,
      email,
    });

  } catch (error) {
    console.error('Login error:', error);
    return respond(500, { error: error.message || 'Internal server error' });
  }
};

function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
