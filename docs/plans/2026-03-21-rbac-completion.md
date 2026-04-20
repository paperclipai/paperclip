# RBAC Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close all RBAC enforcement gaps so the team can safely collaborate with proper permission boundaries.

**Architecture:** Add 2 new permission keys (`issues:manage`, `company:export`), create a shared `requirePermission()` helper in authz.ts, enforce permissions on all unprotected write routes (issues CRUD, company export/import), add role presets (owner/admin/member/viewer) for easy onboarding, and auto-grant agent permissions based on role.

**Tech Stack:** TypeScript, Express, Drizzle ORM, existing `accessService`

---

### Task 1: Add new permission keys to shared constants

**Files:**
- Modify: `packages/shared/src/constants.ts:227-241`

**Step 1: Add the new keys**

In `packages/shared/src/constants.ts`, add `"issues:manage"` and `"company:export"` to the `PERMISSION_KEYS` array:

```typescript
export const PERMISSION_KEYS = [
  "agents:create",
  "users:invite",
  "users:manage_permissions",
  "tasks:assign",
  "tasks:assign_scope",
  "joins:approve",
  "projects:manage",
  "goals:manage",
  "secrets:manage",
  "credentials:manage",
  "company:settings",
  "company:export",
  "approvals:review",
  "issues:manage",
] as const;
```

**Step 2: Verify TypeScript compiles**

Run: `cd /workspace/paperclip && npx turbo build --filter=@paperclipai/shared 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat(rbac): add issues:manage and company:export permission keys"
```

---

### Task 2: Add role presets to shared package

**Files:**
- Create: `packages/shared/src/role-presets.ts`
- Modify: `packages/shared/src/index.ts:239` (add export)

**Step 1: Create role presets file**

Create `packages/shared/src/role-presets.ts`:

```typescript
import type { PermissionKey } from "./constants.js";

export interface RolePreset {
  id: string;
  label: string;
  description: string;
  permissions: PermissionKey[];
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: "owner",
    label: "Owner",
    description: "Full access to all company features",
    permissions: [
      "agents:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
      "tasks:assign_scope",
      "joins:approve",
      "projects:manage",
      "goals:manage",
      "secrets:manage",
      "credentials:manage",
      "company:settings",
      "company:export",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Manage agents, issues, projects, and team members",
    permissions: [
      "agents:create",
      "users:invite",
      "users:manage_permissions",
      "tasks:assign",
      "joins:approve",
      "projects:manage",
      "goals:manage",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "member",
    label: "Member",
    description: "Create and manage issues, assign tasks",
    permissions: [
      "tasks:assign",
      "projects:manage",
      "goals:manage",
      "approvals:review",
      "issues:manage",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    description: "Read-only access to company data",
    permissions: [],
  },
];

/** Map agent roles to default permission grants */
export const AGENT_ROLE_DEFAULT_PERMISSIONS: Record<string, PermissionKey[]> = {
  ceo: [
    "agents:create",
    "tasks:assign",
    "tasks:assign_scope",
    "projects:manage",
    "goals:manage",
    "approvals:review",
    "issues:manage",
  ],
  cto: [
    "agents:create",
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  pm: [
    "tasks:assign",
    "projects:manage",
    "goals:manage",
    "issues:manage",
  ],
  engineer: [
    "tasks:assign",
    "issues:manage",
  ],
  qa: [
    "tasks:assign",
    "issues:manage",
  ],
  devops: [
    "tasks:assign",
    "issues:manage",
  ],
  designer: [
    "issues:manage",
  ],
  researcher: [
    "issues:manage",
  ],
  general: [
    "issues:manage",
  ],
};
```

**Step 2: Export from shared index**

In `packages/shared/src/index.ts`, add after the AGENT_PRESETS export line:

```typescript
export { ROLE_PRESETS, AGENT_ROLE_DEFAULT_PERMISSIONS, type RolePreset } from "./role-presets.js";
```

**Step 3: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=@paperclipai/shared 2>&1 | tail -5`
Expected: Build succeeds

**Step 4: Commit**

```bash
git add packages/shared/src/role-presets.ts packages/shared/src/index.ts
git commit -m "feat(rbac): add role presets (owner/admin/member/viewer) and agent role default permissions"
```

---

### Task 3: Extract shared `requirePermission` helper to authz.ts

**Files:**
- Modify: `server/src/routes/authz.ts`

**Step 1: Add requirePermission to authz.ts**

The existing `assertCompanyPermission` in access.ts (line 1602) is local to a closure. Create a shared version in authz.ts that accepts an access service return type. Add these imports and the function to `server/src/routes/authz.ts`:

```typescript
import type { Request } from "express";
import type { PermissionKey } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";

