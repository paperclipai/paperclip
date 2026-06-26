# Paperclip Page Skill

`paperclip-page` publishes static page directories to a Paperclip-controlled S3
bucket served through CloudFront. It is the durable Paperclip-owned replacement
for quick `here.now`-style page sharing.

The v1 security posture is:

- CloudFront + ACM + Origin Access Control in front of a private S3 REST origin.
- Public content only.
- Dedicated uploader IAM identity, separate from Paperclip attachment storage.
- No `s3:DeleteObject`, no `aws s3 sync --delete`, and no bucket/IAM/DNS changes
  from the publish helper.
- Symlinks, hidden files, unsafe slugs, and accidental overwrites are rejected.

## Agent Quick Start

Build or prepare a static directory with `index.html` at its root:

```bash
site/
  index.html
  assets/app.css
  assets/app.js
```

Validate without AWS writes:

```bash
.agents/skills/paperclip-page/scripts/publish.sh ./site --slug demo --dry-run
```

Publish:

```bash
.agents/skills/paperclip-page/scripts/publish.sh ./site --slug demo
```

Update an existing page from the same source directory:

```bash
.agents/skills/paperclip-page/scripts/publish.sh ./site --slug demo --update
```

The helper prints:

- public URL
- S3 key prefix
- local ownership state path

## Source Directory Rules

- `index.html` must exist at the directory root.
- Source directory itself must not be a symlink.
- No symlinks anywhere in the tree.
- No hidden files or dot paths in published content.
- `.paperclip-page/state.json` is allowed and excluded from uploads.
- Do not publish secrets, credentials, internal logs, private company material,
  customer data, or regulated data.

Add this to the publishing repo or generated site `.gitignore` when the source
directory lives in a git checkout:

```gitignore
.paperclip-page/
```

## Environment Variables

Required for live publishes:

```bash
export AWS_REGION=us-east-1
export PAPERCLIP_PAGE_BUCKET=paperclip-pages-prod
export PAPERCLIP_PAGE_BASE_URL=https://pages.paperclip.ing
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

Optional:

```bash
export PAPERCLIP_PAGE_DEFAULT_PREFIX=""
export PAPERCLIP_PAGE_AWS_PROFILE=paperclip-page-uploader
```

Recommended Paperclip secret names:

- `paperclip-page-aws-access-key-id`
- `paperclip-page-aws-secret-access-key`

Bind those secrets into publisher agents as `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`. Do not reuse Paperclip's internal S3 attachment/object
storage credentials.

## AWS Setup

Run setup with an operator/admin AWS profile. Agents using this skill should not
create buckets, mutate IAM, change DNS, or manage CloudFront.

```bash
export AWS_PROFILE=paperclip-admin
export AWS_REGION=us-east-1
export BUCKET=paperclip-pages-prod
export DOMAIN=pages.paperclip.ing
export UPLOADER_USER=paperclip-page-uploader
export CLOUDFRONT_COMMENT="Paperclip pages"

aws sts get-caller-identity --profile "$AWS_PROFILE"
```

Create the bucket:

```bash
aws s3api create-bucket \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" \
  --bucket "$BUCKET"
```

For regions other than `us-east-1`, add:

```bash
--create-bucket-configuration LocationConstraint="$AWS_REGION"
```

Disable ACLs and keep ownership bucket-enforced:

```bash
aws s3api put-bucket-ownership-controls \
  --profile "$AWS_PROFILE" \
  --bucket "$BUCKET" \
  --ownership-controls '{"Rules":[{"ObjectOwnership":"BucketOwnerEnforced"}]}'
```

Block public access. CloudFront reads through OAC, so the bucket does not need a
public website policy:

```bash
aws s3api put-public-access-block \
  --profile "$AWS_PROFILE" \
  --bucket "$BUCKET" \
  --public-access-block-configuration \
  'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true'
```

Enable versioning:

```bash
aws s3api put-bucket-versioning \
  --profile "$AWS_PROFILE" \
  --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
```

Enable default encryption:

```bash
aws s3api put-bucket-encryption \
  --profile "$AWS_PROFILE" \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

Upload an operator-managed root `404.html` before creating the distribution:

```bash
mkdir -p /tmp/paperclip-pages-bootstrap
printf '<!doctype html><title>Not found</title><h1>Not found</h1>\n' \
  > /tmp/paperclip-pages-bootstrap/404.html

aws s3 cp /tmp/paperclip-pages-bootstrap/404.html "s3://$BUCKET/404.html" \
  --profile "$AWS_PROFILE" \
  --content-type text/html \
  --cache-control 'public,max-age=60'
```

