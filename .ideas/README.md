# Paperclip Improvement Ideas

A running log of original suggestions to improve Paperclip, generated from reviews of the
codebase. Each idea is its own markdown file with three sections:

- **Suggestion** — what to build and why it matters
- **How it could be achieved** — concrete implementation path, grounded in the current code
- **Perceived complexity** — rough effort/risk estimate

## Index

| # | Idea | Complexity |
|---|------|-----------|
| 001 | [Fleet Concurrency Governor](001-fleet-concurrency-governor.md) | Medium–High |
| 002 | [Predictive Budget Circuit Breaker](002-predictive-budget-circuit-breaker.md) | Medium |
| 003 | [Diminishing-Returns Detector](003-diminishing-returns-detector.md) | Medium |
| 004 | [Company Dry-Run Estimator](004-company-dry-run-estimator.md) | Medium–High |
| 005 | [Spend-Schedule / Quiet Hours Profiles](005-spend-schedule-quiet-hours.md) | Low–Medium |
| 006 | [Org Bottleneck Heatmap](006-org-bottleneck-heatmap.md) | Low–Medium |
| 007 | [Holding Company (Meta-Orchestration)](007-holding-company-meta-orchestration.md) | High |
| 008 | [First-Class Local LLM Adapter](008-local-llm-adapter.md) | Low–Medium |
| 009 | [Agent Probation & Staged Trust Ramp](009-agent-probation-trust-ramp.md) | Medium |
| 010 | [Blocker-Graph Deadlock Detector](010-blocker-graph-deadlock-detector.md) | Medium |
| 011 | [Eval-Gated Agent Config Deploys](011-eval-gated-agent-config-deploys.md) | Medium |
| 012 | [Quota-Aware Provider Fallback Chains](012-provider-fallback-chains.md) | Medium |
| 013 | [Unit-Economics Dashboard](013-unit-economics-dashboard.md) | Low–Medium |
| 014 | [Emergency Stop & Drain Mode](014-emergency-stop-drain-mode.md) | Low–Medium |
| 015 | [Company Point-in-Time Rewind](015-company-point-in-time-rewind.md) | Medium–High |
| 016 | [Approval Triage & Policy Batching](016-approval-triage-policy-batching.md) | Medium |
| 017 | [Run Change-Review Surface](017-run-change-review-surface.md) | Medium |
| 018 | [Company Blueprint Library](018-company-blueprint-library.md) | Medium |
| 019 | [Token Budgets for Subscription Users](019-token-budgets-for-subscription-users.md) | Low–Medium |
| 020 | [Outbound Secret-Leak Scanning](020-outbound-secret-leak-scanning.md) | Medium |
| 021 | [Just-in-Time Secret Leasing](021-just-in-time-secret-leasing.md) | Medium |
| 022 | [Per-Agent Network Egress Allow-Listing](022-per-agent-network-egress-allowlist.md) | Medium–High |
| 023 | [Tamper-Evident Audit Log](023-tamper-evident-audit-log.md) | Low–Medium |
| 024 | [Per-Run Resource Caps](024-per-run-resource-caps.md) | Medium |
| 025 | [Capability-Based Auto-Assignment](025-capability-based-auto-assignment.md) | Medium |
| 026 | [Goal-Drift Alignment Auditor](026-goal-drift-alignment-auditor.md) | Medium |
| 027 | [Mobile Push & Fast Approvals](027-mobile-push-and-fast-approvals.md) | Medium |
| 028 | [Agent Shift-Handoff Briefings](028-agent-shift-handoff-briefings.md) | Medium |
| 029 | [Scheduled Operator Digest](029-scheduled-operator-digest.md) | Low–Medium |
| 030 | [Revenue & P&L Tracking](030-revenue-and-pnl-tracking.md) | Medium |
| 031 | [Agent-Run Distributed Tracing](031-agent-run-distributed-tracing.md) | Medium |
| 032 | [A/B Model Bake-Off Harness](032-ab-model-bakeoff-harness.md) | Medium |
| 033 | [Stakeholder Transparency Page](033-stakeholder-transparency-page.md) | Low–Medium |
| 034 | [Data Retention & PII Governance](034-data-retention-pii-governance.md) | Medium |
| 035 | [Adaptive Heartbeat Cadence](035-adaptive-heartbeat-cadence.md) | Medium |
| 036 | [Outbound Webhooks & Event Subscriptions](036-outbound-webhooks-event-subscriptions.md) | Low–Medium |
| 037 | [Prompt-Cache-Aware Context Optimization](037-prompt-cache-aware-context-optimization.md) | Medium |
| 038 | [Approval Delegation & Coverage](038-approval-delegation-coverage.md) | Medium |
| 039 | [Guided Onboarding & Demo Company](039-guided-onboarding-demo-company.md) | Low–Medium |
| 040 | [Operator-Owned Training Dataset](040-operator-owned-training-dataset.md) | Medium |
| 041 | [Host Resource-Aware Local Scheduling](041-host-resource-aware-local-scheduling.md) | Medium |
| 042 | [Workspace Conflict Coordination](042-workspace-conflict-coordination.md) | Medium |
| 043 | [Policy-as-Code Governance Engine](043-policy-as-code-governance-engine.md) | Medium–High |
| 044 | [Agent Reliability SLOs & Error Budgets](044-agent-reliability-slos.md) | Low–Medium |
| 045 | [Plugin Versioning, Rollback & Health](045-plugin-versioning-rollback-health.md) | Medium |
| 046 | [Skill Effectiveness Analytics](046-skill-effectiveness-analytics.md) | Low–Medium |
| 047 | [Role-Based Skill Auto-Provisioning](047-role-based-skill-auto-provisioning.md) | Low–Medium |
| 048 | [Competency-Gated Job Postings (Test-to-Hire)](048-competency-gated-job-postings.md) | Medium–High |
| 049 | [Shared Credential Pooling & Fair-Share Rate Limiting](049-shared-credential-fair-share-rate-limiting.md) | Medium |
| 050 | [Code & Dependency Security Scanning of Work Products](050-work-product-security-scanning.md) | Medium |
| 051 | [Disaster Recovery: Backup Verification & Restore Drills](051-disaster-recovery-backup-verification.md) | Medium |
| 052 | [Org Restructuring Simulator](052-org-restructuring-simulator.md) | Medium |
| 053 | [Inter-Company Shared Services (Agent Lending)](053-inter-company-shared-services.md) | High |
| 054 | [Company Mailbox (Inter-Company Inbox/Outbox & Tickets)](054-company-mailbox.md) | Medium–High |
| 055 | [Estimate-vs-Actual Calibration](055-estimate-vs-actual-calibration.md) | Low–Medium |
| 056 | [Business Experiment Framework](056-business-experiment-framework.md) | Medium |
| 057 | [Incident Management & On-Call](057-incident-management-on-call.md) | Medium |
| 058 | [Work Templates & Definition-of-Done](058-work-templates-definition-of-done.md) | Low–Medium |
| 059 | [Goal Decomposition Quality Assistant](059-goal-decomposition-quality-assistant.md) | Medium |
| 060 | [Knowledge System (Accumulation, Curation & Retrieval)](060-knowledge-system.md) — _merges former 060/065/066_ | Medium–High |
| 061 | [WIP Limits & Flow Control](061-wip-limits-flow-control.md) | Low–Medium |
| 062 | [Inbound Intake Channels (Email/Webhook → Issue)](062-inbound-intake-channels.md) | Medium |
| 063 | [Cost & Capacity Forecasting](063-cost-capacity-forecasting.md) | Medium |
| 064 | [Data Import / Migration from Existing Tools](064-data-import-migration.md) | Medium |
| 065 | [Software-Building Capability & Self-Hosting (Paperclip Builds Paperclip)](065-software-building-and-self-hosting.md) | High |
| 066 | [Built-In Chat Channel (Telegram Bot / WhatsApp) for On-the-Go Operation](066-chat-bot-channel-telegram-whatsapp.md) | Medium |

## Architecture notes (for grounding future ideas)

- Per-agent concurrency already exists: `AGENT_DEFAULT_MAX_CONCURRENT_RUNS = 20`
  (`packages/shared/src/constants.ts`), clamped 1–50 in `server/src/services/heartbeat.ts`.
  There is **no** instance-wide or company-wide cap — slots are counted per agent/heartbeat only.
- Budgets, costs, and burn live in `server/src/services/{budgets,costs,finance}.ts`.
- Watchdogs (`task-watchdogs.ts`) catch stuck/crashed runs but not *unproductive* runs.
- The plugin job scheduler (`plugin-job-scheduler.ts`) already has a `maxConcurrentJobs`
  pattern (default 10) that is a good reference for an admission-control loop.
