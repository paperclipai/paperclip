# First-30 Connector Matrix

Audience: engineers and product owners planning connector rollout on the Apps v2
substrate.

Post-read action: choose the right reuse path, auth mode, resource filters, and
review gates for a provider before writing a connector ticket or playbook entry.

Source: harvested from [PAP-2432](/PAP/issues/PAP-2432) and made canonical for
the [PAP-13211](/PAP/issues/PAP-13211) Apps v2 unification program.

## Batch Recommendation

First implementation batch after the proof providers:

- **Linear**
- **Notion**
- **Sentry**
- **Vercel**
- **Exa**

Do not start provider implementation until the Apps v2 substrate is stable and
the connector-validation scope in [PAP-12373](/PAP/issues/PAP-12373) is ready to
exercise connect, configure, grant, execute, revoke, and activity paths.

Keep Stripe, Salesforce, Zendesk, QuickBooks, Ramp/Brex, and broad Microsoft 365
writes out of the first batch. They carry higher-risk finance, customer,
support, or tenant-wide surfaces and should follow one more cycle of
grant/revocation proof.

## Runtime Pattern Batches

| Batch | Runtime/auth pattern | Providers | Purpose | Gate |
| --- | --- | --- | --- | --- |
| 0 - Proof complete | Built-in/deep wrapper, app install, Google OAuth | GitHub, Slack, Google Drive/Docs | Proved repo, chat, and document flows. | Foundation accepted in [PAP-2367](/PAP/issues/PAP-2367). |
| A - Standards expansion | Direct MCP or thin provider wrapper; OAuth/API key; moderate risk | Linear, Notion, Sentry, Vercel, Exa | Prove the repeatable connector template. | Security review plus connector-validation scope. |
| B - Enterprise suite | Tenant OAuth, broad directory/doc/chat scopes | Atlassian, Microsoft 365, HubSpot, Intercom | Prove enterprise account scoping and support/CRM grants. | Security review after Batch A QA. |
| C - Design/data | Mostly direct MCP/API key, read-heavy, rich file resources | Figma, Canva, PostHog, Datadog, Apify | Extend directory breadth while keeping writes narrow. | Batch A patterns stable. |
| D - Revenue and regulated ops | OAuth/API key with high-risk financial/customer writes | Stripe, Salesforce, Attio, Apollo, QuickBooks, Ramp/Brex | Add revenue/finance workflows after stronger approval UX. | SecurityEngineer sign-off and explicit write-action policy. |
| E - Incident/support/meetings | OAuth/API key plus event/webhook sync | PagerDuty, Cloudflare, Zendesk, Fireflies | Add on-call, DNS/infra, support, and meeting-note ingestion. | Batch A/B broker and webhook evidence. |

## Security Tiers

| Tier | Meaning |
| --- | --- |
| S1 low | API-key or OAuth read-only public/business data; no customer PII, money movement, deploys, or external messaging. |
| S2 medium | Business data reads and narrow low-risk writes with resource filters. |
| S3 high | Broad documents, infrastructure, incident, customer-support, or deployment writes; requires explicit grant review and strong activity logs. |
| S4 critical | Payments, finance, regulated data, tenant-wide admin, or irreversible customer-facing writes; requires SecurityEngineer review and high-risk approval/dry-run defaults. |

## Reuse Classification

Use **direct MCP** when the provider exposes an official or stable MCP server
whose tool/resource semantics match Paperclip grants: Linear, Notion, Sentry,
Vercel, PostHog, Exa, Apify, Canva where available, Fireflies, and most Google
Workspace reads.

Use **OpenAPI-to-MCP shims** when the vendor has a documented REST/OpenAPI
surface but no stable vendor MCP server: Datadog, Apollo.io, QuickBooks,
Ramp/Brex, Zendesk, and portions of Salesforce/Microsoft 365 until their MCP
paths are stable.

Use **vendor-deep wrappers** when the value or security boundary depends on app
installation tokens, event validation, rich UI/action semantics, or
domain-specific governance: GitHub, Slack, Google Workspace writes, Atlassian,
Microsoft 365, Cloudflare, Figma, Stripe, Salesforce, HubSpot, Intercom, and
PagerDuty.

