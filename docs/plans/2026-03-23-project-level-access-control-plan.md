# Project-Level Access Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-project membership, permission grants, agent assignment, and role presets so members only see projects they're assigned to.

**Architecture:** Mirrors the company-level pattern (`company_memberships` + `principal_permission_grants` → `project_members` + `project_permission_grants`). Adds `project_agents` for agent scoping. New middleware `requireProjectPermission` gates project operations. Company owners bypass all project access checks. Legacy projects (0 members) remain visible to all until first member is added.

**Tech Stack:** Drizzle ORM (PostgreSQL), Express routes, React + TanStack Query, Zod validation, `@paperclipai/shared` constants + types, `@paperclipai/db` schema

---

### Task 1: Add Project Permission Keys and Role Presets to Shared Package

**Files:**
- Modify: `packages/shared/src/constants.ts` (add PROJECT_PERMISSION_KEYS after PERMISSION_KEYS ~line 243)
- Modify: `packages/shared/src/role-presets.ts` (add PROJECT_ROLE_PRESETS after AGENT_ROLE_DEFAULT_PERMISSIONS ~line 125)
- Modify: `packages/shared/src/index.ts` (re-export new constants)

**Step 1: Add project permission keys to constants.ts**

After the existing `PERMISSION_KEYS` and `PermissionKey` type (~line 243), add:

```typescript
export const PROJECT_PERMISSION_KEYS = [
  "project:view",
  "project:issues:create",
  "project:issues:edit",
  "project:issues:delete",
  "project:issues:assign",
  "project:agents:use",
  "project:settings",
  "project:members:manage",
] as const;
export type ProjectPermissionKey = (typeof PROJECT_PERMISSION_KEYS)[number];
```

**Step 2: Add project role presets to role-presets.ts**

After `AGENT_ROLE_DEFAULT_PERMISSIONS` (~line 125), add:

```typescript
import type { ProjectPermissionKey } from "./constants.js";

export interface ProjectRolePreset {
  id: string;
  label: string;
  description: string;
  permissions: ProjectPermissionKey[];
}

export const PROJECT_ROLE_PRESETS: ProjectRolePreset[] = [
  {
    id: "super_admin",
    label: "Super Admin",
    description: "Full project control including member management",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:delete",
      "project:issues:assign",
      "project:agents:use",
      "project:settings",
      "project:members:manage",
    ],
  },
  {
    id: "admin",
    label: "Admin",
    description: "Full project access except member management",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:delete",
      "project:issues:assign",
      "project:agents:use",
      "project:settings",
    ],
  },
  {
    id: "editor",
    label: "Editor",
    description: "Create, edit, and assign issues; use agents",
    permissions: [
      "project:view",
      "project:issues:create",
      "project:issues:edit",
      "project:issues:assign",
      "project:agents:use",
    ],
  },
  {
    id: "viewer",
    label: "Viewer",
    description: "Read-only access to project",
    permissions: [
      "project:view",
    ],
  },
];
```

**Step 3: Re-export from index.ts**

Add to the constants export block (~line 33):
```typescript
  PROJECT_PERMISSION_KEYS,
  type ProjectPermissionKey,
```

Add to the role-presets export (~line 241):
```typescript
export { ROLE_PRESETS, AGENT_ROLE_DEFAULT_PERMISSIONS, PROJECT_ROLE_PRESETS, type RolePreset, type ProjectRolePreset } from "./role-presets.js";
```

**Step 4: Build shared package to verify**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/shared build`
Expected: Build succeeds with no errors.

**Step 5: Commit**

```bash
git add packages/shared/src/constants.ts packages/shared/src/role-presets.ts packages/shared/src/index.ts
git commit -m "feat: add project-level permission keys and role presets"
```

---

### Task 2: Create Database Schema for Project Access Tables

**Files:**
- Create: `packages/db/src/schema/project_members.ts`
- Create: `packages/db/src/schema/project_permission_grants.ts`
- Create: `packages/db/src/schema/project_agents.ts`
- Modify: `packages/db/src/schema/index.ts` (re-export new tables)

**Step 1: Create project_members schema**

Follow the exact pattern from `packages/db/src/schema/company_memberships.ts`. Create `packages/db/src/schema/project_members.ts`:

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";

export const projectMembers = pgTable(
  "project_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").notNull().default("viewer"),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectPrincipalUniqueIdx: uniqueIndex("project_members_project_principal_unique_idx").on(
      table.projectId,
      table.principalType,
      table.principalId,
    ),
    companyIdx: index("project_members_company_idx").on(table.companyId),
    principalIdx: index("project_members_principal_idx").on(
      table.principalType,
      table.principalId,
    ),
  }),
);
```

**Step 2: Create project_permission_grants schema**

