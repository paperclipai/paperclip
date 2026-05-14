---
title: AWS ECS Fargate
summary: 使用 ECS Fargate、RDS Postgres 和 EFS 将 Paperclip 部署到 AWS
---

将 Paperclip 部署到 AWS，使用 ECS Fargate（计算）、RDS Postgres 17（数据库）和 EFS（持久存储）。本指南使用 AWS CLI，并在 ALB 后面生成带有 HTTPS 的单任务 ECS 服务。

## 先决条件

- AWS CLI v2 配置为具有管理员级权限的配置文件
- 本地安装了 Docker（用于构建和推送映像）
- 已注册的具有你控制的 DNS 的域（用于 TLS 证书）
- Paperclip 仓库已克隆到本地

为本指南的其余部分设置这些 shell 变量：

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PAPERCLIP_DOMAIN=paperclip.example.com   # 你的域
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
export AUTH_SECRET=$(openssl rand -base64 32)
```

## 1. 创建 ECR 仓库

```bash
aws ecr create-repository \
  --repository-name paperclip-server \
  --image-scanning-configuration scanOnPush=true \
  --region $AWS_REGION
```

## 2. 构建和推送 Docker 映像

```bash
cd /path/to/paperclip

# 向 ECR 认证 Docker
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# 构建
docker build -t paperclip-server .

