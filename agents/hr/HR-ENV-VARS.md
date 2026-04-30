# HR Agent — Required Environment Variables

All variables below must be set in your Paperclip environment (or `.env` file) before the HR agent can run. The `mcp.json` references them as `${VAR_NAME}`.

---

## Required — will crash without these

| Variable | Used by | What it is | Where to get it |
|----------|---------|-----------|----------------|
| `SHAREPOINT_TENANT_ID` | SharePoint MCP | Your Microsoft 365 tenant ID (GUID) | Azure Portal → Azure Active Directory → Tenant ID |
| `SHAREPOINT_CLIENT_ID` | SharePoint MCP | SharePoint app registration client ID | Azure Portal → App registrations → SharePoint app → Application (client) ID |
| `SHAREPOINT_CLIENT_SECRET` | SharePoint MCP | SharePoint app registration client secret | Azure Portal → App registrations → SharePoint app → Certificates & Secrets |
| `OUTLOOK_CLIENT_ID` | Outlook MCP | Outlook app registration client ID | Azure Portal → App registrations → Outlook app → Application (client) ID |
| `OUTLOOK_CLIENT_SECRET` | Outlook MCP | Outlook app registration client secret | Azure Portal → App registrations → Outlook app → Certificates & Secrets |
| `OUTLOOK_MAILBOX` | Outlook MCP | The mailbox the agent sends/reads from | e.g. `karthik.r@medicodio.ai` |

> **Note:** `SHAREPOINT_TENANT_ID` is shared — the Outlook MCP maps it to `OUTLOOK_TENANT_ID` internally (same tenant). You only need one tenant ID. The client ID/secret are scoped separately so SharePoint credentials are never injected into the Outlook MCP process.

## Optional — have defaults

| Variable | Default | What it is |
|----------|---------|-----------|
| `SHAREPOINT_SITE_URL` | `https://medicodio.sharepoint.com/sites/MedicodioMarketing` | Full SharePoint site URL |

## Other MCPs

| Variable | Used by | What it is |
|----------|---------|-----------|
| `APIFY_API_KEY` | Apify MCP | Apify API token — only needed if Apify actors are used |

---

## Azure App Registration — Required Permissions

For the app registered under `SHAREPOINT_CLIENT_ID`, grant these Microsoft Graph API permissions:

| Permission | Type | Required for |
|-----------|------|-------------|
| `Mail.ReadWrite` | Application | Read + send emails via Outlook MCP |
| `Mail.Send` | Application | Send emails |
| `Sites.ReadWrite.All` | Application | Read + write SharePoint files |
| `Files.ReadWrite.All` | Application | Read + write files in SharePoint |

All must be **Application permissions** (not Delegated) and **admin-consented**.

---

## Quick Setup Checklist

- [ ] Azure App registered in your tenant
- [ ] `Mail.ReadWrite`, `Mail.Send`, `Sites.ReadWrite.All`, `Files.ReadWrite.All` granted + admin-consented
- [ ] Client secret created and copied
- [ ] 4 env vars set in Paperclip environment
- [ ] `HR-Onboarding/` folder exists in SharePoint site
- [ ] `HR-Onboarding/audit-log.csv` created with header row: `timestamp|case_id|employee_email|employee_full_name|employee_type|human_in_loop_email|recruiter_or_hr_name|current_status|event|action_taken|brief_reason`
- [ ] `HR-Onboarding/config.md` uploaded (use `HR-SHAREPOINT-CONFIG-TEMPLATE.md` as template)
- [ ] Heartbeat routine scheduled (cron every 30 min) in Paperclip