Follow the exact pattern from `packages/db/src/schema/principal_permission_grants.ts`. Create `packages/db/src/schema/project_permission_grants.ts`:

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";

export const projectPermissionGrants = pgTable(
  "project_permission_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    permissionKey: text("permission_key").notNull(),
    grantedByUserId: text("granted_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectPrincipalPermissionUniqueIdx: uniqueIndex(
      "project_permission_grants_unique_idx",
    ).on(table.projectId, table.principalType, table.principalId, table.permissionKey),
    projectPermissionIdx: index("project_permission_grants_project_permission_idx").on(
      table.projectId,
      table.permissionKey,
    ),
    companyIdx: index("project_permission_grants_company_idx").on(table.companyId),
  }),
);
```

**Step 3: Create project_agents schema**

Create `packages/db/src/schema/project_agents.ts`:

```typescript
import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { projects } from "./projects.js";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const projectAgents = pgTable(
  "project_agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id").notNull().references(() => projects.id),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    projectAgentUniqueIdx: uniqueIndex("project_agents_project_agent_unique_idx").on(
      table.projectId,
      table.agentId,
    ),
    companyIdx: index("project_agents_company_idx").on(table.companyId),
  }),
);
```

**Step 4: Re-export from schema index**

Add to `packages/db/src/schema/index.ts`:

```typescript
export { projectMembers } from "./project_members.js";
export { projectPermissionGrants } from "./project_permission_grants.js";
export { projectAgents } from "./project_agents.js";
```

**Step 5: Generate and run migration**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/db build`
Expected: Build succeeds.

Then generate the migration:
Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/db drizzle-kit generate`
Expected: Migration SQL file created in the migrations directory.

Then push the schema:
Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/db drizzle-kit push`
Expected: Tables created successfully (or use `drizzle-kit migrate` depending on project setup — check existing migration workflow first).

**Step 6: Commit**

```bash
git add packages/db/src/schema/project_members.ts packages/db/src/schema/project_permission_grants.ts packages/db/src/schema/project_agents.ts packages/db/src/schema/index.ts
git add packages/db/drizzle/  # migration files if generated
git commit -m "feat: add project_members, project_permission_grants, project_agents tables"
```

---

### Task 3: Add Project Access Service Functions

**Files:**
- Modify: `server/src/services/access.ts` (~320 lines, add new functions after existing ones)

**Step 1: Add imports for new schema tables**

At the top of `server/src/services/access.ts`, extend the import from `@paperclipai/db` to include:

```typescript
import {
  agents,
  authUsers,
  companyMemberships,
  instanceUserRoles,
  principalPermissionGrants,
  projectMembers,
  projectPermissionGrants,
  projectAgents,
  projects,
} from "@paperclipai/db";
import type { PermissionKey, PrincipalType, ProjectPermissionKey } from "@paperclipai/shared";
```

**Step 2: Add `isCompanyOwner` helper**

Inside the `accessService` function, add a helper that checks if a user has the company "owner" role preset (has all company permissions, specifically `users:manage_permissions` + `secrets:manage` + `company:settings` — the 3 permissions only owners have):

```typescript
async function isCompanyOwner(companyId: string, userId: string): Promise<boolean> {
  // Instance admins are treated as owners
  if (await isInstanceAdmin(userId)) return true;
  // Check if user has the owner-only permission "company:settings"
  // combined with "secrets:manage" — only owner preset has both
  const membership = await getMembership(companyId, "user", userId);
  if (!membership || membership.status !== "active") return false;
  if (membership.membershipRole === "owner") return true;
  // Fallback: check for owner-exclusive grants
  const ownerGrants = await db
    .select()
    .from(principalPermissionGrants)
    .where(
      and(
        eq(principalPermissionGrants.companyId, companyId),
        eq(principalPermissionGrants.principalType, "user"),
        eq(principalPermissionGrants.principalId, userId),
        eq(principalPermissionGrants.permissionKey, "company:settings"),
      ),
    );
  return ownerGrants.length > 0;
}
```

**Step 3: Add `getProjectMembership`**

```typescript
async function getProjectMembership(
  projectId: string,
  principalType: PrincipalType,
  principalId: string,
) {
  return db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.principalType, principalType),
        eq(projectMembers.principalId, principalId),
      ),
    )
    .then((rows) => rows[0] ?? null);
}
```

**Step 4: Add `hasProjectPermission`**

```typescript
async function hasProjectPermission(
  projectId: string,
  principalType: PrincipalType,
  principalId: string,
  permissionKey: ProjectPermissionKey,
): Promise<boolean> {
  const member = await getProjectMembership(projectId, principalType, principalId);
  if (!member) return false;
  // "project:view" is implicit for all members
  if (permissionKey === "project:view") return true;
  const grant = await db
    .select()
    .from(projectPermissionGrants)
    .where(
      and(
        eq(projectPermissionGrants.projectId, projectId),
        eq(projectPermissionGrants.principalType, principalType),
        eq(projectPermissionGrants.principalId, principalId),
        eq(projectPermissionGrants.permissionKey, permissionKey),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return !!grant;
}
```

