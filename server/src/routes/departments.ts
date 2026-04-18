import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { departmentService } from "../services/departments.js";
import { logActivity } from "../services/activity-log.js";
import { getActorInfo } from "./authz.js";
import { scopedCompanyAuthz } from "./scoped-company-authz.js";

const createDepartmentSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullish(),
  parentId: z.string().uuid().nullish(),
  sortOrder: z.number().int().optional(),
});

const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullish(),
  parentId: z.string().uuid().nullish(),
  sortOrder: z.number().int().optional(),
});

const addMemberSchema = z.object({
  principalType: z.enum(["user", "agent"]),
  principalId: z.string().min(1),
  role: z.enum(["member", "lead", "manager"]).default("member"),
});

export function departmentRoutes(db: Db) {
  const router = Router();
  const svc = departmentService(db);
  const scopedAuthz = scopedCompanyAuthz(db);

  function filterDepartmentTree<T extends { id: string; children: T[] }>(
    nodes: T[],
    allowedIds: Set<string>,
  ): T[] {
    const filtered: T[] = [];
    for (const node of nodes) {
      const children = filterDepartmentTree(node.children, allowedIds);
      if (!allowedIds.has(node.id)) {
        filtered.push(...children);
        continue;
      }
      filtered.push({
        ...node,
        children,
      });
    }
    return filtered;
  }

  // List departments (flat)
  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveScopedPermission(req, companyId, "departments:view");
    const result = await svc.list(companyId);
    res.json(scope.companyWide ? result : result.filter((department) => scope.departmentIds.includes(department.id)));
  });

  // Department tree (nested with member counts)
  router.get("/companies/:companyId/departments/tree", async (req, res) => {
    const companyId = req.params.companyId as string;
    const scope = await scopedAuthz.resolveScopedPermission(req, companyId, "departments:view");
    const result = await svc.tree(companyId);
    if (scope.companyWide) {
      res.json(result);
      return;
    }
    res.json(filterDepartmentTree(result, new Set(scope.departmentIds)));
  });

  // Get department by ID
  router.get("/departments/:id", async (req, res) => {
    const dept = await svc.getById(req.params.id as string);
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:view", dept.id);
    res.json(dept);
  });

  // Create department
  router.post(
    "/companies/:companyId/departments",
    validate(createDepartmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      if (req.body.parentId) {
        const parent = await svc.getById(req.body.parentId);
        if (!parent || parent.companyId !== companyId) {
          res.status(404).json({ error: "Parent department not found" });
          return;
        }
        await scopedAuthz.assertScopedPermission(req, companyId, "departments:manage", parent.id);
      } else {
        const scope = await scopedAuthz.resolveScopedPermission(req, companyId, "departments:manage");
        if (!scope.companyWide) {
          res.status(403).json({ error: "Company-wide departments:manage is required to create top-level departments" });
          return;
        }
      }

      const dept = await svc.create(companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "department.created",
        entityType: "department",
        entityId: dept.id,
        details: { name: dept.name },
      });

      res.status(201).json(dept);
    },
  );

  // Update department
  router.patch(
    "/departments/:id",
    validate(updateDepartmentSchema),
    async (req, res) => {
      const dept = await svc.getById(req.params.id as string);
      if (!dept) {
        res.status(404).json({ error: "Department not found" });
        return;
      }
      await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:manage", dept.id);
      if (req.body.parentId !== undefined && req.body.parentId !== null) {
        const parent = await svc.getById(req.body.parentId);
        if (!parent || parent.companyId !== dept.companyId) {
          res.status(404).json({ error: "Parent department not found" });
          return;
        }
        await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:manage", parent.id);
      } else if (req.body.parentId === null) {
        const scope = await scopedAuthz.resolveScopedPermission(req, dept.companyId, "departments:manage");
        if (!scope.companyWide) {
          res.status(403).json({ error: "Company-wide departments:manage is required to move a department to the root" });
          return;
        }
      }

      const updated = await svc.update(dept.id, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: dept.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "department.updated",
        entityType: "department",
        entityId: dept.id,
        details: req.body,
      });

      res.json(updated);
    },
  );

  // Archive department
  router.post("/departments/:id/archive", async (req, res) => {
    const dept = await svc.getById(req.params.id as string);
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:manage", dept.id);

    const archived = await svc.archive(dept.id);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: dept.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "department.archived",
      entityType: "department",
      entityId: dept.id,
      details: { name: dept.name },
    });

    res.json(archived);
  });

  // List members
  router.get("/departments/:id/members", async (req, res) => {
    const dept = await svc.getById(req.params.id as string);
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:view", dept.id);
    const members = await svc.listMembers(dept.id);
    res.json(members);
  });

  // Add member
  router.post(
    "/departments/:id/members",
    validate(addMemberSchema),
    async (req, res) => {
      const dept = await svc.getById(req.params.id as string);
      if (!dept) {
        res.status(404).json({ error: "Department not found" });
        return;
      }
      await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:manage", dept.id);

      const membership = await svc.addMember(dept.id, dept.companyId, req.body);

      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: dept.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "department.member_added",
        entityType: "department",
        entityId: dept.id,
        details: { principalType: req.body.principalType, principalId: req.body.principalId, role: req.body.role },
      });

      res.status(201).json(membership);
    },
  );

  // Remove member
  router.delete("/departments/:id/members/:principalType/:principalId", async (req, res) => {
    const dept = await svc.getById(req.params.id as string);
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    await scopedAuthz.assertScopedPermission(req, dept.companyId, "departments:manage", dept.id);

    await svc.removeMember(dept.id, req.params.principalType as string, req.params.principalId as string);

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: dept.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "department.member_removed",
      entityType: "department",
      entityId: dept.id,
      details: { principalType: req.params.principalType, principalId: req.params.principalId },
    });

    res.status(204).end();
  });

  return router;
}
