---
title: AWS ECS Fargate
summary: Deploy ValAdrien OS to AWS using ECS Fargate, RDS Postgres, and EFS
---

Deploy ValAdrien OS to AWS with ECS Fargate (compute), RDS Postgres 17 (database), and EFS (persistent storage). This guide uses the AWS CLI and produces a single-task ECS service behind an ALB with HTTPS.

## Prerequisites

- AWS CLI v2 configured with a profile that has admin-level permissions
- Docker installed locally (for building and pushing the image)
- A registered domain with DNS you control (for the TLS certificate)
- The ValAdrien OS repo cloned locally

Set these shell variables for the rest of the guide:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export VALADRIEN_OS_DOMAIN=valadrien-os.example.com   # your domain
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
export AUTH_SECRET=$(openssl rand -base64 32)
```

## 1. Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name valadrien-os-server \
  --image-scanning-configuration scanOnPush=true \
  --region $AWS_REGION
```

## 2. Build and Push Docker Image

```bash
cd /path/to/valadrien-os

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build
docker build -t valadrien-os-server .

# Tag and push
docker tag valadrien-os-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/valadrien-os-server:latest

docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/valadrien-os-server:latest
```

## 3. Networking (VPC, Subnets, Security Groups)

Use the default VPC or create a dedicated one. The guide assumes the default VPC with public and private subnets in two AZs.

```bash
# Get default VPC
VPC_ID=$(aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# Get two public subnets (for ALB)
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`] | [0:2].SubnetId' \
  --output text)