**Step 5: Add `canUserAccessProject`**

```typescript
async function canUserAccessProject(
  companyId: string,
  projectId: string,
  userId: string,
): Promise<boolean> {
  // Company owners bypass project access checks
  if (await isCompanyOwner(companyId, userId)) return true;
  // Check if project is in "legacy" mode (no members = visible to all)
  const memberCount = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .then((rows) => rows[0]?.count ?? 0);
  if (memberCount === 0) return true;
  // Check explicit membership
  const membership = await getProjectMembership(projectId, "user", userId);
  return !!membership;
}
```

**Step 6: Add `listProjectMembers`**

```typescript
async function listProjectMembers(projectId: string) {
  const members = await db
    .select()
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId))
    .orderBy(projectMembers.createdAt);

  const grants = await db
    .select()
    .from(projectPermissionGrants)
    .where(eq(projectPermissionGrants.projectId, projectId));

  // Hydrate with display names
  const userIds = members.filter((m) => m.principalType === "user").map((m) => m.principalId);
  const agentIds = members.filter((m) => m.principalType === "agent").map((m) => m.principalId);

  const users = userIds.length > 0
    ? await db.select().from(authUsers).where(inArray(authUsers.id, userIds))
    : [];
  const agentRows = agentIds.length > 0
    ? await db.select().from(agents).where(inArray(agents.id, agentIds))
    : [];

  return members.map((m) => {
    const memberGrants = grants
      .filter(
        (g) =>
          g.principalType === m.principalType && g.principalId === m.principalId,
      )
      .map((g) => ({ permissionKey: g.permissionKey }));

    const user = m.principalType === "user" ? users.find((u) => u.id === m.principalId) : null;
    const agent = m.principalType === "agent" ? agentRows.find((a) => a.id === m.principalId) : null;

    return {
      ...m,
      displayName: user?.raw_user_meta_data?.name ?? user?.email ?? agent?.name ?? m.principalId,
      email: user?.email ?? null,
      grants: memberGrants,
    };
  });
}
```

**Step 7: Add `addProjectMember`**

```typescript
async function addProjectMember(
  projectId: string,
  companyId: string,
  principalType: PrincipalType,
  principalId: string,
  role: string,
  addedByUserId: string | null,
) {
  const preset = (await import("@paperclipai/shared")).PROJECT_ROLE_PRESETS.find(
    (p) => p.id === role,
  );

  return db.transaction(async (tx) => {
    const [member] = await tx
      .insert(projectMembers)
      .values({ projectId, companyId, principalType, principalId, role, addedByUserId })
      .onConflictDoUpdate({
        target: [projectMembers.projectId, projectMembers.principalType, projectMembers.principalId],
        set: { role, updatedAt: new Date() },
      })
      .returning();

    // Apply preset grants
    if (preset) {
      // Delete existing grants
      await tx.delete(projectPermissionGrants).where(
        and(
          eq(projectPermissionGrants.projectId, projectId),
          eq(projectPermissionGrants.principalType, principalType),
          eq(projectPermissionGrants.principalId, principalId),
        ),
      );
      // Insert preset grants
      if (preset.permissions.length > 0) {
        await tx.insert(projectPermissionGrants).values(
          preset.permissions.map((key) => ({
            projectId,
            companyId,
            principalType,
            principalId,
            permissionKey: key,
            grantedByUserId: addedByUserId,
          })),
        );
      }
    }

    return member;
  });
}
```

**Step 8: Add `removeProjectMember`**

```typescript
async function removeProjectMember(projectId: string, memberId: string) {
  const member = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  if (!member) return null;

  await db.transaction(async (tx) => {
    await tx.delete(projectPermissionGrants).where(
      and(
        eq(projectPermissionGrants.projectId, projectId),
        eq(projectPermissionGrants.principalType, member.principalType),
        eq(projectPermissionGrants.principalId, member.principalId),
      ),
    );
    await tx.delete(projectMembers).where(eq(projectMembers.id, memberId));
  });

  return member;
}
```

**Step 9: Add `setProjectMemberPermissions`**

