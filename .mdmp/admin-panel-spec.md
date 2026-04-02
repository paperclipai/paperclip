# IronWorks Admin Panel Specification

**Document**: `.mdmp/admin-panel-spec.md`
**Status**: Draft
**Date**: 2026-04-01
**Author**: Product Architecture

---

## 1. Overview

The admin panel provides Steel Motion LLC (the platform operator) with full visibility into all customer companies, platform health, billing, security, and support across the multi-tenant IronWorks instance. It lives at `/admin/` as a top-level route tree, completely separate from company-scoped routes (`/:companyPrefix/...`) and instance settings (`/instance/settings/...`).

### Guiding Principles

- **Operator-only**: Visible exclusively to users with `instance_admin` role in `instance_user_roles`. Regular company admins/owners never see it.
- **Read-heavy, write-cautious**: Most views are dashboards and tables. Destructive actions (delete company, disable user) require a confirmation dialog with typed confirmation.
- **Cross-company**: Every query in the admin panel omits the `companyId` tenant filter. This is the only place in the app where cross-tenant reads are allowed.
- **Mobile-responsive**: All tables collapse to card-list on screens < 768px. Charts stack vertically. Sidebar collapses to bottom nav on mobile (same pattern as company views).

---

## 2. Access Control

### Route Guard

```
Route: /admin/*
Guard: requireInstanceAdmin middleware
Redirect: /admin/* -> / (with toast "Admin access required") if not instance_admin
```

### Data Source

- **Table**: `instance_user_roles`
- **Check**: `role = 'instance_admin'` for current `userId`
- **Existing service**: `accessService.isInstanceAdmin(userId)` in `server/src/services/access.ts`
- **Existing middleware**: `actorMiddleware` already resolves `req.actor.isInstanceAdmin` from session or board key in `server/src/middleware/auth.ts`

### Server-Side Enforcement

Every `/api/admin/*` route handler must call:

```typescript
function assertInstanceAdmin(req: Request) {
  if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
    throw forbidden("Instance admin access required");
  }
}
```

This mirrors the existing `assertCanManageInstanceSettings` pattern in `server/src/routes/instance-settings.ts`.

### UI Visibility

- Admin link appears in the CompanyRail (left-most rail) only when `useMeAccess().isInstanceAdmin === true`.
- Icon: `Shield` (lucide). Position: bottom of rail, above the theme toggle.
- No admin link is shown in the company Sidebar or InstanceSidebar.

---

## 3. Architecture

### Route Structure

The admin panel is a **separate route tree** under `CloudAccessGate`, parallel to `instance/settings` and `/:companyPrefix`:

```
/admin                   -> redirect to /admin/dashboard
/admin/dashboard         -> AdminDashboard
/admin/companies         -> AdminCompanies (list)
/admin/companies/:id     -> AdminCompanyDetail
/admin/users             -> AdminUsers (list)
/admin/users/:id         -> AdminUserDetail
/admin/billing           -> AdminBilling
/admin/monitoring        -> AdminMonitoring
/admin/security          -> AdminSecurity
/admin/support           -> AdminSupport
```

### Layout

Reuses `<Layout />` with a new `<AdminSidebar />` component (same pattern as `InstanceSidebar`). The admin sidebar shows:

| Icon | Label | Path |
|------|-------|------|
| LayoutDashboard | Dashboard | /admin/dashboard |
| Building2 | Companies | /admin/companies |
| Users | Users | /admin/users |
| CreditCard | Billing | /admin/billing |
| Activity | Monitoring | /admin/monitoring |
| ShieldCheck | Security | /admin/security |
| LifeBuoy | Support | /admin/support |

### API Routes

All admin API routes are prefixed `/api/admin/` and grouped in a new `server/src/routes/admin.ts` file:

```
GET  /api/admin/dashboard/stats
GET  /api/admin/companies
GET  /api/admin/companies/:id
GET  /api/admin/companies/:id/agents
GET  /api/admin/companies/:id/usage
PATCH /api/admin/companies/:id          (status, planTier changes)
DELETE /api/admin/companies/:id         (GDPR cascade)
POST /api/admin/companies/:id/export
GET  /api/admin/users
GET  /api/admin/users/:id
PATCH /api/admin/users/:id              (disable/enable, password reset)
GET  /api/admin/billing/overview
GET  /api/admin/billing/subscriptions
GET  /api/admin/monitoring/metrics
GET  /api/admin/monitoring/errors
GET  /api/admin/security/audit-log
GET  /api/admin/security/sessions
GET  /api/admin/security/login-attempts
POST /api/admin/security/ip-blocklist
GET  /api/admin/support/alerts
```

---

## 4. Section Specifications

### 4.1 Dashboard (`/admin/dashboard`)

The operator's at-a-glance health check. Everything on this page is cross-tenant.

#### Top Row: Key Metrics (4 cards)

| Card | Metric | Data Source | Format |
|------|--------|-------------|--------|
| Total Companies | `COUNT(*)` from `companies` where `status != 'deleted'` | `companies` table | Integer |
| Total Agents | `COUNT(*)` from `agents` where `status NOT IN ('terminated')` | `agents` table | Integer |
| Total Users | `COUNT(*)` from `user` (auth table) | `user` table (Better Auth) | Integer |
| MRR | `SUM` of plan tier prices for active subscriptions | `company_subscriptions` where `status = 'active'` | Dollar amount |

#### Second Row: Operational Metrics (4 cards)

| Card | Metric | Data Source | Format |
|------|--------|-------------|--------|
| Active Agents Now | `COUNT(*)` from `agents` where `status = 'running'` | `agents` table | Integer with green/yellow/red dot |
| Runs Today | `COUNT(*)` from `heartbeat_runs` where `started_at >= start_of_today_CT` | `heartbeat_runs` table | Integer |
| Total Spend Today | `SUM(cost_cents)` from `cost_events` where `occurred_at >= start_of_today_CT` | `cost_events` table | Dollar amount |
| Error Rate (24h) | `COUNT(status='error') / COUNT(*)` from `heartbeat_runs` where `started_at >= now - 24h` | `heartbeat_runs` table | Percentage with color coding (green < 5%, yellow 5-15%, red > 15%) |

#### Third Row: Charts (2 columns on desktop, stacked on mobile)

| Chart | Type | Data Source | Time Range |
|-------|------|-------------|------------|
| Runs per Day | Bar chart | `heartbeat_runs` grouped by date, last 30 days | 30 days |
| Revenue by Tier | Donut/pie | `company_subscriptions` grouped by `plan_tier` | Current |

#### Fourth Row: Lists (2 columns on desktop, stacked on mobile)

| List | Columns | Data Source | Limit |
|------|---------|-------------|-------|
| Top Companies by Spend (MTD) | Company name, Spend ($), Agent count | `cost_events` aggregated by `company_id`, month-to-date, joined with `companies` | Top 5 |
| Recent Signups | Company name, Created date, Plan tier | `companies` ORDER BY `created_at` DESC, joined with `company_subscriptions` | Last 10 |

#### Fifth Row: Alerts Banner

| Alert Type | Condition | Data Source | Severity |
|------------|-----------|-------------|----------|
| Budget Exceeded | Any company where `spent_monthly_cents > budget_monthly_cents` AND `budget_monthly_cents > 0` | `companies` table | Warning (yellow) |
| Agent Failures | Any agent with `status = 'error'` | `agents` table | Error (red) |
| Open Budget Incidents | `budget_incidents` where `status = 'open'` | `budget_incidents` table | Warning (yellow) |
| Failed Payments | `company_subscriptions` where `status = 'past_due'` | `company_subscriptions` table | Error (red) |
| Paused Companies | `companies` where `status = 'paused'` | `companies` table | Info (blue) |

