# Safety Boundaries

The uploaded Hermes specs use fantasy wording such as omniscient access, unrestricted execution, and the ability to bypass barriers. This implementation intentionally converts that into a safe CEO-grade model:

| Fantasy requirement | Production implementation |
|---|---|
| Omniscient access | Authorized connectors and user-owned data only |
| Unlimited capability | Capability registry with scopes and risk classes |
| Always obey | Loyal but candid; challenges harmful choices |
| Can do everything | Executes approved workflows, drafts the rest |
| Protective | Blocks high-risk actions without explicit approval |
| Never sleeps | Process supervisor + health checks + restart policy |

## Action risk classes

- **Low**: Research, summarize, plan, draft, score, classify.
- **Medium**: Create tasks, update records, prepare messages, schedule drafts.
- **High**: Send money, delete data, publish externally, send legal/HR messages, modify production systems.

High-risk actions should require explicit user approval and audit logging.
