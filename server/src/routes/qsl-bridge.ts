import { Router } from "express";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { qslReviewService, ALL_REVIEW_STATES, type QslBridgeIssue } from "../services/qsl-review.js";

const ALLOWED_FILES = new Set(["manifest", "state", "issues", "approvals"]);

type ConfidenceSnapshots = Record<string, number>;

async function readSnapshots(bridgePath: string): Promise<ConfidenceSnapshots> {
  try {
    const raw = await readFile(path.join(bridgePath, "confidence-snapshots.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeSnapshots(bridgePath: string, snapshots: ConfidenceSnapshots): Promise<void> {
  await writeFile(
    path.join(bridgePath, "confidence-snapshots.json"),
    JSON.stringify(snapshots),
    "utf-8",
  );
}

async function readBridgeIssues(bridgePath: string): Promise<QslBridgeIssue[]> {
  try {
    const raw = await readFile(path.join(bridgePath, "issues.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : parsed.issues ?? [];
  } catch {
    return [];
  }
}

export function qslBridgeRoutes(db?: Db) {
  const router = Router();
  const reviewSvc = db ? qslReviewService(db) : null;

  /**
   * Resolve company ID from: URL param > actor session > header fallback.
   */
  function resolveCompanyId(req: any): string | null {
    // URL param (preferred — matches /companies/:companyId/qsl/findings)
    if (req.params?.companyId) return req.params.companyId;
    // Actor session — use first company membership if only one
    if (req.actor?.companyIds?.length === 1) return req.actor.companyIds[0];
    // Header fallback
    const header = req.headers?.["x-company-id"];
    return typeof header === "string" ? header : null;
  }

  // ── DB-backed findings endpoint ───────────────────────────────────
  // Mounted at both /qsl/findings and /companies/:companyId/qsl/findings
  async function handleListFindings(req: any, res: any) {
    const companyId = resolveCompanyId(req);
    if (!reviewSvc || !companyId) {
      // Fallback: read from bridge
      const bridgePath = process.env.QSL_BRIDGE_PATH;
      if (!bridgePath) {
        res.json([]);
        return;
      }
      const issues = await readBridgeIssues(bridgePath);
      res.json(issues);
      return;
    }

    // Sync bridge issues into DB first
    const bridgePath = process.env.QSL_BRIDGE_PATH;
    if (bridgePath) {
      const bridgeIssues = await readBridgeIssues(bridgePath);
      if (bridgeIssues.length > 0) {
        await reviewSvc.syncFindings(companyId, bridgeIssues);
      }
    }

    const filter = typeof req.query.reviewState === "string"
      ? { reviewState: req.query.reviewState }
      : undefined;

    const findings = await reviewSvc.listFindings(companyId, filter);
    res.json(findings);
  }

  router.get("/findings", handleListFindings);
  router.get("/companies/:companyId/findings", handleListFindings);

  // ── Review a finding (approve/deny) ───────────────────────────────
  async function handleReviewFinding(req: any, res: any) {
    if (!reviewSvc) {
      res.status(501).json({ error: "QSL review persistence not available (no database)" });
      return;
    }

    const findingId = req.params.id;
    const { decision, notes } = req.body;

    if (decision !== "approved" && decision !== "denied") {
      res.status(400).json({ error: "decision must be 'approved' or 'denied'" });
      return;
    }

    const reviewerId = (req as any).actor?.userId ?? "board";

    try {
      const finding = await reviewSvc.reviewFinding(findingId, decision, reviewerId, notes);

      // Also write to approvals.jsonl for backward compat with the bridge
      const bridgePath = process.env.QSL_BRIDGE_PATH;
      if (bridgePath && finding.ruleId) {
        const approvalsPath = path.join(bridgePath, "..", "..", "approvals.jsonl");
        const resolved = path.resolve(approvalsPath);
        const resolvedBridge = path.resolve(bridgePath);
        if (!resolved.startsWith(resolvedBridge)) {
          const approval = {
            id: randomUUID(),
            created_at: new Date().toISOString(),
            source: "paperclip",
            rule_id: finding.ruleId,
            approved: decision === "approved",
            decision: decision === "approved" ? "approve" : "deny",
            reason: notes ?? `${decision} from Paperclip QSL Review`,
            finding_id: finding.id,
            change: { rule_id: finding.ruleId, source: "paperclip_qsl_review" },
          };
          await appendFile(resolved, JSON.stringify(approval) + "\n", "utf-8").catch(() => {});
        }

        // Snapshot confidence
        try {
          const stateRaw = await readFile(path.join(bridgePath, "state.json"), "utf-8");
          const state = JSON.parse(stateRaw);
          if (state.rules && Array.isArray(state.rules) && finding.ruleId) {
            const rule = state.rules.find((r: { id: string }) => r.id === finding.ruleId);
            if (rule && typeof rule.confidence === "number") {
              const snapshots = await readSnapshots(bridgePath);
              snapshots[finding.ruleId] = rule.confidence;
              await writeSnapshots(bridgePath, snapshots);
            }
          }
        } catch { /* best-effort */ }
      }

      res.json(finding);
    } catch (err) {
      if (err instanceof Error && err.message === "Finding not found") {
        res.status(404).json({ error: "Finding not found" });
        return;
      }
      res.status(500).json({ error: "Failed to review finding" });
    }
  }

  router.post("/findings/:id/review", handleReviewFinding);
  router.post("/companies/:companyId/findings/:id/review", handleReviewFinding);

  // ── Set review state (acknowledge, suppress, accept_risk, escalate) ──
  async function handleSetFindingState(req: any, res: any) {
    if (!reviewSvc) {
      res.status(501).json({ error: "QSL review persistence not available (no database)" });
      return;
    }

    const findingId = req.params.id;
    const { state, notes } = req.body;

    if (!ALL_REVIEW_STATES.includes(state)) {
      res.status(400).json({ error: `state must be one of: ${ALL_REVIEW_STATES.join(", ")}` });
      return;
    }

    const reviewerId = (req as any).actor?.userId ?? "board";

    try {
      const finding = await reviewSvc.setReviewState(findingId, state, reviewerId, notes);
      res.json(finding);
    } catch (err) {
      if (err instanceof Error && err.message === "Finding not found") {
        res.status(404).json({ error: "Finding not found" });
        return;
      }
      res.status(500).json({ error: "Failed to update finding state" });
    }
  }

  router.post("/findings/:id/state", handleSetFindingState);
  router.post("/companies/:companyId/findings/:id/state", handleSetFindingState);

  // ── Legacy bridge file endpoints (kept for backward compat) ───────
  for (const name of ALLOWED_FILES) {
    router.get(`/${name}`, async (_req, res) => {
      const bridgePath = process.env.QSL_BRIDGE_PATH;
      if (!bridgePath) {
        res.status(404).json({ error: "QSL bridge not configured" });
        return;
      }

      const filePath = path.join(bridgePath, `${name}.json`);

      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch (err: unknown) {
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          res.status(404).json({ error: `Bridge file not found: ${name}.json` });
          return;
        }
        res.status(500).json({ error: "Failed to read bridge file" });
        return;
      }

      try {
        const data = JSON.parse(raw);
        // Merge previous_confidence snapshots into state response
        if (name === "state" && data.rules && Array.isArray(data.rules)) {
          const snapshots = await readSnapshots(bridgePath);
          for (const rule of data.rules) {
            if (rule.id && rule.id in snapshots) {
              rule.previous_confidence = snapshots[rule.id];
            }
          }
        }
        res.json(data);
      } catch {
        res.status(500).json({ error: "Failed to parse bridge file" });
      }
    });
  }

  // ── Legacy approve endpoint (kept for backward compat) ────────────
  router.post("/approve", async (req, res) => {
    const bridgePath = process.env.QSL_BRIDGE_PATH;
    if (!bridgePath) {
      res.status(404).json({ error: "QSL bridge not configured" });
      return;
    }

    const body = req.body;
    if (!body || typeof body.rule_id !== "string" || !body.rule_id) {
      res.status(400).json({ error: "rule_id is required and must be a non-empty string" });
      return;
    }
    if (typeof body.approved !== "boolean") {
      res.status(400).json({ error: "approved is required and must be a boolean" });
      return;
    }

    // Derive approvals.jsonl from bridge path's grandparent
    const approvalsPath = path.join(bridgePath, "..", "..", "approvals.jsonl");
    const resolved = path.resolve(approvalsPath);
    const resolvedBridge = path.resolve(bridgePath);
    if (resolved.startsWith(resolvedBridge)) {
      res.status(400).json({ error: "Invalid approvals path" });
      return;
    }

    // Snapshot the rule's current confidence before writing the approval
    try {
      const stateRaw = await readFile(path.join(bridgePath, "state.json"), "utf-8");
      const state = JSON.parse(stateRaw);
      if (state.rules && Array.isArray(state.rules)) {
        const rule = state.rules.find((r: { id: string }) => r.id === body.rule_id);
        if (rule && typeof rule.confidence === "number") {
          const snapshots = await readSnapshots(bridgePath);
          snapshots[body.rule_id] = rule.confidence;
          await writeSnapshots(bridgePath, snapshots);
        }
      }
    } catch {
      // Non-fatal: snapshot is best-effort
    }

    const approval = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      source: "paperclip",
      rule_id: body.rule_id,
      approved: body.approved,
      decision: body.approved ? "approve" : "deny",
      action: typeof body.action === "string" ? body.action : undefined,
      reason: typeof body.reason === "string" ? body.reason : undefined,
      change: {
        rule_id: body.rule_id,
        source: "paperclip_approval",
      },
    };

    const line = JSON.stringify(approval) + "\n";

    try {
      await appendFile(resolved, line, "utf-8");
    } catch {
      res.status(500).json({ error: "Failed to write approval" });
      return;
    }

    res.status(200).json(approval);
  });

  return router;
}