Each alert row is clickable and navigates to the relevant admin sub-page.

#### Actions

- Refresh button (refetches all queries)
- Time range selector for charts (7d / 30d / 90d)

---

### 4.2 Companies (`/admin/companies`)

#### List View

**Table Columns:**

| Column | Source | Sortable | Filterable |
|--------|--------|----------|------------|
| Name | `companies.name` | Yes | Text search |
| Issue Prefix | `companies.issuePrefix` | Yes | No |
| Status | `companies.status` | Yes | Dropdown: active, paused, deleted |
| Plan Tier | `company_subscriptions.planTier` | Yes | Dropdown: starter, professional, enterprise |
| Agents | `COUNT(agents)` where `status != 'terminated'` for company | Yes | No |
| Users | `COUNT(company_memberships)` where `principal_type = 'user'` and `status = 'active'` | Yes | No |
| MTD Spend | `SUM(cost_events.cost_cents)` for current month | Yes | No |
| Monthly Budget | `companies.budgetMonthlyCents` | Yes | No |
| Created | `companies.createdAt` | Yes | Date range |

**Row Actions (dropdown menu):**

| Action | Description | Confirmation |
|--------|-------------|-------------|
| View Details | Navigate to `/admin/companies/:id` | None |
| Upgrade/Downgrade Tier | Opens plan tier selector dialog | Yes |
| Pause Company | Sets `companies.status = 'paused'`, `paused_at = now()`, requires reason | Yes, with reason text |
| Resume Company | Sets `companies.status = 'active'`, clears `paused_at` and `pause_reason` | Yes |
| Export Data | Triggers full company data export (reuses existing `/company/export` logic cross-company) | Yes |
| Delete Company | GDPR cascade delete: removes all company data across all tables with `company_id` FK | Yes, type company name to confirm |

**Bulk Actions:**

- Select multiple companies via checkbox column
- Bulk pause / bulk resume

**Mobile**: Table collapses to card list showing Name, Status badge, Plan badge, and MTD Spend. Tap to expand or navigate.

#### Company Detail View (`/admin/companies/:id`)

Tabbed view with:

**Overview Tab:**
- Company info card (name, prefix, brand color, created date, status)
- Subscription card (plan tier, Polar customer ID, period dates, cancel status)
- Budget card (monthly budget, MTD spend, percentage used with progress bar)
- Quick stats row: agent count, user count, issue count, run count (30d)

**Agents Tab:**
- Same table as the company's own Agents page, but read-only from admin perspective
- Columns: Name, Role, Status, Last Heartbeat, MTD Spend
- Action: Force-pause agent, Force-terminate agent

**Users Tab:**
- Members of this company from `company_memberships`
- Columns: User Name, Email, Membership Role, Status, Joined Date
- Action: Remove from company, Change role

**Issues Tab:**
- All issues for this company
- Columns: Identifier, Title, Status, Priority, Assignee, Created
- Read-only (admin observes, does not modify customer issues)

**Usage Tab:**
- Cost events chart (line chart, last 30 days)
- Cost breakdown by agent (bar chart)
- Cost breakdown by provider (donut chart)
- Table of recent cost events (last 100)
- Data source: `cost_events` and `finance_events` filtered by `company_id`

**Activity Tab:**
- Recent activity log entries for this company
- Data source: `activity_log` filtered by `company_id`
- Columns: Timestamp, Actor, Action, Entity, Details

---

### 4.3 Users (`/admin/users`)

#### List View

**Table Columns:**

| Column | Source | Sortable | Filterable |
|--------|--------|----------|------------|
| Name | `user.name` | Yes | Text search |
| Email | `user.email` | Yes | Text search |
| Email Verified | `user.emailVerified` | No | Dropdown: yes/no |
| Companies | `COUNT(company_memberships)` where `principal_type = 'user'` | Yes | No |
| Instance Admin | `instance_user_roles` check | No | Dropdown: yes/no |
| Last Login | `session.createdAt` (most recent) | Yes | No |
| Created | `user.createdAt` | Yes | Date range |
| Status | Derived: active if has non-expired session in last 30d, otherwise inactive | No | Dropdown: active/inactive |