# 标记并推送
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest
```

## 3. 网络（VPC、子网、安全组）

使用默认 VPC 或创建专用 VPC。本指南假设默认 VPC 在两个 AZ 中具有公共和私有子网。

```bash
# 获取默认 VPC
VPC_ID=$(aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# 获取两个公共子网（用于 ALB）
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`] | [0:2].SubnetId' \
  --output text)
SUBNET_1=$(echo $SUBNET_IDS | awk '{print $1}')
SUBNET_2=$(echo $SUBNET_IDS | awk '{print $2}')
```

创建安全组：

```bash
# ALB 安全组 — 入站 HTTPS
ALB_SG=$(aws ec2 create-security-group \
  --group-name paperclip-alb \
  --description "Paperclip ALB" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG \
  --protocol tcp --port 443 --cidr 0.0.0.0/0

# 也打开端口 80，以便 ALB 可以接受 HTTP 并重定向到 HTTPS
aws ec2 authorize-security-group-ingress \
  --group-id $ALB_SG \
  --protocol tcp --port 80 --cidr 0.0.0.0/0

# ECS 任务安全组 — 仅从 ALB 入站
ECS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-ecs \
  --description "Paperclip ECS tasks" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $ECS_SG \
  --protocol tcp --port 3100 \
  --source-group $ALB_SG

# RDS 安全组 — 仅从 ECS 入站
RDS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-rds \
  --description "Paperclip RDS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --protocol tcp --port 5432 \
  --source-group $ECS_SG

# EFS 安全组 — 仅从 ECS 入站 NFS
EFS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-efs \
  --description "Paperclip EFS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $EFS_SG \
  --protocol tcp --port 2049 \
  --source-group $ECS_SG
```

## 4. 创建 RDS Postgres 实例

```bash
# 自定义 VPC 没有默认的 DB 子网组 — 创建一个
# 跨越我们的两个子网，以便 RDS 可以放置实例。
aws rds create-db-subnet-group \
  --db-subnet-group-name paperclip-db-subnet \
  --db-subnet-group-description "Paperclip RDS subnets" \
  --subnet-ids $SUBNET_1 $SUBNET_2

aws rds create-db-instance \
  --db-instance-identifier paperclip-db \
  --db-instance-class db.t4g.micro \
  --engine postgres \
  --engine-version 17 \
  --master-username paperclip \
  --master-user-password "$DB_PASSWORD" \
  --allocated-storage 20 \
  --storage-type gp3 \
  --vpc-security-group-ids $RDS_SG \
  --db-subnet-group-name paperclip-db-subnet \
  --no-publicly-accessible \
  --backup-retention-period 7 \
  --no-multi-az \
  --db-name paperclip \
  --region $AWS_REGION

# 等待它变得可用（需要 5-10 分钟）
aws rds wait db-instance-available \
  --db-instance-identifier paperclip-db

# 获取端点
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier paperclip-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

DATABASE_URL="postgresql://paperclip:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/paperclip"
```

## 5. 创建 EFS 文件系统

```bash
EFS_ID=$(aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --encrypted \
  --tags Key=Name,Value=paperclip-data \
  --query 'FileSystemId' --output text)

# 在每个子网中创建挂载目标
for SUBNET in $SUBNET_1 $SUBNET_2; do
  aws efs create-mount-target \
    --file-system-id $EFS_ID \
    --subnet-id $SUBNET \
    --security-groups $EFS_SG
done

# 等待挂载目标
aws efs describe-mount-targets --file-system-id $EFS_ID
```

## 6. 存储密钥

```bash
aws secretsmanager create-secret \
  --name paperclip/database-url \
  --secret-string "$DATABASE_URL"

aws secretsmanager create-secret \
  --name paperclip/anthropic-api-key \
  --secret-string "YOUR_ANTHROPIC_KEY"

aws secretsmanager create-secret \
  --name paperclip/better-auth-secret \
  --secret-string "$AUTH_SECRET"

aws secretsmanager create-secret \
  --name paperclip/openai-api-key \
  --secret-string "YOUR_OPENAI_KEY"

aws secretsmanager create-secret \
  --name paperclip/github-token \
  --secret-string "YOUR_GITHUB_PAT"
```

## 7. IAM 角色

创建 ECS 任务执行角色（拉取映像、读取密钥）和任务角色（应用程序权限）。

```bash
# 任务执行角色
aws iam create-role \
  --role-name paperclip-ecs-execution \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name paperclip-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# 允许读取密钥
aws iam put-role-policy \
  --role-name paperclip-ecs-execution \
  --policy-name SecretsAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:'$AWS_REGION':'$AWS_ACCOUNT_ID':secret:paperclip/*"
    }]
  }'

# 任务角色（应用程序 — 根据需要添加权限）
aws iam create-role \
  --role-name paperclip-ecs-task \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'
```

## 8. ECS 集群和任务定义

```bash
aws ecs create-cluster --cluster-name paperclip

aws logs create-log-group --log-group-name /ecs/paperclip
```

使用 `docker/ecs-task-definition.json` 中的模板注册任务定义。注册前，替换占位符值：

```bash
sed -e "s|<ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" \
    -e "s|<REGION>|$AWS_REGION|g" \
    -e "s|<EFS_ID>|$EFS_ID|g" \
    -e "s|<DOMAIN>|$PAPERCLIP_DOMAIN|g" \
    docker/ecs-task-definition.json > /tmp/paperclip-task-def.json

aws ecs register-task-definition \
  --cli-input-json file:///tmp/paperclip-task-def.json
```

## 9. ALB 和 TLS 证书

请求证书（你必须通过 DNS 验证）：

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name $PAPERCLIP_DOMAIN \
  --validation-method DNS \
  --query 'CertificateArn' --output text)

# 获取要添加到 DNS 的 CNAME 记录
aws acm describe-certificate \
  --certificate-arn $CERT_ARN \
  --query 'Certificate.DomainValidationOptions[0].ResourceRecord'
```

将 CNAME 添加到你的 DNS 提供商，然后等待验证：

```bash
aws acm wait certificate-validated --certificate-arn $CERT_ARN
```

创建 ALB：

```bash
ALB_ARN=$(aws elbv2 create-load-balancer \
  --name paperclip-alb \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $ALB_SG \
  --scheme internet-facing \
  --type application \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)

ALB_DNS=$(aws elbv2 describe-load-balancers \
  --load-balancer-arns $ALB_ARN \
  --query 'LoadBalancers[0].DNSName' --output text)

