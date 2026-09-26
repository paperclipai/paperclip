---
name: "terraform-security-audit"
description: "Security audit for Terraform codebases covering IAM, networking, encryption, secrets, access control, and compliance. Use before prod deploys, periodic audits, or new service security review."
allowed_tools:
  - Read
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/terraform-security-audit"
recommendedForRoles:
  - "engineer"
  - "operations"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "operations"
  - "security"
  - "terraform"
  - "audit"
defaultInstall: false
---
# Terraform Security Audit

Runs a 6-area security audit on Terraform codebases. Produces a pass/fail report per area.

## When to Use

- Security review before production deployment
- Periodic infrastructure security audit
- New service setup validation
- Post-incident security hardening check

## Process

### 1. IAM — Identity and Access Management

- [ ] OIDC used for CI/CD (no long-lived access keys)
- [ ] IRSA for EKS workloads (no node-level IAM)
- [ ] ECS task roles scoped per service (no shared roles)
- [ ] IAM policies follow least privilege
- [ ] No `*` actions on `*` resources
- [ ] No inline policies (use managed or customer policies)
- [ ] Assume role conditions include `ExternalId` or `sts:SourceIdentity`

```hcl
# INSECURE — overly broad permissions
resource "aws_iam_policy" "bad" {
  policy = jsonencode({
    Statement = [{
      Effect   = "Allow"
      Action   = "*"
      Resource = "*"
    }]
  })
}

# SECURE — scoped to specific actions and resources
resource "aws_iam_policy" "good" {
  policy = jsonencode({
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "${aws_s3_bucket.assets.arn}/*"
    }]
  })
}
```

```hcl
# SECURE — IRSA for EKS pods
module "irsa" {
  source = "git::https://github.com/{project}/terraform-modules.git//irsa?ref=v1.0.0"

  name              = "${local.name_prefix}-irsa"
  oidc_provider_arn = var.oidc_provider_arn
  namespace         = var.service
  service_account   = var.service
  policy_arns       = [aws_iam_policy.service.arn]
}
```

### 2. Network — VPC and Security Groups

- [ ] Databases in private subnets only
- [ ] No `0.0.0.0/0` ingress except ALB on 443
- [ ] Security groups use `source_security_group_id`, not CIDR
- [ ] Egress restricted where possible
- [ ] VPC flow logs enabled
- [ ] No public IPs on non-bastion instances

```hcl
# INSECURE — database accessible from anywhere
resource "aws_security_group_rule" "rds_bad" {
  type        = "ingress"
  from_port   = 5432
  to_port     = 5432
  protocol    = "tcp"
  cidr_blocks = ["0.0.0.0/0"]
  security_group_id = aws_security_group.rds.id
}

# SECURE — database only from app security group
resource "aws_security_group_rule" "rds_good" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
  security_group_id        = aws_security_group.rds.id
  description              = "PostgreSQL access from application"
}
```

### 3. Encryption — Data at Rest and in Transit

- [ ] S3: SSE enabled (KMS or AES-256)
- [ ] RDS: `storage_encrypted = true`
- [ ] RDS: `ssl_enforcement` via parameter group
- [ ] Redis: `transit_encryption_enabled = true`
- [ ] Redis: `at_rest_encryption_enabled = true`
- [ ] EBS volumes encrypted
- [ ] Terraform state bucket encrypted with SSE-KMS
- [ ] ALB uses TLS 1.2+ only

```hcl
# INSECURE — no encryption
resource "aws_db_instance" "bad" {
  storage_encrypted = false  # default
}

# SECURE — encryption enabled
resource "aws_db_instance" "good" {
  storage_encrypted = true
  kms_key_id        = var.rds_kms_key_arn
}
```

```hcl
# SECURE — Redis encryption
module "redis" {
  source = "git::https://github.com/{project}/terraform-modules.git//elasticache?ref=v1.0.0"

  transit_encryption = true
  at_rest_encryption = true
  auth_token         = var.redis_auth_token
}
```

### 4. Secrets — Secret Management

