# Paperclip — AWS ECS Terraform Configuration

Deploys Paperclip to AWS using ECS on EC2 (Graviton/arm64) with an Application Load Balancer, EFS for persistent storage, and Secrets Manager for runtime secrets.

## Architecture

```
Internet
    │
    ▼
Application Load Balancer (public subnets, dualstack IPv4/IPv6)
    │  HTTP → HTTPS redirect (when domain configured)
    │  HTTPS → ECS target group
    ▼
ECS Service (private subnets)
    │  EC2 launch type — t4g Graviton (arm64)
    │  Bridge networking, dynamic port mapping
    │  Secrets injected from Secrets Manager at task start
    ▼
EFS Volume (/paperclip)
    Encrypted, persisted across container restarts

VPC: 10.0.0.0/16
  Public subnets:  10.0.0.0/20, 10.0.16.0/20  (ALB)
  Private subnets: 10.0.48.0/20, 10.0.64.0/20 (ECS, EFS)
  NAT Gateway for private subnet IPv4 egress
```

**Optional** (set `domain_name`):
- Route53 hosted zone + A/AAAA alias records
- ACM certificate with DNS validation
- HTTPS listener with TLS 1.3

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html) configured with sufficient IAM permissions
- Docker (to build and push the Paperclip image)

## Quick Start

### 1. (Optional) Bootstrap remote state

Skip this step if you prefer local state.

```bash
cd bootstrap/
terraform init
terraform apply -var="project_name=mycompany-paperclip"
```

Copy the output bucket name, then uncomment and fill in the `backend "s3"` block in `providers.tf`.

### 2. Configure variables

```bash
cp terraform.tfvars.example terraform.tfvars
```

Edit `terraform.tfvars`:

```hcl
aws_region    = "us-east-1"
app_name      = "paperclip"
instance_type = "t4g.medium"
ecr_repo_name = "paperclip"

# Optional — leave empty to use the ALB DNS name over HTTP
domain_name = "paperclip.example.com"
```

### 3. Apply

```bash
terraform init
terraform apply
```

After apply, note the outputs:

```
alb_dns_name          = "paperclip-alb-123456789.us-east-1.elb.amazonaws.com"
ecr_repository_url    = "123456789.dkr.ecr.us-east-1.amazonaws.com/paperclip"
secrets_manager_arn   = "arn:aws:secretsmanager:us-east-1:..."
route53_nameservers   = ["ns-1.awsdns-01.com", ...]   # only when domain_name is set
```

### 4. Update secrets

Before the ECS service can start, update the secret with real values:

```bash
aws secretsmanager put-secret-value \
  --secret-id paperclip-secrets \
  --secret-string '{
    "DATABASE_URL": "postgres://user:password@your-rds-host:5432/paperclip",
    "BETTER_AUTH_SECRET": "your-random-secret-at-least-32-chars",
    "PAPERCLIP_AUTH_ALLOWED_EMAIL_DOMAINS": "",
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-..."
  }'
```

> **DATABASE_URL** — PostgreSQL connection string. If you omit this, Paperclip starts an embedded PostgreSQL instance inside the container; data will be stored on the EFS volume at `/paperclip`.

> **BETTER_AUTH_SECRET** — used to sign auth sessions. Generate with: `openssl rand -base64 32`

> **ANTHROPIC_API_KEY** / **OPENAI_API_KEY** — AI provider API keys. Set whichever providers you intend to use; unused keys can be left as empty strings.

### 5. Build and push the Docker image

```bash
# Authenticate
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin \
    $(terraform output -raw ecr_repository_url | cut -d/ -f1)

# Build for arm64 (matches the t4g Graviton instances)
docker build --platform linux/arm64 \
  -t $(terraform output -raw ecr_repository_url):latest \
  /path/to/paperclip

# Push
docker push $(terraform output -raw ecr_repository_url):latest
```

### 6. Deploy the new image

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
SERVICE=$(terraform output -raw ecs_service_name)

aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --force-new-deployment
```

### 7. (If using a custom domain) Point your registrar

```bash
terraform output route53_nameservers
```

Set the NS records at your domain registrar to the four nameservers shown.
ACM certificate validation completes automatically once DNS propagates (~5 minutes).

## Variables

| Name | Default | Description |
|------|---------|-------------|
| `aws_region` | `us-east-1` | AWS region |
| `app_name` | `paperclip` | Resource name prefix |
| `instance_type` | `t4g.medium` | EC2 instance type (use `t4g.*` for Graviton) |
| `task_memory` | `900` | ECS task memory reservation (MiB) |
| `ecr_repo_name` | `paperclip` | ECR repository name |
| `domain_name` | `""` | Custom domain. Leave empty for HTTP-only access via ALB DNS |
| `paperclip_image_uri` | Amazon Linux placeholder | Initial image URI (updated by CI/CD after first push) |

## Outputs

| Name | Description |
|------|-------------|
| `alb_dns_name` | ALB DNS name (use when no custom domain) |
| `app_url` | Full public URL (HTTP or HTTPS) |
| `ecr_repository_url` | ECR URL to push images to |
| `ecs_cluster_name` | ECS cluster name |
| `ecs_service_name` | ECS service name |
| `secrets_manager_arn` | ARN of the Secrets Manager secret |
| `route53_nameservers` | NS records to set at your registrar (only when `domain_name` is set) |

## Resources Created

| Resource | Description |
|----------|-------------|
| VPC + subnets | `/16` VPC with 2 public and 2 private subnets across 2 AZs |
| Internet Gateway | Public subnet internet access |
| NAT Gateway | Private subnet IPv4 egress (single gateway in `public_a` — see [Known Limitations](#known-limitations)) |
| Application Load Balancer | Public-facing, dualstack (IPv4 + IPv6) |
| ECR Repository | Stores the Paperclip Docker image |
| ECS Cluster | EC2-backed cluster |
| ECS Task Definition | Bridge networking, EFS volume, Secrets Manager injection |
| ECS Service | Desired count 1, ECS Exec enabled |
| Auto Scaling Group | min/max/desired = 1, Graviton arm64 instances |
| EFS File System | Encrypted, mounted at `/paperclip` |
| Secrets Manager Secret | `DATABASE_URL`, `BETTER_AUTH_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, allowed email domains |
| CloudWatch Log Group | `/ecs/paperclip`, 7-day retention |
| IAM Roles | ECS instance role, task execution role, task role |
| Route53 Hosted Zone | *(optional)* DNS zone for custom domain |
| ACM Certificate | *(optional)* TLS certificate with DNS validation |

## Updating Paperclip

To deploy a new image without re-running `terraform apply`:

```bash
# Build and push new image
docker build --platform linux/arm64 -t <ecr_url>:<tag> .
docker push <ecr_url>:<tag>

# Force ECS to pull the new image
aws ecs update-service \
  --cluster <ecs_cluster_name> \
  --service <ecs_service_name> \
  --force-new-deployment
```

## ECS Exec (shell access)

```bash
TASK_ARN=$(aws ecs list-tasks \
  --cluster <ecs_cluster_name> \
  --service-name <ecs_service_name> \
  --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster <ecs_cluster_name> \
  --task "$TASK_ARN" \
  --container paperclip-app \
  --interactive \
  --command "/bin/sh"
```

## First-time Setup: Running the Onboarding Wizard

After the ECS service is running, you need to run the `paperclipai onboard` command once inside the container to generate the initial configuration, secrets, and a bootstrap admin invite link.

### 1. Install the SSM Session Manager Plugin

The SSM plugin is required for `aws ecs execute-command` to open an interactive shell into the container.

**macOS**
```bash
brew install --cask session-manager-plugin
```

**Linux (Debian/Ubuntu)**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/ubuntu_64bit/session-manager-plugin.deb" \
  -o session-manager-plugin.deb
sudo dpkg -i session-manager-plugin.deb
```

**Linux (RPM)**
```bash
curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/linux_64bit/session-manager-plugin.rpm" \
  -o session-manager-plugin.rpm
sudo rpm -i session-manager-plugin.rpm
```

**Windows**

Download and run the installer from:
https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html

Verify the installation:
```bash
session-manager-plugin --version
```

### 2. Connect to the running container

```bash
CLUSTER=$(terraform output -raw ecs_cluster_name)
SERVICE=$(terraform output -raw ecs_service_name)