// ... existing assertBoard, assertCompanyAccess, getActorInfo ...

type AccessChecker = {
  canUser: (companyId: string, userId: string | null | undefined, permissionKey: PermissionKey) => Promise<boolean>;
  hasPermission: (companyId: string, principalType: "user" | "agent", principalId: string, permissionKey: PermissionKey) => Promise<boolean>;
};

export async function requirePermission(
  req: Request,
  access: AccessChecker,
  companyId: string,
  permissionKey: PermissionKey,
) {
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await access.hasPermission(companyId, "agent", req.actor.agentId, permissionKey);
    if (!allowed) throw forbidden(`Missing permission: ${permissionKey}`);
    return;
  }
  if (req.actor.type !== "board") throw unauthorized();
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const allowed = await access.canUser(companyId, req.actor.userId, permissionKey);
  if (!allowed) throw forbidden(`Missing permission: ${permissionKey}`);
}
```

**Step 2: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=server 2>&1 | tail -10`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add server/src/routes/authz.ts
git commit -m "feat(rbac): add shared requirePermission helper to authz"
```

---

### Task 4: Enforce RBAC on issues routes

**Files:**
- Modify: `server/src/routes/issues.ts`

**Step 1: Add import**

Add `requirePermission` to the import from authz:

```typescript
import { assertCompanyAccess, getActorInfo, requirePermission } from "./authz.js";
```

**Step 2: Add permission check to issue creation (line ~409)**

In the `POST /companies/:companyId/issues` handler, after `assertCompanyAccess(req, companyId)`, add:

```typescript
await requirePermission(req, access, companyId, "issues:manage");
```

Note: The existing `assertCanAssignTasks` call for assignee changes stays — it's an additional check on top.

**Step 3: Add permission check to issue update (line ~452)**

In the `PATCH /issues/:id` handler, after `assertCompanyAccess(req, existing.companyId)`, add:

```typescript
await requirePermission(req, access, existing.companyId, "issues:manage");
```

**Step 4: Add permission check to issue delete (line ~621)**

In the `DELETE /issues/:id` handler, after `assertCompanyAccess(req, existing.companyId)`, add:

```typescript
await requirePermission(req, access, existing.companyId, "issues:manage");
```

**Step 5: Add permission check to label creation (line ~239)**

In the `POST /companies/:companyId/labels` handler, after `assertCompanyAccess(req, companyId)`, add:

```typescript
await requirePermission(req, access, companyId, "issues:manage");
```

**Step 6: Add permission check to label deletion (line ~258)**

In the `DELETE /labels/:labelId` handler, after `assertCompanyAccess(req, existing.companyId)`, add:

```typescript
await requirePermission(req, access, existing.companyId, "issues:manage");
```

**Step 7: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=server 2>&1 | tail -10`
Expected: Build succeeds

**Step 8: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat(rbac): enforce issues:manage permission on issue and label CRUD"
```

---

### Task 5: Enforce RBAC on company export/import

**Files:**
- Modify: `server/src/routes/companies.ts`

**Step 1: Add imports**

Add `requirePermission` to the authz import:

```typescript
import { assertBoard, assertCompanyAccess, getActorInfo, requirePermission } from "./authz.js";
```

**Step 2: Add permission check to export (line ~65)**

In the `POST /:companyId/export` handler, after `assertCompanyAccess(req, companyId)`, add:

```typescript
await requirePermission(req, access, companyId, "company:export");
```

**Step 3: Add permission check to import preview (line ~72)**

In the `POST /import/preview` handler, when target mode is `existing_company`, add the permission check:

```typescript
router.post("/import/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      const companyId = req.body.target.companyId;
      await requirePermission(req, access, companyId, "company:export");
    } else {
      assertBoard(req);
      // New company import requires instance admin
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        throw forbidden("Instance admin required for new company import");
      }
    }
    const preview = await portability.previewImport(req.body);
    res.json(preview);
  });
