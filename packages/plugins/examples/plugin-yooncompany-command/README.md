# YoonCompany Command Plugin

Local Paperclip plugin for the YoonCompany one-person AI company console.

Surfaces:

- dashboardWidget: command strip for queue, approvals, failures, cost, and evolution proposals
- sidebarPanel: quick actions for Codex, Hermes, new work, and guide

Risk boundary:

- Creates Paperclip issues only.
- Does not invoke agents automatically.
- Does not deploy, delete, send email, publish externally, write DB directly, change credentials, or grant Hermes repo write permission.

Install only after WO-08A approval:

```powershell
pnpm --filter @yooncompany/paperclip-command-plugin build
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3100/api/plugins/install" -ContentType "application/json" -Body (@{
  packageName = "C:\yooncompany\external\paperclip\packages\plugins\examples\plugin-yooncompany-command"
  isLocalPath = $true
} | ConvertTo-Json)
```