TASK_ARN=$(aws ecs list-tasks \
  --cluster "$CLUSTER" \
  --service-name "$SERVICE" \
  --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster "$CLUSTER" \
  --task "$TASK_ARN" \
  --container paperclip-app \
  --interactive \
  --command "/bin/sh"
```

### 3. Run the onboarding wizard

Once inside the container shell, run:

```bash
gosu node pnpm paperclipai onboard
```

The wizard walks you through the full configuration interactively:

```
██████╗  █████╗ ██████╗ ███████╗██████╗  ██████╗██╗     ██╗██████╗
██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝██║     ██║██╔══██╗
██████╔╝███████║██████╔╝█████╗  ██████╔╝██║     ██║     ██║██████╔╝
██╔═══╝ ██╔══██║██╔═══╝ ██╔══╝  ██╔══██╗██║     ██║     ██║██╔═══╝
██║     ██║  ██║██║     ███████╗██║  ██║╚██████╗███████╗██║██║
╚═╝     ╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝ ╚═════╝╚══════╝╚═╝╚═╝
  ───────────────────────────────────────────────────────
  Open-source orchestration for zero-human companies

┌   paperclipai onboard
│
│  Local home: /paperclip | instance: default | config: /paperclip/instances/default/config.json
│
◇  Choose setup path
│  Advanced setup
│
◇  Database
│
◇  Database mode
│  PostgreSQL (external server)
│
◇  PostgreSQL connection string
│  postgres://user:pass@your-rds-host:5432/paperclip
│
◇  Enable automatic database backups?
│  Yes
│
◇  Backup directory
│  /paperclip/instances/default/data/backups
│
◇  Backup interval (minutes)
│  60
│
◇  Backup retention (days)
│  30
│
◇  LLM Provider
│
◇  Configure an LLM provider now?
│  No
│
◇  Logging
│
◇  Logging mode
│  File-based logging
│
◇  Log directory
│  /paperclip/instances/default/logs
│
◇  Server
│
◇  Deployment mode
│  Authenticated
│
◇  Exposure profile
│  Public internet
│
◇  Bind host
│  0.0.0.0
│
◇  Server port
│  3100
│
◇  Public base URL
│  https://paperclip.example.com
│
◇  Storage
│
◇  Storage provider
│  Local disk (recommended)
│
◇  Local storage base directory
│  /paperclip/instances/default/data/storage
│
◇  Secrets
│
│  Using defaults: provider=local_encrypted, strictMode=false, keyFile=/paperclip/instances/default/secrets/master.key
│
◆  Created PAPERCLIP_AGENT_JWT_SECRET in /paperclip/instances/default/.env
│
◆  Created local secrets key file at /paperclip/instances/default/secrets/master.key
│
◇  Configuration saved ──────────────────────────────────────╮
│                                                            │
│  Database: postgres                                        │
│  LLM: not configured                                       │
│  Logging: file -> /paperclip/instances/default/logs        │
│  Server: authenticated/public @ 0.0.0.0:3100               │
│  Auth URL mode: explicit (https://paperclip.example.com)   │
│  Storage: local_disk                                       │
│  Secrets: local_encrypted (strict mode off)                │
│  Agent auth: PAPERCLIP_AGENT_JWT_SECRET configured         │
│                                                            │
├────────────────────────────────────────────────────────────╯
│
◇  Generating bootstrap CEO invite
│
◆  Created bootstrap CEO invite.
│
│  Invite URL: https://paperclip.example.com/invite/pcp_bootstrap_<token>
│
│  Expires: <timestamp>
│
◇  Start Paperclip now?
│  No
│
└  You're all set!
```

**Key prompts to pay attention to:**

| Prompt | Recommended value |
|--------|-------------------|
| Database mode | `PostgreSQL (external server)` if you set `DATABASE_URL`; otherwise `Embedded PostgreSQL` |
| Public base URL | Your full public URL, e.g. `https://paperclip.example.com` |
| Deployment mode | `Authenticated` (requires login) |
| Exposure profile | `Public internet` |

### 4. Save the invite URL

The wizard prints a one-time bootstrap invite URL at the end:

```
Invite URL: https://paperclip.example.com/invite/pcp_bootstrap_<token>
```

Open this URL in your browser to create the first admin account. The invite expires after 7 days — if it expires, re-run `paperclipai onboard` or use `paperclipai create-invite` to generate a new one.

### 5. Restart the ECS service

The configuration written by the wizard is stored on the EFS volume and persists across restarts. Force a new ECS deployment to pick it up:

```bash
aws ecs update-service \
  --cluster "$CLUSTER" \
  --service "$SERVICE" \
  --force-new-deployment
```

## Known Limitations

### Single NAT Gateway

This module provisions one NAT Gateway, placed in `public_a` (`${var.aws_region}a`), and both private route tables point to it for IPv4 egress.

**Impact:** If `${var.aws_region}a` experiences an AZ-level disruption, private instances running in the `private_b` subnet lose all IPv4 egress. This affects:

- ECR image pulls
- AWS Secrets Manager API calls
- Any other outbound IPv4 traffic from the ECS task

**Why it is left as-is:** Paperclip is designed as a single-instance deployment (`desired_count = 1`, `min_size = 1`). A second NAT Gateway adds ~$32 USD/month in fixed costs for a redundancy benefit that only materialises when the primary AZ fails *and* the ASG has placed the task in the secondary AZ — an unlikely combination for a single-task service.

**To eliminate the dependency** if you scale beyond one instance or require stronger isolation guarantees:

1. Add a second `aws_nat_gateway` resource in `public_b`.
2. Create a separate `aws_route_table` for `private_b` that routes `0.0.0.0/0` to the new gateway.
3. Update the `aws_route_table_association` for `private_b` to use the new route table.

This keeps each AZ's private subnet routing entirely within that AZ.
