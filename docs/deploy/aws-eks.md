---
title: AWS EKS
summary: Deploy Paperclip to AWS using EKS, RDS Postgres, and EFS
---

Deploy Paperclip to AWS with EKS (compute), RDS Postgres 17 (database), and EFS (persistent storage). This guide uses `eksctl`, the AWS CLI, and `kubectl`, and produces a single-replica Deployment behind an ALB with HTTPS. Use this path if you already run Kubernetes; for everyone else, the [ECS Fargate guide](aws-ecs.md) is simpler and cheaper.

## Prerequisites

- AWS CLI v2 configured with a profile that has admin-level permissions
- `eksctl`, `kubectl`, and `helm` installed locally
- Docker installed locally (for building and pushing the image)
- A registered domain with DNS you control (for the TLS certificate)
- The Paperclip repo cloned locally

Set these shell variables for the rest of the guide:

```bash
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export CLUSTER_NAME=paperclip
export PAPERCLIP_DOMAIN=paperclip.example.com   # your domain
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
export AUTH_SECRET=$(openssl rand -base64 32)
export MASTER_KEY=$(openssl rand -base64 32)
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

## 3. Create EKS Cluster

`eksctl` creates a dedicated VPC with public and private subnets in two AZs, a managed node group in the private subnets, and the OIDC provider needed for IAM roles for service accounts (IRSA).

Pick a Kubernetes version that is in standard support. EKS bills extended-support versions at a much higher control-plane rate:

```bash
aws eks describe-cluster-versions \
  --query 'clusterVersions[?versionStatus==`STANDARD_SUPPORT`].clusterVersion' \
  --output text
```

```bash
eksctl create cluster \
  --name $CLUSTER_NAME \
  --region $AWS_REGION \
  --version 1.35 \
  --managed \
  --nodegroup-name paperclip-nodes \
  --node-type t3.large \
  --nodes 2 --nodes-min 1 --nodes-max 3 \
  --node-private-networking \
  --with-oidc

# Takes 15-20 min. Confirm kubectl is pointed at the new cluster
kubectl get nodes
```

> **Note:** Agents run inside the Paperclip container, so size nodes for the agent workload, not just the server. `t3.large` (2 vCPU, 8 GB) fits one server pod with room to spare.

## 4. Networking (VPC, Subnets, Security Groups)

Look up the VPC that `eksctl` created and the cluster security group that the nodes (and therefore pods) use:

```bash
VPC_ID=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --query 'cluster.resourcesVpcConfig.vpcId' --output text)

CLUSTER_SG=$(aws eks describe-cluster \
  --name $CLUSTER_NAME \
  --query 'cluster.resourcesVpcConfig.clusterSecurityGroupId' --output text)

# Get two private subnets (for RDS and EFS)
SUBNET_IDS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[?MapPublicIpOnLaunch==`false`] | [0:2].SubnetId' \
  --output text)
SUBNET_1=$(echo $SUBNET_IDS | awk '{print $1}')
SUBNET_2=$(echo $SUBNET_IDS | awk '{print $2}')
```

Create security groups. The ALB is created by the AWS Load Balancer Controller in step 8, which manages its own security groups, so only RDS and EFS need one here:

```bash
# RDS security group — inbound from the cluster only
RDS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-rds \
  --description "Paperclip RDS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $RDS_SG \
  --protocol tcp --port 5432 \
  --source-group $CLUSTER_SG

# EFS security group — inbound NFS from the cluster only
EFS_SG=$(aws ec2 create-security-group \
  --group-name paperclip-efs \
  --description "Paperclip EFS" \
  --vpc-id $VPC_ID \
  --query 'GroupId' --output text)

aws ec2 authorize-security-group-ingress \
  --group-id $EFS_SG \
  --protocol tcp --port 2049 \
  --source-group $CLUSTER_SG
```

## 5. Create RDS Postgres Instance

```bash
# The cluster VPC doesn't come with a DB subnet group — create one
# that spans our two private subnets so RDS can place the instance.
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

## 6. Create EFS Filesystem

