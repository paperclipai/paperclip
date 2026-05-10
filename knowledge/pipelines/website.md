# BCELab Website Development and Operations

## Purpose

Develop, deploy, operate, and improve the BCELab website that publishes report outputs and product-facing pages.

## Current Diagram

```mermaid
flowchart LR
  change_request_intake["Website change request intake"]
  impact_and_scope_review["Impact and scope review"]
  temporary_workspace_implementation["Temporary workspace implementation"]
  pipeline_definition_alignment["Pipeline definition alignment check"]
  quality_and_build_verification["Quality and build verification"]
  board_deployment_approval["Board deployment approval"]
  production_deployment["Production deployment"]
  post_deploy_monitoring["Post-deploy monitoring"]
  change_request_intake --> impact_and_scope_review
  impact_and_scope_review --> temporary_workspace_implementation
  temporary_workspace_implementation --> pipeline_definition_alignment
  pipeline_definition_alignment --> quality_and_build_verification
  quality_and_build_verification --> board_deployment_approval
  board_deployment_approval --> production_deployment
  production_deployment --> post_deploy_monitoring
```

## Operating State

- Cadence: Change-driven development with continuous post-deploy monitoring
- Health: active with local verification complete
- Source repository: `/Users/Kuku/Documents/Claude/Projects/블록체인경제연구소/blockchain-economics-lab`
- Executable manifest: `pipelines/bcelab-runtime-pipelines.json`
- Development mode: temporary workspace or isolated branch first
- Required pre-approval check: `npm run verify:pipeline` confirms the temporary workspace code matches the website pipeline contract before deployment approval
- Required verification: `npm run verify:runtime-pipelines`, `npm run verify:pipeline`, `npm run lint`, `npx tsc --noEmit`, `npm test -- --passWithNoTests`, `npm run build`, and page-level report visibility checks
- Deployment gate: `.github/workflows/production-deploy.yml` requires Paperclip issue evidence, board approval evidence, and the GitHub `production` environment before Vercel `--prod` deployment
- Production surfaces: homepage, score/top-200 pages, project pages, report listing pages, report detail pages, APIs, and scheduled pipeline integrations
- Post-deploy heartbeat: Vercel cron calls `/api/cron/heartbeat`
- CI enforcement: `.github/workflows/ci.yml` runs lint, typecheck, real Jest tests, runtime pipeline manifest verification, website pipeline alignment, and production build
- Preview enforcement: `.github/workflows/deploy-preview.yml` posts a Vercel preview URL on pull requests

## Inputs

- Board requests for website behavior or product changes
- Pipeline incidents, missing report visibility, broken report cards, stale pages, or deployment failures
- Changes required by ECON, MAT, FOR, or future report pipelines
- Monitoring signals from production pages and scheduled jobs

## Outputs

- Reviewed and approved website code changes
- Production deployment with a clear commit and deployment record
- Verified website behavior for affected pages and report types
- Post-deploy monitoring notes and follow-up issues

## Owners

- Pipeline owner: CTO
- Intake and prioritization: CEO
- Impact and scope review: CTO
- Implementation and deployment: FullStackEngineer
- Board deployment approval request: CEO
- Post-deploy monitoring: COO

## Known Risks

- Uncommitted or undeployed code can make local verification diverge from production behavior; website changes must move through PR or the production deploy workflow.
- Report data can exist in storage while website filters, status rules, or cached pages hide it from users.
- A website fix can accidentally change ECON, MAT, and FOR surfaces differently unless all affected report types are checked together by tests or manual verification.
- Deployment must not proceed if `npm run verify:pipeline` fails or if the PR template lacks Paperclip issue and board approval evidence.
- Production cache, scheduled jobs, and database status fields can make successful code changes appear ineffective unless monitored after deployment.
- Vercel project settings must not bypass the approved production deploy path. If automatic production deploys from `main` are enabled outside GitHub Actions, the CTO must treat that as a governance gap and either disable it or document it as an accepted board risk.

## Open Changes

- Website deployment alignment was implemented in the BCE website repository by adding `scripts/verify-website-pipeline.mjs`, a real Jest `npm test` command, a CI alignment job, a production deployment workflow, PR evidence fields, and `/api/cron/heartbeat`.
- Runtime pipeline alignment was implemented by adding `pipelines/bcelab-runtime-pipelines.json`, `scripts/verify-runtime-pipelines.mjs`, CI enforcement, slide cron preflight verification, and production deploy preflight verification.
- TODO: Link the active Paperclip issue and board approval record for the current ECON/MAT/FOR visibility fix before production deployment.

## Update Rule

Agents must update this page when website behavior, deployment rules, owners, dependencies, health, monitoring, or operating rules change.
