---
name: "terraform-best-practices"
description: "Quick reference for Terraform conventions including file organization, naming, modules, state, security, and anti-patterns. Use when writing or reviewing Terraform code."
key: "paperclipai/optional/agency-agents/terraform-best-practices"
recommendedForRoles:
  - "engineer"
  - "designer"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "security"
  - "terraform"
  - "best"
  - "practices"
defaultInstall: false
---
# Terraform Best Practices — Quick Reference

## File Organization

```
terraform/
  live/                    # Orchestration — providers, backend, module calls
    terraform.tf           # backend + provider (ONLY place for providers)
    variables.tf           # all input variables
    locals.tf              # computed values, remote state refs
    outputs.tf             # exported values
    {resource-group}.tf    # module invocations grouped by concern
  modules/{name}/          # Reusable — no providers, no hardcoded values
    main.tf                # locals, data sources
    variables.tf           # inputs with descriptions + types
    outputs.tf             # consumed values only
    versions.tf            # required_providers
    {resource}.tf          # one file per resource type
  envs/{env}/              # Per-environment config
    state.config           # backend partial config
    terraform.tfvars       # non-sensitive values
    secrets.tfvars         # sensitive values (gitignored)
```

## Naming

| Thing | Convention | Example |
|-------|-----------|---------|
| Resource prefix | `{project}-{service}-{env}` | `acme-payments-prod` |
| Variables | `snake_case` | `instance_class` |
| Locals | `snake_case` | `name_prefix` |
| Outputs | `snake_case` | `repository_url` |
| Resources | `this` (primary) or descriptive | `aws_db_instance.this` |
| Security groups | `name_prefix` (not `name`) | `"${local.name_prefix}-app-"` |
| Files | `{resource-type}.tf` | `rds.tf`, `sg.tf`, `ecr.tf` |
| Modules | `kebab-case` directory | `modules/ecs-service/` |
| Tags | PascalCase keys | `Project`, `Environment`, `ManagedBy` |

## Module Patterns

Use modules from the [c0x12c Terraform Registry](https://registry.terraform.io/namespaces/c0x12c).
Each module source follows `c0x12c/{name}/aws` — see the registry for available modules and versions.

```hcl
# Calling a registry module — always version-pin
module "database" {
  source  = "c0x12c/rds/aws"
  version = "~> 0.6.6"

  name       = "${local.name_prefix}-db"
  vpc_id     = local.vpc_id
  subnet_ids = local.private_subnet_ids
  tags       = local.common_tags
}

# Inside a module — no provider, explicit interface
# versions.tf
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

# variables.tf — every var has description + type
variable "name" {
  description = "Resource name prefix"
  type        = string
}

# outputs.tf — only what consumers need
output "endpoint" {
  description = "Connection endpoint"
  value       = aws_db_instance.this.endpoint
}
```

## State Management

```hcl
# Backend config — S3 + DynamoDB locking
terraform {
  backend "s3" {}
}

# envs/dev/state.config
bucket         = "{project}-terraform-state"
key            = "{service}/dev/terraform.tfstate"
region         = "us-east-1"
dynamodb_table = "{project}-terraform-locks"
encrypt        = true

# Init with partial config
# terraform init -backend-config=../envs/dev/state.config
```

```hcl
# Remote state for cross-stack references
data "terraform_remote_state" "infra" {
  backend = "s3"
  config = {
    bucket = "{project}-terraform-state"
    key    = "infra/terraform.tfstate"
    region = var.region
  }
}

locals {
  vpc_id = data.terraform_remote_state.infra.outputs.vpc_id
}
```

## Security Checklist

```hcl
# Sensitive variables
variable "db_password" {
  type      = string
  sensitive = true
}

# S3 — block public, encrypt, version
module "s3" {
  versioning              = true
  server_side_encryption  = { sse_algorithm = "aws:kms" }
  block_public_access     = {
    block_public_acls       = true
    block_public_policy     = true
    ignore_public_acls      = true
    restrict_public_buckets = true
  }
}

# RDS — encrypt, private subnet, protect
resource "aws_db_instance" "this" {
  storage_encrypted   = true
  deletion_protection = var.env == "prod"
  publicly_accessible = false  # ALWAYS false
}

# Security groups — source SG, not CIDR
resource "aws_security_group_rule" "app_to_db" {
  source_security_group_id = aws_security_group.app.id  # not cidr_blocks
  from_port                = 5432
  to_port                  = 5432
}

# Default tags at provider level
provider "aws" {
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

## Common Anti-Patterns

```hcl
# WRONG — provider in module
# modules/rds/main.tf
provider "aws" { region = "us-east-1" }  # NEVER in a module

# WRONG — no version pin
module "rds" {
  source = "git::https://github.com/{project}/terraform-modules.git//rds"
  # missing ?ref=vX.Y.Z
}

# WRONG — hardcoded values
resource "aws_s3_bucket" "assets" {
  bucket = "acme-prod-assets"  # use ${local.name_prefix}-assets
}

# WRONG — secrets in code
resource "aws_db_instance" "main" {
  password = "hunter2"  # use var.db_password (sensitive)
}

# WRONG — wildcard IAM
resource "aws_iam_policy" "app" {
  policy = jsonencode({
    Statement = [{ Action = "*", Resource = "*", Effect = "Allow" }]
  })
}

# WRONG — public database
resource "aws_db_instance" "main" {
  publicly_accessible = true  # NEVER for databases
}

# WRONG — no state locking
terraform {
  backend "s3" {
    # missing dynamodb_table for locking
  }
}

# WRONG — all resources in one file
# main.tf with 500+ lines of mixed RDS, S3, SQS, IAM...
# Split into rds.tf, s3.tf, sqs.tf, iam.tf
```

## CI/CD Patterns

```yaml
# Standard workflow
# PR: fmt check → validate → plan (comment on PR)
# Merge to main: init → plan → apply

# Key rules:
# - Never auto-apply on PR
# - Always post plan output as PR comment
# - Lock state during apply (DynamoDB)
# - Inject secrets via CI environment variables
# - Pin Terraform version in CI to match team
```

## What to Avoid

- Provider blocks in modules
- Unpinned module versions
- Hardcoded names, IDs, or account numbers
- Secrets in `.tf` files or committed `.tfvars`
- Wildcard IAM policies (`*` on `*`)
- Public databases or caches
- Missing encryption on storage
- Monolithic files (split by resource type)
- `terraform import` in automation (use `import` blocks)
- Missing `description` on variables and outputs
- Nested locals maps (keep flat)
- `count` for conditional resources (use `for_each` with a set)