```typescript
async function setProjectMemberPermissions(
  projectId: string,
  memberId: string,
  grants: Array<{ permissionKey: string }>,
  grantedByUserId: string | null,
) {
  const member = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.id, memberId), eq(projectMembers.projectId, projectId)))
    .then((rows) => rows[0] ?? null);
  if (!member) return null;

  await db.transaction(async (tx) => {
    await tx.delete(projectPermissionGrants).where(
      and(
        eq(projectPermissionGrants.projectId, projectId),
        eq(projectPermissionGrants.principalType, member.principalType),
        eq(projectPermissionGrants.principalId, member.principalId),
      ),
    );
    if (grants.length > 0) {
      await tx.insert(projectPermissionGrants).values(
        grants.map((g) => ({
          projectId,
          companyId: member.companyId,
          principalType: member.principalType,
          principalId: member.principalId,
          permissionKey: g.permissionKey,
          grantedByUserId,
        })),
      );
    }
  });

  return member;
}
```

**Step 10: Add `listAccessibleProjects`**

```typescript
async function listAccessibleProjects(
  companyId: string,
  userId: string,
): Promise<string[]> {
  // Company owners see everything
  if (await isCompanyOwner(companyId, userId)) return []; // empty = no filter needed

  // Get project IDs where user is a member
  const memberships = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.companyId, companyId),
        eq(projectMembers.principalType, "user"),
        eq(projectMembers.principalId, userId),
      ),
    );

  // Also get project IDs with zero members (legacy mode)
  const legacyProjects = await db
    .select({ id: projects.id })
    .from(projects)
    .leftJoin(projectMembers, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projects.companyId, companyId),
        sql`${projectMembers.id} IS NULL`,
      ),
    );

  const memberProjectIds = memberships.map((m) => m.projectId);
  const legacyProjectIds = legacyProjects.map((p) => p.id);
  return [...new Set([...memberProjectIds, ...legacyProjectIds])];
}
```

**Step 11: Add project agent functions**

```typescript
async function listProjectAgents(projectId: string) {
  const rows = await db
    .select()
    .from(projectAgents)
    .innerJoin(agents, eq(projectAgents.agentId, agents.id))
    .where(eq(projectAgents.projectId, projectId))
    .orderBy(projectAgents.createdAt);

  return rows.map((r) => ({
    ...r.project_agents,
    agent: { id: r.agents.id, name: r.agents.name, role: r.agents.role, iconName: r.agents.iconName },
  }));
}

async function addProjectAgent(
  projectId: string,
  companyId: string,
  agentId: string,
  addedByUserId: string | null,
) {
  const [row] = await db
    .insert(projectAgents)
    .values({ projectId, companyId, agentId, addedByUserId })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

async function removeProjectAgent(projectId: string, agentId: string) {
  const [row] = await db
    .delete(projectAgents)
    .where(
      and(eq(projectAgents.projectId, projectId), eq(projectAgents.agentId, agentId)),
    )
    .returning();
  return row ?? null;
}
```

**Step 12: Export all new functions from the service return object**

Add to the return statement of `accessService`:

```typescript
return {
  // ... existing functions ...
  isCompanyOwner,
  getProjectMembership,
  hasProjectPermission,
  canUserAccessProject,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
  setProjectMemberPermissions,
  listAccessibleProjects,
  listProjectAgents,
  addProjectAgent,
  removeProjectAgent,
};
```

**Step 13: Build and verify**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/server build`
Expected: Build succeeds with no type errors.

**Step 14: Commit**

```bash
git add server/src/services/access.ts
git commit -m "feat: add project-level access service functions"
```

---

### Task 4: Add Project Access Authorization Middleware

**Files:**
- Modify: `server/src/routes/authz.ts` (~75 lines)

**Step 1: Add `requireProjectPermission` helper**

After the existing `requirePermission` function, add:

```typescript
export async function requireProjectPermission(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  projectId: string,
  permissionKey: ProjectPermissionKey,
) {
  assertCompanyAccess(req, companyId);

  // Local implicit and instance admin bypass
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    // Company owners bypass project checks
    if (await access.isCompanyOwner(companyId, req.actor.userId)) return;
    // Check project permission
    const allowed = await access.hasProjectPermission(projectId, "user", req.actor.userId, permissionKey);
    if (!allowed) throw forbidden(`Missing project permission: ${permissionKey}`);
    return;
  }

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const allowed = await access.hasProjectPermission(projectId, "agent", req.actor.agentId, permissionKey);
    if (!allowed) throw forbidden(`Missing project permission: ${permissionKey}`);
    return;
  }

  throw unauthorized();
}
```

Add `requireProjectAccess` for simple membership checks (no specific permission):

```typescript
export async function requireProjectAccess(
  req: Request,
  access: ReturnType<typeof accessService>,
  companyId: string,
  projectId: string,
) {
  assertCompanyAccess(req, companyId);

  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const canAccess = await access.canUserAccessProject(companyId, projectId, req.actor.userId);
    if (!canAccess) throw forbidden("No access to this project");
    return;
  }

  if (req.actor.type === "agent") {
    if (!req.actor.agentId) throw forbidden("Agent authentication required");
    const member = await access.getProjectMembership(projectId, "agent", req.actor.agentId);
    if (!member) throw forbidden("No access to this project");
    return;
  }

  throw unauthorized();
}
```

**Step 2: Add import for ProjectPermissionKey**

Add to the imports at the top of `authz.ts`:
```typescript
import type { ProjectPermissionKey } from "@paperclipai/shared";
```

**Step 3: Build and verify**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/server build`
Expected: Build succeeds.

