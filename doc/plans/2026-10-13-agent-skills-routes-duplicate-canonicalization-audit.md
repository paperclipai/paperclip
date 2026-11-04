# Agent skills route duplicate canonicalization audit — 2026-10-13

Status: duplicate-proof deletion, based on `github/master` `d67e3507b23041212fa26302ce6de078c5ebcc05`. Owner: `server/src/__tests__/agent-skills-routes.test.ts`. Production code and unrelated declarations are unchanged.

## Removed declarations and retained keepers

Remove two successful canonicalization replays:

- The sync case that sends the `paperclip` alias with `mode: replace` and checks the canonical persisted singleton is covered by the retained complete-replacement case. That keeper starts with an existing assignment, performs the same request and checks the same canonical result. It additionally proves replacement removes the prior assignment.
- The hire case that checks canonical desired skills in the approval payload and requested configuration snapshot is covered by the retained detailed hire case. That keeper checks both canonical fields and also preserves agent creation, icon, actor attribution, and source-issue linkage.

All other declarations remain. The broader suite retains adapter-specific configuration, secret handling, merge/remove/replace semantics, beta gates, built-in role defaults, onboarding trust, approval policy, actor attribution, and rejection boundaries. Production routes, services, and their seams are unchanged. Caller review covered Agent Skills and Company Skills UI, New Agent/onboarding hire flows, and CLI `skills agent sync`.

## Local validation and savings

The historical serialized route/authz weight is 24,106 ms and includes suite startup, imports, database setup, and shutdown. It is not a measurement of removable runtime. The edit removes two test declarations and about 48 test lines, including separators. It removes two HTTP requests and their repeated module-reset/import setup. No production lines are removed, and no CI time reduction is claimed.

The focused exact-head owner suite passed **58/58** in 38.38 seconds. No baseline or mutation run is claimed. A faulty canonicalizer or approval serializer should fail the retained replacement and detailed-hire keepers. The existing skills-service and authorization-service owner suites continue to cover storage and the direct permission decision.
