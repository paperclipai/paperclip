import { Router } from "express";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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

export function qslBridgeRoutes() {
  const router = Router();

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
    // QSL_BRIDGE_PATH = .../quantumshield-core/bridge/output
    // approvals target = .../quantumshield-core/approvals.jsonl
    const approvalsPath = path.join(bridgePath, "..", "..", "approvals.jsonl");
    const resolved = path.resolve(approvalsPath);

    // Safety: ensure we're not writing inside bridge/output
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
