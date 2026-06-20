# Paperclip — Commercialization & Path to Revenue

> **Revised 2026-06-20** to correct an ownership error in the prior version.
>
> **Ownership correction:** **Paperclip is an upstream open-source project (`paperclipai/paperclip`, MIT) that Michael Bennett *forked*.** Mike did not build Paperclip and does not own it. This document does **not** treat Paperclip as a proprietary product to package and sell. It distinguishes what is upstream's, what is Mike's, what can be reused/learned/integrated, and which **services** Mike can honestly offer while respecting upstream's open-source ownership.
>
> `[OBSERVED]` = confirmed in repo/artifacts. `[DOCUMENTED]` = stated in reports/config. `[EXTERNAL]` = runs outside this repo (EC2/on-chain).

---

## The five layers (who owns what)

| Layer | Owner | What it is | Can it be sold? |
|---|---|---|---|
| **1. Upstream Paperclip** | `paperclipai/paperclip` (MIT, "Dotta" et al., 1894 commits) | The open-source control plane: server, UI, adapters, plugin SDK, MCP server, DB schema. | **No — not Mike's to sell.** MIT permits use/modification/redistribution, but it is not a proprietary product Mike can claim or relabel. |
| **2. Mike's fork & local deployment/lab** | Michael Bennett (this repo, 51 commits on top of the fork) | Fork QoL patches + a running deployment with embedded Postgres, 17 backups, 2 live companies. | The *deployment/operation* is a service (below); the forked code stays MIT. |
| **3. QSL / Selarix integrations** | Mike | `qsl_findings`/`qsl-bridge`/`QslReview`, Selarix company config, board exports, EC2 wiring. | These are Mike's own integration work — sellable as integration services, subject to MIT for any upstream code reused. |
| **4. Operational practices & governance layer** | Mike | The Python runtime-health/governance stack (`scripts/*.py`), risk register, hardening order, hash-chained checkpoints, board-review packets. | **Mike's original work** — the strongest sellable IP/know-how, deliverable as methodology + tooling. |
| **5. The businesses Paperclip orchestrates** | Mike | CrawDaddy (security scans, USDC), SELARIX (PQC tool). | These are Mike's products/services — the actual revenue. Paperclip merely orchestrates them. |

**Bottom line:** revenue comes from **Layer 5 (Mike's businesses)** and from **services built on Layers 2–4 (Mike's deployment, integrations, and operational know-how)** — *not* from selling Layer 1.

---

## Track 1 — Businesses Paperclip orchestrates (Layer 5, closest to revenue)

### 1. CrawDaddy — automated repo security scanning  ⭐ closest to revenue
- **What it is:** an autonomous security scanner (CSO agent in the QSL cabinet) that scans GitHub repos, scores them, publishes Gist reports, alerts via Telegram, paid in **USDC on-chain**. This is Mike's product. `[EXTERNAL + DOCUMENTED]`
- **Why it's closest:** the payment rail is *already working* — `CRAWDADDY_PRELAUNCH_REPORT.md` records the watcher detecting **5 real USDC transfers** via Alchemy (wallet `0x25B50fEd…`), 90s websocket stability with **0 errors**, "LAUNCH APPROVED" (2026-03-30). Real scored reports produced (90/100, 100/100, 15/100). `[OBSERVED in report]`
- **North Star:** **$500 USDC/month sustained from CrawDaddy** (`QSL_CONFIG.md`). Gates the rest of the cabinet. `[DOCUMENTED]`
- **Gap to revenue:** repeat paying demand, not technical plumbing.
- **Paperclip's role:** orchestration only (scheduling, cost control, governance). Paperclip is infrastructure Mike *uses*, not the product.

### 2. SELARIX — Post-Quantum Cryptography (PQC) migration tool  → AWS Marketplace
- **What it is:** Mike's healthcare-cybersecurity SaaS for PQC migration. `[DOCUMENTED]`
- **Path:** `AWS_MARKETPLACE_RESEARCH.md` (2026-03-31): AWS Marketplace SaaS listing — Metering/Contracts API, AWS bills buyers directly (strong for hospital procurement). **Fees: 3% standard** / 8–15% AWS-sourced. **Timeline: 4–8 weeks** assuming integration done; filterable by HIPAA/HITRUST/FedRAMP. Bedrock is *not yet* a third-party agent marketplace as of early 2026. `[DOCUMENTED]`
- **Gap:** SaaS fulfillment URL + metering integration + seller registration (2–4 wk) + listing review (2–4 wk).
- **Note:** SELARIX (the PQC product) is Mike's; it is unrelated to selling Paperclip.

### 3. SN61 BitTensor miner (CMO role)
- Mining revenue stream in the cabinet (Hostinger). Secondary; least in-repo detail. `[DOCUMENTED]`

---

## Track 2 — Services Mike can honestly sell (Layers 2–4)

Paperclip is open source, so anyone can download it. **The sellable thing is expertise and labor around it**, not the software. These are legitimate, common offerings around any OSS platform:

