---
title: Secrets Remote Import
summary: AWS Secrets Manager metadata-only remote import API
---

Remote import lets the board link existing AWS Secrets Manager entries as
Paperclip `external_reference` secrets without copying plaintext into
Paperclip.

Both routes are board-only and company-scoped. The selected provider vault must
belong to the company, use `aws_secrets_manager`, and have a selectable status
(`ready` or `warning`). Disabled, coming-soon, or cross-company vaults are
rejected.

Remote import is an inventory and metadata workflow. Preview calls AWS
`ListSecrets` only and import stores a Paperclip external reference plus
fingerprint/version metadata. Neither route calls `GetSecretValue` or
`BatchGetSecretValue`, requests `SecretString`, requires KMS decrypt, logs raw
remote metadata, or copies secret plaintext into Paperclip.

## Preview Remote AWS Secrets

```
POST /api/companies/{companyId}/secrets/remote-import/preview
{
  "providerConfigId": "<aws-vault-uuid>",
  "query": "stripe",
  "nextToken": "optional-provider-page-token",
  "pageSize": 50
}
```

`query` is optional and is sent to AWS as an inventory filter. Treat it as
non-secret metadata because AWS may record list request parameters in
CloudTrail. `nextToken` is an opaque AWS cursor; pass it back unchanged.
`pageSize` is capped at 100.

Response:

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "nextToken": null,
  "candidates": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "remoteName": "prod/stripe",
      "name": "prod/stripe",
      "key": "prod-stripe",
      "providerVersionRef": null,
      "providerMetadata": {
        "lastChangedDate": "2026-05-06T00:00:00.000Z",
        "hasDescription": true
      },
      "status": "ready",
      "importable": true,
      "conflicts": []
    }
  ]
}
```

Candidate `status` values:

- `ready`: no existing exact external reference and no name/key collision.
- `duplicate`: an existing secret already has the exact provider `externalRef`.
- `conflict`: the suggested Paperclip `name` or `key` is already in use.

Conflict `type` values are `exact_reference`, `name`, `key`, and
`provider_guardrail`. AWS refs under Paperclip's own managed namespace are
blocked as external references so one company cannot import another company's
Paperclip-managed AWS secret through a broad runtime role.

## Import Remote AWS Secret References

```
POST /api/companies/{companyId}/secrets/remote-import
{
  "providerConfigId": "<aws-vault-uuid>",
  "secrets": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "description": "Stripe key used by production checkout",
      "providerVersionRef": null,
      "providerMetadata": {
        "lastChangedDate": "2026-05-06T00:00:00.000Z",
        "hasDescription": true
      }
    }
  ]
}
```

The import response is row-level. Ready rows become active
`external_reference` secrets with version metadata only. Exact-reference
duplicates and name/key conflicts are skipped without failing the whole request.
The `secrets` array accepts 1-100 rows, and the backend re-checks duplicates and
conflicts at submit time.
Each row may include an optional Paperclip `description` entered during review;
blank descriptions are stored as `null`. AWS provider descriptions are not
copied into this field.

```json
{
  "providerConfigId": "<aws-vault-uuid>",
  "provider": "aws_secrets_manager",
  "importedCount": 1,
  "skippedCount": 1,
  "errorCount": 0,
  "results": [
    {
      "externalRef": "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/stripe",
      "name": "Stripe production key",
      "key": "stripe-production-key",
      "status": "imported",
      "reason": null,
      "secretId": "<paperclip-secret-id>",
      "conflicts": []
    }
  ]
}
```

Activity logs record aggregate counts and provider/vault ids only, not remote
secret names, ARNs, tags, or values.

Imported references may still fail during a future bound runtime resolution if
the Paperclip runtime role can list the AWS secret but lacks
`secretsmanager:GetSecretValue` or required KMS decrypt permission for that
specific secret.