- [ ] No secrets in `.tf` files or committed `.tfvars`
- [ ] `secrets.tfvars` in `.gitignore`
- [ ] Sensitive variables marked `sensitive = true`
- [ ] Secrets injected via CI/CD environment variables
- [ ] No plaintext passwords in state (use `sensitive` output)
- [ ] git-secret-protector or pre-commit hooks block accidental commits

```hcl
# INSECURE — password in code
resource "aws_db_instance" "bad" {
  password = "SuperSecret123!"
}

# SECURE — from variable, marked sensitive
variable "db_password" {
  description = "Database master password"
  type        = string
  sensitive   = true
}

resource "aws_db_instance" "good" {
  password = var.db_password
}
```

```hcl
# SECURE — sensitive output
output "connection_string" {
  value     = "postgresql://${var.db_user}:${var.db_password}@${aws_db_instance.main.endpoint}/${var.db_name}"
  sensitive = true
}
```

### 5. Access — Cluster and Console Access

- [ ] EKS `aws-auth` ConfigMap restricts access to needed roles
- [ ] SSO used for console access (no IAM users with passwords)
- [ ] Bastion host in private subnet with Session Manager (no SSH keys)
- [ ] CloudTrail enabled for API audit logging
- [ ] MFA enforced on human accounts

```hcl
# EKS access control
resource "kubernetes_config_map" "aws_auth" {
  metadata {
    name      = "aws-auth"
    namespace = "kube-system"
  }

  data = {
    mapRoles = yamlencode([
      {
        rolearn  = var.admin_role_arn
        username = "admin"
        groups   = ["system:masters"]
      },
      {
        rolearn  = var.node_role_arn
        username = "system:node:{{EC2PrivateDNSName}}"
        groups   = ["system:bootstrappers", "system:nodes"]
      }
    ])
  }
}
```

### 6. Compliance — Tags, Naming, and Backups

- [ ] All resources tagged: Project, Service, Environment, ManagedBy
- [ ] Naming follows `{project}-{service}-{env}` convention
- [ ] RDS automated backups enabled (retention >= 7 days, 30 for prod)
- [ ] S3 versioning enabled on data buckets
- [ ] DynamoDB point-in-time recovery enabled
- [ ] CloudWatch alarms on critical metrics
- [ ] Cost allocation tags configured

```hcl
# CORRECT — default tags at provider level
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

# CORRECT — backup retention
resource "aws_db_instance" "main" {
  backup_retention_period = var.env == "prod" ? 30 : 7
  backup_window           = "03:00-04:00"
}
```

## Interaction Style

- Scans all `.tf` files in the codebase
- Checks every area — does not skip sections
- Highlights critical findings first (IAM wildcards, public access, missing encryption)
- Provides remediation code for each failing check

## Rules

- Critical: IAM `*/*`, public database access, unencrypted storage, secrets in code
- Warning: Missing tags, short backup retention, no flow logs
- Info: Missing descriptions, optional hardening not applied

## Output

Produces a security audit report:

```
## Terraform Security Audit: {service}

### Overall: Pass | Fail

| Area       | Status   | Critical | Warnings | Info |
|------------|----------|----------|----------|------|
| IAM        | Pass     | 0        | 0        | 1    |
| Network    | Fail     | 1        | 0        | 0    |
| Encryption | Pass     | 0        | 1        | 0    |
| Secrets    | Pass     | 0        | 0        | 0    |
| Access     | Pass     | 0        | 0        | 1    |
| Compliance | Warning  | 0        | 2        | 0    |

### Critical Findings
- **[Network]** Security group `rds_main` allows ingress from 0.0.0.0/0 on port 5432
  - File: `modules/{service}/sg.tf:15`
  - Fix: Replace `cidr_blocks` with `source_security_group_id`

### Warnings
- **[Encryption]** Redis `at_rest_encryption` not enabled
  - File: `modules/{service}/redis.tf:8`
  - Fix: Add `at_rest_encryption = true`

### Remediation Priority
1. Fix critical findings before any deployment
2. Address warnings before production promotion
3. Info items for next sprint
```
