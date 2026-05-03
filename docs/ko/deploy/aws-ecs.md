---
title: AWS ECS Fargate
summary: ECS Fargate, RDS Postgres, EFS로 Paperclip 배포
---

# AWS ECS Fargate

이 가이드는 Paperclip을 AWS ECS Fargate에 배포하는 흐름을 요약합니다. 구성 요소는 ECS Fargate(compute), RDS Postgres 17(database), EFS(persistent storage), ALB(HTTPS ingress)입니다.

## Prerequisites

- admin 권한이 있는 AWS CLI v2 profile
- Docker
- DNS를 제어할 수 있는 domain
- 로컬에 clone된 Paperclip repo

기본 변수:

```sh
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export PAPERCLIP_DOMAIN=paperclip.example.com
export DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
export AUTH_SECRET=$(openssl rand -base64 32)
```

## 배포 흐름

1. **ECR repository 생성**
   Docker image를 push할 `paperclip-server` repository를 만듭니다.

2. **Docker image build/push**
   로컬에서 image를 build하고 ECR에 tag/push합니다.

3. **Network 준비**
   VPC, public subnet, ALB security group, ECS task security group, RDS security group, EFS security group을 구성합니다.

4. **RDS Postgres 생성**
   production database로 RDS Postgres 17을 만듭니다.

5. **EFS 생성**
   uploaded assets, local runtime state 등 persistent data를 보관합니다.

6. **ALB + ACM certificate**
   HTTPS endpoint와 domain routing을 설정합니다.

7. **ECS task/service 생성**
   Paperclip container에 `DATABASE_URL`, `PAPERCLIP_HOME`, auth/secrets/storage 관련 env를 주입합니다.

8. **Smoke test**
   `/api/health`, login, company list, agent environment test를 확인합니다.

## 운영 메모

- internet-facing 배포는 `authenticated + public` 모드를 사용합니다.
- public URL과 local bind address가 다르면 `PAPERCLIP_API_URL`을 명시합니다.
- RDS, EFS, secrets key, object storage backup 정책을 별도로 잡아야 합니다.
- Docker image update 후 ECS service rolling deploy를 사용합니다.
