import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { eq, desc } from "drizzle-orm";
import { pluginLogs } from "@paperclipai/db";
import { badRequest, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { secretService } from "../services/secrets.js";
import { goalService } from "../services/goals.js";
import { pluginStateStore } from "../services/plugin-state-store.js";
import { issueService } from "../services/issues.js";
import { logActivity } from "../services/index.js";

const GITHUB_SYNC_PLUGIN_KEY = "paperclipai.plugin-github-sync";
const REPO_PATTERN = /^[^/]+\/[^/]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SYNC_FOOTER =
  "\n\n---\n\nSynced from Paperclip. Comments here are not read back into Paperclip — open a PR or contact the maintainer.";

function sanitiseBody(body: string | null): string {
  let text = body ?? "";
  text = text.replace(/\[([^\]]*)\]\(\/[A-Z][A-Z0-9-]*\/[^)]+\)/g, "$1");
  text = text.replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    "[id-redacted]",
  );
  return text + SYNC_FOOTER;
}

function buildTitle(identifier: string | null, title: string): string {
  return identifier ? `[${identifier}] ${title}` : title;
}

function mapIssueStatus(status: string): {
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned";
} {
  if (status === "done") return { state: "closed", state_reason: "completed" };
  if (status === "cancelled") return { state: "closed", state_reason: "not_planned" };
  return { state: "open" };
}

interface GithubConfig {
  repo: string;
  host: string;
  secretRef: string;
  syncedGoalIds: string[];
  dryRun: boolean;
}

function parseConfig(settingsJson: Record<string, unknown>): GithubConfig {
  return {
    repo: typeof settingsJson["repo"] === "string" ? settingsJson["repo"] : "",
    host: typeof settingsJson["host"] === "string" ? settingsJson["host"] : "github.com",
    secretRef: typeof settingsJson["secretRef"] === "string" ? settingsJson["secretRef"] : "",
    syncedGoalIds: Array.isArray(settingsJson["syncedGoalIds"])
      ? (settingsJson["syncedGoalIds"] as string[])
      : [],
    dryRun: settingsJson["dryRun"] !== false,
  };
}

