terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "paperclip"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  paperclip_public_url = "https://${var.hostname}"
}

# Secrets Manager shell ARNs must exist before IAM policies reference them.
# ---------------------------------------------------------------------------

resource "random_password" "better_auth" {
  length  = 48
  special = true
}

resource "aws_secretsmanager_secret" "database_url" {
  name = "paperclip/${var.environment}/database-url"
}

resource "aws_secretsmanager_secret" "better_auth" {
  name = "paperclip/${var.environment}/better-auth-secret"
}

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name = "paperclip/${var.environment}/anthropic-api-key"
}

resource "aws_secretsmanager_secret" "claude_oauth_token" {
  name = "paperclip/${var.environment}/claude-oauth-token"
}

resource "aws_secretsmanager_secret" "github_token" {
  name = "paperclip/${var.environment}/github-token"
}

resource "aws_secretsmanager_secret" "openai_api_key" {
  name = "paperclip/${var.environment}/openai-api-key"
}

resource "aws_secretsmanager_secret" "google_api_key" {
  name = "paperclip/${var.environment}/google-api-key"
}

resource "aws_secretsmanager_secret_version" "better_auth" {
  secret_id     = aws_secretsmanager_secret.better_auth.id
  secret_string = random_password.better_auth.result
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

module "networking" {
  source = "../../modules/networking"

  environment        = var.environment
  availability_zones = ["${var.aws_region}a", "${var.aws_region}b"]
  single_nat_gateway = var.single_nat_gateway
}

# ---------------------------------------------------------------------------
# Security (SGs + IAM + WAF ACL)
# ---------------------------------------------------------------------------

module "security" {
  source = "../../modules/security"

  environment = var.environment
  vpc_id      = module.networking.vpc_id
  secret_arns = [
    aws_secretsmanager_secret.database_url.arn,
    aws_secretsmanager_secret.better_auth.arn,
    aws_secretsmanager_secret.claude_oauth_token.arn,
    aws_secretsmanager_secret.github_token.arn,
    aws_secretsmanager_secret.openai_api_key.arn,
    aws_secretsmanager_secret.anthropic_api_key.arn,
    aws_secretsmanager_secret.google_api_key.arn,
  ]
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

module "database" {
  source = "../../modules/database"

  environment                  = var.environment
  subnet_ids                   = module.networking.private_subnets
  security_group_id            = module.security.rds_security_group_id
  instance_class               = var.db_instance_class
  allocated_storage            = var.db_storage
  max_allocated_storage        = var.db_max_storage
  db_password                  = var.db_password
  backup_retention_period      = var.db_backup_retention
  multi_az                     = var.db_multi_az
  deletion_protection          = var.db_deletion_protection
  engine_version               = var.db_engine_version
  performance_insights_enabled = var.db_performance_insights
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgres://postgres:%s@%s/paperclip?sslmode=require",
    urlencode(var.db_password),
    module.database.endpoint
  )
}

# ---------------------------------------------------------------------------
# EFS + ECS task policy for IAM-based EFS mounts
# ---------------------------------------------------------------------------

module "storage" {
  source = "../../modules/storage"

  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  private_subnet_ids    = module.networking.private_subnets
  ecs_security_group_id = module.security.ecs_security_group_id
}

resource "aws_iam_role_policy" "ecs_task_efs" {
  name = "paperclip-${var.environment}-efs-mount"
  role = module.security.ecs_task_role_name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:ClientRootAccess"
        ]
        Resource = [
          module.storage.efs_file_system_arn,
          module.storage.efs_access_point_arn
        ]
      }
    ]
  })
}

data "aws_ecr_repository" "server" {
  name = "paperclip/server"
}

# ---------------------------------------------------------------------------
# Load balancer + ACM (add ACM DNS validation CNAME in Cloudflare while apply runs)
# ---------------------------------------------------------------------------

module "loadbalancer" {
  source = "../../modules/loadbalancer"

  environment           = var.environment
  vpc_id                = module.networking.vpc_id
  public_subnets        = module.networking.public_subnets
  alb_security_group_id = module.security.alb_security_group_id
  hostname              = var.hostname
  container_port        = var.container_port
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = module.loadbalancer.alb_arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = module.loadbalancer.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = module.loadbalancer.target_group_arn
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = module.loadbalancer.alb_arn
  web_acl_arn  = module.security.waf_web_acl_arn
}

locals {
  ecs_secrets = [
    { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
    { name = "BETTER_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.better_auth.arn },
    { name = "CLAUDE_CODE_OAUTH_TOKEN", valueFrom = aws_secretsmanager_secret.claude_oauth_token.arn },
    { name = "GITHUB_TOKEN", valueFrom = aws_secretsmanager_secret.github_token.arn },
    { name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai_api_key.arn },
    { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.anthropic_api_key.arn },
    { name = "GOOGLE_API_KEY", valueFrom = aws_secretsmanager_secret.google_api_key.arn },
  ]
}

# ---------------------------------------------------------------------------
# ECS
# ---------------------------------------------------------------------------

module "compute" {
  source = "../../modules/compute"

  environment           = var.environment
  aws_region            = var.aws_region
  ecr_repository_url    = data.aws_ecr_repository.server.repository_url
  image_tag             = var.ecs_image_tag
  cpu                   = var.ecs_cpu
  memory                = var.ecs_memory
  desired_count         = var.ecs_desired_count
  execution_role_arn    = module.security.ecs_execution_role_arn
  task_role_arn         = module.security.ecs_task_role_arn
  ecs_secrets           = local.ecs_secrets
  private_subnets       = module.networking.private_subnets
  ecs_security_group_id = module.security.ecs_security_group_id
  target_group_arn      = module.loadbalancer.target_group_arn
  alb_listener_arn      = aws_lb_listener.https.arn
  efs_file_system_id    = module.storage.efs_file_system_id
  efs_access_point_id   = module.storage.efs_access_point_id
  container_port                = var.container_port
  paperclip_public_url          = local.paperclip_public_url
  paperclip_allowed_hostnames   = var.hostname

  depends_on = [
    aws_secretsmanager_secret_version.database_url,
    aws_iam_role_policy.ecs_task_efs,
  ]
}

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

module "monitoring" {
  source = "../../modules/monitoring"

  environment             = var.environment
  alarm_email             = var.alarm_email
  ecs_cluster_name        = module.compute.cluster_name
  ecs_service_name        = module.compute.service_name
  rds_instance_id         = "paperclip-${var.environment}-db"
  alb_arn_suffix          = module.loadbalancer.alb_arn_suffix
  target_group_arn_suffix = module.loadbalancer.target_group_arn_suffix
}
