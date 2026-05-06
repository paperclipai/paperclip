# Paperclip on AWS

Terraform stacks for deploying Paperclip (ECS Fargate + RDS Postgres 17 + EFS + ALB + WAF).

## Prerequisites

- AWS CLI credentials for account `872443248397`, region `us-east-1`
- Docker (for building the server image)
- Sparkmed bootstrap state backend already exists (`sparkmed-terraform-state-*`, DynamoDB lock table)

## 1. Bootstrap (once)

Creates ECR repository `paperclip/server`. Already applied if the repo exists in account `872443248397`.

```bash
cd infrastructure/terraform/bootstrap
terraform init && terraform apply
```

## 2. Build and push image

**Important:** Build for `linux/amd64` (Fargate architecture), not ARM.

```bash
export ACCOUNT=872443248397
export REGION=us-east-1
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com
docker buildx build --platform linux/amd64 -t ${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/paperclip/server:production-latest --push .
```

## 3. Deploy infrastructure

```bash
cd infrastructure/terraform/environments/production
export TF_VAR_db_password='YOUR_RDS_PASSWORD'
terraform init
terraform apply
```

During apply, ACM **DNS validation** will wait: add the CNAME from `terraform output acm_certificate_validation` to **Cloudflare** (DNS only).

After apply, add `area51.robowise.ai` CNAME pointing to `terraform output alb_dns_name` in Cloudflare. SSL mode: **Full (strict)**.

## Operations

### Check deployment status

```bash
# Service health
aws ecs describe-services --cluster paperclip-production-cluster \
  --services paperclip-production-server --region us-east-1 \
  --query 'services[0].{desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:3]}'

# ALB health (should return 200)
curl -sk https://paperclip-production-alb-1078710891.us-east-1.elb.amazonaws.com/health

# Latest task status
TASK=$(aws ecs list-tasks --cluster paperclip-production-cluster \
  --service-name paperclip-production-server --desired-status RUNNING \
  --region us-east-1 --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster paperclip-production-cluster \
  --tasks "$TASK" --region us-east-1 \
  --query 'tasks[0].{status:lastStatus,health:healthStatus,exitCode:containers[0].exitCode}'
```

### View logs

```bash
# Find latest log stream
STREAM=$(aws logs describe-log-streams --log-group-name /ecs/paperclip/production/server \
  --order-by LastEventTime --descending --max-items 1 \
  --query 'logStreams[0].logStreamName' --output text --region us-east-1)

# View recent logs
aws logs get-log-events --log-group-name /ecs/paperclip/production/server \
  --log-stream-name "$STREAM" --region us-east-1 --limit 50 \
  --query 'events[*].message' --output text
```

### Force redeployment (pick up new image or secrets)

```bash
aws ecs update-service --cluster paperclip-production-cluster \
  --service paperclip-production-server --force-new-deployment --region us-east-1
```

Expect ~2-3 min downtime (503) while the old task drains and the new one starts.

### Update a secret

```bash
aws secretsmanager put-secret-value \
  --secret-id paperclip/production/SECRET_NAME \
  --secret-string 'NEW_VALUE' --region us-east-1
# Then force redeployment (above) — ECS caches secrets at task launch
```

### Run a one-off command (e.g. bootstrap-ceo)

One-off tasks must run in a **public subnet** with `assignPublicIp=ENABLED` and use a task definition **without** the `secrets` block (ECS can't resolve Secrets Manager during cold-start in private subnets reliably). Pass secrets as plaintext env vars in the task definition override instead.

```bash
aws ecs run-task \
  --cluster paperclip-production-cluster \
  --task-definition paperclip-bootstrap:4 \
  --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-03abd6af9b2e6deb0],securityGroups=[sg-04c8e4339ed997121],assignPublicIp=ENABLED}' \
  --region us-east-1
```

### Secrets inventory

| Secret | Secrets Manager path |
|--------|---------------------|
| DATABASE_URL | `paperclip/production/database-url` |
| BETTER_AUTH_SECRET | `paperclip/production/better-auth-secret` |
| CLAUDE_CODE_OAUTH_TOKEN | `paperclip/production/claude-oauth-token` |
| GITHUB_TOKEN | `paperclip/production/github-token` |
| OPENAI_API_KEY | `paperclip/production/openai-api-key` |
| ANTHROPIC_API_KEY | `paperclip/production/anthropic-api-key` |
| GOOGLE_API_KEY | `paperclip/production/google-api-key` |

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| 503 from Cloudflare | No healthy ECS tasks | Check service events, view logs |
| 504 Gateway timeout | Task running but unresponsive | Check logs for startup errors, may need memory increase |
| Exit code 137 | OOM killed | Increase `ecs_memory` in `variables.tf`, apply + redeploy |
| Exit code 1 + SSL error | `self-signed certificate in certificate chain` | Ensure `NODE_TLS_REJECT_UNAUTHORIZED=0` is in task env |
| `exec format error` | Image built for ARM, Fargate needs amd64 | Rebuild with `--platform linux/amd64` |
| `bootstrap_pending` | No admin user | Run `bootstrap-ceo` via one-off task or CLI with DB access |

## Outputs

- `paperclip_url` -- public URL
- `alb_dns_name` -- ALB DNS for Cloudflare CNAME
- `acm_certificate_validation` -- CNAME records for ACM DNS validation
- `ecr_repository_url` -- ECR image URI
