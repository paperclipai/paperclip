# Paperclip Startup Template

A reusable [agentcompanies/v1](https://agentcompanies.io/specification) package that stands up a Paperclip-shaped company with the standard 8-role startup lineup, governance rules, and logging conventions.

## What you get

- **8 agents**: CEO, CTO, CMO, FrontendEngineer, BackendEngineer, Coder, QA, SecurityEngineer
- **Governance baked in**: five-non-negotiable communication contract, lane boundaries, CTO no-code rule, escalation paths
- **Logging conventions**: run-audit headers, five-section progress comments, status-transition discipline

## Import

```bash
paperclipai company import . \
  --target new \
  --new-company-name "YourCompanyName" \
  --agents all \
  --yes
```

## Customise

Edit `agents/<role>/AGENTS.md` to tailor per-role responsibilities. Keep the five non-negotiables verbatim — they are the company's communication contract.

## Spec & references

- agentcompanies/v1 spec: https://agentcompanies.io/specification
- Paperclip: https://github.com/paperclipai/paperclip
- Governance contract: [RULES.md](./RULES.md)
- Org chart and reporting: [docs/teams.md](./docs/teams.md)
- Heartbeat and logging conventions: [docs/logging.md](./docs/logging.md)

## Licence

MIT — see [LICENSE](./LICENSE).