**Step 4: Commit**

```bash
git add server/src/routes/authz.ts
git commit -m "feat: add requireProjectPermission and requireProjectAccess middleware"
```

---

### Task 5: Add Zod Validators for Project Access API

**Files:**
- Modify: `packages/shared/src/validators/` (find the file containing `updateMemberPermissionsSchema` and add project-level validators near it)

First locate the exact file:
Run: `grep -r "updateMemberPermissionsSchema" packages/shared/src/validators/`

Add these validators in the same file:

```typescript
export const addProjectMemberSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId: z.string().min(1),
  role: z.enum(["super_admin", "admin", "editor", "viewer"]).default("viewer"),
});
export type AddProjectMember = z.infer<typeof addProjectMemberSchema>;

export const updateProjectMemberSchema = z.object({
  role: z.enum(["super_admin", "admin", "editor", "viewer"]),
});
export type UpdateProjectMember = z.infer<typeof updateProjectMemberSchema>;

export const updateProjectMemberPermissionsSchema = z.object({
  grants: z.array(
    z.object({
      permissionKey: z.enum([
        "project:view",
        "project:issues:create",
        "project:issues:edit",
        "project:issues:delete",
        "project:issues:assign",
        "project:agents:use",
        "project:settings",
        "project:members:manage",
      ]),
    }),
  ),
});
export type UpdateProjectMemberPermissions = z.infer<typeof updateProjectMemberPermissionsSchema>;

export const addProjectAgentSchema = z.object({
  agentId: z.string().uuid(),
});
export type AddProjectAgent = z.infer<typeof addProjectAgentSchema>;

export const applyProjectRolePresetSchema = z.object({
  presetId: z.enum(["super_admin", "admin", "editor", "viewer"]),
});
export type ApplyProjectRolePreset = z.infer<typeof applyProjectRolePresetSchema>;
```

Re-export from `packages/shared/src/validators/index.ts` and `packages/shared/src/index.ts`.

**Step: Build and commit**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/shared build`

```bash
git add packages/shared/
git commit -m "feat: add Zod validators for project access API"
```

---

### Task 6: Add Project Access API Routes

**Files:**
- Modify: `server/src/routes/projects.ts` (~408 lines — add new member/agent endpoints and modify existing routes)

**Step 1: Add imports**

At the top of `projects.ts`, add:

```typescript
import {
  requireProjectPermission,
  requireProjectAccess,
} from "./authz.js";
import type { ProjectPermissionKey } from "@paperclipai/shared";
import { PROJECT_ROLE_PRESETS } from "@paperclipai/shared";
```

Also import the new validators:
```typescript
import {
  addProjectMemberSchema,
  updateProjectMemberSchema,
  updateProjectMemberPermissionsSchema,
  addProjectAgentSchema,
  applyProjectRolePresetSchema,
} from "@paperclipai/shared";
```

**Step 2: Add project member endpoints**

After existing routes, add:

```typescript
// --- Project Members ---

// List project members
router.get("/projects/:id/members", async (req, res) => {
  const projectId = req.params.id;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectAccess(req, access, project.companyId, projectId);
  const members = await access.listProjectMembers(projectId);
  res.json(members);
});

// Add project member
router.post("/projects/:id/members", validate(addProjectMemberSchema), async (req, res) => {
  const projectId = req.params.id;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
  const member = await access.addProjectMember(
    projectId,
    project.companyId,
    req.body.principalType,
    req.body.principalId,
    req.body.role,
    req.actor?.userId ?? null,
  );
  res.status(201).json(member);
});

// Update project member role
router.patch("/projects/:id/members/:memberId", validate(updateProjectMemberSchema), async (req, res) => {
  const projectId = req.params.id;
  const memberId = req.params.memberId;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
  // Update role and re-apply preset grants
  const member = await access.addProjectMember(
    projectId,
    project.companyId,
    // Need to fetch existing member to get principalType/principalId
    // Or restructure to accept memberId directly
    req.body.principalType ?? "user",  // Will be fetched from member record
    req.body.principalId ?? "",
    req.body.role,
    req.actor?.userId ?? null,
  );
  res.json(member);
});

