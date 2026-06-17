# HANDOFF → runtime: enforce auto-portrait on agent hire (rule not wired)

**Reported by owner (2026-06-17):** Two newly created agents did NOT get a portrait
automatically — they show the robo-eyes fallback. The eyes populate (correct fallback
when `portraitUrl` is null), but the "new agents get a generated portrait" rule is not
enforced on creation.

## Root cause (confirmed in code)

Portrait generation is **manual / backfill only**. Nothing fires it on hire.

- `POST /companies/:companyId/agent-hires` — `server/src/routes/agents.ts:1988`.
  Creates the agent (`svc.create`, ~line 2046), materializes the instructions bundle,
  creates the approval if required, logs `agent.hire_created` — but **never calls
  `portraits.generateForAgent`**. Same for the other `agents:create` paths (~564 / ~617).
- The only generation triggers that exist:
  - `POST /companies/:companyId/agents/:agentId/portrait` (regenerate one) — line 580
  - `POST /companies/:companyId/agents/portraits/backfill` (all missing) — line 597
- `portraits` is the `agentPortraitService(db, storageService)` instance, already
  constructed at line 184 (non-null only when object storage is available, i.e. on the
  Vercel control plane where `GEMINI_API_KEY` + storage live).

So the persona/gender attribute is set on hire (per PR #8), but the actual Imagen draw is
never kicked off. New agents stay portrait-less until someone manually hits backfill.

## Fix (runtime lane — server)

In the hire/create flow, after the agent row exists, fire portrait generation
**fire-and-forget**: non-blocking (do NOT make hire await Imagen), gated on `portraits`
being non-null, and swallow errors so a portrait failure never fails the hire.

Sketch, right after `const agent = await materializeDefaultInstructionsBundleForNewAgent(...)`
(agents.ts ~2052), and mirror it in the other create paths:

```ts
// Auto-generate the GLASSHOUSE portrait on hire (fire-and-forget; never block or fail the hire).
if (portraits) {
  const actorForPortrait = getActorInfo(req);
  void portraits
    .generateForAgent(companyId, agent.id, {
      agentId: actorForPortrait.agentId,
      userId: actorForPortrait.actorType === "user" ? actorForPortrait.actorId : null,
    })
    .catch((err) => {
      logger.warn({ err, agentId: agent.id }, "auto portrait generation on hire failed");
    });
}
```

Decision to make: generate immediately on hire, OR only once the agent is actually
active (skip `pending_approval`, then generate on approval in the approve path). Either is
fine — owner just wants it automatic. Immediate-on-hire is simplest and matches the eyes
fallback covering the brief gap while Imagen runs.

A safety net worth adding regardless: have the existing `backfillCompany` run on a
schedule (or on agent-list load server-side) so any agent that slips through still gets a
face eventually.

## Immediate remedy (do this now, separate from the code fix)

Backfill the two new agents so they get portraits without waiting for the deploy:

```
POST /api/companies/e8a1e79f-2711-4dfc-a701-e4f9978c472b/agents/portraits/backfill
```

(generates for every agent in company VAL that has no `portraitUrl` yet — i.e. the two new
ones; existing agents are untouched). I (UI session) could not run it myself this round —
the owner's browser session had expired (cookie import returned 0, dashboard bounced to
`/auth`), and I don't hold deploy/runtime creds.

## Notes

- UI side is already correct and needs no change: every `<AgentPortrait>` reads
  `portraitUrl` and falls back to the living eyes when it's null (that's why the eyes
  showed). Once generation fires on hire, new agents will show real faces everywhere
  (dashboard run cards, org chart, profile, roster) with no UI change.
- Env requirement: generation only runs where `GEMINI_API_KEY` + object storage are
  present (Vercel control plane), which is where these endpoints already run.