# 目标组
TG_ARN=$(aws elbv2 create-target-group \
  --name paperclip-tg \
  --protocol HTTP \
  --port 3100 \
  --vpc-id $VPC_ID \
  --target-type ip \
  --health-check-path /api/health \
  --health-check-interval-seconds 30 \
  --healthy-threshold-count 2 \
  --unhealthy-threshold-count 3 \
  --query 'TargetGroups[0].TargetGroupArn' --output text)

# HTTPS 监听器
LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN \
  --query 'Listeners[0].ListenerArn' --output text)

# HTTP 监听器 — 将所有 :80 流量重定向到 :443
HTTP_LISTENER_ARN=$(aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=redirect,RedirectConfig='{Protocol=HTTPS,Port=443,StatusCode=HTTP_301}' \
  --query 'Listeners[0].ListenerArn' --output text)
```

将你的 DNS 指向 ALB：

- 为 `$PAPERCLIP_DOMAIN` -> `$ALB_DNS` 创建 CNAME 或 ALIAS 记录

## 10. 创建 ECS 服务

```bash
aws ecs create-service \
  --cluster paperclip \
  --service-name paperclip-server \
  --task-definition paperclip-server \
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
    "containerName": "paperclip-server",
    "containerPort": 3100
  }]'
```

> **注意：** 如果使用没有 NAT 网关的公共子网，则需要 `assignPublicIp: ENABLED`。对于私有子网，设置为 `DISABLED` 并确保为出站互联网访问配置了 NAT 网关。

## 11. 验证部署

```bash
# 观察任务启动
aws ecs describe-services \
  --cluster paperclip \
  --services paperclip-server \
  --query 'services[0].{desired:desiredCount,running:runningCount,status:status}'

