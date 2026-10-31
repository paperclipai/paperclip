# Archive attention sources without repeated feed scans

Attention retention now reconstructs source deadlines at startup and after committed source changes. It no longer rebuilds every active company's full feed on each heartbeat tick. The archive age remains 90 days. Keep and manual archive state remain authoritative, and automatic archive still commits its notification outbox atomically.

This document records source ownership, producer coverage, and the evidence needed to review the replacement. It makes no claim about host suspension or external wake alarms.

## Existing source rows own eligibility and deadlines

`attention-retention.ts` selects at most 100 unfinished source candidates per reconstruction page. It excludes inactive companies and kept or archived retention states. The scoped coordinator retains eligible deadlines, retries concrete failures, and cancels entries that leave attention. It does not schedule another scan after settlement unless a producer changes a relevant source.

| Source | Eligible durable state | Activity owner |
| --- | --- | --- |
| Decision | Open decision with a visible execution issue | Decision updated time |
| Interaction | Pending board-visible interaction; newest ordinary confirmation or independent quality gate | Interaction updated time |
| Recovery action | Active or escalated action owned by a user or board, with a visible source issue | Recovery updated time |
| Blocker attention | Board unblock descriptor or non-live terminal blocker selected by the issue owner | Blocked transition or terminal issue updated time |
| Review | Human participant, user assignee, pending approval, or stalled review selected by the issue owner | Issue updated time |
| Failed run | Failed or timed-out run with an exhaustion event, eligible agent and issue, and no newer matching run | Finished time, falling back to updated or created time |
| Budget alert | Open hard incident, or soft incident meeting the existing 85 percent rounded threshold | Incident updated time |
| Agent error | Agent in error status | Agent updated time |

The feed and worker share confirmation collapse, newer-run probes, issue visibility, review eligibility, and terminal-blocker predicates. Issue graph and agent invokability logic remain with their existing owners. Blocker entries retain both the root used to reconstruct the graph and the terminal subject that owns retention state. PostgreSQL deadlines round submillisecond timestamps upward. The worker locks the source and terminal subject before archival.

`productivity_review` generates no feed items and owes no retention work. Queue retention-day overrides control shelf presentation, which is computed on reads. They do not change the fixed automatic archive age. Approval retention, join-request retention, and archive notification delivery keep their existing workers.

## Existing mutation boundaries reactivate work

Committed hints identify a company, source kind, source ID or changed issue where those values are known. Routine issue writers pass identity to the retention domain helper before their mutation. The helper captures old and new parent paths, reverse blocker ancestors, run-linked issues and liveness-origin references; issue-scoped source queries then select reviews, blockers, interactions, decisions, recovery actions and failed runs by their issue identity. Budget incidents and agent errors remain tied to their own source changes. Ordinary issue writes do not reconstruct the unrelated company feed. Queue keys explicitly pick supported identity fields. Retention's own writes use exact source hints; blocker retention changes invalidate the company/source because multiple blocked roots can project one terminal subject. Reconstruction pages and due batches remain bounded. Review attention and interaction invokability are computed in company batches per candidate page; a full 100-candidate review page uses at most 20 statements and 100 confirmations use at most six. Decisions, recovery source links, runs, eligible agents, issue visibility, newer-run probes and blocker graphs also load in company batches per page. A 100-source decision or recovery page uses at most three statements; 100 failed runs use at most six; 100 blocker roots use at most 30 graph/source statements plus retention-state reads for their emitted entries. These evidence maps exist only for one load. The blocker owner shares fetched node and edge facts while tracking depth, node count, expanded nodes and live-work reachability independently for each root. An unrelated graph reaching its limit cannot change a shallow root’s terminal subject or deadline. All later graph queries, including recovery source IDs, agent IDs and workspace-finalize inputs, use bounded chunks. A SQL-generated 70,000-node graph proves PostgreSQL parameter limits are respected at the driver boundary. Archive checks still lock and freshly re-read sources, terminal subjects and related eligibility. Ordinary execution, decision and budget mutations pass their affected company; exact decision sources are included.

Producer coverage includes decision creation and changes; interaction creation, resolution, expiry and supersession; issue creation, updates, blocker relations, checkout, adoption and release; agent hire, configuration, lifecycle, error clearing and deletion; budget incidents and company pause/resume; exhausted-run events and retry-run creation; native status, review, finalization and reconstruction; external conversation transitions; and imported blocker relations. Existing service transactions retain outer commit ownership. Savepoint release does not publish work before outer commit.

The writer contract follows the existing delivery workers: serving processes use the transaction-aware service boundaries, and each serving process registers its workers. Independent raw SQL writers must supply equivalent ingress or restart reconstruction. Restores reconstruct work at startup. The change adds no permanent listener, independent timer, table, or Cloud wake mechanism. Existing sleep-safety gates remain in force.

## Real PostgreSQL evidence proves quiet and reactivation

The new acceptance suite exercises all eight sources, including terminal blocker identity and date, newest confirmations, independent quality gates, unhealthy reporting chains, conversation visibility, maintained reviews and pending approvals, newer-run suppression, ordinary task and interaction producers, ordinary exhaustion-event ingress, and ordinary error clearing. Additional ordinary producer controls cover child creation with a parent-blocking relation, budget incident creation and resolution, and repeated company-scoped execution-control writes.

It also checks keep/revive, moved and cancelled deadlines, company activation and isolation, retained terminal history, restart, nested outer commit and rollback, first writes during drain, retry across drain, atomic archive/outbox rollback, and notifications during reconstruction. A 225-item backlog uses three startup pages and source-specific self-invalidations. SQL is counted at the PostgreSQL driver boundary.

The old aggregate path issued 12 statements per tick in each of three configured-idle samples. The replacement issued zero statements during 300 seconds after settlement. One transaction-status read after an injected rollback is classified as uncertainty reconciliation; the following 300-second drain window must remain quiet.

The focused suite supports `PAPERCLIP_ATTENTION_RETENTION_TEST_DATABASE_URL`, validates its dedicated `_test` database name, applies pending migrations, and prewarms a six-connection pool before advancing fake time. Providers are not involved in retention selection; the existing archive outbox delivery tests verify the separate controlled notification boundary. Fake time proves scheduling and SQL quiet, not database or host suspension.

## Review and operational limits remain explicit

Local embedded PostgreSQL could not start on the test host because system semaphores were exhausted. The accepted runs use isolated PostgreSQL 17 databases. A mixed consumer run also exposed fixture contamination from a lifecycle suite that retains native finalization rows; isolated reruns are required and preserve the failed run in the review evidence. Broad Linux CI remains the required full-suite gate.

Review the source parity fixtures and producer hints together. The intended outcome is unchanged archive state and notifications with no recurring retention SQL when the sources remain unchanged. No merge or deployment is part of this change.