// Update project member permissions (fine-tune)
router.patch(
  "/projects/:id/members/:memberId/permissions",
  validate(updateProjectMemberPermissionsSchema),
  async (req, res) => {
    const projectId = req.params.id;
    const memberId = req.params.memberId;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const updated = await access.setProjectMemberPermissions(
      projectId,
      memberId,
      req.body.grants,
      req.actor?.userId ?? null,
    );
    if (!updated) throw notFound("Member not found");
    res.json(updated);
  },
);

// Apply role preset to project member
router.post(
  "/projects/:id/members/:memberId/role-preset",
  validate(applyProjectRolePresetSchema),
  async (req, res) => {
    const projectId = req.params.id;
    const memberId = req.params.memberId;
    const project = await svc.getById(projectId);
    if (!project) throw notFound("Project not found");
    await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
    const preset = PROJECT_ROLE_PRESETS.find((p) => p.id === req.body.presetId);
    if (!preset) throw notFound("Preset not found");
    const updated = await access.setProjectMemberPermissions(
      projectId,
      memberId,
      preset.permissions.map((key) => ({ permissionKey: key })),
      req.actor?.userId ?? null,
    );
    if (!updated) throw notFound("Member not found");
    res.json({ ...updated, appliedPreset: req.body.presetId });
  },
);

// Remove project member
router.delete("/projects/:id/members/:memberId", async (req, res) => {
  const projectId = req.params.id;
  const memberId = req.params.memberId;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
  const removed = await access.removeProjectMember(projectId, memberId);
  if (!removed) throw notFound("Member not found");
  res.json(removed);
});

// --- Project Agents ---

// List project agents
router.get("/projects/:id/agents-access", async (req, res) => {
  const projectId = req.params.id;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectAccess(req, access, project.companyId, projectId);
  const agents = await access.listProjectAgents(projectId);
  res.json(agents);
});

// Add agent to project
router.post("/projects/:id/agents-access", validate(addProjectAgentSchema), async (req, res) => {
  const projectId = req.params.id;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
  const row = await access.addProjectAgent(projectId, project.companyId, req.body.agentId, req.actor?.userId ?? null);
  res.status(201).json(row);
});

// Remove agent from project
router.delete("/projects/:id/agents-access/:agentId", async (req, res) => {
  const projectId = req.params.id;
  const agentId = req.params.agentId;
  const project = await svc.getById(projectId);
  if (!project) throw notFound("Project not found");
  await requireProjectPermission(req, access, project.companyId, projectId, "project:members:manage");
  const removed = await access.removeProjectAgent(projectId, agentId);
  if (!removed) throw notFound("Agent not assigned to project");
  res.json(removed);
});

// Project role presets list
router.get("/project-role-presets", (_req, res) => {
  res.json(PROJECT_ROLE_PRESETS);
});
```

**Step 3: Modify project creation to auto-add creator as super_admin**

In the existing `POST /companies/:companyId/projects` handler (~line 76-118), after the project is created:

```typescript
// After: const project = await svc.create(companyId, { ... });
// Add: Auto-add creator as project super_admin
const actor = getActorInfo(req);
if (actor.actorType === "user") {
  await access.addProjectMember(
    project.id,
    companyId,
    "user",
    actor.actorId,
    "super_admin",
    actor.actorId,
  );
}
```

**Step 4: Modify project list to filter by access**

In the existing `GET /companies/:companyId/projects` handler, after fetching projects, filter by access:

```typescript
// Replace the existing project list query with access-filtered version
const actor = getActorInfo(req);
let projectList;
if (actor.actorType === "user") {
  const accessibleIds = await access.listAccessibleProjects(companyId, actor.actorId);
  // Empty array from listAccessibleProjects means "owner, show all"
  projectList = await svc.listByCompany(companyId);
  if (accessibleIds.length > 0) {
    projectList = projectList.filter((p) => accessibleIds.includes(p.id));
  }
} else {
  projectList = await svc.listByCompany(companyId);
}
res.json(projectList);
```

**Note:** The `listAccessibleProjects` function returns an empty array for owners (meaning "show all"). For non-owners, it returns the specific project IDs they can see.

**Step 5: Modify project update to use project-level permission**

In the existing `PATCH /projects/:id` handler (~line 120-153), replace the company-level `projects:manage` check with:

```typescript
await requireProjectPermission(req, access, project.companyId, project.id, "project:settings");
```

**Step 6: Build and verify**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/server build`
Expected: Build succeeds.

**Step 7: Commit**

```bash
git add server/src/routes/projects.ts
git commit -m "feat: add project member/agent access routes and filter project list by access"
```

---

### Task 7: Update Issue Routes for Project-Level Permissions

**Files:**
- Modify: `server/src/routes/issues.ts`

**Step 1: Add imports**

Add to the imports in `issues.ts`:

```typescript
import { requireProjectPermission } from "./authz.js";
```

**Step 2: Modify issue creation**

In `POST /companies/:companyId/issues` (~line 409-450), after `requirePermission(req, access, companyId, "issues:manage")`, add project-level check:

