# Speko Company Phone Agent

This optional [Paperclip](https://github.com/paperclipai/paperclip) catalog template provides one Company Phone Agent for voice intake and task follow-up. It follows [agentcompanies/v1](https://agentcompanies.io/specification).

The agent receives authorized requests on a bound task, clarifies the request, works with existing company agents when needed, and publishes concise results. It has no bundled credentials, runtime override, external skills, or automatic outbound calling permission.

## Getting started

Select this template from Paperclip's team catalog, review the proposed agent, and choose its runtime before installation. Then select the agent in the Speko connection setup. Speko setup selects an existing agent and does not recommend installing this template. Every assigned agent automatically receives the connection’s voice guidance; this template is only for companies that separately want a dedicated receptionist. Existing task assignments are preserved.

For a filesystem import, run `paperclipai company import --from packages/teams-catalog/catalog/optional/communications/speko-company-phone-agent/TEAM.md` from the repository root and review the import before applying it.

## Agent

- **Speko Company Phone Agent** — the single root agent; greeting, intake, clarification, authorized delegation, and concise follow-up. No additional skills are required.
