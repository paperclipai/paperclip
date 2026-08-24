---
title: FAQ
summary: Frequently asked questions about Paperclip setup, billing, notifications, and operation
version: v0.5.0
last_updated: 2026-08-21
---

# Frequently Asked Questions

## Getting Started

### "How do I get Paperclip running?"

Two options:

- **Voyonder Cloud (SaaS):** Go to [voyonder.com](https://voyonder.com), sign up, and create a company in your browser. See the [Run Your First AI Company](/start/your-first-company) guide.
- **Self-Hosted:** Run `npx paperclipai onboard --yes` in your terminal. See the [Quickstart](/start/quickstart) guide.

### "What's the fastest way to see Paperclip in action?"

Deploy a **template company** — it's the fastest path. From the Companies page, click **Templates** and deploy a pre-built company (Travel Concierge, Support Ops, Engineering Team, or CPA Firm) in one click. Each template ships with agents, skills, knowledge, a goal, and a starter issue.

### "Do I need a database?"

No — Paperclip uses an embedded PostgreSQL instance by default. For production, you can configure an external PostgreSQL database via `DATABASE_URL`.

### "What's the difference between `local_trusted` and `authenticated` mode?"

- **`local_trusted`** (default for local development) — no signup required, auto-authenticated for local requests
- **`authenticated`** — requires user accounts, email/password signup, and board authentication

## Billing

### "How do I connect Stripe?"

> ⚠️ *Fork-only billing implementation removed during upstream merge cleanup (commit `de8529fc03`). Staff Engineer is restoring billing with upstream-compatible code (VOY-1590 in_progress). The billing setup described below documents the old fork-specific implementation and may be partially or fully stale until restoration completes.*

Set two environment variables: `STRIPE_SECRET_KEY` (your Stripe secret key) and `STRIPE_WEBHOOK_SECRET` (your Stripe webhook signing secret). See the [Billing Setup Guide](/guides/board-operator/billing-setup) for step-by-step instructions.

### "Why can't I create a subscription?"

Billing mutations (create, update, cancel, reactivate) require **board user** access. Agents are explicitly blocked from billing changes — they receive `403 Forbidden`. Make sure you're using a board user session or API key.

### "Can I change my subscription tier?"

Yes — upgrade or downgrade at any time via the Billing page or the `PATCH /api/companies/{companyId}/billing/subscription` endpoint. Changes take effect immediately with prorated billing.

### "What happens when I cancel?"

Cancellation takes effect at the end of the current billing period. You retain access until then. You can reactivate before the period ends.

## Notifications

### "How do I set up email notifications?"

Configure SMTP credentials as environment variables: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`. Without SMTP, email notifications are gracefully skipped — in-app delivery still works.

### "How do I enable web push notifications?"

Generate VAPID keys with `npx web-push generate-vapid-keys` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` as environment variables. Users then enable push from the notification preferences page.

### "Why am I not getting notifications?"

Check your notification preferences at **Settings → Notifications**. Each notification type can be configured per channel (in-app, email, web push) with independent digest settings (instant, daily, weekly, or never).

### "Can agents send notifications?"

Yes — agents can send notifications to users in their own company via the `POST /notifications/send` endpoint. They cannot send to another company.

## Marketplace

### "How do I hire a marketplace agent?"

Browse agents at **Agents → Marketplace** (or `/company/templates`). Click an agent to see details, then click **Hire to Company**. You can customize the name and adapter type before confirming.

### "What permissions do I need to hire an agent?"

You need the `agents:create` permission on the company. If the company has `requireBoardApprovalForNewAgents` enabled, the hire goes through the approval workflow instead.

### "Can I customize a hired agent?"

Yes — from the agent detail page you can edit the name, adapter type, adapter config, test the environment, and set the budget.

## Templates

### "What templates are available?"

Paperclip ships with four templates: **Travel Concierge** (Travel & Hospitality), **Support Ops** (SaaS & Customer Support), **Engineering Team** (Software Engineering), and **CPA Firm** (Finance & Accounting).

### "What does a template create?"

A complete company: agents with skills, knowledge starter pack, company goal, onboarding project, and a starter issue. Deployment is atomic — if anything fails, everything rolls back.

### "Can I customize a template before deploying?"

You can override the company name and set a monthly budget. After deployment, you can customize individual agents, add more agents from the marketplace, and modify the goal.

## Knowledge Starter Packs

### "What are knowledge starter packs?"

Pre-curated bundles of knowledge documents for common industries. Instead of creating knowledge documents from scratch, install a pack to give your agents immediate industry context.

### "How do I install a starter pack?"

Via the API: `POST /api/companies/{companyId}/knowledge/starter-packs/{packKey}/install`. Or deploy a template company that includes a starter pack — it's installed automatically.

### "Can I create my own starter packs?"

Yes — server operators can add custom packs by creating JSON files in `server/src/knowledge-starter-packs-data/`.

## Troubleshooting

### "My agent isn't doing anything after I created the company"

Check in order:
1. **Is the agent's heartbeat enabled?** Go to the agent detail page and check the status. If paused, resume it.
2. **Is there a pending approval?** Check the approval queue.
3. **Does the agent have budget?** If budget is 0, set a monthly budget in company settings.
4. **Is the adapter configured correctly?** Click "Test Environment" on the agent detail page.

### "I see 403 errors"

In `local_trusted` mode, make sure you're accessing via `localhost` or the loopback address. In `authenticated` mode, check that your session is valid.

### "The server won't start"

Common causes:
- Missing environment variables (check the [Environment Variables](/deploy/environment-variables) reference)
- Port already in use (change `PORT` or stop the other process)
- Database connection issues (check `DATABASE_URL`)

### "How do I update the docs?"

The docs are Mintlify-based. Run `npx mintlify dev` from the `docs/` directory to preview changes. The docs auto-deploy via Mintlify Cloud when merged to the main branch.

## Related

- **[Run Your First AI Company](/start/your-first-company)** — SaaS quickstart (just a browser)
- [Quickstart](/start/quickstart) — self-hosted setup guide
- [Billing Setup Guide](/guides/board-operator/billing-setup) — Stripe configuration
- [Notification Configuration](/guides/board-operator/notification-configuration) — SMTP and VAPID setup
- [Environment Variables Reference](/deploy/environment-variables) — full configuration reference