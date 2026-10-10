---
title: AWS App Runner
summary: Deploy Paperclip to AWS using App Runner, RDS Postgres, and S3
---

Deploy Paperclip to AWS with App Runner (compute), RDS Postgres 17 (database), and S3 (file storage). This guide uses the AWS CLI and produces a single-instance App Runner service with a managed HTTPS endpoint and custom domain. There is no ALB, no cluster, and no certificate to request.

## Limitations

App Runner has no persistent disk and no EFS support. Read this section before choosing it over the [ECS Fargate guide](aws-ecs.md):

- **`/paperclip` is ephemeral.** Anything written to the local filesystem is lost on every deployment, restart, or scale event. That includes agent workspaces, checked-out repositories, and local agent state. Agents can still run, but every run starts from a clean filesystem. Choose ECS Fargate if agents need long-lived working directories.
- **Local database backups are ephemeral.** Paperclip writes its automatic database backups under `/paperclip`, so each deployment or restart discards them. Rely on the RDS automated backups (7-day retention in this guide) as your backup history.
- **Updates briefly run two instances.** App Runner starts the new instance before it drains the old one. Both share the same database and scheduler for a short time during each deployment. If that is not acceptable, use the [EKS guide](aws-eks.md), which stops the old pod before it starts the new one.
- **Uploaded files go to S3.** This guide sets `PAPERCLIP_STORAGE_PROVIDER=s3` so attachments survive deployments.
- **The secrets master key must be supplied.** By default Paperclip generates its encryption key on disk, which would be regenerated on each deploy and orphan every stored secret. This guide sets `PAPERCLIP_SECRETS_MASTER_KEY` from Secrets Manager instead.
- **Outbound traffic only reaches RDS through a VPC connector.** Inbound traffic is always public HTTPS.
- **One instance only.** Paperclip is a single-instance control plane, so the auto scaling configuration is pinned to min 1, max 1. App Runner has no scale-to-zero, but you can pause the service (see Scaling to Zero).

## Prerequisites

- AWS CLI v2 configured with a profile that has admin-level permissions
- Docker installed locally (for building and pushing the image)
- A registered domain with DNS you control (for the custom domain)
- The Paperclip repo cloned locally

Set these shell variables for the rest of the guide:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PAPERCLIP_DOMAIN=paperclip.example.com   # your domain
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
export AUTH_SECRET=$(openssl rand -base64 32)
export MASTER_KEY=$(openssl rand -base64 32)
export BUCKET_NAME=paperclip-storage-$AWS_ACCOUNT_ID
```

## 1. Create ECR Repository

```bash
aws ecr create-repository \
  --repository-name paperclip-server \
  --image-scanning-configuration scanOnPush=true \
  --region $AWS_REGION
```

## 2. Build and Push Docker Image

```bash
cd /path/to/paperclip

# Authenticate Docker to ECR
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Build
docker build -t paperclip-server .

# Tag and push
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest
```

## 3. Networking (VPC, Subnets, Security Groups)

Use the default VPC or create a dedicated one. The guide assumes the default VPC. A VPC connector gives the service private IPs only, so its subnets must be private and route outbound traffic through a NAT Gateway. Without that, Paperclip can reach RDS but cannot call model APIs or GitHub.

```bash
# Get default VPC
VPC_ID=$(aws ec2 describe-vpcs \
  --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)

# Get two AZs and one public subnet (for the NAT Gateway)
AZ_1=$(aws ec2 describe-availability-zones \
  --query 'AvailabilityZones[0].ZoneName' --output text)
AZ_2=$(aws ec2 describe-availability-zones \
  --query 'AvailabilityZones[1].ZoneName' --output text)
PUBLIC_SUBNET=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID Name=availability-zone,Values=$AZ_1 \
  --query 'Subnets[0].SubnetId' --output text)

# Pick two unused /24 ranges for the private subnets. The default VPC's
# subnets stop at 172.31.95.255, so these are free unless you added subnets.
PRIVATE_CIDR_1=172.31.100.0/24
PRIVATE_CIDR_2=172.31.101.0/24

# Check that no existing subnet already uses them (this must print nothing)
aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query "Subnets[?CidrBlock=='$PRIVATE_CIDR_1' || CidrBlock=='$PRIVATE_CIDR_2'].[SubnetId,CidrBlock]" \
  --output text

# List all subnet ranges if you need to choose different ones
aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[].CidrBlock' --output text

# Create two private subnets
SUBNET_1=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --availability-zone $AZ_1 --cidr-block $PRIVATE_CIDR_1 \
  --query 'Subnet.SubnetId' --output text)
