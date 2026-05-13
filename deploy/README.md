# Deploy

Odysseus ships four deploy modes, all single-tenant (privilege isolation): local docker-compose, Kubernetes (Helm), AWS (Terraform), Azure (Terraform).

## Local laptop (docker-compose)

```bash
cp ../.env.example ../.env       # fill in ANTHROPIC_API_KEY + profile-required secrets
export ODYSSEUS_PROFILE=small-firm  # or in-house-dept
docker compose -f deploy/docker-compose.yml up
# UI on http://localhost:3000
```

## Kubernetes (Helm)

`deploy/helm/odysseus/` — chart skeleton. Sprint 3 deliverable. Expects an external Postgres (RDS / Azure DB for Postgres / Cloud SQL) and a secrets backend (Vault / cloud-native secret manager).

## AWS single-tenant (Terraform)

`deploy/terraform/aws/` — sprint 3 deliverable. Provisions:
- ECS Fargate cluster (or EKS) for server + UI.
- RDS PostgreSQL (private subnet, encrypted at rest with KMS).
- S3 bucket for matter artifacts (encrypted, versioned, MFA-delete on production).
- KMS keys for application secrets.
- ALB with WAF.
- One Terraform module = one customer. **Do NOT** parameterize for multi-tenant.

## Azure single-tenant (Terraform)

`deploy/terraform/azure/` — sprint 3 deliverable. Provisions:
- AKS cluster.
- Azure Database for PostgreSQL — Flexible Server.
- Blob storage for artifacts.
- Key Vault for secrets.
- Application Gateway + WAF.

## Why no multi-tenant SaaS in v1

Legal privilege requires hard isolation between matters of different clients/companies. v1 deliberately ships only single-tenant: every customer gets a dedicated database, dedicated storage, dedicated secrets. Multi-tenant SaaS is a v2+ decision.