SUBNET_1=$(echo $SUBNET_IDS | awk '{print $1}')
SUBNET_2=$(echo $SUBNET_IDS | awk '{print $2}')
```

Create security groups:

```bash
# ALB security group — inbound HTTPS
ALB_SG=$(aws ec2 create-security-group \
  --group-name valadrien-os-alb \
  --description "ValAdrien OS ALB" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# Also open port 80 so the ALB can accept HTTP and redirect to HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# ECS task security group — inbound from ALB only
ECS_SG=$(aws ec2 create-security-group \
  --group-name valadrien-os-ecs \
  --description "ValAdrien OS ECS tasks" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $ECS_SG \
  --protocol tcp --port 3100 \
  --source-group $ALB_SG

# RDS security group — inbound from ECS only
RDS_SG=$(aws ec2 create-security-group \
  --group-name valadrien-os-rds \
  --description "ValAdrien OS RDS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --protocol tcp --port 5432 \
  --source-group $ECS_SG

# EFS security group — inbound NFS from ECS only
EFS_SG=$(aws ec2 create-security-group \
  --group-name valadrien-os-efs \
  --description "ValAdrien OS EFS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $EFS_SG \
  --protocol tcp --port 2049 \
  --source-group $ECS_SG
```

## 4. Create RDS Postgres Instance

```bash
# Custom VPCs don't come with a default DB subnet group — create one
# that spans our two subnets so RDS can place the instance.
aws rds create-db-subnet-group \
  --db-subnet-group-name valadrien-os-db-subnet \
  --db-subnet-group-description "ValAdrien OS RDS subnets" \
  --subnet-ids $SUBNET_1 $SUBNET_2

aws rds create-db-instance \
  --db-instance-identifier valadrien-os-db \
  --db-instance-class db.t4g.micro \
  --engine postgres \
  --engine-version 17 \
  --master-username valadrien-os \
  --master-user-password "$DB_PASSWORD" \
  --allocated-storage 20 \
  --storage-type gp3 \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name valadrien-os-db-subnet \
  --no-publicly-accessible \
  --backup-retention-period 7 \
  --no-multi-az \
  --db-name valadrien-os \
  --region $AWS_REGION

# Wait for it to become available (takes 5-10 min)
aws rds wait db-instance-available \
  --db-instance-identifier valadrien-os-db

# Get the endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier valadrien-os-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

DATABASE_URL="postgresql://valadrien-os:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/valadrien-os"
```

## 5. Create EFS Filesystem

```bash
EFS_ID=$(aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --encrypted \
  --tags Key=Name,Value=valadrien-os-data \
  --query 'FileSystemId' --output text)

# Create mount targets in each subnet
for SUBNET in $SUBNET_1 $SUBNET_2; do
  aws efs create-mount-target \
    --file-system-id $EFS_ID \
    --subnet-id $SUBNET \
    --security-groups $EFS_SG
done

# Wait for mount targets
aws efs describe-mount-targets --file-system-id $EFS_ID
```

## 6. Store Secrets

```bash
aws secretsmanager create-secret \
  --name valadrien-os/database-url \
  --secret-string "$DATABASE_URL"

aws secretsmanager create-secret \
  --name valadrien-os/anthropic-api-key \
  --secret-string "YOUR_ANTHROPIC_KEY"

aws secretsmanager create-secret \
  --name valadrien-os/better-auth-secret \
  --secret-string "$AUTH_SECRET"

aws secretsmanager create-secret \
  --name valadrien-os/openai-api-key \
  --secret-string "YOUR_OPENAI_KEY"

aws secretsmanager create-secret \
  --name valadrien-os/github-token \
  --secret-string "YOUR_GITHUB_PAT"
```

## 7. IAM Roles

Create the ECS task execution role (pulls images, reads secrets) and the task role (application permissions).

```bash
# Task execution role
aws iam create-role \
  --role-name valadrien-os-ecs-execution \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name valadrien-os-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Allow reading secrets
aws iam put-role-policy \
  --role-name valadrien-os-ecs-execution \
  --policy-name SecretsAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:'$AWS_REGION':'$AWS_ACCOUNT_ID':secret:valadrien-os/*"
    }]
  }'

# Task role (application — add permissions as needed)
aws iam create-role \
  --role-name valadrien-os-ecs-task \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'
```

## 8. ECS Cluster and Task Definition

```bash
aws ecs create-cluster --cluster-name valadrien-os

aws logs create-log-group --log-group-name /ecs/valadrien-os
```

Register the task definition using the template at `docker/ecs-task-definition.json`. Before registering, replace the placeholder values:

```bash
sed -e "s|<ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" \
    -e "s|<REGION>|$AWS_REGION|g" \
    -e "s|<EFS_ID>|$EFS_ID|g" \
    -e "s|<DOMAIN>|$VALADRIEN_OS_DOMAIN|g" \
    docker/ecs-task-definition.json > /tmp/valadrien-os-task-def.json

aws ecs register-task-definition \
  --cli-input-json file:///tmp/valadrien-os-task-def.json
```

## 9. ALB and TLS Certificate

Request a certificate (you must validate via DNS):

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name $VALADRIEN_OS_DOMAIN \
  --validation-method DNS \
  --query 'CertificateArn' --output text)

# Get the CNAME record to add to your DNS
aws acm describe-certificate \
  --certificate-arn $CERT_ARN \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

Add the CNAME to your DNS provider, then wait for validation:

```bash
aws acm wait certificate-validated --certificate-arn $CERT_ARN
```

Create the ALB:

```bash
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name valadrien-os-alb \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)

# Target group
TG_ARN=$(aws elbv2 create-target-group \
  --name valadrien-os-tg \
  --protocol HTTP \
  --port 3100 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /api/health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# HTTPS listener
LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN \
  --query 'Listeners[0].ListenerArn' --output text)

# HTTP listener — redirect all :80 traffic to :443
HTTP_LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --query 'Listeners[0].ListenerArn' --output text)
```

Point your DNS to the ALB:
- Create a CNAME or ALIAS record for `$VALADRIEN_OS_DOMAIN` -> `$ALB_DNS`

## 10. Create ECS Service

```bash
aws ecs create-service \
  --cluster valadrien-os \
  --service-name valadrien-os-server \
  --task-definition valadrien-os-server \
  --desired-count 1 \
  --launch-type FARGATE \
  --deployment-configuration '{
    "deploymentCircuitBreaker": {"enable": true, "rollback": true},
    "maximumPercent": 200,
    "minimumHealthyPercent": 100
  }' \
  --network-configuration '{
    "awsvpcConfiguration": {
      "subnets": ["'$SUBNET_1'", "'$SUBNET_2'"],
      "securityGroups": ["'$ECS_SG'"],
      "assignPublicIp": "ENABLED"
    }
  }' \
  --load-balancers '[{
    "targetGroupArn": "'$TG_ARN'",
    "containerName": "valadrien-os-server",
    "containerPort": 3100
  }]'
```

> **Note:** `assignPublicIp: ENABLED` is needed if using public subnets without a NAT Gateway. For private subnets, set to `DISABLED` and ensure a NAT Gateway is configured for outbound internet access.

## 11. Verify Deployment

```bash
# Watch task come up
aws ecs describe-services \
  --cluster valadrien-os \
  --services valadrien-os-server \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'

# Check task health
aws ecs list-tasks --cluster valadrien-os --service-name valadrien-os-server
TASK_ARN=$(aws ecs list-tasks --cluster valadrien-os --service-name valadrien-os-server --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster valadrien-os --tasks $TASK_ARN \
  --query 'tasks[0].{status:lastStatus,health:healthStatus}'

# Check logs
aws logs tail /ecs/valadrien-os --since 10m --follow

# Hit the health endpoint
curl -sf https://$VALADRIEN_OS_DOMAIN/api/health
```

**Healthy indicators:**
- ECS task status: `RUNNING`, health: `HEALTHY`
- Logs show `plugin job coordinator started` and `plugin-loader: loadAll complete`
- `/api/health` returns 200

## Post-Deploy Security Hardening

After the first user has signed up (which grants admin role), lock down the instance:

```bash
# Disable public sign-up (prevents unauthorized users from creating accounts)
# Add to the task definition environment section, then redeploy:
#   { "name": "VALADRIEN_OS_AUTH_DISABLE_SIGN_UP", "value": "true" }

# Or update via Secrets Manager / task def override, then force new deployment
aws ecs update-service \
  --cluster valadrien-os \
  --service valadrien-os-server \
  --force-new-deployment
```

Use the invite flow (added in v2026.416.0) to grant access to additional users after sign-up is disabled.

## Deploying Updates

Build, push, and force a new deployment:

```bash
# Build and push new image
docker build -t valadrien-os-server .
docker tag valadrien-os-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/valadrien-os-server:latest
docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/valadrien-os-server:latest

# Roll out
aws ecs update-service \
  --cluster valadrien-os \
  --service valadrien-os-server \
  --force-new-deployment

# Watch the deployment
aws ecs describe-services \
  --cluster valadrien-os \
  --services valadrien-os-server \
  --query 'services[0].deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState}'
```

ECS performs a rolling update: starts a new task, waits for it to pass health checks, then drains the old task.

## Rollback

If the new deployment is unhealthy:

```bash
# ECS automatically rolls back if the new task fails health checks
# (circuit breaker is enabled in the service configuration above).
# To force rollback manually:

# 1. Find the previous task definition revision
aws ecs list-task-definitions \
  --family-prefix valadrien-os-server \
  --sort DESC \
  --query 'taskDefinitionArns[0:3]'

# 2. Update service to the previous revision
aws ecs update-service \
  --cluster valadrien-os \
  --service valadrien-os-server \
  --task-definition valadrien-os-server:<PREVIOUS_REVISION>
```

## Scaling to Zero (Cost Savings)

Scale down when not in use:

```bash
# Stop
aws ecs update-service \
  --cluster valadrien-os \
  --service valadrien-os-server \
  --desired-count 0

# Start
aws ecs update-service \
  --cluster valadrien-os \
  --service valadrien-os-server \
  --desired-count 1
```

RDS can also be stopped (auto-restarts after 7 days):

```bash
aws rds stop-db-instance --db-instance-identifier valadrien-os-db
aws rds start-db-instance --db-instance-identifier valadrien-os-db
```

## Teardown

Remove all resources in reverse order:

```bash
# 1. ECS service and cluster
aws ecs update-service --cluster valadrien-os --service valadrien-os-server --desired-count 0
aws ecs delete-service --cluster valadrien-os --service valadrien-os-server --force
aws ecs delete-cluster --cluster valadrien-os

# 2. ALB and ACM cert
aws elbv2 delete-listener --listener-arn $HTTP_LISTENER_ARN
aws elbv2 delete-listener --listener-arn $LISTENER_ARN
aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws acm delete-certificate --certificate-arn $CERT_ARN

# 3. RDS (creates final snapshot)
aws rds delete-db-instance \
  --db-instance-identifier valadrien-os-db \
  --final-db-snapshot-identifier valadrien-os-db-final
aws rds wait db-instance-deleted --db-instance-identifier valadrien-os-db
aws rds delete-db-subnet-group --db-subnet-group-name valadrien-os-db-subnet

# 4. EFS (mount targets must be deleted first)
for MT in $(aws efs describe-mount-targets --file-system-id $EFS_ID --query 'MountTargets[*].MountTargetId' --output text); do
  aws efs delete-mount-target --mount-target-id $MT
done
# Mount-target deletion is async; poll until none remain before deleting
# the filesystem, otherwise delete-file-system fails with FileSystemInUse.
echo "Waiting for mount targets to delete..."
while aws efs describe-mount-targets \
  --file-system-id $EFS_ID \
  --query 'MountTargets[0].MountTargetId' --output text 2>/dev/null | grep -q 'fsmt-'; do
  sleep 5
done
aws efs delete-file-system --file-system-id $EFS_ID

# 5. Secrets
for s in database-url anthropic-api-key better-auth-secret openai-api-key github-token; do
  aws secretsmanager delete-secret --secret-id valadrien-os/$s --force-delete-without-recovery
done

# 6. Security groups (after all dependents are gone)
for sg in $EFS_SG $RDS_SG $ECS_SG $ALB_SG; do
  aws ec2 delete-security-group --group-id $sg
done

# 7. ECR
aws ecr delete-repository --repository-name valadrien-os-server --force

# 8. IAM roles
aws iam delete-role-policy --role-name valadrien-os-ecs-execution --policy-name SecretsAccess
aws iam detach-role-policy --role-name valadrien-os-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name valadrien-os-ecs-execution
aws iam delete-role --role-name valadrien-os-ecs-task

# 9. Log group
aws logs delete-log-group --log-group-name /ecs/valadrien-os
```

## Cost Reference

| Service | Config | Monthly |
|---------|--------|---------|
| ECS Fargate | 2 vCPU, 4 GB, 24/7 | ~$70 |
| RDS Postgres | db.t4g.micro, 20 GB | ~$15 |
| ALB | 1 LCU average | ~$22 |
| NAT Gateway | 1 AZ (if using private subnets) | ~$35 |
| EFS | 1 GB Standard | ~$0.30 |
| Secrets Manager | 5 secrets | ~$2 |
| CloudWatch Logs | ~1 GB/mo | ~$0.50 |
| ECR | ~1 GB | ~$0.10 |
| **Total (public subnets, no NAT)** | | **~$110/mo** |
| **Total (private subnets + NAT)** | | **~$145/mo** |

Use Fargate Spot and scheduled scaling to 0 during off-hours to reduce to ~$60-85/mo.
