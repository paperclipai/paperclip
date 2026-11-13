# Human staff on the org chart

Active human company members can appear on the org chart next to agents. This closes the gap where invited people had access but no visible place in the reporting hierarchy.

## Who appears

- **Humans:** users with an **active** company membership.
- **Agents:** unchanged; terminated agents stay off the chart.

Org API nodes include `kind`: `user` or `agent`, plus `title` for display.

## Set title and reports-to

1. Open **Settings → Members** (`/company/settings/members`).
2. Choose **Edit** on a member.
3. Set **Job title**, **Org chart role**, and **Reports to** (another member or agent).
4. Save.

These fields live in `company_staff_profiles`. Membership role and status still control access.

## View the hybrid org chart

Open **Org chart** (`/org`). Human cards use a distinct style: user icon, primary border, and a **Human member** label. Agent cards are unchanged.

Exported org SVG treats human nodes with a separate accent color.

## Agents that report to a human

When creating or updating an agent, set **reports to** to a human manager via `reportsToUserId` (API) or agent configuration. An agent cannot set both `reportsTo` (agent) and `reportsToUserId` (human).

The manager must be an active company member.

## Agent chat to other members

With **Agent Chat** enabled, a running agent may call `send_chat_message` with optional `recipientUserId` to reach another active member. The default recipient remains the task run’s responsible user.

The member sees and replies in the existing agent chat UI.
