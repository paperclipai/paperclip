---
name: "terraform-module-creator"
description: "Create or extend reusable Terraform modules with proper structure, interfaces, and documentation. Use when building new infrastructure modules or extending existing ones."
allowed_tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/terraform-module-creator"
recommendedForRoles:
  - "engineer"
  - "designer"
tags:
  - "agency-agents"
  - "engineer"
  - "designer"
  - "terraform"
  - "module"
  - "creator"
defaultInstall: false
---
# Terraform Module Creator

Creates or extends reusable Terraform modules following standard conventions for structure, interfaces, and composition.

## When to Use

- Creating a new reusable infrastructure module
- Extending an existing module with new resources
- Refactoring inline resources into a proper module
- Standardizing an ad-hoc module to follow conventions

## Process

### 1. Determine Module Purpose

Ask the user:
- **Module name** (e.g., `rds`, `ecs-service`, `s3-bucket`)
- **Resources managed** (what AWS/cloud resources it wraps)
- **Consumers** (which services will use this module)

### 2. Create Module Directory

```
modules/{module-name}/
  main.tf           # Core resource or locals
  variables.tf      # All input variables
  outputs.tf        # All outputs
  {resource}.tf     # One file per resource type
  versions.tf       # Provider version constraints
  README.md         # Auto-generated usage docs
```

### 3. Define Variables

```hcl
# variables.tf — explicit interfaces, no hardcoded defaults for critical values

variable "name" {
  description = "Resource name prefix"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]+$", var.name))
    error_message = "Name must be lowercase alphanumeric with hyphens."
  }
}

variable "vpc_id" {
  description = "VPC ID where resources are deployed"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for resource placement"
  type        = list(string)
}

variable "tags" {
  description = "Additional tags to apply to all resources"
  type        = map(string)
  default     = {}
}

# Use object types for grouped config
variable "backup" {
  description = "Backup configuration"
  type = object({
    enabled          = bool
    retention_days   = number
    window           = optional(string, "03:00-04:00")
  })
  default = {
    enabled        = true
    retention_days = 7
  }
}
```

### 4. Resource Per File

```hcl
# rds.tf — one resource type per file
resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = var.engine
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage

  db_name  = var.db_name
  username = var.master_username
  password = var.master_password

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = var.backup.retention_days
  backup_window           = var.backup.window
  deletion_protection     = var.deletion_protection

  tags = merge(var.tags, {
    Name = var.name
  })
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-subnet-group"
  subnet_ids = var.subnet_ids

  tags = merge(var.tags, {
    Name = "${var.name}-subnet-group"
  })
}
```

### 5. Security Group Per Resource

```hcl
# sg.tf
resource "aws_security_group" "rds" {
  name_prefix = "${var.name}-rds-"
  vpc_id      = var.vpc_id
  description = "Security group for ${var.name} RDS instance"

  tags = merge(var.tags, {
    Name = "${var.name}-rds-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "rds_ingress" {
  type                     = "ingress"
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = var.app_security_group_id
  description              = "Allow access from application"
}
```

### 6. Define Outputs

```hcl
# outputs.tf — expose values that consumers need
output "endpoint" {
  description = "Database connection endpoint"
  value       = aws_db_instance.this.endpoint
}

output "port" {
  description = "Database port"
  value       = aws_db_instance.this.port
}

output "security_group_id" {
  description = "Security group ID for the database"
  value       = aws_security_group.rds.id
}

output "arn" {
  description = "ARN of the database instance"
  value       = aws_db_instance.this.arn
}

# Mark sensitive outputs
output "connection_string" {
  description = "Full connection string"
  value       = "postgresql://${var.master_username}:${var.master_password}@${aws_db_instance.this.endpoint}/${var.db_name}"
  sensitive   = true
}
```

### 7. Version Constraints

```hcl
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
```

### 8. Publishing to Registry

New modules should be contributed to the [c0x12c Terraform Registry](https://registry.terraform.io/namespaces/c0x12c):

1. Create a new repo at `https://github.com/c0x12c/terraform-aws-{module-name}` following the Terraform registry naming convention
2. Push the module code with proper `versions.tf`, `variables.tf`, `outputs.tf`
3. Tag a release: `git tag v0.1.0 && git push --tags`
4. The registry auto-publishes from GitHub tags
5. Consumers then use: `source = "c0x12c/{module-name}/aws"` with `version = "~> 0.1.0"`

### 9. Module Usage Example

```hcl
# How consumers call this module — use c0x12c registry
module "database" {
  source  = "c0x12c/rds/aws"
  version = "~> 0.6.6"

  name            = "${local.name_prefix}-db"
  engine          = "postgres"
  engine_version  = "15.4"
  instance_class  = "db.t3.micro"
  allocated_storage = 20
  db_name         = "myservice"
  master_username = "admin"
  master_password = var.db_password
  vpc_id          = local.vpc_id
  subnet_ids      = local.private_subnet_ids
  app_security_group_id = module.ecs_service.security_group_id

  deletion_protection = var.env == "prod"

  backup = {
    enabled        = true
    retention_days = var.env == "prod" ? 30 : 7
  }

  tags = local.common_tags
}
```

## Interaction Style

- Asks module purpose and consumers before generating
- Creates complete module in one pass
- Includes usage example showing how to call the module
- Validates naming and interface consistency

## Rules

- NO provider blocks in modules — providers come from the caller
- NO hardcoded values — everything via variables
- Explicit interfaces — every input has description, type, and validation where useful
- One resource per file — named after the resource type
- Use `this` as the resource name for the primary resource
- `name_prefix` over `name` for security groups (allows create-before-destroy)
- Mark sensitive outputs with `sensitive = true`
- Use `object()` types for grouped configuration
- Use `optional()` for fields with sensible defaults
- Version constraints in `versions.tf`, not `main.tf`
- Tags passed through and merged, never overridden
- Lifecycle rules for zero-downtime updates where applicable

## Output

Produces a module directory:

```
modules/{module-name}/
  main.tf
  variables.tf
  outputs.tf
  versions.tf
  sg.tf
  {resource-1}.tf
  {resource-2}.tf
```

Plus a usage snippet for consumers to copy.