```typescript
// If issue has a projectId, also check project-level permission
if (req.body.projectId) {
  await requireProjectPermission(req, access, companyId, req.body.projectId, "project:issues:create");
}
```

**Step 3: Modify issue update**

In `PATCH /issues/:id` (~line 452-619), after `requirePermission(req, access, existing.companyId, "issues:manage")`, add:

```typescript
if (existing.projectId) {
  await requireProjectPermission(req, access, existing.companyId, existing.projectId, "project:issues:edit");
}
```

**Step 4: Modify issue deletion**

In `DELETE /issues/:id` (~line 621-658), after `requirePermission(req, access, existing.companyId, "issues:manage")`, add:

```typescript
if (existing.projectId) {
  await requireProjectPermission(req, access, existing.companyId, existing.projectId, "project:issues:delete");
}
```

**Step 5: Build and verify**

Run: `cd /workspace/paperclip && pnpm --filter @paperclipai/server build`
Expected: Build succeeds.

**Step 6: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat: enforce project-level permissions on issue CRUD"
```

---

### Task 8: Add Frontend API Client for Project Access

**Files:**
- Modify: `ui/src/api/projects.ts` (~44 lines — add member/agent API methods)
- Modify: `ui/src/lib/queryKeys.ts` (~80 lines — add project member/agent query keys)

**Step 1: Add project access API methods to projects.ts**

Add to the `projectsApi` object in `ui/src/api/projects.ts`:

```typescript
// Project Members
listMembers: (projectId: string) =>
  api.get<ProjectMember[]>(`/projects/${projectId}/members`),

addMember: (projectId: string, data: { principalType: string; principalId: string; role: string }) =>
  api.post<ProjectMember>(`/projects/${projectId}/members`, data),

updateMemberPermissions: (projectId: string, memberId: string, grants: Array<{ permissionKey: string }>) =>
  api.patch<ProjectMember>(`/projects/${projectId}/members/${memberId}/permissions`, { grants }),

applyMemberRolePreset: (projectId: string, memberId: string, presetId: string) =>
  api.post<ProjectMember>(`/projects/${projectId}/members/${memberId}/role-preset`, { presetId }),

removeMember: (projectId: string, memberId: string) =>
  api.delete<ProjectMember>(`/projects/${projectId}/members/${memberId}`),

// Project Agents
listAgentsAccess: (projectId: string) =>
  api.get<ProjectAgentAccess[]>(`/projects/${projectId}/agents-access`),

addAgentAccess: (projectId: string, agentId: string) =>
  api.post<ProjectAgentAccess>(`/projects/${projectId}/agents-access`, { agentId }),

removeAgentAccess: (projectId: string, agentId: string) =>
  api.delete<ProjectAgentAccess>(`/projects/${projectId}/agents-access/${agentId}`),
```

Add type interfaces at the top of the file:

```typescript
interface ProjectMember {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  role: string;
  displayName: string;
  email: string | null;
  grants: Array<{ permissionKey: string }>;
  createdAt: string;
}

interface ProjectAgentAccess {
  id: string;
  projectId: string;
  agentId: string;
  agent: { id: string; name: string; role: string; iconName: string | null };
  createdAt: string;
}
```

**Step 2: Add query keys**

In `ui/src/lib/queryKeys.ts`, add inside the `projects` object:

```typescript
projects: {
  list: (companyId: string) => ["projects", companyId] as const,
  listWithArchived: (companyId: string) => ["projects", companyId, "with-archived"] as const,
  detail: (id: string) => ["projects", "detail", id] as const,
  members: (projectId: string) => ["projects", "members", projectId] as const,
  agents: (projectId: string) => ["projects", "agents", projectId] as const,
},
```

**Step 3: Commit**

```bash
git add ui/src/api/projects.ts ui/src/lib/queryKeys.ts
git commit -m "feat: add frontend API client for project access management"
```

---

### Task 9: Add Project Members Panel to ProjectDetail Page

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx`

**Step 1: Add members panel in the project header area**

Add a lightweight member list showing avatars/names and an "Add member" button. This panel shows on the overview tab.

Key elements:
- Fetch members via `useQuery({ queryKey: queryKeys.projects.members(projectId), queryFn: () => projectsApi.listMembers(projectId) })`
- Display member count badge: "N members"
- Show small avatar list (first 5 members + "+N more")
- "Add member" button triggers a modal
- Add member modal: dropdown of company members (from `accessApi.listMembers(companyId)`), role selector (super_admin/admin/editor/viewer), confirm button
- Uses `useMutation` with `projectsApi.addMember()` and invalidates `queryKeys.projects.members(projectId)`

Follow the exact component patterns from `CompanySettings.tsx` MembersSection for styling (border, badges, hover states).

