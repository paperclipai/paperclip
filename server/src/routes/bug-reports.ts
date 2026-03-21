import { Router } from "express";
import { z } from "zod";
import { LinearClient } from "@linear/sdk";
import { assertBoard } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { logger } from "../middleware/logger.js";

const bugReportSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).default(""),
  severity: z.enum(["critical", "high", "medium", "low"]),
  pageUrl: z.string().max(500).default(""),
  userAgent: z.string().max(500).default(""),
});

const SEVERITY_PRIORITY: Record<string, number> = {
  critical: 1, // urgent
  high: 2,     // high
  medium: 3,   // medium
  low: 4,      // low
};

export function bugReportRoutes() {
  const router = Router();

  router.post("/bug-reports", validate(bugReportSchema), async (req, res) => {
    assertBoard(req);

    const apiKey = process.env.LINEAR_API_KEY;
    const teamKey = process.env.LINEAR_TEAM_KEY ?? "VALINT";

    if (!apiKey) {
      logger.warn("Bug report submitted but LINEAR_API_KEY is not configured");
      res.status(503).json({ error: "Bug reporting is not configured. Set LINEAR_API_KEY." });
      return;
    }

    const { title, description, severity, pageUrl, userAgent } = req.body;
    const actorLabel =
      req.actor.source === "local_implicit"
        ? "Local Board"
        : req.actor.userId ?? "Unknown user";

    const bodyParts = [
      description,
      "",
      "---",
      `**Severity:** ${severity}`,
      `**Reported by:** ${actorLabel}`,
      pageUrl ? `**Page:** ${pageUrl}` : null,
      userAgent ? `**Browser:** ${userAgent}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const linear = new LinearClient({ apiKey });

      // Resolve team by key
      const teams = await linear.teams({ filter: { key: { eq: teamKey } } });
      const team = teams.nodes[0];
      if (!team) {
        logger.error(`Linear team with key "${teamKey}" not found`);
        res.status(503).json({ error: `Linear team "${teamKey}" not found.` });
        return;
      }

      // Find or create "bug" and "user-reported" labels on this team
      const labelNames = ["bug", "user-reported", "paperclip"];
      const existingLabels = await linear.issueLabels({
        filter: {
          team: { id: { eq: team.id } },
          name: { in: labelNames },
        },
      });
      const existingLabelMap = new Map(existingLabels.nodes.map((l) => [l.name, l.id]));
      const labelIds: string[] = [];

      for (const name of labelNames) {
        if (existingLabelMap.has(name)) {
          labelIds.push(existingLabelMap.get(name)!);
        } else {
          try {
            const created = await linear.createIssueLabel({
              teamId: team.id,
              name,
              color: name === "bug" ? "#FF3B30" : name === "paperclip" ? "#0066CC" : "#6E6E73",
            });
            const label = await created.issueLabel;
            if (label) labelIds.push(label.id);
          } catch (labelErr) {
            logger.warn(`Could not create Linear label "${name}": ${labelErr}`);
          }
        }
      }

      const issue = await linear.createIssue({
        teamId: team.id,
        title: `[Bug] ${title}`,
        description: bodyParts,
        priority: SEVERITY_PRIORITY[severity] ?? 3,
        labelIds: labelIds.length > 0 ? labelIds : undefined,
      });

      const created = await issue.issue;
      logger.info(`Bug report filed to Linear: ${created?.identifier ?? "unknown"}`);

      res.json({
        success: true,
        issueIdentifier: created?.identifier ?? null,
        issueUrl: created?.url ?? null,
      });
    } catch (err) {
      logger.error("Failed to file bug report to Linear: %s", err instanceof Error ? err.message : String(err));
      res.status(502).json({ error: "Failed to file bug report. Check server logs." });
    }
  });

  return router;
}