Create an ACM certificate in `us-east-1` for CloudFront:

```bash
export ACM_REGION=us-east-1

aws acm request-certificate \
  --profile "$AWS_PROFILE" \
  --region "$ACM_REGION" \
  --domain-name "$DOMAIN" \
  --validation-method DNS \
  --idempotency-token paperclippages \
  > /tmp/paperclip-pages-acm.json

export CERT_ARN="$(jq -r '.CertificateArn' /tmp/paperclip-pages-acm.json)"

aws acm describe-certificate \
  --profile "$AWS_PROFILE" \
  --region "$ACM_REGION" \
  --certificate-arn "$CERT_ARN" \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord'
```

Add the returned DNS validation record in Cloudflare, then wait:

```bash
aws acm wait certificate-validated \
  --profile "$AWS_PROFILE" \
  --region "$ACM_REGION" \
  --certificate-arn "$CERT_ARN"
```

Create a CloudFront Origin Access Control:

```bash
aws cloudfront create-origin-access-control \
  --profile "$AWS_PROFILE" \
  --origin-access-control-config "{
    \"Name\":\"paperclip-pages-oac\",
    \"Description\":\"OAC for $BUCKET\",
    \"SigningProtocol\":\"sigv4\",
    \"SigningBehavior\":\"always\",
    \"OriginAccessControlOriginType\":\"s3\"
  }" \
  > /tmp/paperclip-pages-oac.json

export OAC_ID="$(jq -r '.OriginAccessControl.Id' /tmp/paperclip-pages-oac.json)"
```

Create and publish a CloudFront Function so clean page URLs such as `/demo/`
load `/demo/index.html` from the S3 REST origin:

```bash
cat > paperclip-pages-index-router.js <<'EOF'
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }

  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);
  if (lastSegment.indexOf('.') === -1) {
    request.uri = uri + '/index.html';
  }

  return request;
}
EOF

aws cloudfront create-function \
  --profile "$AWS_PROFILE" \
  --name paperclip-pages-index-router \
  --function-config 'Comment=Rewrite clean page URLs to index.html,Runtime=cloudfront-js-2.0' \
  --function-code fileb://paperclip-pages-index-router.js \
  > /tmp/paperclip-pages-function.json

export FUNCTION_ETAG="$(jq -r '.ETag' /tmp/paperclip-pages-function.json)"

aws cloudfront publish-function \
  --profile "$AWS_PROFILE" \
  --name paperclip-pages-index-router \
  --if-match "$FUNCTION_ETAG" \
  > /tmp/paperclip-pages-function-live.json

export FUNCTION_ARN="$(jq -r '.FunctionSummary.FunctionMetadata.FunctionARN' /tmp/paperclip-pages-function-live.json)"
```

Create `cloudfront-config.json`:

```bash
export CALLER_REFERENCE="paperclip-pages-$(date +%s)"

jq -n \
  --arg caller "$CALLER_REFERENCE" \
  --arg comment "$CLOUDFRONT_COMMENT" \
  --arg domain "$DOMAIN" \
  --arg bucket "$BUCKET" \
  --arg oac "$OAC_ID" \
  --arg functionArn "$FUNCTION_ARN" \
  --arg cert "$CERT_ARN" \
  '{
    CallerReference: $caller,
    Comment: $comment,
    Enabled: true,
    IsIPV6Enabled: true,
    Aliases: {Quantity: 1, Items: [$domain]},
    Origins: {
      Quantity: 1,
      Items: [{
        Id: "s3-origin",
        DomainName: ($bucket + ".s3.amazonaws.com"),
        OriginAccessControlId: $oac,
        S3OriginConfig: {OriginAccessIdentity: ""}
      }]
    },
    DefaultRootObject: "index.html",
    DefaultCacheBehavior: {
      TargetOriginId: "s3-origin",
      ViewerProtocolPolicy: "redirect-to-https",
      AllowedMethods: {Quantity: 2, Items: ["GET", "HEAD"], CachedMethods: {Quantity: 2, Items: ["GET", "HEAD"]}},
      Compress: true,
      CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
      OriginRequestPolicyId: "88a5eaf4-2fd4-4709-b370-b4c650ea3fcf",
      FunctionAssociations: {
        Quantity: 1,
        Items: [{EventType: "viewer-request", FunctionARN: $functionArn}]
      }
    },
    CustomErrorResponses: {
      Quantity: 1,
      Items: [{ErrorCode: 403, ResponsePagePath: "/404.html", ResponseCode: "404", ErrorCachingMinTTL: 60}]
    },
    ViewerCertificate: {
      ACMCertificateArn: $cert,
      SSLSupportMethod: "sni-only",
      MinimumProtocolVersion: "TLSv1.2_2021"
    },
    Restrictions: {GeoRestriction: {RestrictionType: "none", Quantity: 0}}
  }' > cloudfront-config.json
```

