# External Research Sources (Consolidated Bibliography)

All web + arXiv sources gathered while developing the combinations, grouped by topic. Anchor ids (e.g.
`[finops]`, `[bandits]`) are referenced from wiki pages' `## Provenance` blocks. Captured 2026-06.

## [otel-finops] Cost attribution, observability, FinOps — grounds [[economics-and-finance]], [[cost-attribution]]
- OpenTelemetry GenAI semantic conventions (gen_ai spans, token usage): https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- LLM cost monitoring with OpenTelemetry — Uptrace: https://uptrace.dev/blog/llm-cost-monitoring
- FinOps for AI Overview — FinOps Foundation: https://www.finops.org/wg/finops-for-ai-overview/
- Token Economics & TokenOps — Finout: https://www.finout.io/blog/token-economics-and-tokenops-the-definitive-guide-to-finops-for-tokens
- GPU Cloud FinOps for AI Teams (chargeback/showback) — Spheron: https://www.spheron.network/blog/gpu-cloud-finops-ai-teams-cost-allocation-chargeback-budgeting/

## [zero-trust] Zero-trust / agent identity / least privilege — grounds [[security-governance]], [[trust-as-currency]]
- Zero Trust Architecture for Agentic AI in 2026 — Zentera: https://www.zentera.net/blog/zero-trust-architecture-for-agentic-ai
- Zero Trust for AI Agents: Least Privilege — Zscaler: https://www.zscaler.com/blogs/product-insights/zero-trust-for-ai-agents-least-privilege
- AI Agent Identity & Zero-Trust: 2026 Playbook: https://medium.com/@raktims2210/ai-agent-identity-zero-trust-the-2026-playbook-for-securing-autonomous-systems-in-banks-e545d077fdff
- Announcing Zero Trust for AI — Microsoft Security: https://www.microsoft.com/en-us/security/blog/2026/03/19/new-tools-and-guidance-announcing-zero-trust-for-ai/
- Zero Trust for AI Agents (identity/behavioral) — Cisco: https://blogs.cisco.com/security/security-agentic-ai-how-cisco-brings-zero-trust-to-your-new-digital-workforce

## [guardrails] Unattended/overnight agent guardrails — grounds [[runtime-control-and-safety]], [[night-shift]]
- Agentic AI Guardrails — Aembit: https://aembit.io/blog/agentic-ai-guardrails-for-safe-scaling/
- Complete AI Guardrails Implementation Guide 2026 — Maxim: https://www.getmaxim.ai/articles/the-complete-ai-guardrails-implementation-guide-for-2026/
- AI Agent Risks & Guardrails 2026 — Atlan: https://atlan.com/know/ai-agent-risks-guardrails/
- AI Agents in 2026 — Symphony Solutions: https://symphony-solutions.com/insights/ai-agents-in-2026

## [provenance] Auditability, decision provenance, replay — grounds [[security-governance]], [[provenance-and-replay]]
- Agentic AI Observability: A 2026 Playbook — Arthur: https://www.arthur.ai/column/agentic-ai-observability-playbook-2026
- AI Agent Audit Trails — iSimplifyMe: https://isimplifyme.com/blog/agent-audit-trails
- Reasoning Traces vs Real Audit Trails — Apptitude: https://apptitude.io/blog/ai-agent-accountability-reasoning-traces-audit-trail/
- AI Audit Trail: Compliance & Evidence — Swept AI: https://www.swept.ai/ai-audit-trail
- (EU AI Act Article 12 lifetime event-logging; high-risk deadline 2026-08-02. R-LAM deterministic replay.)

## [self-healing] Self-healing systems / agentic SRE — grounds [[resilience-recovery]], [[self-healing-org]]
- Self-Healing Software Systems — Impala Intech: https://impalaintech.com/blog/self-healing-software-systems/
- AI SRE: Autonomous Agents Slash MTTR 80% — Rootly: https://rootly.com/sre/ai-sre-explained-autonomous-agents-slash-mttr-80
- Agentic SRE / Self-Healing Infrastructure 2026 — Unite.AI: https://www.unite.ai/agentic-sre-how-self-healing-infrastructure-is-redefining-enterprise-aiops-in-2026/
- Self-Healing Systems / Auto-Remediation — Infosys: https://www.infosys.com/iki/techcompass/self-healing-systems.html

## [bandits] Budget allocation / portfolio bandits (arXiv) — grounds [[economics-and-finance]], [[capital-allocator]]
- Risk-Aware Multi-Armed Bandit for Portfolio Selection — arXiv 1709.04415: https://arxiv.org/abs/1709.04415
- Improving Portfolio Optimization with Bandit Networks — arXiv 2410.04217: https://arxiv.org/html/2410.04217v2
- Knapsack-based Optimal Policies for Budget-Limited Bandits — arXiv 1204.1909: https://arxiv.org/pdf/1204.1909
- Multi-Task Combinatorial Bandits for Budget Allocation — arXiv 2409.00561: https://arxiv.org/html/2409.00561v1
- Constrained Optimization with Bandit Feedback (fairness floors) — arXiv 2106.05165: https://arxiv.org/pdf/2106.05165
- Agent Contracts: Resource-Bounded Autonomous AI — arXiv 2601.08815: https://arxiv.org/pdf/2601.08815

