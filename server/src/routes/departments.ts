import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { departmentService } from "../services/departments.js";
import { logActivity } from "../services/activity-log.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

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

  // List departments (flat)
  router.get("/companies/:companyId/departments", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.list(companyId);
    res.json(result);
  });

  // Department tree (nested with member counts)
  router.get("/companies/:companyId/departments/tree", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.tree(companyId);
    res.json(result);
  });

  // Get department by ID
  router.get("/departments/:id", async (req, res) => {
    const dept = await svc.getById(req.params.id as string);
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    assertCompanyAccess(req, dept.companyId);
    res.json(dept);
  });

  // Create department
  router.post(
    "/companies/:companyId/departments",
    validate(createDepartmentSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

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
      assertCompanyAccess(req, dept.companyId);

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
    assertCompanyAccess(req, dept.companyId);

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
    assertCompanyAccess(req, dept.companyId);
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
      assertCompanyAccess(req, dept.companyId);

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
    assertCompanyAccess(req, dept.companyId);

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