**Row Actions:**

| Action | Description | Confirmation |
|--------|-------------|-------------|
| View Details | Navigate to `/admin/users/:id` | None |
| Disable Account | Revokes all sessions, prevents new logins. Does not delete data. | Yes |
| Enable Account | Re-enables login capability | Yes |
| Reset Password | Sends password reset email via Better Auth | Yes |
| Promote to Instance Admin | Calls `accessService.promoteInstanceAdmin(userId)` | Yes |
| Demote from Instance Admin | Calls `accessService.demoteInstanceAdmin(userId)` | Yes, cannot demote self |

**Mobile**: Card list showing Name, Email, Company count badge, Admin badge.

#### User Detail View (`/admin/users/:id`)

- User info card (name, email, verified status, created date, image)
- Instance admin status with toggle
- Company memberships table: Company Name, Role, Status, Joined Date, with actions to remove or change role
- Active sessions table: Session ID (truncated), IP Address, User Agent, Created, Expires
- Recent activity: last 50 activity log entries where `actor_type = 'user'` and `actor_id = userId`

---

### 4.4 Billing (`/admin/billing`)

#### Overview Cards (top row)

| Card | Metric | Data Source |
|------|--------|-------------|
| MRR | Sum of monthly prices for all `company_subscriptions` where `status = 'active'` | `company_subscriptions` + plan tier pricing map |
| Active Subscriptions | `COUNT(*)` where `status = 'active'` | `company_subscriptions` |
| Trials | `COUNT(*)` where `status = 'trialing'` AND `trial_ends_at > now()` | `company_subscriptions` |
| Past Due | `COUNT(*)` where `status = 'past_due'` | `company_subscriptions` |
| Churned (30d) | `COUNT(*)` where `status = 'canceled'` AND `updated_at >= now - 30d` | `company_subscriptions` |