```bash
EFS_ID=$(aws efs create-file-system \
  --performance-mode generalPurpose \
  --throughput-mode bursting \
  --encrypted \
  --tags Key=Name,Value=paperclip-data \
  --query 'FileSystemId' --output text)

# Wait until the file system is available before adding mount targets
until [ "$(aws efs describe-file-systems --file-system-id $EFS_ID \
  --query 'FileSystems[0].LifeCycleState' --output text)" = "available" ]; do
  sleep 5
done

# Create a mount target in every private subnet. Nodes can run in any
# of them, and a pod cannot mount EFS in an AZ without a mount target.
PRIVATE_SUBNETS=$(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values=$VPC_ID \
  --query 'Subnets[?MapPublicIpOnLaunch==`false`].SubnetId' \
  --output text)
for SUBNET in $PRIVATE_SUBNETS; do
  aws efs create-mount-target \
    --file-system-id $EFS_ID \
    --subnet-id $SUBNET \
    --security-groups $EFS_SG
done

# Wait for mount targets
aws efs describe-mount-targets --file-system-id $EFS_ID \
  --query 'MountTargets[].[AvailabilityZoneName,LifeCycleState]' --output text
```

> **Note:** `eksctl` creates private subnets in up to three AZs. If a mount target is missing in a node's AZ, the pod stays in `ContainerCreating` with `Failed to resolve "fs-....efs.<region>.amazonaws.com"`.

Install the EFS CSI driver as an EKS add-on, with an IAM role for its service account:

```bash
eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME \
  --namespace kube-system \
  --name efs-csi-controller-sa \
  --role-name paperclip-efs-csi \
  --attach-policy-arn arn:aws:iam::aws:policy/service-role/AmazonEFSCSIDriverPolicy \
  --role-only \
  --approve

eksctl create addon \
  --cluster $CLUSTER_NAME \
  --name aws-efs-csi-driver \
  --service-account-role-arn arn:aws:iam::$AWS_ACCOUNT_ID:role/paperclip-efs-csi
```

## 7. Namespace, Storage, and Secrets

```bash
kubectl create namespace paperclip
```

Create a StorageClass and PersistentVolumeClaim from the template at `docker/eks/storage.yaml`. The `efs-ap` provisioning mode creates an EFS access point that forces UID/GID 1000, matching the `node` user in the Paperclip image:

```bash
sed -e "s|<EFS_ID>|$EFS_ID|g" \
    docker/eks/storage.yaml | kubectl apply -f -
```

Store secrets as a Kubernetes Secret:

```bash
kubectl create secret generic paperclip-secrets \
  --namespace paperclip \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  --from-literal=BETTER_AUTH_SECRET="$AUTH_SECRET" \
  --from-literal=PAPERCLIP_SECRETS_MASTER_KEY="$MASTER_KEY" \
  --from-literal=ANTHROPIC_API_KEY="YOUR_ANTHROPIC_KEY" \
  --from-literal=OPENAI_API_KEY="YOUR_OPENAI_KEY" \
  --from-literal=GITHUB_TOKEN="YOUR_GITHUB_PAT"
```

> **Warning:** Back up `$MASTER_KEY` outside the cluster (for example in a password manager or AWS Secrets Manager). Paperclip encrypts stored secrets with this key. If you restore the RDS database without the original key, every secret stored in Paperclip becomes unreadable. Supplying the key here, instead of letting Paperclip generate one on the EFS volume, keeps it separate from the data it protects.

