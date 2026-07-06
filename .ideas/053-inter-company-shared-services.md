# 053 — Inter-Company Shared Services (Agent Lending)

## Suggestion

One Paperclip instance runs many companies, but they're hard-isolated — cross-company access is
explicitly denied (`authorization.ts`, `agent-assignability.ts`'s `ancestor_cross_company`,
`trust-preset-resolver.ts`'s `cross_company_boundary`). That isolation is correct as a default, but
it forces real waste: every company must build or hire its **own** specialists. If you run five
companies, you stand up five legal reviewers, five designers, five security auditors — duplicated
cost, duplicated config, inconsistent quality. Human conglomerates solve this with **shared
services**: a central function (Legal, Design, IT) that subsidiaries draw on. Paperclip has no
peer-to-peer equivalent.

Add **inter-company shared services**: let a company expose specific agents as services that
*other* companies in the same instance can request work from, through a governed, audited bridge —
without dissolving the per-company isolation.

## How it could be achieved

1. **Publish a service, not full access.** A company marks an agent (or role) as an offered
   *service* with a defined interface: what it does, what it costs (charged back to the requesting
   company), and what inputs it accepts. This is narrow and explicit — not general cross-company
   visibility.
2. **Governed request bridge.** A requesting company files a *service request* (a scoped, typed
   task) to the providing agent. Reuse the same controlled cross-company capability proposed for
   the Holding Company (idea 007) — a deliberate, audited seam rather than a weakening of
   `authorization.ts`. The provider sees only the request payload, never the requester's internals.
3. **Chargeback.** Work done by a shared service is costed to the *requesting* company's budget
   (ideas 002/019/030), so shared functions are economically honest — the using company pays, the
   providing company isn't silently subsidizing it.
4. **Boundaries preserved.** No shared agent gets standing access to a requester's workspace,
   secrets, or task tree; everything flows through the typed request/response, scanned for leaks
   (idea 020) on the way out. Every cross-company interaction is logged to the tamper-evident audit
   trail (idea 023).
5. **Discovery.** A shared-services directory at the instance level so a company can find "who
   offers legal review?" — capability matching (idea 025) applied across the company boundary.

## Perceived complexity

**High.** Like the Holding Company (idea 007), this deliberately pierces a security boundary the
system was built to enforce, so the governed cross-company bridge is the hard, safety-critical core
— it must be impossible for a service request to escalate into general access, and chargeback +
audit must be airtight. The service-interface model and directory are moderate; the isolation
guarantees are where the real work and review go. Best sequenced after (or alongside) idea 007,
since both need the same governed cross-company seam — build that seam once and use it for both
hierarchical oversight (007) and peer service-sharing (053). Ship read-only discovery + manual
single-request flows first; standing service relationships are a later tier.
