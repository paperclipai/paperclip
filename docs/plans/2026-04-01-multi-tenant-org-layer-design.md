# Multi-Tenant Organization Layer — Design

**Date:** 2026-04-01
**Status:** Approved

## Problem

SixZenith manages 100+ clients with 5 staff (3 senior, 2 new). AI agents are company-scoped — no way to share agents across clients without duplicating them. No credential vault ACL. No assigner-scoped execution policies. No trust tiers for staff.

## Solution

Organization layer + agent templates/instances + credential vault ACL + assigner-tier execution policies + 2FA.

## Architecture

```
Organization
├── org_memberships (staff access)
├── agent_templates (shared skills/prompt, org-level)
│   └── template_memory (promoted lessons, human-reviewed)
│
├── Company A (client)
│   ├── Agent Instances (template_id FK, isolated HOME)
│   ├── Credentials (ACL: use/view/manage per principal)
│   ├── Projects → project_members + project_permission_grants
│   └── Issues (assigner_policy_tier snapshot)
│
├── Company B ...
└── Company C ...
```

## Database Changes

### New Tables

```sql
-- Organizations group companies under one agency
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Org-level memberships for staff
CREATE TABLE org_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, user_id)
);

-- Agent templates (org-level, shared skills/prompt)
CREATE TABLE agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'general',
  title TEXT,
  icon TEXT,
  adapter_type TEXT NOT NULL DEFAULT 'claude_local',
  adapter_config JSONB NOT NULL DEFAULT '{}',
  system_prompt TEXT,
  skills JSONB NOT NULL DEFAULT '[]',
  approval_policy JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-credential access control
CREATE TABLE credential_access_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES provider_credentials(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'use',
  granted_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(credential_id, principal_type, principal_id)
);
```

### Modified Tables

```sql
-- Companies belong to an organization
ALTER TABLE companies
  ADD COLUMN organization_id UUID REFERENCES organizations(id);

-- Agents can be instances of a template
ALTER TABLE agents
  ADD COLUMN template_id UUID REFERENCES agent_templates(id);

-- Issues snapshot the assigner's permission tier
ALTER TABLE issues
  ADD COLUMN assigner_policy_tier TEXT;

-- Heartbeat runs track applied policy
ALTER TABLE heartbeat_runs
  ADD COLUMN applied_policy_tier TEXT,
  ADD COLUMN applied_policy_snapshot JSONB;
```

### New Permission Keys

```typescript
// Company-level
"credentials:view"     // Can reveal raw credential values (gated by credential_access_grants)

// Org-level (future)
"org:manage"           // Can add/remove companies from org
"org:templates:manage" // Can manage agent templates
```

## Assigner-Tier Execution Policy

When a staff member assigns work to an agent:
1. Snapshot their `membershipRole` as `assigner_policy_tier` on the issue (atomic, same transaction)
2. Agent-created sub-issues inherit tier from parent issue via `parentId` walk
3. Null tier = most restrictive (restricted)
4. Tier determines what the agent can auto-approve vs needs owner approval

| Tier | Auto-approve | Needs approval |
|------|-------------|---------------|
| restricted | read, analyze, comment | everything else |
| standard | read, analyze, comment, code, pr_create | deploy, merge, credential_use |
| senior | everything | production_deploy |
| owner | everything | nothing |

## Credential Vault ACL

- `use`: agent can use credential at runtime (current behavior)
- `view`: human can reveal raw credential value via API
- `manage`: human can create/update/delete the credential

`GET /credentials/:id/reveal` — rate-limited, audit-logged, requires `view` access grant.

## Security: Agent Project Bypass Fix

Remove `authz.ts:105-109` bypass. Agents get project-scoped API access based on the issue's projectId. This is a 2-line fix that closes the largest existing exploit surface.

## Phase 2: OpenShell Integration

Use NVIDIA OpenShell as the per-run sandbox layer:
- Kernel-level filesystem isolation
- Network egress allowlists
- Process execution control
- Deny-by-default policy engine
- Paperclip generates OpenShell policy YAML per run based on assigner tier + company scope
