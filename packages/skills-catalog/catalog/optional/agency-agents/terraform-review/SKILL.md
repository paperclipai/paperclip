---
name: "terraform-review"
description: "PR review checklist for Terraform changes covering structure, state safety, security, naming, modules, variables, providers, and CI/CD. Use when reviewing Terraform PRs or doing pre-merge checks."
allowed_tools:
  - Read
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/terraform-review"
recommendedForRoles:
  - "engineer"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "security"
  - "terraform"
  - "review"
defaultInstall: false
---
# Terraform Review

Runs an 8-category review checklist on Terraform changes. Produces an Approved / Needs Changes / Blocked verdict.

## When to Use

- Reviewing a Terraform pull request
- Pre-merge validation of infrastructure changes
- Self-review before opening a PR
- Auditing existing Terraform code

## Process

### 1. Structure

- [ ] Files follow standard layout: `live/`, `modules/`, `envs/`
- [ ] One resource per file in modules
- [ ] `terraform.tf` has backend + provider config
- [ ] `variables.tf`, `outputs.tf`, `locals.tf` are separate files
- [ ] No `.terraform/` or `*.tfstate*` in the PR

```
# CORRECT structure
terraform/
  live/terraform.tf        # backend + provider
  live/variables.tf        # inputs
  live/locals.tf           # computed values
  live/outputs.tf          # exports
  modules/{service}/       # one resource per file
  envs/{env}/              # per-environment config

# WRONG — everything in one file
terraform/main.tf          # 500 lines of mixed resources
```

### 2. State Safety

- [ ] No `terraform state` commands in automation
- [ ] State stored in S3 with DynamoDB locking
- [ ] `prevent_destroy` on critical resources (RDS, S3 with data)
- [ ] No resources removed without `terraform state rm` plan documented
- [ ] `create_before_destroy` on security groups and launch configs
- [ ] Import blocks used for adopting existing resources (not `terraform import` CLI)

```hcl
# CORRECT — protect critical resources
resource "aws_db_instance" "main" {
  lifecycle {
    prevent_destroy = true
  }
}

# CORRECT — zero-downtime SG updates
resource "aws_security_group" "app" {
  name_prefix = "${local.name_prefix}-app-"
  lifecycle {
    create_before_destroy = true
  }
}
```

### 3. Security

- [ ] No secrets in `.tf` or `.tfvars` committed to git
- [ ] Sensitive variables marked `sensitive = true`
- [ ] S3 buckets block public access
- [ ] RDS/Redis in private subnets only
- [ ] Security groups follow least privilege (no `0.0.0.0/0` ingress on non-ALB)
- [ ] Encryption enabled (S3 SSE, RDS encryption, Redis transit + at-rest)
- [ ] IAM policies use least privilege, no `*` actions on `*` resources

```hcl
# WRONG — overly permissive
resource "aws_security_group_rule" "bad" {
  cidr_blocks = ["0.0.0.0/0"]
  from_port   = 0
  to_port     = 65535
}

# CORRECT — scoped to specific source
resource "aws_security_group_rule" "good" {
  source_security_group_id = var.alb_security_group_id
  from_port                = 8080
  to_port                  = 8080
}
```

### 4. Naming

- [ ] Resources use `local.name_prefix` (pattern: `{project}-{service}-{env}`)
- [ ] Consistent naming across all resources in the module
- [ ] Tags include: Project, Service, Environment, ManagedBy
- [ ] No hardcoded names or account IDs

```hcl
# CORRECT
locals {
  name_prefix = "${var.project}-${var.service}-${var.env}"
}

# WRONG
resource "aws_s3_bucket" "assets" {
  bucket = "my-bucket-prod"  # hardcoded
}
```

### 5. Modules

- [ ] No provider blocks inside modules
- [ ] Module source uses version pinning (`?ref=vX.Y.Z`)
- [ ] No circular module dependencies
- [ ] Module outputs only expose what consumers need
- [ ] Modules have `versions.tf` with required provider versions

```hcl
# CORRECT — pinned version
module "rds" {
  source = "git::https://github.com/{project}/terraform-modules.git//rds?ref=v1.2.0"
}

# WRONG — no version pin
module "rds" {
  source = "git::https://github.com/{project}/terraform-modules.git//rds"
}
```

### 6. Variables

- [ ] All variables have `description` and `type`
- [ ] Sensitive variables marked `sensitive = true`
- [ ] Validation blocks on critical inputs (CIDR, names, enums)
- [ ] No unused variables
- [ ] Defaults are sensible for dev, overridden per env

```hcl
# CORRECT
variable "instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"

  validation {
    condition     = can(regex("^db\\.", var.instance_class))
    error_message = "Must be a valid RDS instance class."
  }
}

# WRONG — no description, no type
variable "instance_class" {}
```

### 7. Providers

- [ ] Provider versions pinned with `~>` (pessimistic constraint)
- [ ] `required_version` for Terraform itself
- [ ] Provider config only in `live/terraform.tf`, never in modules
- [ ] Default tags configured at provider level

### 8. CI/CD

- [ ] `terraform fmt -check` runs in CI
- [ ] `terraform validate` runs in CI
- [ ] Plan output posted as PR comment
- [ ] Apply only runs on merge to main
- [ ] State locking prevents concurrent applies
- [ ] Secrets injected via CI environment, not committed

## Interaction Style

- Reads all changed `.tf` files in the PR
- Checks every category — does not skip sections
- Flags blocking issues (security, state safety) separately from suggestions
- Shows exact file and line for each finding

## Rules

- Blocking issues: secrets in code, no state locking, `0.0.0.0/0` ingress, missing encryption
- Needs Changes: missing descriptions, no version pin, naming inconsistency
- Suggestions: code style, optional validations, documentation

## Output

Produces a structured review:

```
## Terraform Review: {PR title}

### Verdict: Approved | Needs Changes | Blocked

### Findings

#### Blocked (if any)
- [ ] **[Security]** Secrets found in terraform.tfvars — file:line

#### Needs Changes (if any)
- [ ] **[Naming]** Hardcoded bucket name in s3.tf:12
- [ ] **[Modules]** Missing version pin on RDS module

#### Suggestions (if any)
- **[Variables]** Consider adding validation on `instance_class`

### Checklist Summary
| Category  | Status |
|-----------|--------|
| Structure | Pass   |
| State     | Pass   |
| Security  | Fail   |
| Naming    | Warn   |
| Modules   | Warn   |
| Variables | Pass   |
| Providers | Pass   |
| CI/CD     | Pass   |
```