```

**Step 4: Add permission check to import (line ~82)**

Same pattern for the `POST /import` handler:

```typescript
router.post("/import", validate(companyPortabilityImportSchema), async (req, res) => {
    if (req.body.target.mode === "existing_company") {
      const companyId = req.body.target.companyId;
      await requirePermission(req, access, companyId, "company:export");
    } else {
      assertBoard(req);
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        throw forbidden("Instance admin required for new company import");
      }
    }
    // ... rest of handler unchanged
```

**Step 5: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=server 2>&1 | tail -10`
Expected: Build succeeds

**Step 6: Commit**

```bash
git add server/src/routes/companies.ts
git commit -m "feat(rbac): enforce company:export permission on export/import routes"
```

---

### Task 6: Auto-grant agent permissions on creation

**Files:**
- Modify: `server/src/routes/agents.ts` (find the agent creation handler)
- Uses: `AGENT_ROLE_DEFAULT_PERMISSIONS` from shared

**Step 1: Add imports**

Add to the imports in agents.ts:

```typescript
import { AGENT_ROLE_DEFAULT_PERMISSIONS } from "@paperclipai/shared";
```

**Step 2: After agent creation, auto-grant permissions**

Find where agents are created (the POST handler that calls `svc.create()`). After the agent is created and `access.ensureMembership()` is called, add:

```typescript
const defaultPerms = AGENT_ROLE_DEFAULT_PERMISSIONS[created.role] ?? [];
if (defaultPerms.length > 0) {
  await access.setPrincipalGrants(
    companyId,
    "agent",
    created.id,
    defaultPerms.map((key) => ({ permissionKey: key })),
    req.actor.type === "board" ? (req.actor.userId ?? null) : null,
  );
}
```

This needs to happen everywhere an agent is created — check both the direct POST handler and any join-request approval flows in access.ts that create agents.

**Step 3: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=server 2>&1 | tail -10`

**Step 4: Commit**

```bash
git add server/src/routes/agents.ts
git commit -m "feat(rbac): auto-grant default permissions to agents based on role"
```

---

### Task 7: Add role preset application endpoint and owner auto-grant

**Files:**
- Modify: `server/src/routes/access.ts` (add new endpoint)

**Step 1: Add import**

Add to imports in access.ts:

```typescript
import { ROLE_PRESETS } from "@paperclipai/shared";
```

**Step 2: Add PUT endpoint for applying role presets**

Near the existing member permission endpoints (around line 2590), add:

```typescript
router.put(
  "/companies:companyId/members/:memberId/role-preset",
  async (req, res) => {
    const companyId = req.params.companyId as string;
    const memberId = req.params.memberId as string;
    await assertCompanyPermission(req, companyId, "users:manage_permissions");
    const presetId = req.body.presetId;
    if (typeof presetId !== "string") throw badRequest("presetId is required");
    const preset = ROLE_PRESETS.find((p) => p.id === presetId);
    if (!preset) throw badRequest(`Unknown role preset: ${presetId}`);
    const updated = await access.setMemberPermissions(
      companyId,
      memberId,
      preset.permissions.map((key) => ({ permissionKey: key })),
      req.actor.userId ?? null,
    );
    if (!updated) throw notFound("Member not found");
    res.json({ ...updated, appliedPreset: presetId });
  },
);
```

**Step 3: Add GET endpoint for listing available presets**

```typescript
router.get("/role-presets", (_req, res) => {
  res.json(ROLE_PRESETS);
});
```

**Step 4: Auto-grant owner permissions when creating company**

In the `POST /` handler (company creation, around line 109 of companies.ts), after `access.ensureMembership()`, add:

```typescript
// Auto-grant owner permissions to company creator
const ownerPreset = ROLE_PRESETS.find((p) => p.id === "owner");
if (ownerPreset) {
  const membership = await access.getMembership(company.id, "user", req.actor.userId ?? "local-board");
  if (membership) {
    await access.setMemberPermissions(
      company.id,
      membership.id,
      ownerPreset.permissions.map((key) => ({ permissionKey: key })),
      req.actor.userId ?? null,
    );
  }
}
```

**Step 5: Verify build**

Run: `cd /workspace/paperclip && npx turbo build --filter=server 2>&1 | tail -10`

**Step 6: Commit**

```bash
git add server/src/routes/access.ts server/src/routes/companies.ts
git commit -m "feat(rbac): add role preset endpoints and auto-grant owner on company creation"
```

---

### Task 8: Verify full build and test

**Step 1: Full build**

Run: `cd /workspace/paperclip && npx turbo build 2>&1 | tail -20`
Expected: All packages build successfully

**Step 2: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(rbac): build fixes for RBAC completion"
```