Create the distribution:

```bash
aws cloudfront create-distribution \
  --profile "$AWS_PROFILE" \
  --distribution-config file://cloudfront-config.json \
  > /tmp/paperclip-pages-cloudfront.json

export DISTRIBUTION_ID="$(jq -r '.Distribution.Id' /tmp/paperclip-pages-cloudfront.json)"
export DISTRIBUTION_DOMAIN="$(jq -r '.Distribution.DomainName' /tmp/paperclip-pages-cloudfront.json)"
```

Grant CloudFront read access to the private bucket:

```bash
export ACCOUNT_ID="$(aws sts get-caller-identity --profile "$AWS_PROFILE" --query Account --output text)"

jq -n \
  --arg bucket "$BUCKET" \
  --arg account "$ACCOUNT_ID" \
  --arg distribution "$DISTRIBUTION_ID" \
  '{
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowCloudFrontServicePrincipalReadOnly",
      Effect: "Allow",
      Principal: {Service: "cloudfront.amazonaws.com"},
      Action: "s3:GetObject",
      Resource: ("arn:aws:s3:::" + $bucket + "/*"),
      Condition: {
        StringEquals: {
          "AWS:SourceArn": ("arn:aws:cloudfront::" + $account + ":distribution/" + $distribution)
        }
      }
    }]
  }' > bucket-policy.json

aws s3api put-bucket-policy \
  --profile "$AWS_PROFILE" \
  --bucket "$BUCKET" \
  --policy file://bucket-policy.json
```

Create the uploader IAM user:

```bash
aws iam create-user \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER"
```

Create `paperclip-page-uploader-policy.json`. This policy supports collision
checks and additive uploads under slug prefixes while protecting root bootstrap
objects such as `404.html`.

```bash
jq -n \
  --arg bucket "$BUCKET" \
  '{
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ListPublishedPagePrefixes",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: ("arn:aws:s3:::" + $bucket)
      },
      {
        Sid: "ReadPublishedPages",
        Effect: "Allow",
        Action: ["s3:GetObject"],
        Resource: ("arn:aws:s3:::" + $bucket + "/*")
      },
      {
        Sid: "WritePublishedPageObjects",
        Effect: "Allow",
        Action: ["s3:PutObject"],
        Resource: ("arn:aws:s3:::" + $bucket + "/*/*")
      },
      {
        Sid: "DenyReservedRootWrites",
        Effect: "Deny",
        Action: ["s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging"],
        Resource: [
          ("arn:aws:s3:::" + $bucket + "/404.html"),
          ("arn:aws:s3:::" + $bucket + "/index.html")
        ]
      }
    ]
  }' > paperclip-page-uploader-policy.json
```

Attach it:

```bash
aws iam put-user-policy \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER" \
  --policy-name PaperclipPagePublisher \
  --policy-document file://paperclip-page-uploader-policy.json
```

Create access keys and treat the output as secret material:

```bash
aws iam create-access-key \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER" \
  > /tmp/paperclip-page-uploader-key.json
chmod 600 /tmp/paperclip-page-uploader-key.json
```

## Cloudflare DNS

Use DNS-only or proxied CNAME to CloudFront. Do not point v1 at the S3 website
endpoint.

Cloudflare UI:

- Open the `paperclip.ing` zone.
- Add `CNAME`:
  - Name: `pages`
  - Target: the CloudFront domain, for example `d111111abcdef8.cloudfront.net`
  - Proxy status: DNS only or Proxied
  - TTL: Auto

API equivalent:

```bash
export CF_ZONE_ID=<paperclip.ing-zone-id>
export CF_API_TOKEN=<token-with-zone-dns-edit>

curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/dns_records" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data "$(jq -n \
    --arg name pages \
    --arg content "$DISTRIBUTION_DOMAIN" \
    '{type:"CNAME", name:$name, content:$content, ttl:1, proxied:false}')"
```

Smoke check:

```bash
curl -I "https://$DOMAIN/404.html"
```

## Paperclip Secrets

