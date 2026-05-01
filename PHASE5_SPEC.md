# PHASE 5 — MULTI-TENANT SAAS PLATFORM

Build a multi-tenant AI customer service platform.

## CURRENT STATE
- Working single-tenant agent (Demosite only)
- Widget works: ~/Desktop/Programs/CSR_AI/widget
- Lambda, DynamoDB, Bedrock all deployed
- GitHub: https://github.com/dmadera0/CSR_AI

## GOAL
Support unlimited customers with isolated data.

## FEATURES NEEDED

1. **Self-serve signup** - customers create accounts, get API keys
2. **Admin dashboard** - customize agent, upload docs, view analytics
3. **Multi-tenant chat** - each customer gets own Knowledge Base
4. **WordPress plugin** - auto-embed widget
5. **Embed code** - universal script tag
6. **White-label URLs** - demosite.yourplatform.com
7. **Smart doc parsing** - PDF, Word, Markdown

## DATABASE TABLES

**Tenants**: tenant_id, company_name, email, api_key, knowledge_base_id, agent_name, greeting_message, primary_color

**Users**: user_id, tenant_id, email, password_hash, role

**Documents**: tenant_id#doc_id, filename, s3_key, file_type, status

**Conversations** (update existing): Add tenant_id prefix to session_id

## API ENDPOINTS

- POST /auth/signup - Create account
- POST /chat - Send message (tenant_id in request)
- POST /documents/upload - Upload PDF/Word/MD
- GET /documents - List docs
- PUT /tenant/customize - Update agent settings
- GET /conversations - View history

## TECH STACK
- React dashboard
- AWS Lambda (multi-tenant logic)
- DynamoDB (tables above)
- Bedrock (one KB per tenant)
- S3 (tenant docs)
- WordPress plugin (PHP)

## DELIVERABLES
1. Updated CDK stack (new tables)
2. Multi-tenant Lambda handlers
3. Admin dashboard (React)
4. WordPress plugin (PHP)
5. Document parser (PDF/Word→markdown)
6. Embed code generator
7. White-label subdomain router

DO NOT BUILD OR DEPLOY. Show plan and code structure first.