SUBNET_2=$(aws ec2 create-subnet \
  --vpc-id $VPC_ID --availability-zone $AZ_2 --cidr-block $PRIVATE_CIDR_2 \
  --query 'Subnet.SubnetId' --output text)

# Stop here if either subnet was not created
echo "$SUBNET_1 $SUBNET_2"

# NAT Gateway in the public subnet
EIP_ALLOC=$(aws ec2 allocate-address --domain vpc \
  --query 'AllocationId' --output text)
NAT_ID=$(aws ec2 create-nat-gateway \
  --subnet-id $PUBLIC_SUBNET --allocation-id $EIP_ALLOC \
  --query 'NatGateway.NatGatewayId' --output text)
aws ec2 wait nat-gateway-available --nat-gateway-ids $NAT_ID

# Route the private subnets through the NAT Gateway
PRIVATE_RT=$(aws ec2 create-route-table --vpc-id $VPC_ID \
  --query 'RouteTable.RouteTableId' --output text)
aws ec2 create-route \
  --route-table-id $PRIVATE_RT \
  --destination-cidr-block 0.0.0.0/0 \
  --nat-gateway-id $NAT_ID
for SUBNET in $SUBNET_1 $SUBNET_2; do
  aws ec2 associate-route-table --route-table-id $PRIVATE_RT --subnet-id $SUBNET
done
```

Create security groups:

```bash
# App Runner VPC connector security group — outbound only
CONNECTOR_SG=$(aws ec2 create-security-group \
  --group-name paperclip-apprunner \
  --description "Paperclip App Runner VPC connector" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

# RDS security group — inbound from the connector only
RDS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-rds \
  --description "Paperclip RDS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --protocol tcp --port 5432 \
  --source-group $CONNECTOR_SG
```

## 4. Create RDS Postgres Instance

```bash
# Create a DB subnet group that spans our two subnets so RDS can place the instance.
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

# Wait for it to become available (takes 5-10 min)
aws rds wait db-instance-available \
  --db-instance-identifier paperclip-db

# Get the endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances \
  --db-instance-identifier paperclip-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)

# RDS Postgres 15+ rejects unencrypted connections by default
# (rds.force_ssl=1), so the URL must request TLS.
DATABASE_URL="postgresql://paperclip:${DB_PASSWORD}@${RDS_ENDPOINT}:5432/paperclip?sslmode=require"
```

## 5. Create S3 Bucket

```bash
# us-east-1 must not pass a LocationConstraint
aws s3api create-bucket \
  --bucket $BUCKET_NAME \
  --region $AWS_REGION

aws s3api put-public-access-block \
  --bucket $BUCKET_NAME \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket $BUCKET_NAME \
  --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

> **Note:** In any region other than `us-east-1`, add `--create-bucket-configuration LocationConstraint=$AWS_REGION` to `create-bucket`.

## 6. Store Secrets

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
  --name paperclip/secrets-master-key \
  --secret-string "$MASTER_KEY"

aws secretsmanager create-secret \
  --name paperclip/openai-api-key \
  --secret-string "YOUR_OPENAI_KEY"

aws secretsmanager create-secret \
  --name paperclip/github-token \
  --secret-string "YOUR_GITHUB_PAT"
```

> **Warning:** Back up `paperclip/secrets-master-key`. If it is lost, every secret stored in Paperclip becomes unreadable.

> **Note:** Codex agents need `OPENAI_API_KEY` bound per agent under **Agents → (agent) → Secrets & variables**. The server-level variable is not used, and a Codex run without a per-agent key fails with `configuration_incomplete`.

## 7. IAM Roles

App Runner uses two roles: an access role (pulls the image from ECR) and an instance role (application permissions at runtime, including reading secrets and writing to S3).

```bash
# Access role — lets App Runner pull from ECR
aws iam create-role \
  --role-name paperclip-apprunner-access \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "build.apprunner.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy \
  --role-name paperclip-apprunner-access \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess

# Instance role — application permissions
aws iam create-role \
  --role-name paperclip-apprunner-instance \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "tasks.apprunner.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Allow reading secrets