> **Note:** Kubernetes Secrets are only base64-encoded. Enable [envelope encryption with a KMS key](https://docs.aws.amazon.com/eks/latest/userguide/enable-kms.html) on the cluster, or sync from AWS Secrets Manager with the External Secrets Operator, if that matters for your environment.

> **Note:** Codex agents need `OPENAI_API_KEY` bound per agent under **Agents → (agent) → Secrets & variables**. The server-level variable is not used, and a Codex run without a per-agent key fails with `configuration_incomplete`.

## 8. AWS Load Balancer Controller

The controller turns a Kubernetes Ingress into an ALB. Its IAM policy and Helm chart come from public sources, so pin both to one released version and verify them before you use them. The values below are for controller v3.5.0 (chart 3.5.0):

```bash
# Pin the controller release. The policy is fetched by commit, which
# cannot change, rather than by branch or tag.
ALB_CONTROLLER_COMMIT=11eb202c97e4ae2ee45e0658c4cde9a4b59f33d4   # v3.5.0
ALB_CHART_VERSION=3.5.0
ALB_POLICY_SHA256=16f232c9d9f79366fe949c4550ad517a202380058a9e48d45a4e215044a20a6a
ALB_CHART_SHA256=45051f634b33e10baccb3354d0681b7de787c60445e599fa276e0c9aedd4ccd5

# Download the IAM policy. It is created only if its checksum matches.
curl -fsSL -o /tmp/alb-iam-policy.json \
  https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/$ALB_CONTROLLER_COMMIT/docs/install/iam_policy.json

echo "$ALB_POLICY_SHA256  /tmp/alb-iam-policy.json" | sha256sum -c - \
  && aws iam create-policy \
       --policy-name PaperclipALBControllerPolicy \
       --policy-document file:///tmp/alb-iam-policy.json

eksctl create iamserviceaccount \
  --cluster $CLUSTER_NAME \
  --namespace kube-system \
  --name aws-load-balancer-controller \
  --attach-policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/PaperclipALBControllerPolicy \
  --approve

# Download the pinned chart. That exact file is installed only if its
# checksum matches.
helm repo add eks https://aws.github.io/eks-charts
helm repo update
helm pull eks/aws-load-balancer-controller --version $ALB_CHART_VERSION --destination /tmp

echo "$ALB_CHART_SHA256  /tmp/aws-load-balancer-controller-$ALB_CHART_VERSION.tgz" | sha256sum -c - \
  && helm install aws-load-balancer-controller \
       /tmp/aws-load-balancer-controller-$ALB_CHART_VERSION.tgz \
       --namespace kube-system \
       --set clusterName=$CLUSTER_NAME \
       --set serviceAccount.create=false \
       --set serviceAccount.name=aws-load-balancer-controller \
       --set region=$AWS_REGION \
       --set vpcId=$VPC_ID

kubectl rollout status deployment/aws-load-balancer-controller -n kube-system
```

> **Note:** Each `sha256sum -c` check guards the command chained after it with `&&`. If a check prints `FAILED`, the policy is not created or the chart is not installed. Stop and find out why before you continue. On macOS, use `shasum -a 256 -c -` instead of `sha256sum -c -`.

> **Note:** To move to a newer controller release, update all four values together. Take the release commit from the [controller releases](https://github.com/kubernetes-sigs/aws-load-balancer-controller/releases), the chart version whose `appVersion` matches that release, and the chart digest from `https://aws.github.io/eks-charts/index.yaml`. Compute the policy hash from the file at that commit, and review the policy before you create it.

## 9. TLS Certificate

Request a certificate (you must validate via DNS):

```bash
CERT_ARN=$(aws acm request-certificate \
  --domain-name $PAPERCLIP_DOMAIN \
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

## 10. Deploy Paperclip

Apply the Deployment and Service from the template at `docker/eks/deployment.yaml`. It uses the same environment as the ECS task definition. It runs one replica with the `Recreate` strategy: Paperclip is a single-instance control plane (one heartbeat scheduler, one local workspace), so the old pod must stop before the new one starts.

```bash
sed -e "s|<ACCOUNT_ID>|$AWS_ACCOUNT_ID|g" \
    -e "s|<REGION>|$AWS_REGION|g" \
    -e "s|<DOMAIN>|$PAPERCLIP_DOMAIN|g" \
    docker/eks/deployment.yaml | kubectl apply -f -
```

> **Note:** Do not add `command:` to the container. It replaces the image's `ENTRYPOINT` and removes `tini` as PID 1, so orphaned agent processes are never reaped. Use `args:` if you need to change the server command.

## 11. Ingress (ALB)

Apply the Ingress from the template at `docker/eks/ingress.yaml`:

```bash
sed -e "s|<CERT_ARN>|$CERT_ARN|g" \
    -e "s|<DOMAIN>|$PAPERCLIP_DOMAIN|g" \
    docker/eks/ingress.yaml | kubectl apply -f -

# Wait for the ALB address (takes 2-3 min)
ALB_DNS=$(kubectl get ingress paperclip-server -n paperclip \
  -o jsonpath='{.status.loadBalancer.ingress[0].hostname}')
echo $ALB_DNS
```

Point your DNS to the ALB:
- Create a CNAME or ALIAS record for `$PAPERCLIP_DOMAIN` -> `$ALB_DNS`

## 12. Verify Deployment

```bash
# Watch the pod come up
kubectl get pods -n paperclip -w

# Check rollout and pod health
kubectl rollout status deployment/paperclip-server -n paperclip
kubectl describe pod -n paperclip -l app=paperclip-server

# Check logs
kubectl logs -n paperclip deployment/paperclip-server --since=10m -f

# Hit the health endpoint
curl -sf https://$PAPERCLIP_DOMAIN/api/health
```

**Healthy indicators:**
- Pod status: `Running`, `1/1` ready
- Logs show `plugin job coordinator started` and `plugin-loader: loadAll complete`
- `/api/health` returns 200

## Create the First Admin

A fresh public instance stays in `bootstrap_pending` until the first admin exists. In `authenticated` + `public` mode, the browser cannot claim admin. You must create a one-time bootstrap invite with the CLI and open it in your browser.

Run the setup wizard in a throwaway pod. It has no volume, so it does not touch the server's `/paperclip` data on EFS. It reads `DATABASE_URL` from `paperclip-secrets`, so the RDS password does not appear in the Pod spec:

```bash
IMAGE=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:latest

kubectl run paperclip-bootstrap -n paperclip --rm -it --restart=Never \
  --image=$IMAGE \
  --overrides='{
    "spec": {
      "containers": [{
        "name": "paperclip-bootstrap",
        "image": "'$IMAGE'",
        "args": ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "cli/src/index.ts", "onboard"],
        "stdin": true,
        "tty": true,
        "envFrom": [{"secretRef": {"name": "paperclip-secrets"}}],
        "env": [
          {"name": "PAPERCLIP_DEPLOYMENT_MODE", "value": "authenticated"},
          {"name": "PAPERCLIP_DEPLOYMENT_EXPOSURE", "value": "public"},
          {"name": "PAPERCLIP_PUBLIC_URL", "value": "https://'$PAPERCLIP_DOMAIN'"},
          {"name": "HEARTBEAT_SCHEDULER_ENABLED", "value": "false"}
        ]
      }]
    }
  }'
