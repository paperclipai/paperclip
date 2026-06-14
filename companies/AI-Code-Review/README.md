# AI Code Review Platform

Our AI Code Review Platform is an AI SaaS platform designed to provide intelligent code review and optimization suggestions for software development teams. We focus on enhancing code quality, performance, and security across various programming languages.

## Workflow

Our company operates with a collaborative workflow:
- The Head of Product generates product ideas based on market needs.
- The CEO prioritizes these ideas, ensuring alignment with overall company strategy.
- The CTO oversees the technical implementation, delegating specific tasks to the Lead AI Engineer for AI model development and platform integration.

## Organization Chart

- **CEO** (reports to: N/A)
  - Role: Overall strategic direction, prioritization, and business oversight.
  - Skills: Paperclip (for task coordination)

- **CTO** (reports to: CEO)
  - Role: Leads technical vision, architecture, and oversees implementation.
  - Skills: Paperclip (for task coordination)

- **Head of Product** (reports to: CEO)
  - Role: Identifies market needs, defines product features, and generates ideas.
  - Skills: Paperclip (for task coordination)

- **Lead AI Engineer** (reports to: CTO)
  - Role: Develops and integrates AI models for code review and optimization.
  - Skills: Paperclip (for task coordination)

## Technical Architecture

See [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) for the complete SaaS architecture plan including:
- Service design (API Gateway, Identity, Webhook Ingest, Review Orchestrator, AI Review, Static Analysis, Billing)
- Database model with PostgreSQL 16, Redis caching, read replicas
- REST API contracts with cursor pagination, idempotency, versioning
- Security architecture (WAF, RBAC, encryption, SAST/SCA in CI)
- AI integration with prompt versioning, fallback chains, output validation
- Scalability targets (99.95% uptime, p95 <60s review latency)
- Observability with OpenTelemetry, Prometheus, Grafana, structured logging

## CI/CD

- **CI** — `.github/workflows/ci.yml`: Lint, typecheck, unit tests, security scans (Semgrep/Trivy), integration tests, Docker build & push to ECR
- **CD** — `.github/workflows/deploy.yml`: Helm deploy to staging, canary rollout to production, Slack notification
- **Branch strategy:** `main` → staging, `release/*` → production, `feature/*` → PR

## Deployment

- **Local dev:** `docker compose -f deploy/docker-compose.yml up`
- **Kubernetes:** Helm chart at `deploy/charts/codereview/` with HPA per service
- **Terraform:** Infrastructure at `deploy/terraform/` (VPC, EKS, RDS, Redis)
- **Production:** `bash deploy/scripts/deploy.sh production`

## Billing & Compliance

- **Stripe integration** at `compliance/billing/` with subscription plans and usage metering
- **Immutable audit log** at `compliance/audit/audit-log-schema.sql` (append-only via security definer)
- **GDPR/CCPA** data deletion and export endpoints at `compliance/privacy/`
- **DPA technical controls** at `compliance/terms/` covering sub-processors, data minimization, encryption

## Services

| Service | Port | Tech | Responsibility |
|---|---|---|---|
| API | 3000 | Node.js/Fastify | REST API, auth, results |
| AI Review | 8000 | Python/FastAPI | LLM code review |
| Webhook | 3001 | Node.js/Fastify | Git provider webhooks |

## Getting Started

```bash
# Copy environment config
cp .env.example .env

# Start all services
docker compose -f deploy/docker-compose.yml up

# Run tests
npm test
```

To import this company into Paperclip:
```bash
paperclipai company import --from companies/AI-Code-Review
```
