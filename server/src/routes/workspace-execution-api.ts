import { Router } from "express";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { normalizeIssueIdentifier } from "@paperclipai/shared";
import { assertAuthenticated, assertCompanyAccess } from "./authz.js";
import { heartbeatService, issueService } from "../services/index.js";

export function workspaceExecutionApiRoutes(db: Db) {
  const router = Router();
  const heartbeat = heartbeatService(db);
  const issueSvc = issueService(db);

  async function resolveIssue(rawId: string) {
    const identifier = normalizeIssueIdentifier(rawId);
    if (identifier) return issueSvc.getByIdentifier(identifier);
    return issueSvc.getById(rawId);
  }

  async function resolveRun(req: any, res: any) {
    assertAuthenticated(req);
    const run = await heartbeat.getRun(req.params.runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return null;
    }
    assertCompanyAccess(req, run.companyId);
    return run;
  }

  function firstRow(result: unknown): Record<string, unknown> | null {
    if (Array.isArray(result) && result.length > 0) return result[0] as Record<string, unknown>;
    return null;
  }

  function allRows(result: unknown): Record<string, unknown>[] {
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  }

  // 1. GET /api/issues/:issueId/workspace-manifest
  router.get("/issues/:issueId/workspace-manifest", async (req, res) => {
    const issue = await resolveIssue(req.params.issueId);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    assertCompanyAccess(req, issue.companyId);

    const result = await db.execute(sql`
      SELECT h.issue_id, h.current_revision_id, h.version, h.updated_at,
             r.revision_id, r.parent_revision_id, r.base_ref, r.overlay_ref,
             r.patch_ref, r.size_bytes, r.file_count, r.created_at AS revision_created_at
      FROM issue_workspace_heads h
      LEFT JOIN workspace_revisions r ON r.revision_id = h.current_revision_id
      WHERE h.issue_id = ${issue.id}
    `);
    const row = firstRow(result);
    if (!row) return res.json({ issueId: issue.id, head: null, revision: null });
    return res.json({
      issueId: issue.id,
      head: { currentRevisionId: row.current_revision_id, version: row.version, updatedAt: row.updated_at },
      revision: row.current_revision_id
        ? {
            revisionId: row.revision_id,
            parentRevisionId: row.parent_revision_id,
            baseRef: row.base_ref,
            overlayRef: row.overlay_ref,
            patchRef: row.patch_ref,
            sizeBytes: row.size_bytes,
            fileCount: row.file_count,
            createdAt: row.revision_created_at,
          }
        : null,
    });
  });

  // 2. GET /api/issues/:issueId/workspace-revisions
  router.get("/issues/:issueId/workspace-revisions", async (req, res) => {
    const issue = await resolveIssue(req.params.issueId);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    assertCompanyAccess(req, issue.companyId);

    const result = await db.execute(sql`
      SELECT * FROM workspace_revisions WHERE issue_id = ${issue.id}
      ORDER BY created_at DESC LIMIT 50
    `);
    return res.json(allRows(result));
  });

  // 3. POST /api/issues/:issueId/workspace-revisions
  router.post("/issues/:issueId/workspace-revisions", async (req, res) => {
    const issue = await resolveIssue(req.params.issueId);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    assertCompanyAccess(req, issue.companyId);

    const { parentRevisionId, baseRef, overlayRef, patchRef, sizeBytes, fileCount, expectedVersion } = req.body;
    if (expectedVersion === undefined || expectedVersion === null) {
      return res.status(400).json({ error: "expectedVersion is required" });
    }

    const newRevisionId = randomUUID();

    await db.execute(sql`
      INSERT INTO workspace_revisions
        (revision_id, issue_id, parent_revision_id, base_ref, overlay_ref, patch_ref, size_bytes, file_count, created_at)
      VALUES
        (${newRevisionId}, ${issue.id}, ${parentRevisionId ?? null}, ${baseRef ?? null},
         ${overlayRef ?? null}, ${patchRef ?? null}, ${sizeBytes ?? null}, ${fileCount ?? null}, now())
    `);

    const advResult = await db.execute(sql`
      SELECT advance_workspace_head(${issue.id}::uuid, ${newRevisionId}::uuid, ${expectedVersion}::int) AS result
    `);
    const advRow = firstRow(advResult);
    let parsed: Record<string, unknown> = {};
    const raw = advRow?.result;
    if (typeof raw === "string") {
      try { parsed = JSON.parse(raw); } catch { /* ignore */ }
    } else if (raw && typeof raw === "object") {
      parsed = raw as Record<string, unknown>;
    }

    if (!parsed?.ok) {
      return res.status(409).json({ error: "conflict", expected: expectedVersion, actual: parsed?.version ?? null });
    }

    return res.status(201).json({
      revisionId: newRevisionId, issueId: issue.id,
      parentRevisionId: parentRevisionId ?? null, baseRef: baseRef ?? null,
      overlayRef: overlayRef ?? null, patchRef: patchRef ?? null,
      sizeBytes: sizeBytes ?? null, fileCount: fileCount ?? null,
      version: parsed.version,
    });
  });

  // 4. GET /api/heartbeat-runs/:runId/artifacts
  router.get("/heartbeat-runs/:runId/artifacts", async (req, res) => {
    const run = await resolveRun(req, res);
    if (!run) return;
    const result = await db.execute(sql`
      SELECT * FROM run_artifacts WHERE run_id = ${run.id} ORDER BY created_at
    `);
    return res.json(allRows(result));
  });

  // 5. POST /api/heartbeat-runs/:runId/artifacts
  router.post("/heartbeat-runs/:runId/artifacts", async (req, res) => {
    const run = await resolveRun(req, res);
    if (!run) return;
    const { issueId, kind, objectRef, contentType, sizeBytes, sha256 } = req.body;
    if (!issueId || !kind || !objectRef) {
      return res.status(400).json({ error: "issueId, kind, and objectRef are required" });
    }
    const artifactId = randomUUID();
    await db.execute(sql`
      INSERT INTO run_artifacts
        (artifact_id, run_id, issue_id, kind, object_ref, content_type, size_bytes, sha256, created_at)
      VALUES
        (${artifactId}, ${run.id}, ${issueId}, ${kind}, ${objectRef},
         ${contentType ?? null}, ${sizeBytes ?? null}, ${sha256 ?? null}, now())
    `);
    return res.status(201).json({ artifactId, runId: run.id, issueId, kind, objectRef, contentType, sizeBytes, sha256 });
  });

  // 6. GET /api/run-artifacts/:artifactId
  router.get("/run-artifacts/:artifactId", async (req, res) => {
    assertAuthenticated(req);
    const result = await db.execute(sql`
      SELECT a.*, r.company_id FROM run_artifacts a
      JOIN heartbeat_runs r ON r.id = a.run_id
      WHERE a.artifact_id = ${req.params.artifactId}
    `);
    const row = firstRow(result);
    if (!row) return res.status(404).json({ error: "Artifact not found" });
    assertCompanyAccess(req, row.company_id as string);
    return res.json(row);
  });

  // 7. GET /api/issues/:issueId/run-artifacts
  router.get("/issues/:issueId/run-artifacts", async (req, res) => {
    const issue = await resolveIssue(req.params.issueId);
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    assertCompanyAccess(req, issue.companyId);
    const result = await db.execute(sql`
      SELECT * FROM run_artifacts WHERE issue_id = ${issue.id}
      ORDER BY created_at DESC LIMIT 100
    `);
    return res.json(allRows(result));
  });

  // 8. PUT /api/heartbeat-runs/:runId/logs
  router.put("/heartbeat-runs/:runId/logs", async (req, res) => {
    const run = await resolveRun(req, res);
    if (!run) return;
    const { stdoutRef, stderrRef, summaryRef } = req.body;
    await db.execute(sql`
      INSERT INTO run_logs (run_id, stdout_ref, stderr_ref, summary_ref, updated_at)
      VALUES (${run.id}, ${stdoutRef ?? null}, ${stderrRef ?? null}, ${summaryRef ?? null}, now())
      ON CONFLICT (run_id) DO UPDATE SET
        stdout_ref  = COALESCE(EXCLUDED.stdout_ref,  run_logs.stdout_ref),
        stderr_ref  = COALESCE(EXCLUDED.stderr_ref,  run_logs.stderr_ref),
        summary_ref = COALESCE(EXCLUDED.summary_ref, run_logs.summary_ref),
        updated_at  = now()
    `);
    return res.json({ runId: run.id, stdoutRef: stdoutRef ?? null, stderrRef: stderrRef ?? null, summaryRef: summaryRef ?? null });
  });

  // 9. GET /api/heartbeat-runs/:runId/logs
  router.get("/heartbeat-runs/:runId/logs", async (req, res) => {
    const run = await resolveRun(req, res);
    if (!run) return;
    const result = await db.execute(sql`
      SELECT * FROM run_logs WHERE run_id = ${run.id}
    `);
    const row = firstRow(result);
    if (!row) return res.json({ runId: run.id, stdoutRef: null, stderrRef: null, summaryRef: null });
    return res.json({ runId: run.id, stdoutRef: row.stdout_ref, stderrRef: row.stderr_ref, summaryRef: row.summary_ref });
  });

  return router;
}