```

> **Note:** This runs the `paperclipai` CLI that ships inside the Paperclip image, so its version always matches the server and nothing is downloaded from npm. Do not replace it with `npx paperclipai`, which fetches whatever version is newest and runs it with your production database credentials.

Choose **Quickstart**. The wizard reads the environment above, writes a config inside the throwaway pod, and prints a bootstrap invite URL. When it asks **Start Paperclip now?**, use the arrow keys to select **No**, then press Enter. The default is **Yes**, so pressing Enter starts a second server against the same database. If that happens, stop the container with `Ctrl+C` right away. `HEARTBEAT_SCHEDULER_ENABLED=false` stops that server from waking agents, but it still runs other background work, such as execution-status sweeps and database backups. On a fresh instance there are no companies or agents yet, so this work has nothing to act on.

> **Note:** `paperclipai auth bootstrap-ceo` alone does not work here. It needs a config file, and the Deployment is configured through environment variables only.

Open the invite URL, sign up, and accept the invite. That account becomes the first instance admin.

## Post-Deploy Security Hardening

After the first admin has accepted the bootstrap invite, lock down the instance:

```bash
# Disable public sign-up (prevents unauthorized users from creating accounts).
# Setting the env var triggers a new rollout.
kubectl set env deployment/paperclip-server -n paperclip \
  PAPERCLIP_AUTH_DISABLE_SIGN_UP=true
```

Use the invite flow (added in v2026.416.0) to grant access to additional users after sign-up is disabled.

## Deploying Updates

Build, push, and roll out a new image. Tag with a unique version rather than relying on `:latest`, so Kubernetes sees the change and rollbacks have something to return to:

```bash
VERSION=$(git rev-parse --short HEAD)