MRR calculation uses the plan tier pricing map (defined in the codebase's pricing constants):

| Tier | Monthly Price |
|------|--------------|
| starter | $0 (free) |
| professional | $49 |
| enterprise | $199 |

These values should be config-driven, not hardcoded in the admin panel.

#### MRR Chart

- Line chart showing MRR over time (last 12 months)
- Data source: snapshot query -- for each month, count active subscriptions by tier and multiply by tier price
- Note: This requires either a materialized view or a scheduled job that records monthly MRR snapshots. **New table needed**: `admin_mrr_snapshots(id, month, tier, count, mrr_cents, created_at)` or compute on-the-fly from subscription status change events.

#### Subscriptions by Tier

- Donut chart: active subscriptions grouped by `plan_tier`
- Data source: `company_subscriptions` where `status = 'active'`

#### Subscriptions Table

| Column | Source | Sortable | Filterable |
|--------|--------|----------|------------|
| Company | `companies.name` (joined) | Yes | Text search |
| Plan Tier | `company_subscriptions.planTier` | Yes | Dropdown |
| Status | `company_subscriptions.status` | Yes | Dropdown: active, trialing, past_due, canceled, incomplete |
| Polar Customer ID | `company_subscriptions.polarCustomerId` | No | No |
| LLM Auth Method | `company_subscriptions.llmAuthMethod` | No | Dropdown |
| Current Period | `currentPeriodStart` - `currentPeriodEnd` | Yes | No |
| Cancel at Period End | `company_subscriptions.cancelAtPeriodEnd` | No | Dropdown: yes/no |
| Trial Ends | `company_subscriptions.trialEndsAt` | Yes | No |

**Row Actions:**

| Action | Description |
|--------|-------------|
| View in Polar | Opens `https://dashboard.polar.sh/customers/{polarCustomerId}` in new tab |
| Change Tier | Updates `planTier` locally (Polar webhook should be the source of truth for billing; this is a manual override for edge cases) |

#### External Links

- Button: "Open Polar Dashboard" -> `https://dashboard.polar.sh/` (new tab)
- Note: IronWorks uses Polar as Merchant of Record, so actual payment management (refunds, invoices, payment methods) lives in Polar. The admin panel shows subscription metadata only.

**Mobile**: Cards stack. Table collapses to card list.

---

### 4.5 Monitoring (`/admin/monitoring`)

#### Server Metrics Cards (top row)

| Card | Metric | Data Source | Update Interval |
|------|--------|-------------|----------------|
| CPU Usage | Current % | Node.js `os.cpus()` via `/api/admin/monitoring/metrics` | 30s polling |
| Memory Usage | Used / Total | Node.js `os.totalmem()` / `os.freemem()` | 30s polling |
| Disk Usage | Used / Total | `df` command output or `statvfs` via server endpoint | 5min polling |
| Uptime | Process uptime | `process.uptime()` | 30s polling |
| DB Size | Total database size | `SELECT pg_database_size(current_database())` | 5min polling |

Each card shows a spark-line (last 1 hour of data points). Color coding: green < 70%, yellow 70-90%, red > 90%.

**New requirement**: The server needs to collect and store or cache these metrics. Options:
1. **In-memory ring buffer** (simplest): keep last 120 data points (1 hour at 30s intervals) in server memory. Lost on restart.
2. **New table** `admin_server_metrics(id, metric, value, recorded_at)`: persistent but adds DB load.

Recommendation: In-memory ring buffer for v1. Persistent metrics in v2 if needed.

#### Database Growth Chart

- Line chart: DB size over time (last 30 days)
- Data source: Daily snapshot stored in `admin_server_metrics` or computed from pg_stat_user_tables
- Fallback for v1: show current size only, no history

#### Agent Run Statistics

| Metric | Data Source |
|--------|-------------|
| Runs Today | `COUNT(heartbeat_runs)` where `started_at >= today_CT` |
| Success Rate (24h) | `COUNT(status='completed') / COUNT(*)` where `started_at >= now - 24h` |
| Avg Duration (24h) | `AVG(finished_at - started_at)` where both non-null, last 24h |
| Currently Running | `COUNT(heartbeat_runs)` where `status = 'running'` |
| Queued | `COUNT(heartbeat_runs)` where `status = 'queued'` |

#### Runs Over Time Chart

- Stacked bar chart: completed (green) / error (red) / other (gray) per day, last 30 days
- Data source: `heartbeat_runs` grouped by date and status

#### API Request Volume

- Line chart: requests per hour, last 24 hours
- Data source: In-memory counter in Express middleware, or external tool (e.g., nginx access logs)
- v1 approach: Simple request counter middleware that buckets by hour in memory

#### Error Log

**Table Columns:**

| Column | Source |
|--------|--------|
| Timestamp | `heartbeat_runs.finishedAt` or `heartbeat_runs.createdAt` |
| Company | `companies.name` (joined via `heartbeat_runs.companyId`) |
| Agent | `agents.name` (joined via `heartbeat_runs.agentId`) |
| Error Code | `heartbeat_runs.errorCode` |
| Error Message | `heartbeat_runs.error` (truncated to 200 chars) |
| Exit Code | `heartbeat_runs.exitCode` |
| Run ID | `heartbeat_runs.id` (link to run detail) |

- Filter: `heartbeat_runs` where `status = 'error'` ORDER BY `finished_at` DESC LIMIT 100
- Expandable rows to show full error text, stderr excerpt
- Action: Link to run transcript in company context

**Mobile**: Cards for server metrics. Charts stack. Error log shows as card list.

---

### 4.6 Security (`/admin/security`)

#### Audit Log

Records every admin action. **New table required**:

```sql
CREATE TABLE admin_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,          -- e.g. 'company.paused', 'user.disabled', 'tier.changed'
  target_type TEXT NOT NULL,     -- 'company', 'user', 'subscription'
  target_id TEXT NOT NULL,
  details JSONB,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_log_user_idx ON admin_audit_log(user_id, created_at DESC);
CREATE INDEX admin_audit_log_action_idx ON admin_audit_log(action, created_at DESC);
```

**Table Columns:**

| Column | Sortable | Filterable |
|--------|----------|------------|
| Timestamp | Yes | Date range |
| Admin User | Yes | Dropdown (instance admins) |
| Action | Yes | Dropdown |
| Target | No | Text search |
| Details | No | No |
| IP Address | No | Text search |

Every mutating action in `/api/admin/*` routes writes to this table.

#### Login Attempts

**Data source**: Better Auth tracks sessions. For failed attempts, we need a **new table**:

```sql
CREATE TABLE admin_login_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  success BOOLEAN NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  failure_reason TEXT,           -- 'invalid_password', 'account_disabled', 'rate_limited'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_login_attempts_email_idx ON admin_login_attempts(email, created_at DESC);
CREATE INDEX admin_login_attempts_ip_idx ON admin_login_attempts(ip_address, created_at DESC);
```

**Table Columns:**

| Column | Source |
|--------|--------|
| Timestamp | `created_at` |
| Email | `email` |
| Success | Boolean badge (green/red) |
| IP Address | `ip_address` |
| User Agent | `user_agent` (truncated) |
| Failure Reason | `failure_reason` |

- Default filter: last 7 days
- Highlight rows with > 5 failed attempts from same IP in red

#### Active Sessions

**Data source**: `session` table (Better Auth)

**Table Columns:**

| Column | Source |
|--------|--------|
| User | `user.name` + `user.email` (joined via `session.userId`) |
| IP Address | `session.ipAddress` |
| User Agent | `session.userAgent` (parsed to show browser/OS) |
| Created | `session.createdAt` |
| Expires | `session.expiresAt` |
| Status | Derived: active if `expiresAt > now()`, expired otherwise |

**Actions:**
- Revoke Session: deletes the session row, forcing re-login
- Revoke All Sessions for User: deletes all sessions for a user

#### IP Blocklist

**New table required**:

```sql
CREATE TABLE admin_ip_blocklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip_address TEXT NOT NULL UNIQUE,
  reason TEXT,
  blocked_by_user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ,       -- NULL = permanent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Table Columns:** IP Address, Reason, Blocked By, Expires, Created

**Actions:**
- Add IP to blocklist (dialog: IP, reason, duration or permanent)
- Remove from blocklist
- Server middleware checks this table on every request (cached in memory, refreshed every 60s)

**Mobile**: All tables collapse to card lists. Audit log is most important -- keep it usable on mobile.

---

### 4.7 Support (`/admin/support`)

The support triage view surfaces items that need operator attention across all companies.

#### Alerts Summary Cards (top row)

| Card | Metric | Data Source |
|------|--------|-------------|
| Open Budget Incidents | `COUNT(budget_incidents)` where `status = 'open'` | `budget_incidents` |
| Agents in Error | `COUNT(agents)` where `status = 'error'` | `agents` |
| Paused Agents | `COUNT(agents)` where `status = 'paused'` | `agents` |
| Paused Companies | `COUNT(companies)` where `status = 'paused'` | `companies` |
| Failed Payments | `COUNT(company_subscriptions)` where `status = 'past_due'` | `company_subscriptions` |

#### Budget Incidents Table

| Column | Source |
|--------|--------|
| Company | `companies.name` (joined) |
| Scope | `budget_incidents.scopeType` + scope name (agent or company) |
| Metric | `budget_incidents.metric` |
| Threshold | `budget_incidents.thresholdType` |
| Limit | `budget_incidents.amountLimit` (formatted as dollars) |
| Observed | `budget_incidents.amountObserved` (formatted as dollars) |
| Status | `budget_incidents.status` |
| Created | `budget_incidents.createdAt` |

**Actions:** Dismiss incident, Navigate to company detail

#### Error Agents Table

| Column | Source |
|--------|--------|
| Company | `companies.name` |
| Agent | `agents.name` |
| Status | `agents.status` |
| Last Heartbeat | `agents.lastHeartbeatAt` |
| Pause Reason | `agents.pauseReason` |
| Last Error | Most recent `heartbeat_runs.error` for this agent |

**Actions:** Force-resume agent, Navigate to agent detail (in company context)

#### Companies Over Budget

| Column | Source |
|--------|--------|
| Company | `companies.name` |
| Budget | `companies.budgetMonthlyCents` (formatted) |
| Spent | `companies.spentMonthlyCents` (formatted) |
| Overage | `spent - budget` (formatted, red text) |
| Agent Count | Count of agents |

Filter: only companies where `spent_monthly_cents > budget_monthly_cents` AND `budget_monthly_cents > 0`.

#### Subscription Issues

Companies with `past_due` or `incomplete` subscription status.

| Column | Source |
|--------|--------|
| Company | `companies.name` |
| Plan Tier | `company_subscriptions.planTier` |
| Status | `company_subscriptions.status` |
| Period End | `company_subscriptions.currentPeriodEnd` |

**Actions:** Navigate to billing tab filtered to this company, Open in Polar

**Mobile**: Alert cards at top, then each section as a collapsible accordion.

---

## 5. New Database Objects Required

| Object | Type | Purpose |
|--------|------|---------|
| `admin_audit_log` | Table | Tracks all admin panel actions |
| `admin_login_attempts` | Table | Tracks auth attempts for security monitoring |
| `admin_ip_blocklist` | Table | IP-based access blocking |
| `admin_mrr_snapshots` | Table (v2) | Monthly MRR history for trending charts |

The `admin_audit_log` and `admin_login_attempts` tables are required for launch. The IP blocklist and MRR snapshots can be added iteratively.

---

## 6. New Files Required

### Server

| File | Purpose |
|------|---------|
| `server/src/routes/admin.ts` | All admin API route handlers |
| `server/src/services/admin-dashboard.ts` | Cross-tenant aggregation queries |
| `server/src/services/admin-companies.ts` | Company management (pause, delete cascade, tier change) |
| `server/src/services/admin-users.ts` | User management (disable, sessions, password reset) |
| `server/src/services/admin-monitoring.ts` | Server metrics collection, error log queries |
| `server/src/services/admin-security.ts` | Audit log, login attempts, IP blocklist, session management |
| `server/src/services/admin-support.ts` | Cross-company alert aggregation |
| `server/src/middleware/ip-blocklist.ts` | Request-level IP check middleware |
| `packages/db/src/schema/admin_audit_log.ts` | Drizzle schema for audit log |
| `packages/db/src/schema/admin_login_attempts.ts` | Drizzle schema for login attempts |
| `packages/db/src/schema/admin_ip_blocklist.ts` | Drizzle schema for IP blocklist |

### UI

| File | Purpose |
|------|---------|
| `ui/src/pages/admin/AdminDashboard.tsx` | Dashboard page |
| `ui/src/pages/admin/AdminCompanies.tsx` | Companies list |
| `ui/src/pages/admin/AdminCompanyDetail.tsx` | Company detail (tabbed) |
| `ui/src/pages/admin/AdminUsers.tsx` | Users list |
| `ui/src/pages/admin/AdminUserDetail.tsx` | User detail |
| `ui/src/pages/admin/AdminBilling.tsx` | Billing overview |
| `ui/src/pages/admin/AdminMonitoring.tsx` | Monitoring dashboard |
| `ui/src/pages/admin/AdminSecurity.tsx` | Security center |
| `ui/src/pages/admin/AdminSupport.tsx` | Support triage |
| `ui/src/components/AdminSidebar.tsx` | Admin navigation sidebar |
| `ui/src/api/admin.ts` | Admin API client functions |

---

## 7. GDPR Company Deletion Cascade

When deleting a company, the following tables must be cascaded (ordered by FK dependency):

1. `heartbeat_run_events` (via `heartbeat_runs.company_id`)
2. `heartbeat_runs`
3. `cost_events`
4. `finance_events`
5. `issue_comments`, `issue_labels`, `issue_attachments`, `issue_documents`, `issue_work_products`, `issue_approvals`, `issue_read_states`, `issue_inbox_archives`
6. `issues`
7. `approval_comments`, `approvals`
8. `agent_api_keys`, `agent_config_revisions`, `agent_runtime_state`, `agent_task_sessions`, `agent_wakeup_requests`
9. `agents`
10. `project_workspaces`, `project_goals`
11. `projects`
12. `goals`
13. `budget_incidents`, `budget_policies`
14. `company_memberships`, `company_secrets`, `company_secret_versions`, `company_logos`, `company_skills`
15. `company_subscriptions`
16. `activity_log`
17. `documents`, `document_revisions`
18. `library_files`, `library_file_events`
19. `playbook_runs`, `playbooks`
20. `routines`
21. `labels`
22. `knowledge_pages`
23. `execution_workspaces`, `workspace_operations`, `workspace_runtime_services`
24. `plugin_company_settings`, `plugin_entities`, `plugin_jobs`, `plugin_logs`, `plugin_state`
25. `messaging_bridges`
26. `invites`, `join_requests`
27. `companies` (the row itself)

This must run in a single transaction. The admin audit log entry is written OUTSIDE the transaction (so it persists even if the cascade fails). Before deletion, an export is automatically generated and stored for 30 days (GDPR data portability).

---

## 8. Responsiveness Strategy

| Breakpoint | Layout |
|------------|--------|
| >= 1280px (xl) | Full sidebar + content area with multi-column grid |
| 768-1279px (md-lg) | Collapsed sidebar (icons only) + content area |
| < 768px (sm) | No sidebar, bottom nav bar (same pattern as `MobileBottomNav`), single column, tables become card lists |

All charts use the existing `ChartCard` component pattern from the Dashboard. Tables reuse the same `DataTable` patterns used throughout the app.

---

## 9. Implementation Priority

### Phase 1 (MVP) -- Ship before first paying customer

1. Dashboard (stats cards + alerts banner, no charts)
2. Companies list + detail (overview + agents tabs)
3. Users list + basic actions (disable/enable)
4. Audit log table
5. Route guard + sidebar

### Phase 2 -- First month post-launch

6. Billing tab with Polar integration
7. Support triage view
8. Companies detail (all tabs)
9. User detail view
10. Dashboard charts

### Phase 3 -- Operational maturity

11. Monitoring tab (server metrics, error log)
12. Security tab (login attempts, IP blocklist, sessions)
13. GDPR deletion cascade
14. MRR trending charts
15. Company data export from admin

---

## 10. Open Questions

1. **MRR Calculation**: Should MRR be derived purely from Polar webhook data (source of truth) or from local `company_subscriptions` table? Recommendation: local table, synced via Polar webhooks.
2. **Server Metrics Persistence**: In-memory ring buffer vs. dedicated metrics table? Recommendation: in-memory for v1.
3. **IP Blocklist Scope**: Should it block all routes or only auth routes? Recommendation: all routes, with allowlist for health check endpoint.
4. **Company Pause Behavior**: When a company is paused, should running agents be force-stopped? Recommendation: yes, queue graceful shutdown.
5. **Admin Notifications**: Should admin users receive email/Slack notifications for critical alerts? Recommendation: yes in v2, via the existing plugin/messaging bridge system.