aws iam put-role-policy \
  --role-name paperclip-apprunner-instance \
  --policy-name SecretsAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:'$AWS_REGION':'$AWS_ACCOUNT_ID':secret:paperclip/*"
    }]
  }'

# Allow reading and writing the storage bucket
aws iam put-role-policy \
  --role-name paperclip-apprunner-instance \
  --policy-name StorageAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::'$BUCKET_NAME'/*"
      },
      {
        "Effect": "Allow",
        "Action": ["s3:ListBucket"],
        "Resource": "arn:aws:s3:::'$BUCKET_NAME'"
      }
    ]
  }'
```

## 8. VPC Connector and Auto Scaling

The VPC connector gives the service outbound access to RDS. Once a service uses a VPC connector, all of its outbound traffic goes through your VPC, so the private subnets from step 3 (with their NAT route) also carry calls to model APIs and GitHub.

```bash
VPC_CONNECTOR_ARN=$(aws apprunner create-vpc-connector \
  --vpc-connector-name paperclip-connector \
  --subnets $SUBNET_1 $SUBNET_2 \
  --security-groups $CONNECTOR_SG \
  --query 'VpcConnector.VpcConnectorArn' --output text)

# Pin to a single instance
ASC_ARN=$(aws apprunner create-auto-scaling-configuration \
  --auto-scaling-configuration-name paperclip-single \
  --min-size 1 \
  --max-size 1 \
  --query 'AutoScalingConfiguration.AutoScalingConfigurationArn' --output text)
```

## 9. Create App Runner Service

Create the service from the template at `docker/apprunner-service.json`. Before creating it, replace the placeholder values:

```bash
# App Runner needs each secret's full ARN, including the random suffix
# Secrets Manager appends to the name. A partial ARN fails at deploy time.
secret_arn() {
  aws secretsmanager describe-secret \
    --secret-id paperclip/$1 --query ARN --output text
}

sed -e "s|<ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" \
    -e "s|<REGION>|$AWS_REGION|g" \
    -e "s|<DOMAIN>|$PAPERCLIP_DOMAIN|g" \
    -e "s|<BUCKET_NAME>|$BUCKET_NAME|g" \
    -e "s|<VPC_CONNECTOR_ARN>|$VPC_CONNECTOR_ARN|g" \
    -e "s|<ASC_ARN>|$ASC_ARN|g" \
    -e "s|<DATABASE_URL_SECRET_ARN>|$(secret_arn database-url)|g" \
    -e "s|<BETTER_AUTH_SECRET_ARN>|$(secret_arn better-auth-secret)|g" \
    -e "s|<SECRETS_MASTER_KEY_ARN>|$(secret_arn secrets-master-key)|g" \
    -e "s|<ANTHROPIC_API_KEY_SECRET_ARN>|$(secret_arn anthropic-api-key)|g" \
    -e "s|<OPENAI_API_KEY_SECRET_ARN>|$(secret_arn openai-api-key)|g" \
    -e "s|<GITHUB_TOKEN_SECRET_ARN>|$(secret_arn github-token)|g" \
    docker/apprunner-service.json > /tmp/paperclip-apprunner.json

SERVICE_ARN=$(aws apprunner create-service \
  --cli-input-json file:///tmp/paperclip-apprunner.json \
  --query 'Service.ServiceArn' --output text)

# Wait for the service to reach RUNNING (takes 5-10 min)
aws apprunner describe-service \
  --service-arn $SERVICE_ARN \
  --query 'Service.{status:Status,url:ServiceUrl}'
```

> **Note:** `PAPERCLIP_PUBLIC_URL` points at your custom domain, which you attach in the next step. Until DNS is in place, the default `*.awsapprunner.com` URL will load but sign-in redirects will target the custom domain.

## 10. Custom Domain and TLS

App Runner provisions and renews the certificate for you. Associate the domain, then add the DNS records it returns:

```bash
aws apprunner associate-custom-domain \
  --service-arn $SERVICE_ARN \
  --domain-name $PAPERCLIP_DOMAIN \
  --no-enable-www-subdomain

# Shows the certificate validation CNAMEs and the target for your domain
aws apprunner describe-custom-domains \
  --service-arn $SERVICE_ARN \
  --query '{target:DNSTarget,records:CustomDomains[0].CertificateValidationRecords}'
```

Add the DNS records to your DNS provider:
- Create the certificate validation CNAME records returned above
- Create a CNAME or ALIAS record for `$PAPERCLIP_DOMAIN` -> `DNSTarget`

Wait for the domain to become active (takes a few minutes after DNS propagates):

```bash
aws apprunner describe-custom-domains \
  --service-arn $SERVICE_ARN \
  --query 'CustomDomains[0].Status'
```

## 11. Verify Deployment

```bash
# Watch the service come up
aws apprunner describe-service \
  --service-arn $SERVICE_ARN \
  --query 'Service.{status:Status,url:ServiceUrl}'

# Check logs (App Runner creates the log groups automatically)
SERVICE_ID=$(echo $SERVICE_ARN | awk -F/ '{print $3}')
aws logs tail /aws/apprunner/paperclip-server/$SERVICE_ID/application --since 10m --follow

# Hit the health endpoint
curl -sf https://$PAPERCLIP_DOMAIN/api/health
```

**Healthy indicators:**
- Service status: `RUNNING`
- Logs show `plugin job coordinator started` and `plugin-loader: loadAll complete`
- `/api/health` returns 200

## Create the First Admin

A fresh public instance stays in `bootstrap_pending` until the first admin exists. In `authenticated` + `public` mode, the browser cannot claim admin. You must create a one-time bootstrap invite with the CLI and open it in your browser.

App Runner has no shell access to the running service, so run the CLI in a one-off container on an EC2 host in the same VPC. The host needs Docker, outbound internet access, and permission to pull from ECR. Allow that host into the RDS security group first:

```bash
aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --protocol tcp --port 5432 \
  --source-group <SECURITY_GROUP_OF_THAT_HOST>
```

On the EC2 host, with the same shell variables set, start the setup wizard in a throwaway container:

```bash
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin \
    $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

docker run --rm -it \
  -e DATABASE_URL="$DATABASE_URL" \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=public \
  -e PAPERCLIP_PUBLIC_URL="https://$PAPERCLIP_DOMAIN" \
  -e HEARTBEAT_SCHEDULER_ENABLED=false \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest \
  node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts onboard
```

> **Note:** This runs the `paperclipai` CLI that ships inside the Paperclip image, so its version always matches the server and nothing is downloaded from npm. Do not replace it with `npx paperclipai`, which fetches whatever version is newest and runs it with your production database credentials.

Choose **Quickstart**. The wizard reads the environment above, writes a config inside the throwaway container, and prints a bootstrap invite URL. When it asks **Start Paperclip now?**, use the arrow keys to select **No**, then press Enter. The default is **Yes**, so pressing Enter starts a second server against the same database. If that happens, stop the container with `Ctrl+C` right away. `HEARTBEAT_SCHEDULER_ENABLED=false` stops that server from waking agents, but it still runs other background work, such as execution-status sweeps and database backups. On a fresh instance there are no companies or agents yet, so this work has nothing to act on.

> **Note:** `paperclipai auth bootstrap-ceo` alone does not work here. It needs a config file, and the App Runner service is configured through environment variables only.

Open the invite URL, sign up, and accept the invite. That account becomes the first instance admin. Remove the temporary RDS security group rule afterwards.

## Post-Deploy Security Hardening

After the first admin has accepted the bootstrap invite, lock down the instance:

```bash
# Disable public sign-up (prevents unauthorized users from creating accounts).
# Add PAPERCLIP_AUTH_DISABLE_SIGN_UP to RuntimeEnvironmentVariables in
# /tmp/paperclip-apprunner.json:
#   "PAPERCLIP_AUTH_DISABLE_SIGN_UP": "true"
# then apply it to the running service:
aws apprunner update-service \
  --service-arn $SERVICE_ARN \
  --source-configuration "$(jq -c .SourceConfiguration /tmp/paperclip-apprunner.json)"
```

Use the invite flow (added in v2026.416.0) to grant access to additional users after sign-up is disabled.

## Deploying Updates

Build, push, and start a new deployment:

```bash
# Build and push new image
docker build -t paperclip-server .
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest
docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

# Roll out
aws apprunner start-deployment --service-arn $SERVICE_ARN

# Watch the deployment
aws apprunner list-operations \
  --service-arn $SERVICE_ARN \
  --max-results 3 \
  --query 'OperationSummaryList[*].{type:Type,status:Status,started:StartedAt}'
```

App Runner performs a rolling update: starts a new instance, waits for it to pass health checks, then shifts traffic and drains the old instance. For a short time, both instances run the heartbeat scheduler against the same database. Because the local filesystem is ephemeral, nothing on disk carries over. If the overlap is a problem for your workload, use the EKS guide.

## Rollback

If the new deployment is unhealthy:

```bash
# App Runner automatically keeps serving the previous deployment if the
# new one fails its health checks. To roll back manually:

# 1. Push (or re-tag) a known-good image as :latest
aws ecr describe-images \
  --repository-name paperclip-server \
  --query 'sort_by(imageDetails,&imagePushedAt)[-3:].{tags:imageTags,pushed:imagePushedAt}'

# 2. Redeploy
aws apprunner start-deployment --service-arn $SERVICE_ARN
```

To make rollbacks cleaner, tag each build with a unique version (for example the git SHA) and point `ImageIdentifier` at that tag with `aws apprunner update-service`, rather than relying on `:latest`.

## Scaling to Zero (Cost Savings)

App Runner cannot scale to zero, but a paused service stops billing for compute:

```bash
# Stop
aws apprunner pause-service --service-arn $SERVICE_ARN

# Start
aws apprunner resume-service --service-arn $SERVICE_ARN
```

RDS can also be stopped (auto-restarts after 7 days):

```bash
aws rds stop-db-instance --db-instance-identifier paperclip-db
aws rds start-db-instance --db-instance-identifier paperclip-db
```

## Teardown

Remove all resources in reverse order:

```bash
# 1. App Runner service, VPC connector, and auto scaling configuration
aws apprunner disassociate-custom-domain \
  --service-arn $SERVICE_ARN --domain-name $PAPERCLIP_DOMAIN
aws apprunner delete-service --service-arn $SERVICE_ARN
# Deletion is async; wait until the service is gone before removing what it uses
while aws apprunner describe-service --service-arn $SERVICE_ARN >/dev/null 2>&1; do
  sleep 10
done
aws apprunner delete-vpc-connector --vpc-connector-arn $VPC_CONNECTOR_ARN
aws apprunner delete-auto-scaling-configuration --auto-scaling-configuration-arn $ASC_ARN

# 2. RDS (creates final snapshot)
aws rds delete-db-instance \
  --db-instance-identifier paperclip-db \
  --final-db-snapshot-identifier paperclip-db-final
aws rds wait db-instance-deleted --db-instance-identifier paperclip-db
aws rds delete-db-subnet-group --db-subnet-group-name paperclip-db-subnet

# 3. S3 (deletes all uploaded files)
aws s3 rb s3://$BUCKET_NAME --force

# 4. Secrets
for s in database-url anthropic-api-key better-auth-secret secrets-master-key openai-api-key github-token; do
  aws secretsmanager delete-secret --secret-id paperclip/$s --force-delete-without-recovery
done

# 5. Security groups (after all dependents are gone)
for sg in $RDS_SG $CONNECTOR_SG; do
  aws ec2 delete-security-group --group-id $sg
done

# 6. NAT Gateway, route table, and private subnets
aws ec2 delete-nat-gateway --nat-gateway-id $NAT_ID
while [ "$(aws ec2 describe-nat-gateways --nat-gateway-ids $NAT_ID \
  --query 'NatGateways[0].State' --output text)" != "deleted" ]; do
  sleep 10
done
aws ec2 release-address --allocation-id $EIP_ALLOC
# Deleting the subnets also removes their route table associations
for SUBNET in $SUBNET_1 $SUBNET_2; do
  aws ec2 delete-subnet --subnet-id $SUBNET
done
aws ec2 delete-route-table --route-table-id $PRIVATE_RT

# 7. ECR
aws ecr delete-repository --repository-name paperclip-server --force

# 8. IAM roles
aws iam detach-role-policy --role-name paperclip-apprunner-access \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess
aws iam delete-role --role-name paperclip-apprunner-access
aws iam delete-role-policy --role-name paperclip-apprunner-instance --policy-name SecretsAccess
aws iam delete-role-policy --role-name paperclip-apprunner-instance --policy-name StorageAccess
aws iam delete-role --role-name paperclip-apprunner-instance

# 9. Log groups (App Runner does not delete them with the service).
# Scope the prefix to this service ID so other services' logs are kept.
SERVICE_ID=${SERVICE_ARN##*/}
for g in $(aws logs describe-log-groups \
  --log-group-name-prefix /aws/apprunner/paperclip-server/$SERVICE_ID/ \
  --query 'logGroups[].logGroupName' --output text); do
  aws logs delete-log-group --log-group-name $g
done
```

## Cost Reference

| Service | Config | Monthly |
|---------|--------|---------|
| App Runner | 2 vCPU, 4 GB, 1 provisioned instance, 24/7 | ~$90 |
| RDS Postgres | db.t4g.micro, 20 GB | ~$15 |
| NAT Gateway | 1 AZ | ~$35 |
| S3 | 1 GB Standard | ~$0.03 |
| Secrets Manager | 6 secrets | ~$2.50 |
| CloudWatch Logs | ~1 GB/mo | ~$0.50 |
| ECR | ~1 GB | ~$0.10 |
| **Total** | | **~$143/mo** |

App Runner bills memory for the provisioned instance around the clock and vCPU only while it handles requests, so an idle instance costs less than the figure above. Paperclip's heartbeat scheduler keeps the instance active, so plan for the full amount. Pause the service during off-hours to cut compute cost.
