---
name: "terraform-service-scaffold"
description: "Generate complete service-level Terraform infrastructure with modules, environments, and CI/CD. Use when adding Terraform to a new service or bootstrapping infrastructure from scratch."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/terraform-service-scaffold"
recommendedForRoles:
  - "engineer"
tags:
  - "agency-agents"
  - "engineer"
  - "terraform"
  - "service"
  - "scaffold"
defaultInstall: false
---
# Terraform Service Scaffold

Generates a complete service-level Terraform structure with live orchestration, reusable modules, environment configs, and CI/CD workflow.

## Canonical source: scaffold FROM the wiki, do not hand-author

> **Scaffold from `spartan-sre-wiki`, the single canonical home for all infra
> templates - do not invent bespoke HCL or copy a live service.** The hand-roll /
> copy-a-live-service approach is exactly what this repo replaces (it drifts and
> bakes in one service's quirks).

- **Repo:** `spartan-stratos/spartan-sre-wiki` (`git@github.com:spartan-stratos/spartan-sre-wiki.git`) - clone it locally and `git pull` before scaffolding.
- **Templates live under** `templates/`:
  - `templates/terraform/single-root/` - one root, `envs/{dev,prod}/`, ECS **or** EKS.
  - `templates/terraform/multiple-root/` - separate roots per env/concern (multi-account).
  - `templates/service-monorepo/` - **data-driven ArgoCD scaffold**: one
    `infra/deployables.yaml` is the source of truth read by Terraform, the render
    workflow, and the deploy matrix. Adding a deployable = one manifest entry. Use
    this for any EKS service's app/GitOps wiring.
  - `templates/argocd/` - hand-authored ArgoCD Application starters (copy-one-file fallback).

**Preferred flow:**
1. `git clone git@github.com:spartan-stratos/spartan-sre-wiki.git` (or use the local clone above; `git pull` first).
2. `templates/scaffold.sh single-root <dest>` (or `multiple-root`) to stamp the variant out (restores `.github/`, materializes `*.example` files).
3. Fill placeholders (`YOUR_` / `REPLACE_ME_`), set the backend, `terraform init`.
4. For ArgoCD/GitOps, copy `templates/service-monorepo/` and follow
   `templates/service-monorepo/docs/argocd-onboarding.md`.

The inline HCL below documents **what those templates contain** - use it as reference
and as a fallback only when the wiki is unreachable. Prefer the templates verbatim.

## When to Use

- Adding Terraform to a new service repository
- Bootstrapping service infrastructure from scratch
- Setting up a new microservice with standard cloud resources

## Process

### 1. Gather Requirements

Ask the user:
- **Service name** (e.g., `{service}`)
- **Container host**: ECS or EKS
- **Resources needed**: RDS, Redis, S3, SQS, or combination
- **Environments**: which environments to scaffold (default: dev)

### 2. Read Infra Remote State

```hcl
# Check existing shared infrastructure outputs
data "terraform_remote_state" "infra" {
  backend = "s3"

  config = {
    bucket = "{project}-terraform-state"
    key    = "infra/terraform.tfstate"
    region = var.region
  }
}
```

### 3. Create Live Orchestration

Location: `terraform/live/`

#### terraform.tf

```hcl
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = var.project
      Service     = var.service
      Environment = var.env
      ManagedBy   = "terraform"
    }
  }
}
```

#### variables.tf

```hcl
variable "project" {
  description = "Project identifier"
  type        = string
}

variable "service" {
  description = "Service name"
  type        = string
}

variable "env" {
  description = "Environment (dev, staging, prod)"
  type        = string
}

variable "region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}
```

#### locals.tf

```hcl
locals {
  name_prefix = "${var.project}-${var.service}-${var.env}"

  vpc_id             = data.terraform_remote_state.infra.outputs.vpc_id
  private_subnet_ids = data.terraform_remote_state.infra.outputs.private_subnet_ids
  public_subnet_ids  = data.terraform_remote_state.infra.outputs.public_subnet_ids

  common_tags = {
    Project     = var.project
    Service     = var.service
    Environment = var.env
  }
}
```

#### outputs.tf

```hcl
output "ecr_repository_url" {
  description = "ECR repository URL for {service}"
  value       = module.{service}.ecr_repository_url
}

output "service_endpoint" {
  description = "Service endpoint URL"
  value       = module.{service}.service_endpoint
}
```

### 4. Create Service Module

Location: `terraform/modules/{service}/`

One resource per file:

#### main.tf

```hcl
# Module entry point - locals and data sources only
locals {
  name_prefix = "${var.project}-${var.service}-${var.env}"
}
```

#### ecr.tf

```hcl
module "ecr_backend" {
  source = "git::https://github.com/{project}/terraform-modules.git//ecr?ref=v1.0.0"

  name                 = "${local.name_prefix}-backend"
  image_tag_mutability = "IMMUTABLE"

  lifecycle_policy_rules = [
    {
      description   = "Keep last 20 images"
      count_number  = 20
      tag_status    = "any"
      count_type    = "imageCountMoreThan"
    }
  ]
}

module "ecr_worker" {
  source = "git::https://github.com/{project}/terraform-modules.git//ecr?ref=v1.0.0"

  name                 = "${local.name_prefix}-worker"
  image_tag_mutability = "IMMUTABLE"

  lifecycle_policy_rules = [
    {
      description   = "Keep last 20 images"
      count_number  = 20
      tag_status    = "any"
      count_type    = "imageCountMoreThan"
    }
  ]
}
```

#### rds.tf

```hcl
module "rds" {
  source = "git::https://github.com/{project}/terraform-modules.git//rds?ref=v1.0.0"

  name                = "${local.name_prefix}-db"
  engine              = "postgres"
  engine_version      = "15.4"
  instance_class      = var.rds_instance_class
  allocated_storage   = var.rds_allocated_storage
  db_name             = replace(var.service, "-", "_")
  master_username     = var.db_username
  master_password     = var.db_password
  subnet_ids          = var.private_subnet_ids
  vpc_id              = var.vpc_id
  deletion_protection = var.env == "prod" ? true : false

  backup_retention_period = var.env == "prod" ? 30 : 7
  multi_az                = var.env == "prod" ? true : false
}
```

#### redis.tf

```hcl
module "redis" {
  source = "git::https://github.com/{project}/terraform-modules.git//elasticache?ref=v1.0.0"

  name               = "${local.name_prefix}-cache"
  engine             = "redis"
  node_type          = var.redis_node_type
  num_cache_nodes    = 1
  subnet_ids         = var.private_subnet_ids
  vpc_id             = var.vpc_id
  transit_encryption = true
  at_rest_encryption = true
  auth_token         = var.redis_auth_token
}
```

#### s3.tf

```hcl
module "s3" {
  source = "git::https://github.com/{project}/terraform-modules.git//s3?ref=v1.0.0"

  bucket_name = "${local.name_prefix}-assets"
  versioning  = true

  server_side_encryption = {
    sse_algorithm = "aws:kms"
  }

  block_public_access = {
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
  }
}
```

#### sqs.tf

```hcl
module "sqs" {
  source = "git::https://github.com/{project}/terraform-modules.git//sqs?ref=v1.0.0"

  name                       = "${local.name_prefix}-queue"
  visibility_timeout_seconds = 300
  message_retention_seconds  = 1209600
  receive_wait_time_seconds  = 20

  dead_letter_queue = {
    enabled             = true
    max_receive_count   = 3
    retention_seconds   = 1209600
  }
}
```

#### ecs.tf (if container host is ECS)

```hcl
module "ecs_service" {
  source = "git::https://github.com/{project}/terraform-modules.git//ecs-service?ref=v1.0.0"

  name            = local.name_prefix
  cluster_id      = var.ecs_cluster_id
  task_definition = module.ecs_task.arn
  desired_count   = var.desired_count
  subnet_ids      = var.private_subnet_ids
  security_groups = [aws_security_group.service.id]

  target_group_arn = aws_lb_target_group.service.arn
  container_name   = "${local.name_prefix}-backend"
  container_port   = var.container_port
}

module "ecs_task" {
  source = "git::https://github.com/{project}/terraform-modules.git//ecs-task?ref=v1.0.0"

  family           = local.name_prefix
  cpu              = var.task_cpu
  memory           = var.task_memory
  execution_role   = var.ecs_execution_role_arn
  task_role        = var.ecs_task_role_arn
  image            = "${module.ecr_backend.repository_url}:${var.image_tag}"
  container_port   = var.container_port
  environment      = var.container_environment
  secrets          = var.container_secrets
}

resource "aws_lb_target_group" "service" {
  name        = local.name_prefix
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }
}
```

#### eks.tf (if container host is EKS)

```hcl
resource "kubernetes_namespace" "service" {
  metadata {
    name = var.service
    labels = {
      project = var.project
      env     = var.env
    }
  }
}

resource "kubernetes_service_account" "service" {
  metadata {
    name      = var.service
    namespace = kubernetes_namespace.service.metadata[0].name
    annotations = {
      "eks.amazonaws.com/role-arn" = module.irsa.role_arn
    }
  }
}

module "irsa" {
  source = "git::https://github.com/{project}/terraform-modules.git//irsa?ref=v1.0.0"

  name                = "${local.name_prefix}-irsa"
  oidc_provider_arn   = var.oidc_provider_arn
  namespace           = var.service
  service_account     = var.service
  policy_arns         = var.irsa_policy_arns
}

resource "kubernetes_secret" "service" {
  metadata {
    name      = "${var.service}-secrets"
    namespace = kubernetes_namespace.service.metadata[0].name
  }

  data = var.k8s_secrets
}

resource "kubernetes_config_map" "service" {
  metadata {
    name      = "${var.service}-config"
    namespace = kubernetes_namespace.service.metadata[0].name
  }

  data = var.k8s_config
}
```

### 5. Create Environment Config

Location: `terraform/envs/dev/`

#### state.config

```hcl
bucket         = "{project}-terraform-state"
key            = "{service}/dev/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "{project}-terraform-locks"
encrypt        = true
```

#### terraform.tfvars

```hcl
project = "{project}"
service = "{service}"
env     = "dev"
region  = "us-east-1"

# RDS
rds_instance_class  = "db.t3.micro"
rds_allocated_storage = 20
db_username         = "{service}_admin"

# Redis
redis_node_type = "cache.t3.micro"

# Container
desired_count  = 1
task_cpu       = 256
task_memory    = 512
container_port = 8080
image_tag      = "latest"
```

#### secrets.tfvars

```hcl
# Encrypted via git-secret-protector - committed to git, decrypted at CI/CD time
db_password      = ""
redis_auth_token = ""
```

#### git-secret-protector Setup

Secrets are encrypted in git using [git-secret-protector](https://github.com/nicovince/git-secret-protector), NOT `.gitignore`.

```bash
# 1. Install git-secret-protector
pip install git-secret-protector

# 2. Initialize per-environment filters
git-secret-protector init --filter secrets-dev
git-secret-protector init --filter secrets-prod

# 3. Add .gitattributes rules for auto-encrypt on commit
cat >> .gitattributes <<'EOF'
terraform/live/envs/dev/secrets.tfvars filter=secrets-dev
terraform/live/envs/prod/secrets.tfvars filter=secrets-prod
EOF

# 4. Store encryption keys securely (CI/CD secrets, NOT in repo)
# GitHub Actions: store as repository secret GIT_SECRET_PROTECTOR_KEY_DEV / _PROD
```

The secrets file IS committed to git (encrypted). On checkout, the smudge filter decrypts it
if the key is available. In CI/CD, decrypt before terraform plan/apply.

### 6. Generate CI/CD Workflow

```yaml
# .github/workflows/terraform.yml
name: Terraform

on:
  pull_request:
    paths: ['terraform/**']
  push:
    branches: [main]
    paths: ['terraform/**']

env:
  TF_VERSION: '1.11'
  ENVIRONMENT: dev

jobs:
  plan:
    runs-on: ubuntu-latest
    if: github.event_name == 'pull_request'
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
      - name: Decrypt secrets
        run: |
          pip install git-secret-protector
          git-secret-protector reveal --filter secrets-${{ env.ENVIRONMENT }}
        env:
          GIT_SECRET_PROTECTOR_KEY: ${{ secrets.GIT_SECRET_PROTECTOR_KEY_DEV }}
      - name: Init
        run: |
          cd terraform/live
          terraform init -backend-config=envs/${{ env.ENVIRONMENT }}/state.config
      - name: Plan
        run: |
          cd terraform/live
          terraform plan \
            -var-file=envs/${{ env.ENVIRONMENT }}/terraform.tfvars \
            -var-file=envs/${{ env.ENVIRONMENT }}/secrets.tfvars \
            -no-color

  apply:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: ${{ env.TF_VERSION }}
      - name: Decrypt secrets
        run: |
          pip install git-secret-protector
          git-secret-protector reveal --filter secrets-${{ env.ENVIRONMENT }}
        env:
          GIT_SECRET_PROTECTOR_KEY: ${{ secrets.GIT_SECRET_PROTECTOR_KEY_DEV }}
      - name: Init
        run: |
          cd terraform/live
          terraform init -backend-config=envs/${{ env.ENVIRONMENT }}/state.config
      - name: Apply
        run: |
          cd terraform/live
          terraform apply \
            -var-file=envs/${{ env.ENVIRONMENT }}/terraform.tfvars \
            -var-file=envs/${{ env.ENVIRONMENT }}/secrets.tfvars \
            -auto-approve
```

### 7. Output Checklist

After generating all files, produce this checklist:

- [ ] `terraform/live/terraform.tf` - backend + provider
- [ ] `terraform/live/variables.tf` - all input variables
- [ ] `terraform/live/locals.tf` - computed values, remote state
- [ ] `terraform/live/outputs.tf` - exported values
- [ ] `terraform/modules/{service}/` - resource-per-file
- [ ] `terraform/envs/dev/state.config` - backend config
- [ ] `terraform/envs/dev/terraform.tfvars` - environment values
- [ ] `terraform/envs/dev/secrets.tfvars` - sensitive values (gitignored)
- [ ] `.github/workflows/terraform.yml` - CI/CD pipeline
- [ ] `.gitignore` includes `*.tfvars` secrets, `.terraform/`, `*.tfstate*`

## Interaction Style

- Asks service name, container host, and resources before generating
- Generates all files in one pass - no partial output
- Uses registry modules with version pinning, never inline resources
- Keeps providers in `live/` only, never in modules

## Rules

- Use registry modules from `{project}/terraform-modules` with `?ref=vX.Y.Z`
- Version-pin all providers and modules
- Flat locals - no nested maps unless unavoidable
- Providers defined in `live/` only, never in modules
- One resource per file in modules
- Remote state for cross-stack references
- Sensitive variables marked with `sensitive = true`
- All resources tagged with project, service, environment, ManagedBy
- State stored in S3 with DynamoDB locking
- Secrets never committed - use `.gitignore` and `secrets.tfvars`

## Output

Produces a complete directory tree:

```
terraform/
  live/
    terraform.tf
    variables.tf
    locals.tf
    outputs.tf
  modules/{service}/
    main.tf
    ecr.tf
    rds.tf
    redis.tf
    s3.tf
    sqs.tf
    ecs.tf (or eks.tf)
    variables.tf
    outputs.tf
  envs/dev/
    state.config
    terraform.tfvars
    secrets.tfvars
.github/workflows/terraform.yml
```