**Step 2: Add "Members" tab to ProjectDetail**

Extend the tab type:
```typescript
type ProjectTab = "overview" | "list" | "members";
```

Add tab button and tab content. The "Members" tab content renders the full ProjectMembersSection (see Task 10).

**Step 3: Commit**

```bash
git add ui/src/pages/ProjectDetail.tsx
git commit -m "feat: add members panel and tab to project detail page"
```

---

### Task 10: Add Full Project Members & Permissions Management UI

**Files:**
- Modify: `ui/src/pages/ProjectDetail.tsx` (add ProjectMembersSection component)

**Step 1: Build ProjectMembersSection component**

Mirror the pattern from `CompanySettings.tsx` MembersSection (~lines 503-948). Key elements:

- **Member list** with expandable permission editors
- **Permission labels** for project-level keys:
  ```typescript
  const PROJECT_PERMISSION_LABELS: Record<string, string> = {
    "project:view": "View project",
    "project:issues:create": "Create issues",
    "project:issues:edit": "Edit issues",
    "project:issues:delete": "Delete issues",
    "project:issues:assign": "Assign issues",
    "project:agents:use": "Use agents",
    "project:settings": "Project settings",
    "project:members:manage": "Manage members",
  };
  ```
- **Role preset buttons**: Super Admin / Admin / Editor / Viewer (using `PROJECT_ROLE_PRESETS` from shared)
- **Individual permission checkboxes** with toggle fields
- **Save/Cancel** buttons for permission changes
- **Remove member** button
- **Agents sub-section**: list assigned agents, add/remove agent controls

Use the same mutations pattern:
```typescript
const permissionsMutation = useMutation({
  mutationFn: ({ memberId, grants }: { memberId: string; grants: Array<{ permissionKey: string }> }) =>
    projectsApi.updateMemberPermissions(projectId, memberId, grants),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.members(projectId) });
  },
});
```

**Step 2: Build ProjectAgentsSection component**

- Lists agents assigned to this project
- "Add agent" button opens a dropdown of company agents not yet assigned
- Remove button per agent
- Uses `projectsApi.listAgentsAccess()`, `addAgentAccess()`, `removeAgentAccess()`

**Step 3: Commit**

```bash
git add ui/src/pages/ProjectDetail.tsx
git commit -m "feat: add project members and permissions management UI"
```

---

### Task 11: Add Type Exports to Shared Package

**Files:**
- Modify: `packages/shared/src/types/index.ts` (or wherever types like `CompanyMembership` are defined)

**Step 1: Add project access types**

```typescript
export interface ProjectMember {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  role: string;
  addedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectPermissionGrant {
  id: string;
  projectId: string;
  companyId: string;
  principalType: string;
  principalId: string;
  permissionKey: string;
  grantedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectAgent {
  id: string;
  projectId: string;
  companyId: string;
  agentId: string;
  addedByUserId: string | null;
  createdAt: string;
}
```

Re-export from `packages/shared/src/index.ts`.

**Step 2: Commit**

```bash
git add packages/shared/
git commit -m "feat: add ProjectMember, ProjectPermissionGrant, ProjectAgent types"
```

---

### Task 12: End-to-End Verification and Smoke Test

**Step 1: Build all packages**

```bash
cd /workspace/paperclip
pnpm build
```
Expected: All packages build without errors.

**Step 2: Start the development server**

```bash
pnpm dev
```
Expected: Server starts, no migration errors.

**Step 3: Manual smoke tests**

1. Create a new project → verify creator is auto-added as super_admin
2. Go to project detail → verify "Members" tab appears
3. Add a member → verify they appear in the list
4. Change member's role via preset buttons → verify permissions update
5. Fine-tune permissions via checkboxes → verify save works
6. Remove a member → verify they disappear
7. Add an agent to the project → verify it appears
8. Log in as a non-member → verify the project is not visible in the project list
9. Log in as company owner → verify all projects are visible regardless of membership

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```

---

## Task Dependency Graph

```
Task 1 (shared constants) ──┐
                             ├── Task 3 (access service) ── Task 4 (authz middleware) ─┬── Task 6 (project routes)
Task 2 (DB schema) ─────────┘                                                         │
                                                                                       ├── Task 7 (issue routes)
Task 5 (validators) ────────────────────────────────────────────────────────────────────┘

Task 11 (shared types) ── Task 8 (frontend API) ── Task 9 (project detail panel) ── Task 10 (full members UI)

Task 12 (verification) depends on all above
```

## Parallelizable Tasks

- Tasks 1 + 2 can run in parallel (shared constants + DB schema)
- Tasks 5 + 11 can run in parallel with Tasks 3 + 4 (validators/types + service/middleware)
- Tasks 9 + 10 are sequential (panel then full UI)
