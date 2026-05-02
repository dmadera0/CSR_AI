const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const dynamo = new DynamoDBClient({ region: 'us-east-1' });
const TENANTS_TABLE = process.env.TENANTS_TABLE;

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  console.log('Owner admin handler:', event.routeKey);

  try {
    if (event.routeKey === 'GET /admin/tenants') {
      const scanResult = await dynamo.send(new ScanCommand({
        TableName: TENANTS_TABLE
      }));

      console.log('Scan result:', JSON.stringify(scanResult.Items, null, 2));

      const tenants = (scanResult.Items || []).map(item => {
        try {
          return {
            tenant_id: item.tenant_id?.S || '',
            company_name: item.company_name?.S || '',
            email: item.email?.S || '',
            knowledge_base_id: item.knowledge_base_id?.S || '',
            status: (item.status && item.status.S) ? item.status.S : 'active',
            created_at: item.created_at?.S || new Date().toISOString()
          };
        } catch (e) {
          console.error('Error mapping tenant:', e, item);
          return null;
        }
      }).filter(t => t !== null);

      return respond(200, { tenants });
    }

    if (event.routeKey === 'PUT /admin/tenants/{tenantId}') {
      const tenantId = event.pathParameters.tenantId;
      const body = JSON.parse(event.body || '{}');
      const { company_name, email } = body;

      if (!company_name || !email) {
        return respond(400, { error: 'Missing company_name or email' });
      }

      await dynamo.send(new UpdateItemCommand({
        TableName: TENANTS_TABLE,
        Key: { tenant_id: { S: tenantId } },
        UpdateExpression: 'SET company_name = :cn, email = :e',
        ExpressionAttributeValues: {
          ':cn': { S: company_name },
          ':e': { S: email }
        }
      }));

      return respond(200, { success: true, message: 'Tenant updated successfully' });
    }

    if (event.requestContext.http.method === 'OPTIONS') {
      return respond(200, {});
    }

    return respond(404, { error: 'Route not found' });

  } catch (error) {
    console.error('Admin error:', error);
    return respond(500, { error: error.message || 'Internal server error' });
  }
};