export function githubIntegrationRoutes(db: Db) {
  const router = Router();
  const registry = pluginRegistryService(db);
  const secrets = secretService(db);
  const goals = goalService(db);
  const stateStore = pluginStateStore(db);
  const issueSvc = issueService(db);

  // GET /api/companies/:companyId/integrations/github
  router.get("/companies/:companyId/integrations/github", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const plugin = await registry.getByKey(GITHUB_SYNC_PLUGIN_KEY);
    if (!plugin) {
      res.json({ configured: false, reason: "plugin_not_installed" });
      return;
    }

    const settings = await registry.getCompanySettings(plugin.id, companyId);
    if (!settings) {
      res.json({ configured: false });
      return;
    }

    const config = parseConfig(settings.settingsJson);

    const lastLog = await db
      .select({ message: pluginLogs.message, createdAt: pluginLogs.createdAt })
      .from(pluginLogs)
      .where(eq(pluginLogs.pluginId, plugin.id))
      .orderBy(desc(pluginLogs.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    res.json({
      configured: true,
      enabled: settings.enabled,
      repo: config.repo || null,
      host: config.host,
      secretRef: config.secretRef || null,
      syncedGoalIds: config.syncedGoalIds,
      dryRun: config.dryRun,
      lastError: settings.lastError ?? null,
      lastSyncAt: lastLog?.createdAt ?? null,
      lastSyncMessage: lastLog?.message ?? null,
    });
  });

  // POST /api/companies/:companyId/integrations/github
  router.post("/companies/:companyId/integrations/github", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const body = req.body as Record<string, unknown>;

    if (typeof body["repo"] !== "string" || !REPO_PATTERN.test(body["repo"])) {
      throw badRequest('repo must be in "owner/repo" format');
    }

    if (typeof body["secretRef"] !== "string" || !UUID_PATTERN.test(body["secretRef"])) {
      throw badRequest("secretRef must be a valid secret UUID");
    }

    const secret = await secrets.getById(body["secretRef"]);
    if (!secret || secret.companyId !== companyId) {
      throw unprocessable("secretRef does not resolve to a secret in this company");
    }

    const rawGoalIds = Array.isArray(body["syncedGoalIds"]) ? (body["syncedGoalIds"] as unknown[]) : [];
    if (!rawGoalIds.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
      throw badRequest("syncedGoalIds must be an array of UUID strings");
    }
    const syncedGoalIds = rawGoalIds as string[];

    if (syncedGoalIds.length > 0) {
      const companyGoals = await goals.list(companyId);
      const goalIdSet = new Set(companyGoals.map((g) => g.id));
      const missing = syncedGoalIds.filter((id) => !goalIdSet.has(id));
      if (missing.length > 0) {
        throw unprocessable(
          `syncedGoalIds contains goals not in this company: ${missing.join(", ")}`,
        );
      }
    }

    const plugin = await registry.getByKey(GITHUB_SYNC_PLUGIN_KEY);
    if (!plugin) {
      res.status(422).json({ error: "GitHub sync plugin is not installed on this instance" });
      return;
    }

    const configToSave: GithubConfig = {
      repo: body["repo"] as string,
      host:
        typeof body["host"] === "string" && body["host"].trim().length > 0
          ? body["host"].trim()
          : "github.com",
      secretRef: body["secretRef"] as string,
      syncedGoalIds,
      dryRun: body["dryRun"] !== false,
    };

    if (configToSave.dryRun === false && configToSave.syncedGoalIds.length === 0) {
      throw unprocessable(
        "syncedGoalIds must list at least one goal when dryRun is disabled — leaving it empty would mirror every issue in the company. Either pick the goal subtrees you want to sync, or keep dryRun enabled.",
      );
    }

    // Validate that the configured token is authorised on the target repo whenever
    // the repo value changes.  Skipped when repo is unchanged to avoid an extra
    // GitHub round-trip on every config save.
    const existingSettings = await registry.getCompanySettings(plugin.id, companyId);
    const prevRepo = existingSettings ? parseConfig(existingSettings.settingsJson).repo : "";

    if (configToSave.repo !== prevRepo) {
      const [owner, repo] = configToSave.repo.split("/");
      const apiHost = configToSave.host === "github.com" ? "api.github.com" : configToSave.host;
      const token = await secrets.resolveSecretValue(companyId, configToSave.secretRef, "latest");

      let handshakeStatus: number | null = null;
      let handshakeBody = "";
      try {
        const resp = await fetch(`https://${apiHost}/repos/${owner}/${repo}`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "paperclip-github-sync/0.1.0",
          },
          redirect: "error",
        });
        handshakeStatus = resp.status;
        if (!resp.ok) {
          handshakeBody = await resp.text().catch(() => "");
        }
      } catch {
        // Network/redirect error — allow the config save; the first sync will surface it.
      }

      if (handshakeStatus === 401 || handshakeStatus === 403 || handshakeStatus === 404) {
        const raw = `GitHub ${handshakeStatus}: ${handshakeBody.slice(0, 200)}`;
        const redacted = token ? raw.split(token).join("[REDACTED]") : raw;
        throw unprocessable(`GitHub token is not authorised on the configured repo: ${redacted}`);
      }
    }

    const updated = await registry.upsertCompanySettings(plugin.id, companyId, {
      enabled: true,
      settingsJson: configToSave as unknown as Record<string, unknown>,
      lastError: null,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github_integration.configured",
      entityType: "company",
      entityId: companyId,
      details: { repo: configToSave.repo, dryRun: configToSave.dryRun },
    });

    res.json({
      configured: true,
      enabled: updated.enabled,
      repo: configToSave.repo,
      host: configToSave.host,
      secretRef: configToSave.secretRef,
      syncedGoalIds: configToSave.syncedGoalIds,
      dryRun: configToSave.dryRun,
      lastError: null,
    });
  });

  // DELETE /api/companies/:companyId/integrations/github
  router.delete("/companies/:companyId/integrations/github", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const plugin = await registry.getByKey(GITHUB_SYNC_PLUGIN_KEY);
    if (!plugin) {
      res.json({ ok: true });
      return;
    }

    const existing = await registry.getCompanySettings(plugin.id, companyId);
    if (!existing) {
      res.json({ ok: true });
      return;
    }

    await registry.upsertCompanySettings(plugin.id, companyId, {
      enabled: false,
      settingsJson: existing.settingsJson,
    });

    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "github_integration.disabled",
      entityType: "company",
      entityId: companyId,
    });

    res.json({ ok: true });
  });

  // POST /api/issues/:issueId/sync-to-github
  router.post("/issues/:issueId/sync-to-github", async (req, res) => {
    assertBoard(req);
    const issueId = req.params.issueId as string;

    const issue = await issueSvc.getById(issueId);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }

    const companyId = issue.companyId;
    assertCompanyAccess(req, companyId);

    const plugin = await registry.getByKey(GITHUB_SYNC_PLUGIN_KEY);
    if (!plugin) {
      res.status(422).json({ error: "GitHub sync plugin is not installed" });
      return;
    }

    const settings = await registry.getCompanySettings(plugin.id, companyId);
    if (!settings || !settings.enabled) {
      res.status(422).json({ error: "GitHub integration is not configured or disabled for this company" });
      return;
    }

    const config = parseConfig(settings.settingsJson);
    if (!config.repo || !config.secretRef) {
      res.status(422).json({ error: "GitHub integration config is incomplete" });
      return;
    }

    const title = buildTitle(issue.identifier ?? null, issue.title);
    const body = sanitiseBody(issue.description ?? null);
    const { state, state_reason } = mapIssueStatus(issue.status);
    const ts = new Date().toISOString();

    if (config.dryRun) {
      await db.insert(pluginLogs).values({
        pluginId: plugin.id,
        level: "info",
        message: `dry-run: would_create_or_update ${title}`,
        meta: { issueId, action: "would_create_or_update", state },
      });
      res.json({
        dryRun: true,
        action: "would_create_or_update",
        title,
        body,
        state,
        ...(state_reason ? { state_reason } : {}),
        ts,
      });
      return;
    }

    let token: string;
    try {
      token = await secrets.resolveSecretValue(companyId, config.secretRef, "latest");
    } catch (err) {
      res.status(422).json({ error: `Failed to resolve secretRef: ${String(err)}` });
      return;
    }

    const redact = (s: string) => (token ? s.split(token).join("[REDACTED]") : s);

    const existingRaw = await stateStore.get(plugin.id, "issue", "gh-issue-number", {
      scopeId: issueId,
      namespace: "github-sync",
    });
    const existingGhNumber = typeof existingRaw === "number" ? existingRaw : null;

    const [owner, repo] = config.repo.split("/");
    const apiHost = config.host === "github.com" ? "api.github.com" : config.host;
    const baseUrl = `https://${apiHost}/repos/${owner}/${repo}`;

    async function ghRequest<T>(method: string, path: string, reqBody?: unknown): Promise<T> {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          "User-Agent": "paperclip-github-sync/0.1.0",
        },
        body: reqBody !== undefined ? JSON.stringify(reqBody) : undefined,
        redirect: "error",
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(redact(`GitHub API error ${response.status}: ${errText.slice(0, 200)}`));
      }
      return response.json() as Promise<T>;
    }

    let ghIssueNumber: number;
    let action: "created" | "updated";

    try {
      if (existingGhNumber === null) {
        const ghIssue = await ghRequest<{ number: number }>("POST", "/issues", {
          title,
          body,
          labels: ["paperclip-synced"],
        });
        ghIssueNumber = ghIssue.number;
        action = "created";

        if (state === "closed") {
          await ghRequest("PATCH", `/issues/${ghIssueNumber}`, {
            state,
            state_reason: state_reason ?? "completed",
          });
        }

        await stateStore.set(plugin.id, {
          scopeKind: "issue",
          scopeId: issueId,
          namespace: "github-sync",
          stateKey: "gh-issue-number",
          value: ghIssueNumber,
        });
      } else {
        await ghRequest("PATCH", `/issues/${existingGhNumber}`, {
          title,
          body,
          state,
          ...(state_reason ? { state_reason } : {}),
          labels: ["paperclip-synced"],
        });
        ghIssueNumber = existingGhNumber;
        action = "updated";
      }
    } catch (err) {
      const errMsg = redact(String(err));
      await registry.upsertCompanySettings(plugin.id, companyId, {
        enabled: true,
        settingsJson: settings.settingsJson,
        lastError: errMsg,
      });
      await db.insert(pluginLogs).values({
        pluginId: plugin.id,
        level: "error",
        message: `sync failed for ${title}: ${errMsg}`,
        meta: { issueId, error: errMsg },
      });
      res.status(502).json({ error: `GitHub API call failed: ${errMsg}` });
      return;
    }

    await registry.upsertCompanySettings(plugin.id, companyId, {
      enabled: true,
      settingsJson: settings.settingsJson,
      lastError: null,
    });

    await db.insert(pluginLogs).values({
      pluginId: plugin.id,
      level: "info",
      message: `${action} #${ghIssueNumber} for ${title}`,
      meta: { issueId, action, githubIssueNumber: ghIssueNumber },
    });

    res.json({ dryRun: false, action, githubIssueNumber: ghIssueNumber, ts });
  });

  return router;
}