| Service | What it is | Built on | Honesty guardrail |
|---|---|---|---|
| **Setup** | Stand up a Paperclip instance for a client (embedded/managed Postgres, auth mode, storage, secrets). | Layer 2 know-how | Position as "setup of the open-source Paperclip," not "my software." |
| **Deployment** | Production deploy (cloud/Tailscale/self-host), backups, monitoring. | Layer 2 + Layer 4 ops stack | Client owns their MIT-licensed instance. |
| **Customization** | Fork-level QoL patches, UI tweaks, adapter config. | Layer 2 fork experience | Contribute generic improvements upstream where appropriate. |
| **Integration** | Wire Paperclip to a client's agents, repos, payment rails, EC2, external tools (the QSL/Selarix-style work). | Layer 3 | Integration code is the client's/Mike's; respect upstream license for reused parts. |
| **Governed workflow design** | Design approval gates, budgets, org charts, routines, escalation policies for a client's agent org. | Layer 4 governance know-how | This is methodology — clearly Mike's deliverable. |
| **Managed operations** | Ongoing run/monitor/remediate: guardian runs, governance checkpoints, DR, board-review packets. | Layer 4 Python stack (Mike's original work) | Sell the *service + tooling*, disclose it sits atop open-source Paperclip. |
| **Training & documentation** | Onboard a client's team; write runbooks; produce the kind of first-hour guide in this harvest. | Layers 2–4 | Straightforward services revenue. |

**Strongest service IP:** Layer 4. The runtime-guardian / governance-checkpoint / remediation methodology and tooling are **Mike's original work** and unusually mature — they are the most defensible thing to sell as "managed governed operations for AI-agent companies," explicitly *on top of* open-source Paperclip.

### What about Clipmart / plugins / hosted Paperclip?
- **Clipmart** (download-and-run company templates) is an **upstream roadmap feature** — it's paperclipai's to build and monetize, not Mike's. Mike *can* **publish company templates** to it (e.g. a hardened QSL-style ops template) and **author/sell plugins** for it — those are Mike's artifacts riding on upstream's distribution. `[DOCUMENTED upstream feature]`
- **Plugins:** Mike can build and sell **plugins** (his own code) using the open `packages/plugins/sdk`. Selling a plugin is fine; selling Paperclip is not.
- **Hosted/managed Paperclip:** Mike can offer a **managed-hosting service** (operating *open-source* Paperclip for clients) — that's a service, allowed under MIT. He must **not** rebrand or present Paperclip as his proprietary SaaS. Check upstream trademark/naming before using the "Paperclip" name commercially.

---

## Ranked: closest to revenue (with corrected framing)

| Rank | Opportunity | Layer | Distance to $ | Blocker |
|---|---|---|---|---|
| 1 | **CrawDaddy scans (USDC)** | 5 (Mike's product) | Shortest — rail proven | Repeat paying demand |
| 2 | **SELARIX → AWS Marketplace** | 5 (Mike's product) | 4–8 wks | Metering + fulfillment |
| 3 | **Services: setup/integration/managed ops** | 2–4 (Mike's labor + know-how) | Immediate once a client exists | Client pipeline |
| 4 | **Governed-ops methodology + tooling as a service** | 4 (Mike's original IP) | Medium | Productize/package the methodology |
| 5 | **Plugins / company templates for Clipmart** | Mike's artifacts on upstream | Medium–long | Upstream Clipmart must ship |

> Removed from the prior version: "Clipmart as *my* platform play," "package the governance/DR stack as *my* enterprise tier when pitching hosted Paperclip," and any framing of Paperclip itself as a proprietary product. Those implied ownership Mike does not have.

---

## Recommendations (revised)

1. **Protect the CrawDaddy USDC rail and instrument repeat revenue toward $500/mo.** This is Mike's nearest real money and is independent of Paperclip's licensing. `[OBSERVED rail]`
2. **Decide SELARIX AWS go/no-go on a 6–8 week clock.** Mike's product; research is done. `[DOCUMENTED]`
3. **Productize the services in Track 2** — especially **managed governed operations** built on Mike's Layer-4 tooling. This is the cleanest, most honest recurring revenue: sell expertise and operations *around* open-source Paperclip.
4. **Contribute generic improvements upstream** (fork QoL patches, adapter fixes) — good citizenship that also builds credibility for the services business.
5. **Publish QSL-style company templates / plugins** to the upstream ecosystem (awesome-paperclip, Clipmart when it ships) as Mike's own artifacts.
6. **Fix or retire Moltbook** before relying on it for content-driven acquisition — broken (401) since 2026-04-09. `[OBSERVED BROKEN]`
7. **Respect upstream branding and license:** don't market Paperclip as a proprietary product; verify trademark/naming before any commercial use of the "Paperclip" name; keep service offers framed as "around the open-source project."

---

## Observed vs documented / caveats

- CrawDaddy and SELARIX run on EC2/on-chain **outside this repo**; their live status here is inferred from dated reports, not a live check this pass. The CrawDaddy "LAUNCH APPROVED / 5 USDC transfers" results are **as of 2026-03-30** — ~3 months stale vs this harvest. Re-verify. `[OBSERVED-in-report, possibly stale]`
- No MRR figures were found in-repo beyond a $37.37 wallet balance (`SELARIX_CONFIG.md`) and the $500/mo target.
- This document makes **no claim that Mike owns Paperclip.** All "platform" monetization belongs to upstream; Mike's revenue is his businesses (Layer 5) and services/artifacts (Layers 2–4) built lawfully on the MIT-licensed project.