## [routing] Ticket triage / skill-based routing (arXiv) — grounds [[external-integration]], [[front-desk]], [[staffing]]
- Cognitive system for human-level helpdesk ticket assignment — arXiv 1808.02636: https://arxiv.org/pdf/1808.02636
- UCB-based routing in skill-based queues (real data) — arXiv 2506.20543: https://arxiv.org/pdf/2506.20543
- TaDaa: real-time ticket assignment deep-learning advisor — arXiv 2207.11187: https://arxiv.org/pdf/2207.11187
- SSR-TA: seq2seq expert recommendation for ticket automation — arXiv 2301.12612: https://arxiv.org/pdf/2301.12612
- Triage in Software Engineering: systematic review — arXiv 2511.08607: https://arxiv.org/html/2511.08607v1
- LLMs for Automated Ticket Escalation — arXiv 2504.08475: https://arxiv.org/html/2504.08475v1
- AI Ticket Triage metrics (72s→4s, $1/resolution) — Twig: https://www.twig.so/blog/triaging-customer-support-tickets-with-ai

## [digital-twin] Pre-flight / digital twin / shadow mode — grounds [[pre-flight]], [[provenance-and-replay]]
- ADDT — Digital Twin for Safety Validation — arXiv 2504.09461: https://arxiv.org/abs/2504.09461
- Digital Twin Counterfactual Framework — arXiv 2604.01325: https://arxiv.org/html/2604.01325
- TwinLoop: Simulation-in-the-Loop Digital Twins for Multi-Agent RL — arXiv 2604.06610: https://arxiv.org/html/2604.06610v1
- Shadow Mode Rollouts for AI Agents — Brightlume: https://brightlume.ai/blog/shadow-mode-rollouts-ai-agents-pilot-production
- Controlling AI Actions: Pre-Execution Control Layer — Data443: https://data443.com/blog/controlling-ai-actions-pre-execution-control-layer/
- Kill Switches Don't Work If the Agent Writes the Policy — Stanford Law/Berkeley AILCCP: https://law.stanford.edu/2026/03/07/kill-switches-dont-work-if-the-agent-writes-the-policy-the-berkeley-agentic-ai-profile-through-the-ailccp-lens/

## [chatops] Chat channel / human-in-the-loop messaging — grounds [[human-in-the-loop]], [[chat-channel]]
- Telegram Bot API: https://core.telegram.org/bots/api
- Telegram vs WhatsApp for an AI Agent (opt-in/template/window): https://www.hermify.io/en/blog/telegram-vs-whatsapp-for-ai-agent
- A2H: Agent-to-Human Protocol — arXiv 2602.15831: https://arxiv.org/pdf/2602.15831
- AgentClick: HITL Review Layer for Terminal AI Agents — arXiv 2604.16520: https://arxiv.org/html/2604.16520v1
- Toward Safe & Responsible AI Agents (transparency/accountability) — arXiv 2601.06223: https://arxiv.org/pdf/2601.06223

## [self-improve] Self-improving agents / curriculum / bootstrap (arXiv) — grounds [[software-building-and-self-hosting]], [[bootstrap-ladder]]
- Darwin Gödel Machine: Open-Ended Evolution of Self-Improving Agents — arXiv 2505.22954: https://arxiv.org/abs/2505.22954
- Huxley-Gödel Machine: Human-Level Coding Agent — arXiv 2510.21614: https://arxiv.org/html/2510.21614v1
- Intrinsically Motivated Goal Exploration w/ Automatic Curriculum Learning — arXiv 1708.02190: https://arxiv.org/pdf/1708.02190
- On the Statistical Limits of Self-Improving Agents — arXiv 2510.04399: https://arxiv.org/pdf/2510.04399
- International AI Safety Report 2026 — arXiv 2602.21012: https://arxiv.org/pdf/2602.21012
- When AI Builds Itself — Anthropic: https://www.anthropic.com/institute/recursive-self-improvement

## [code-memory] Codebase memory / code retrieval — grounds [[knowledge-and-memory]], [[code-knowledge-flywheel]]
- Persistent Codebase Memory for Coding Agents — Cognee: https://www.cognee.ai/blog/guides/ai-coding-agent-persistent-codebase-memory
- State of AI Agent Memory 2026 — mem0: https://mem0.ai/blog/state-of-ai-agent-memory-2026
- State of AI Coding Agents 2026 — Dave Patten: https://medium.com/@dave-patten/the-state-of-ai-coding-agents-2026-from-pair-programming-to-autonomous-ai-teams-b11f2b39232a

## [swe-agents] Autonomous software engineering (arXiv) — grounds [[software-building-and-self-hosting]]
- Live-SWE-agent: Self-Evolving SE Agents (77.4% SWE-bench Verified) — arXiv 2511.13646: https://arxiv.org/html/2511.13646v3
- SWE-EVO: Long-Horizon Software Evolution benchmark — arXiv 2512.18470: https://arxiv.org/pdf/2512.18470
- Effective Strategies for Asynchronous SE Agents — arXiv 2603.21489: https://arxiv.org/pdf/2603.21489

## [llm-wiki] The Karpathy LLM-wiki pattern itself — grounds [[llm-wiki]]
- Karpathy llm-wiki gist: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Beyond RAG: Karpathy's LLM Wiki Pattern — Level Up Coding: https://levelup.gitconnected.com/beyond-rag-how-andrej-karpathys-llm-wiki-pattern-builds-knowledge-that-actually-compounds-31a08528665e
- Karpathy shares LLM Knowledge Base architecture — VentureBeat: https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an