## Matrix

| # | Provider | Batch | Reuse path | Auth mode | Required resource filters | Initial tools | Webhook/sync needs | Tier |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Slack | 0 | Vendor-deep wrapper on MCP-style provider | Slack OAuth bot; optional user token later | Workspace, channel allowlist, thread/user limits | Search/read channels, draft/post/reply | Events API for selected channels, message/thread sync | S3 |
| 2 | Gmail | Later Google suite | Direct MCP/Google provider | Google OAuth | Account/org, labels, sender/recipient/domain filters | Search/read, draft/send with approval | Pub/Sub watch optional after read/write proof | S3 |
| 3 | Google Calendar | Later Google suite | Direct MCP/Google provider | Google OAuth | Calendar allowlist, attendee/domain filters | List availability, draft/create/update events | Calendar watch optional | S2 |
| 4 | Google Drive | 0 | Direct MCP plus Google deep wrapper | Google OAuth | Shared drive, folder, document filters | Search/fetch metadata/content | Metadata crawl optional | S3 |
| 5 | Notion | A | Direct MCP with thin wrapper for block/database policy | Notion OAuth | Workspace, page, database, property filters | Search/query DBs, read pages, create draft page/append block | Page/database update sync optional | S3 |
| 6 | GitHub | 0 | Vendor-deep wrapper | GitHub App preferred; OAuth fallback | Org/account, repo allowlist, branch/environment filters | Search repos/issues/PRs/checks, create issue/comment | PR/check webhook sync | S3 |
| 7 | Linear | A | Direct MCP/GraphQL thin wrapper | Linear OAuth | Workspace, team, project, label, cycle filters | Search/read issues, create issue, comment, update status | Issue/comment webhook optional | S2 |
| 8 | Atlassian Jira/Confluence | B | Vendor-deep wrapper around Rovo/REST | Atlassian OAuth | Site, Jira project, Confluence space/page filters | Search/read issues/pages, create issue/comment/page draft | Jira/Confluence webhooks | S3 |
| 9 | Microsoft 365 | B | Vendor-deep wrapper; Graph MCP where stable | Entra OAuth | Tenant, team/channel, mailbox/calendar, drive/folder filters | Search mail/files, draft email/event, Teams draft | Graph subscriptions after policy review | S4 |
| 10 | Google Docs/Sheets | 0 | Direct MCP plus Google deep wrapper | Google OAuth | Same Drive filters plus doc/sheet ID filters | Fetch doc/sheet, draft create/append/update | Metadata/content sync optional | S3 |
| 11 | Sentry | A | Direct MCP or thin REST wrapper | OAuth or org token secret ref | Org, project, environment, issue status filters | Search/read issues/events/releases, assign/comment/resolve gated | Issue alert webhook, release sync | S2 |
| 12 | PagerDuty | E | Direct MCP with REST wrapper for events | OAuth | Account, service, escalation policy, incident urgency filters | Read incidents/on-call, ack/resolve with approval | Incident webhooks | S3 |
| 13 | Cloudflare | E | Direct MCP with vendor-deep wrapper for Workers/DNS | OAuth or scoped API token | Account, zone, Worker/project filters | Read zones/deployments/logs, draft DNS/Worker change | Audit/deployment sync optional | S4 |
| 14 | Vercel | A | Direct MCP or thin REST wrapper | Vercel OAuth | Team, project, environment, deployment filters | Read projects/deployments/log metadata, redeploy/cancel gated | Deployment webhooks | S3 |
| 15 | PostHog | C | Direct MCP/API-key provider | Project/personal API key secret ref | Project, environment, dashboard/feature flag filters | Query events/insights/flags, create annotation | Optional insight/flag sync | S2 |
| 16 | Datadog | C | OpenAPI-to-MCP shim first, deep wrapper later | API key + app key secret refs | Site, org, service, monitor, dashboard filters | Read metrics/logs/monitors, mute/unmute gated | Monitor/webhook events | S3 |
| 17 | Figma | C | Vendor-deep wrapper; MCP for Dev Mode reads | Figma OAuth | Team, project, file, branch filters | Read files/comments/dev data, create comment | File/comment webhooks optional | S3 |
| 18 | Canva | C | Direct app/MCP where available; Connect API wrapper | Canva OAuth | Team, folder, brand/template filters | Search/read designs, create design from template | Asset sync optional | S2 |
| 19 | Exa | A | Direct MCP/API-key provider | API key secret ref | Domain allow/deny list, content category, rate limits | Web/neural search, fetch result content | No webhook; usage/activity only | S1 |
| 20 | Apify | C | Direct MCP/API-token provider | API token secret ref | Actor allowlist, dataset/run filters | Run actor, read dataset, fetch status | Actor run completion webhook optional | S2 |
| 21 | HubSpot | B | Direct MCP/REST wrapper | HubSpot OAuth | Portal, pipeline, object type, owner/team filters | Search contacts/companies/deals, create note/task/deal gated | CRM webhooks | S3 |
| 22 | Salesforce | D | Vendor-deep wrapper; OpenAPI/GraphQL where useful | Salesforce OAuth | Org, object, record type, field-level filters | Search/read records, create task/note/opportunity draft | Platform events/webhooks | S4 |
| 23 | Attio | D | Direct MCP/REST wrapper | Attio OAuth | Workspace, list, object, attribute filters | Search records, create note/task/update stage gated | Workspace webhook optional | S3 |
| 24 | Apollo.io | D | OpenAPI-to-MCP shim | API key secret ref | Workspace, list, persona, sequence filters | Search prospects/accounts, add to list gated | No first webhook; usage/activity only | S3 |
| 25 | Stripe | D | Vendor-deep wrapper using Stripe agent toolkit | OAuth or restricted key secret ref | Account, mode, object type, refund/payment capability filters | Search customers/subs/invoices, create invoice/refund draft | Stripe webhooks mandatory for state sync | S4 |
| 26 | QuickBooks | D | OpenAPI-to-MCP shim, Intuit wrapper later | Intuit OAuth | Realm/company, entity/report filters | Read reports/invoices/vendors, create invoice draft | Intuit webhooks optional | S4 |
| 27 | Ramp/Brex | D | OpenAPI-to-MCP shim | OAuth/API token depending provider | Entity, department, cardholder, merchant/category filters | Read transactions/cards/reimbursements, draft memo/category update | Transaction webhooks optional | S4 |
| 28 | Intercom | B | Direct MCP/REST wrapper | Intercom OAuth | Workspace, inbox/team, tag, conversation view filters | Search conversations/users, draft/reply/assign gated | Conversation/contact webhooks | S3 |
| 29 | Zendesk | E | OpenAPI-to-MCP shim first, app wrapper later | Zendesk OAuth | Subdomain, brand, group, view, ticket tag filters | Search/read tickets/users, comment/assign/status gated | Ticket webhooks | S3 |
| 30 | Fireflies | E | Direct MCP/API wrapper; choose over Granola for public API maturity | OAuth/API key secret ref | Team, user, meeting folder/source filters | Search/read transcripts/summaries, export action items | Meeting-completed webhook/sync | S2 |

## First Batch Acceptance Template

Every provider ticket in Batch A must cover:

- **Connect:** OAuth/API-key/app-install flow creates a company-scoped
  connection and stores credential material only as secret refs.
- **Configure:** operator can set provider-specific resource filters, health
  checks, read/write mode, and risk defaults.
- **Grant:** selected actors see only allowed tools and resource scopes.
- **Execute:** allowed read and narrow write actions run through the broker or
  gateway with activity tied to issue/run context.
- **Revoke:** revocation disables grants and blocks tool listing/execution
  immediately.
- **Activity:** connect, config change, grant change, tool execution, denial,
  and revoke events are logged with provider key, connection id, actor, tool,
  action class, and run/issue where present.
- **Negative access:** ungranted agents cannot list/invoke tools; granted agents
  cannot access disallowed resources; raw secret values never appear in API
  responses, logs, comments, action requests, or agent outputs.