# 检查任务运行状况
aws ecs list-tasks --cluster paperclip --service-name paperclip-server
TASK_ARN=$(aws ecs list-tasks --cluster paperclip --service-name paperclip-server --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster paperclip --tasks $TASK_ARN \
  --query 'tasks[0].{status:lastStatus,health:healthStatus}'

# 检查日志
aws logs tail /ecs/paperclip --since 10m --follow

# 访问运行状况端点
curl -sf https://$PAPERCLIP_DOMAIN/api/health
```

**健康指标：**

- ECS 任务状态：`RUNNING`，运行状况：`HEALTHY`
- 日志显示 `plugin job coordinator started` 和 `plugin-loader: loadAll complete`
- `/api/health` 返回 200

## 部署后安全强化

在第一个用户注册后（授予管理员角色），锁定实例：

```bash
# 禁用公共注册（防止未经授权的用户创建帐户）
# 添加到任务定义环境部分，然后重新部署：
#   { "name": "PAPERCLIP_AUTH_DISABLE_SIGN_UP", "value": "true" }

# 或通过 Secrets Manager / 任务定义覆盖更新，然后强制新部署
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --force-new-deployment
```

在注册被禁用后，使用邀请流程（在 v2026.416.0 中添加）授予其他用户的访问权限。

## 部署更新

构建、推送并强制新部署：

```bash
# 构建并推送新映像
docker build -t paperclip-server .
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest
docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

# 推出
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --force-new-deployment

# 观察部署
aws ecs describe-services \
  --cluster paperclip \
  --services paperclip-server \
  --query 'services[0].deployments[*].{status:status,running:runningCount,desired:desiredCount,rollout:rolloutState}'
```

ECS 执行滚动更新：启动新任务，等待其通过运行状况检查，然后排空旧任务。

## 回滚

如果新部署不健康：

```bash
# 如果新任务运行状况检查失败，ECS 会自动回滚
# （断路器在上面的服务配置中启用）。
# 手动强制回滚：

# 1. 查找以前的任务定义修订
aws ecs list-task-definitions \
  --family-prefix paperclip-server \
  --sort DESC \
  --query 'taskDefinitionArns[0:3]'

# 2. 将服务更新到以前的修订
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --task-definition paperclip-server:<PREVIOUS_REVISION>
```

## 缩放到零（成本节省）

不使用时缩减：

```bash
# 停止
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --desired-count 0

# 启动
aws ecs update-service \
  --cluster paperclip \
  --service paperclip-server \
  --desired-count 1
```

RDS 也可以停止（7 天后自动重启）：

```bash
aws rds stop-db-instance --db-instance-identifier paperclip-db
aws rds start-db-instance --db-instance-identifier paperclip-db
```

## 拆解

按相反顺序删除所有资源：

```bash
# 1. ECS 服务和集群
aws ecs update-service --cluster paperclip --service paperclip-server --desired-count 0
aws ecs delete-service --cluster paperclip --service paperclip-server --force
aws ecs delete-cluster --cluster paperclip

# 2. ALB 和 ACM 证书
aws elbv2 delete-listener --listener-arn $HTTP_LISTENER_ARN
aws elbv2 delete-listener --listener-arn $LISTENER_ARN
aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws acm delete-certificate --certificate-arn $CERT_ARN

# 3. RDS（创建最终快照）
aws rds delete-db-instance \
  --db-instance-identifier paperclip-db \
  --final-db-snapshot-identifier paperclip-db-final
aws rds wait db-instance-deleted --db-instance-identifier paperclip-db
aws rds delete-db-subnet-group --db-subnet-group-name paperclip-db-subnet

# 4. EFS（必须首先删除挂载目标）
for MT in $(aws efs describe-mount-targets --file-system-id $EFS_ID --query 'MountTargets[*].MountTargetId' --output text); do
  aws efs delete-mount-target --mount-target-id $MT
done
# 挂载目标删除是异步的；在删除文件系统之前轮询直到没有剩余，否则 delete-file-system 会因 FileSystemInUse 失败。
echo "Waiting for mount targets to delete..."
while aws efs describe-mount-targets \
  --file-system-id $EFS_ID \
  --query 'MountTargets[0].MountTargetId' --output text 2>/dev/null | grep -q 'fsmt-'; do
  sleep 5
done
aws efs delete-file-system --file-system-id $EFS_ID

# 5. 密钥
for s in database-url anthropic-api-key better-auth-secret openai-api-key github-token; do
  aws secretsmanager delete-secret --secret-id paperclip/$s --force-delete-without-recovery
done

# 6. 安全组（在所有依赖项删除后）
for sg in $EFS_SG $RDS_SG $ECS_SG $ALB_SG; do
  aws ec2 delete-security-group --group-id $sg
done

# 7. ECR
aws ecr delete-repository --repository-name paperclip-server --force

# 8. IAM 角色
aws iam delete-role-policy --role-name paperclip-ecs-execution --policy-name SecretsAccess
aws iam detach-role-policy --role-name paperclip-ecs-execution \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name paperclip-ecs-execution
aws iam delete-role --role-name paperclip-ecs-task

# 9. 日志组
aws logs delete-log-group --log-group-name /ecs/paperclip
```

## 成本参考


| 服务                 | 配置                  | 每月          |
| ------------------ | ------------------- | ----------- |
| ECS Fargate        | 2 vCPU, 4 GB, 24/7  | ~$70        |
| RDS Postgres       | db.t4g.micro, 20 GB | ~$15        |
| ALB                | 1 LCU 平均            | ~$22        |
| NAT 网关             | 1 AZ（如果使用私有子网）      | ~$35        |
| EFS                | 1 GB 标准             | ~$0.30      |
| Secrets Manager    | 5 个密钥               | ~$2         |
| CloudWatch Logs    | ~1 GB/月             | ~$0.50      |
| ECR                | ~1 GB               | ~$0.10      |
| **总计（公共子网，无 NAT）** |                     | **~$110/月** |
| **总计（私有子网 + NAT）** |                     | **~$145/月** |


使用 Fargate Spot 和在非高峰时间计划缩减到 0，以减少到 ~$60-85/月。