Create secrets from environment variables so values do not land in shell history:

```bash
export PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID="$(jq -r '.AccessKey.AccessKeyId' /tmp/paperclip-page-uploader-key.json)"
export PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY="$(jq -r '.AccessKey.SecretAccessKey' /tmp/paperclip-page-uploader-key.json)"

pnpm paperclipai secrets create \
  --company-id <company-id> \
  --name paperclip-page-aws-access-key-id \
  --value-env PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID

pnpm paperclipai secrets create \
  --company-id <company-id> \
  --name paperclip-page-aws-secret-access-key \
  --value-env PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY
```

Bind runtime env to publishing agents:

```json
{
  "AWS_ACCESS_KEY_ID": {
    "type": "secret_ref",
    "secretId": "<access-key-secret-id>",
    "version": "latest"
  },
  "AWS_SECRET_ACCESS_KEY": {
    "type": "secret_ref",
    "secretId": "<secret-key-secret-id>",
    "version": "latest"
  },
  "AWS_REGION": { "type": "plain", "value": "us-east-1" },
  "PAPERCLIP_PAGE_BUCKET": { "type": "plain", "value": "paperclip-pages-prod" },
  "PAPERCLIP_PAGE_BASE_URL": { "type": "plain", "value": "https://pages.paperclip.ing" },
  "PAPERCLIP_PAGE_DEFAULT_PREFIX": { "type": "plain", "value": "" }
}
```

## Install And Attach

Create or update the company skill from this package:

```bash
pnpm paperclipai skills create \
  --company-id <company-id> \
  --name "Paperclip Page" \
  --slug paperclip-page \
  --description "Publish static pages to the Paperclip pages host" \
  --body-file .agents/skills/paperclip-page/SKILL.md
```

Attach it to an agent:

```bash
pnpm paperclipai skills agent sync <agent-id-or-shortname> \
  --company-id <company-id> \
  --skill paperclip-page
```

Ensure the agent can read this directory or copy the package into the installed
company skill location with `scripts/publish.sh` preserved as executable.

## Credential Rotation

1. Create a second access key:

```bash
aws iam create-access-key \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER" \
  > /tmp/paperclip-page-uploader-key-rotation.json
chmod 600 /tmp/paperclip-page-uploader-key-rotation.json
```

2. Store new secret versions in Paperclip Secrets.
3. Update agent env bindings to the new versions or `latest`.
4. Run a dry-run and a small publish smoke.
5. Disable the old key:

```bash
aws iam update-access-key \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER" \
  --access-key-id <old-access-key-id> \
  --status Inactive
```

6. Delete the old key after the next successful publish:

```bash
aws iam delete-access-key \
  --profile "$AWS_PROFILE" \
  --user-name "$UPLOADER_USER" \
  --access-key-id <old-access-key-id>
```

## Troubleshooting

`AccessDenied` on upload:

- Confirm agent env contains the uploader key, not the admin key.
- Confirm the uploader policy allows `s3:ListBucket`, `s3:GetObject`, and
  `s3:PutObject`.
- Confirm uploads target `<slug>/...` so the `arn:aws:s3:::<bucket>/*/*`
  object ARN matches.

`Slug already exists`:

- Use a different slug.
- Or run `--update` from the original source directory that has
  `.paperclip-page/state.json`.

Generated slug collides:

- The helper appends a short suffix for generated slugs when AWS reports a
  collision. Explicit slugs fail instead of silently changing the URL.

URL 404s after upload:

- Check `curl -I https://<domain>/<slug>/`.
- Check CloudFront distribution deployment status.
- Check DNS CNAME target.
- Check the object exists at `s3://<bucket>/<slug>/index.html`.

Stale browser cache:

- The helper uses `Cache-Control: public,max-age=60`.
- Wait a minute or issue a CloudFront invalidation if the operator wants an
  immediate refresh.

CloudFront returns 403:

- Confirm the bucket policy references the correct distribution ARN.
- Confirm OAC is attached to the S3 origin.
- Confirm the bucket is private and public access block is enabled.

## Public Content Security Notes

Anything published with this skill is public. The tool cannot reliably classify
generated files, so the publishing agent must inspect content before uploading.

Do not publish:

- API keys, OAuth tokens, cookies, or `.env` files
- internal customer data
- private company docs
- unpublished security reports
- raw transcripts that may contain secrets

Recovery after accidental overwrite uses S3 versioning. Because v1 uploader
credentials cannot delete objects, rollback should be performed by an operator
with admin credentials.
