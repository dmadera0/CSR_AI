const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { BedrockAgentClient, StartIngestionJobCommand } = require('@aws-sdk/client-bedrock-agent');
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const s3 = new S3Client({ region: 'us-east-1' });
const bedrock = new BedrockAgentClient({ region: 'us-east-1' });
const dynamo = new DynamoDBClient({ region: 'us-east-1' });

const DOCS_BUCKET = process.env.DOCS_BUCKET_NAME;
const TENANTS_TABLE = process.env.TENANTS_TABLE;
const DATA_SOURCE_ID = process.env.DATA_SOURCE_ID;

function parseMultipart(body, contentType) {
  const boundary = contentType.split('boundary=')[1];
  const parts = body.split(`--${boundary}`);
  const files = [];

  parts.forEach((part) => {
    if (part.includes('filename=')) {
      const filenameMatch = part.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : 'unknown';
      const contentStartIndex = part.indexOf('\r\n\r\n') + 4;
      const contentEndIndex = part.lastIndexOf('\r\n');
      const fileContent = part.slice(contentStartIndex, contentEndIndex);
      files.push({
        filename,
        content: Buffer.from(fileContent, 'binary')
      });
    }
  });

  return files;
}

exports.handler = async (event) => {
  console.log('Upload handler invoked');

  try {
    let tenantId = null;
    let files = [];

    if (event.isBase64Encoded) {
      const body = Buffer.from(event.body, 'base64').toString('utf-8');
      const contentType = event.headers['content-type'];
      const tenantMatch = body.match(/name="tenant_id"\r\n\r\n([^\r\n]+)/);
      tenantId = tenantMatch ? tenantMatch[1] : null;
      files = parseMultipart(body, contentType);
    } else {
      const body = event.body;
      const contentType = event.headers['content-type'];
      const tenantMatch = body.match(/name="tenant_id"\r\n\r\n([^\r\n]+)/);
      tenantId = tenantMatch ? tenantMatch[1] : null;
      files = parseMultipart(body, contentType);
    }

    if (!tenantId) {
      return respond(400, { error: 'Missing tenant_id' });
    }

    if (files.length === 0) {
      return respond(400, { error: 'No files provided' });
    }

    console.log(`Upload for tenant ${tenantId}: ${files.length} file(s)`);

    const tenantResult = await dynamo.send(new GetItemCommand({
      TableName: TENANTS_TABLE,
      Key: { tenant_id: { S: tenantId } }
    }));

    if (!tenantResult.Item) {
      return respond(404, { error: 'Tenant not found' });
    }

    const kbId = tenantResult.Item.knowledge_base_id.S;

    let uploadedCount = 0;
    for (const file of files) {
      const key = `tenant-docs/${tenantId}/${file.filename}`;
      
      await s3.send(new PutObjectCommand({
        Bucket: DOCS_BUCKET,
        Key: key,
        Body: file.content,
        ContentType: file.filename.endsWith('.pdf') ? 'application/pdf' : 'text/markdown'
      }));

      console.log(`Uploaded: ${key}`);
      uploadedCount++;
    }

    console.log(`Starting KB ingestion for ${kbId}`);
    try {
      await bedrock.send(new StartIngestionJobCommand({
        knowledgeBaseId: kbId,
        dataSourceId: DATA_SOURCE_ID
      }));
      console.log('Ingestion job started');
    } catch (ingestionError) {
      console.error('Ingestion error:', ingestionError.message);
    }

    return respond(200, {
      success: true,
      uploaded: uploadedCount,
      message: `Uploaded ${uploadedCount} file(s). Knowledge base is syncing...`,
    });

  } catch (error) {
    console.error('Upload error:', error);
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
