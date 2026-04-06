import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { deliverableService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function reviewTemplateRoutes(db: Db) {
  const router = Router();
  const svc = deliverableService(db);

  // ── List templates ─────────────────────────────────────────────────
  router.get("/companies/:companyId/review-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const result = await svc.listTemplates(companyId);
    res.json(result);
  });

  // ── Create template ────────────────────────────────────────────────
  router.post("/companies/:companyId/review-templates", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { name, description, stages, isDefault } = req.body;
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const template = await svc.createTemplate(companyId, {
      name,
      description: description ?? null,
      stages: stages ?? [],
      isDefault: isDefault ?? false,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "review_template.created",
      entityType: "review_pipeline_template",
      entityId: template.id,
      details: { name: template.name },
    });

    res.status(201).json(template);
  });

  // ── Update template ────────────────────────────────────────────────
  router.patch("/review-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getTemplate(id);
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);

    const template = await svc.updateTemplate(id, req.body);
    res.json(template);
  });

  // ── Delete template ────────────────────────────────────────────────
  router.delete("/review-templates/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getTemplate(id);
    if (!existing) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    const actor = getActorInfo(req);

    const template = await svc.deleteTemplate(id);
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "review_template.deleted",
      entityType: "review_pipeline_template",
      entityId: id,
    });

    res.json(template);
  });

  // ── Seed default templates ─────────────────────────────────────────
  router.post("/companies/:companyId/review-templates/seed", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const existing = await svc.listTemplates(companyId);
    if (existing.length > 0) {
      res.json({ seeded: 0, message: "Templates already exist" });
      return;
    }

    const defaults = [
      {
        name: "Code Review Pipeline",
        description: "Standard code review workflow: automated checks, peer review, and lead approval.",
        stages: [
          { label: "Automated Checks", role: "CI/CD system validates lint, tests, and build" },
          { label: "Peer Review", role: "Team member reviews code quality and logic" },
          { label: "Lead Approval", role: "Tech lead gives final approval" },
        ],
        isDefault: true,
      },
      {
        name: "Document Review",
        description: "Review pipeline for documents, reports, and proposals.",
        stages: [
          { label: "Content Review", role: "Subject matter expert reviews accuracy" },
          { label: "Editorial Review", role: "Editor checks clarity and formatting" },
          { label: "Final Approval", role: "Manager approves for publication" },
        ],
        isDefault: false,
      },
      {
        name: "Design Review",
        description: "UI/UX design review with feedback loops.",
        stages: [
          { label: "Design Critique", role: "Design team reviews visual and interaction quality" },
          { label: "Usability Check", role: "QA validates accessibility and responsiveness" },
          { label: "Stakeholder Approval", role: "Product owner signs off" },
        ],
        isDefault: false,
      },
      {
        name: "Deployment Approval",
        description: "Pre-deployment review ensuring quality and security before release.",
        stages: [
          { label: "QA Verification", role: "QA team validates all test cases pass" },
          { label: "Security Review", role: "Security team checks for vulnerabilities" },
          { label: "Release Approval", role: "Release manager approves deployment" },
        ],
        isDefault: false,
      },
      {
        name: "Client Deliverable",
        description: "Review pipeline for client-facing deliverables and presentations.",
        stages: [
          { label: "Internal Review", role: "Team reviews completeness and accuracy" },
          { label: "Quality Assurance", role: "QA validates formatting and requirements" },
          { label: "Manager Review", role: "Project manager reviews before client delivery" },
          { label: "Client Approval", role: "Client reviews and approves deliverable" },
        ],
        isDefault: false,
      },
      {
        name: "Quick Approval",
        description: "Simple single-step approval for low-risk items.",
        stages: [
          { label: "Approve / Reject", role: "Designated approver reviews and decides" },
        ],
        isDefault: false,
      },
    ];

    const created = [];
    for (const tmpl of defaults) {
      const t = await svc.createTemplate(companyId, tmpl);
      created.push(t);
    }

    res.status(201).json({ seeded: created.length, templates: created });
  });

  // ── Project defaults ───────────────────────────────────────────────
  router.get("/projects/:projectId/review-defaults", async (req, res) => {
    const projectId = req.params.projectId as string;
    const result = await svc.getProjectDefault(projectId);
    if (!result) {
      res.status(404).json({ error: "No review default set for this project" });
      return;
    }
    assertCompanyAccess(req, result.companyId);
    res.json(result);
  });

  router.put("/projects/:projectId/review-defaults", async (req, res) => {
    const projectId = req.params.projectId as string;
    const { companyId, reviewPipelineTemplateId } = req.body;
    if (!companyId || !reviewPipelineTemplateId) {
      res.status(400).json({ error: "companyId and reviewPipelineTemplateId are required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const result = await svc.setProjectDefault(projectId, companyId, reviewPipelineTemplateId);
    res.json(result);
  });

  return router;
}
