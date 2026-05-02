const bcrypt = require('bcryptjs');
const { DynamoDBClient, PutItemCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { createHash, randomBytes } = require('crypto');

const dynamo = new DynamoDBClient({ region: 'us-east-1' });

const TENANTS_TABLE = process.env.TENANTS_TABLE;
// Pre-created KB ID (shared across tenants, data isolated by S3 prefix)
const DEFAULT_KB_ID = 'AB2OOZFU3J';

exports.handler = async (event) => {
  console.log('Signup handler invoked');
  
  try {
    const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    const { company_name, email, password } = body;

    // Validate input
    if (!company_name || !email || !password) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: company_name, email, password' })
      };
    }

    if (password.length < 8) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Password must be at least 8 characters' })
      };
    }

    console.log('Signup request for:', email);

    // Check if email already exists
    const emailCheck = await dynamo.send(new QueryCommand({
      TableName: TENANTS_TABLE,
      IndexName: 'email-index',
      KeyConditionExpression: 'email = :email',
      ExpressionAttributeValues: { ':email': { S: email } }
    }));

    if (emailCheck.Items && emailCheck.Items.length > 0) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'Email already registered' })
      };
    }

    // Generate unique tenant_id
    const slug = company_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const randomSuffix = randomBytes(2).toString('hex');
    const tenant_id = `${slug}-${randomSuffix}`;

    console.log('Generated tenant_id:', tenant_id);

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);
    
    // Generate API key (returned to user once)
    const api_key = randomBytes(32).toString('hex');
    const api_key_hash = createHash('sha256').update(api_key).digest('hex');

    // Write tenant to DynamoDB
    console.log('Writing tenant to DynamoDB...');
    await dynamo.send(new PutItemCommand({
      TableName: TENANTS_TABLE,
      Item: {
        tenant_id: { S: tenant_id },
        company_name: { S: company_name },
        email: { S: email },
        password_hash: { S: password_hash },
        knowledge_base_id: { S: DEFAULT_KB_ID },  // Shared KB, data isolated by S3 prefix
        api_key_hash: { S: api_key_hash },
        created_at: { S: new Date().toISOString() },
        status: { S: 'active' }
      }
    }));

    console.log('Tenant created successfully');

    // Return success with credentials (API key shown once)
    return {
      statusCode: 201,
      body: JSON.stringify({
        success: true,
        tenant_id,
        api_key,  // Raw API key returned once
        knowledge_base_id: DEFAULT_KB_ID,
        message: 'Account created successfully. Save your API key — it will not be shown again.'
      })
    };

  } catch (error) {
    console.error('Signup error:', error.message, error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error.message || 'Internal server error',
        type: error.constructor.name
      })
    };
  }
};
