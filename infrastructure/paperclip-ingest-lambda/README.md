# Paperclip Ingest Middleware Lambda

This directory contains the KIN-942 scaffold for the KIN-375 Phase C ingest middleware pipeline.

## What is included

- `template.yaml`: AWS SAM template for Lambda + EventBridge trigger + DLQ.
- `src/handler.mjs`: minimal Lambda handler scaffold for middleware execution.
- `tests/handler.test.mjs`: unit test for local handler behavior.
- `events/mock-event.json`: sample EventBridge payload for local invoke.
- `samconfig.toml`: default SAM build and local invoke parameters.

## Local validation

1. Run handler unit test:

```bash
node --test infrastructure/paperclip-ingest-lambda/tests/handler.test.mjs
```

2. Validate SAM template:

```bash
sam validate --template-file infrastructure/paperclip-ingest-lambda/template.yaml
```

3. Build SAM app:

```bash
sam build --template-file infrastructure/paperclip-ingest-lambda/template.yaml
```

4. Run local invoke with mock event:

```bash
sam local invoke IngestMiddlewareFunction --template-file infrastructure/paperclip-ingest-lambda/template.yaml --event infrastructure/paperclip-ingest-lambda/events/mock-event.json
```

## CI/CD workflow

The workflow at `.github/workflows/ingest-lambda-ci.yml` performs:

- PR/push validation scoped to this directory
- unit test + `sam validate` + `sam build`
- `sam package` + `sam deploy` to dev and staging on merge to `master`/`main`

## Required GitHub Secrets

- `AWS_REGION`
- `AWS_ROLE_ARN_DEV`
- `AWS_ROLE_ARN_STAGING`
- `SAM_ARTIFACT_BUCKET_DEV`
- `SAM_ARTIFACT_BUCKET_STAGING`
- `PAPERCLIP_INGEST_STACK_DEV`
- `PAPERCLIP_INGEST_STACK_STAGING`