# Build and push new image
docker build -t paperclip-server .
docker tag paperclip-server:latest \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:$VERSION
docker push \
  $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:$VERSION

# Roll out
kubectl set image deployment/paperclip-server -n paperclip \
  paperclip-server=$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/paperclip-server:$VERSION

# Watch the deployment
kubectl rollout status deployment/paperclip-server -n paperclip
```

Because the strategy is `Recreate`, the old pod stops before the new one starts, so expect a short outage during each rollout. Database migrations apply automatically on startup (`PAPERCLIP_MIGRATION_AUTO_APPLY`).

## Rollback

If the new deployment is unhealthy:

```bash
# Kubernetes keeps the previous ReplicaSets. To roll back:

# 1. See the revision history
kubectl rollout history deployment/paperclip-server -n paperclip

# 2. Roll back to the previous revision (or add --to-revision=<N>)
kubectl rollout undo deployment/paperclip-server -n paperclip
```

Unlike ECS, there is no circuit breaker. With `Recreate`, a bad image means downtime until you run the rollback, so watch `kubectl rollout status` after every update.

## Scaling to Zero (Cost Savings)

Scale down when not in use:

```bash
# Stop the pod
kubectl scale deployment/paperclip-server -n paperclip --replicas=0

# Stop paying for nodes too (the EKS control plane keeps billing)
eksctl scale nodegroup \
  --cluster $CLUSTER_NAME \
  --name paperclip-nodes \
  --nodes 0 --nodes-min 0

# Start
eksctl scale nodegroup \
  --cluster $CLUSTER_NAME \
  --name paperclip-nodes \
  --nodes 2 --nodes-min 1
kubectl scale deployment/paperclip-server -n paperclip --replicas=1
```

RDS can also be stopped (auto-restarts after 7 days):

```bash
aws rds stop-db-instance --db-instance-identifier paperclip-db
aws rds start-db-instance --db-instance-identifier paperclip-db
```

## Teardown

Remove all resources in reverse order:

```bash
# 1. Kubernetes resources (deleting the Ingress removes the ALB)
kubectl delete namespace paperclip
kubectl delete storageclass paperclip-efs
helm uninstall aws-load-balancer-controller -n kube-system

# 2. RDS (creates final snapshot)
aws rds delete-db-instance \
  --db-instance-identifier paperclip-db \
  --final-db-snapshot-identifier paperclip-db-final
aws rds wait db-instance-deleted --db-instance-identifier paperclip-db
aws rds delete-db-subnet-group --db-subnet-group-name paperclip-db-subnet

# 3. EFS (mount targets must be deleted first)
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

# 4. Security groups (after all dependents are gone)
for sg in $EFS_SG $RDS_SG; do
  aws ec2 delete-security-group --group-id $sg
done

# 5. EKS cluster (also deletes the VPC, node group, and IAM service accounts)
eksctl delete cluster --name $CLUSTER_NAME --region $AWS_REGION

# 6. ACM cert and IAM policy
aws acm delete-certificate --certificate-arn $CERT_ARN
aws iam delete-policy \
  --policy-arn arn:aws:iam::$AWS_ACCOUNT_ID:policy/PaperclipALBControllerPolicy

# 7. ECR
aws ecr delete-repository --repository-name paperclip-server --force
```

## Cost Reference

| Service | Config | Monthly |
|---------|--------|---------|
| EKS control plane | 1 cluster | ~$73 |
| EC2 nodes | 2x t3.large, 24/7 | ~$120 |
| RDS Postgres | db.t4g.micro, 20 GB | ~$15 |
| ALB | 1 LCU average | ~$22 |
| NAT Gateway | 1 AZ (created by `eksctl`) | ~$35 |
| EFS | 1 GB Standard | ~$0.30 |
| CloudWatch Logs | Control plane logs off by default | ~$0 |
| ECR | ~1 GB | ~$0.10 |
| **Total (2 nodes)** | | **~$265/mo** |
| **Total (1 node)** | | **~$205/mo** |

The EKS control plane and NAT Gateway bill even when the node group is scaled to zero. If you don't already run Kubernetes, ECS Fargate is roughly half the cost.
