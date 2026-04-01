/**
 * Linear OAuth routes for Paperclip.
 *
 * GET  /api/auth/linear/start    — Redirect to Linear OAuth authorize page
 * GET  /api/auth/linear/callback — Exchange code for token, store as company secret
 * GET  /api/auth/linear/status   — Check if Linear is connected for a company
 * POST /api/auth/linear/disconnect — Remove Linear connection
 */

import { Router } from "express";
import crypto from "node:crypto";
import type { Db } from "@paperclipai/db";
import { plugins, pluginConfig, companies, labels, issueLabels, projects, cycles, issueCycles } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import type { SecretProvider } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";

const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";

const LINEAR_SECRET_NAME = "linear-oauth-token";
const SCOPES = ["read", "write", "admin"];

// In-memory CSRF state store (short-lived, cleared on use)
const pendingStates = new Map<string, { companyId: string; createdAt: number }>();

// Clean expired states every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingStates) {
    if (now - value.createdAt > 600_000) pendingStates.delete(key);
  }
}, 300_000);

export interface LinearAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  secretsProvider: SecretProvider;
}

export function linearAuthRoutes(db: Db, config: LinearAuthConfig) {
  const router = Router();
  const svc = secretService(db);

  // GET /api/auth/linear/start?companyId=xxx
  router.get("/start", (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId query param required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    if (!config.clientId) {
      res.status(500).json({ error: "Linear OAuth not configured (PAPERCLIP_LINEAR_CLIENT_ID)" });
      return;
    }

    const state = crypto.randomBytes(32).toString("hex");
    pendingStates.set(state, { companyId, createdAt: Date.now() });

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: SCOPES.join(","),
      state,
      prompt: "consent",
    });

    res.redirect(`${LINEAR_AUTHORIZE_URL}?${params.toString()}`);
  });

  // GET /api/auth/linear/callback?code=xxx&state=yyy
  // No auth required — this is a redirect from Linear's OAuth server
  router.get("/callback", async (req, res, next) => {
    try {
    const code = req.query.code as string;
    const state = req.query.state as string;
    const error = req.query.error as string;

    if (error) {
      res.status(400).send(callbackPage("error", `Linear OAuth error: ${error}`));
      return;
    }

    if (!code || !state) {
      res.status(400).send(callbackPage("error", "Missing code or state parameter"));
      return;
    }

    const pending = pendingStates.get(state);
    if (!pending) {
      res.status(400).send(callbackPage("error", "Invalid or expired state. Please try again."));
      return;
    }
    pendingStates.delete(state);

    const { companyId } = pending;
    console.log("[linear-auth] callback companyId:", companyId);

    // Exchange code for access token
    const tokenRes = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      res.status(500).send(callbackPage("error", `Token exchange failed: ${tokenRes.status}`));
      return;
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in?: number;
      scope?: string;
    };

    // Store or rotate the token as a company secret
    const existing = await svc.getByName(companyId, LINEAR_SECRET_NAME);
    if (existing) {
      await svc.rotate(
        existing.id,
        { value: tokenData.access_token, externalRef: null },
        { userId: "oauth-callback", agentId: null },
      );
    } else {
      await svc.create(
        companyId,
        {
          name: LINEAR_SECRET_NAME,
          provider: config.secretsProvider,
          value: tokenData.access_token,
          description: "Linear OAuth access token (auto-managed)",
          externalRef: null,
        },
        { userId: "oauth-callback", agentId: null },
      );
    }

    // Get the secret ID (either existing or freshly created)
    const secret = await svc.getByName(companyId, LINEAR_SECRET_NAME);
    const secretId = secret?.id;

    // Fetch Linear teams to auto-detect team ID
    let teamId = "";
    let teamKey = "";
    try {
      const teamsRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          Authorization: tokenData.access_token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: "{ teams { nodes { id name key } } }" }),
      });
      if (teamsRes.ok) {
        const teamsData = (await teamsRes.json()) as {
          data?: { teams?: { nodes?: Array<{ id: string; name: string; key: string }> } };
        };
        const teams = teamsData.data?.teams?.nodes ?? [];
        if (teams.length > 0) {
          teamId = teams[0].id;
          teamKey = teams[0].key;
          console.log(`[linear-auth] auto-detected team: ${teamKey} (${teams[0].name})`);
        }
      }
    } catch {
      console.warn("[linear-auth] could not fetch Linear teams for auto-config");
    }

    // Sync company issue prefix to match Linear team key (e.g., LUC)
    if (teamKey) {
      try {
        // Fetch the highest issue number so Paperclip starts numbering after it
        const counterRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: {
            Authorization: tokenData.access_token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `query($teamId: ID!) {
              issues(
                filter: { team: { id: { eq: $teamId } } }
                orderBy: updatedAt
                first: 100
              ) { nodes { number } }
            }`,
            variables: { teamId },
          }),
        });
        let issueCounter = 0;
        if (counterRes.ok) {
          const counterData = (await counterRes.json()) as {
            data?: { issues?: { nodes?: Array<{ number: number }> } };
            errors?: Array<{ message: string }>;
          };
          if (counterData.errors?.length) {
            console.warn("[linear-auth] counter query errors:", counterData.errors);
          }
          const numbers = counterData.data?.issues?.nodes?.map((n) => n.number) ?? [];
          issueCounter = numbers.length > 0 ? Math.max(...numbers) : 0;
          console.log(`[linear-auth] highest issue number from Linear: ${issueCounter}`);
        }

        await db
          .update(companies)
          .set({
            issuePrefix: teamKey,
            issueCounter,
            updatedAt: new Date(),
          })
          .where(eq(companies.id, companyId));
        console.log(`[linear-auth] synced company prefix to ${teamKey}, counter to ${issueCounter}`);
      } catch (err) {
        console.warn("[linear-auth] could not sync issue prefix:", err);
      }
    }

    // Auto-configure the Linear plugin if installed
    if (secretId) {
      try {
        const [plugin] = await db
          .select()
          .from(plugins)
          .where(eq(plugins.pluginKey, "paperclip-plugin-linear"))
          .limit(1);

        if (plugin) {
          const configJson = {
            linearTokenRef: secretId,
            teamId,
            syncComments: true,
            syncDirection: "bidirectional",
          };

          const [existingConfig] = await db
            .select()
            .from(pluginConfig)
            .where(eq(pluginConfig.pluginId, plugin.id))
            .limit(1);

          if (existingConfig) {
            await db
              .update(pluginConfig)
              .set({ configJson, updatedAt: new Date() })
              .where(eq(pluginConfig.pluginId, plugin.id));
          } else {
            await db.insert(pluginConfig).values({
              pluginId: plugin.id,
              configJson,
            });
          }
          // Store company ID in plugin state so the import job can find it
          const { pluginState } = await import("@paperclipai/db");
          await db.insert(pluginState).values({
            pluginId: plugin.id,
            scopeKind: "instance",
            scopeId: null,
            namespace: "default",
            stateKey: "company-id",
            valueJson: JSON.stringify(companyId),
          }).onConflictDoUpdate({
            target: [pluginState.pluginId, pluginState.scopeKind, pluginState.scopeId, pluginState.namespace, pluginState.stateKey],
            set: { valueJson: JSON.stringify(companyId), updatedAt: new Date() },
          });

          console.log("[linear-auth] auto-configured Linear plugin");

          // Start or update tunnel + webhook
          try {
            const { getTunnelUrl, startLinearTunnel, registerWebhookWithToken } = await import("../linear-tunnel.js");
            const existingTunnel = getTunnelUrl();
            if (existingTunnel) {
              // Tunnel already running — register webhook with new admin-scoped token
              void registerWebhookWithToken(existingTunnel, tokenData.access_token, teamId);
            } else if (teamId) {
              // Start tunnel + webhook
              const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
              void startLinearTunnel({
                port: Number(port),
                linearToken: tokenData.access_token,
                teamId,
              });
            }
          } catch {
            // Tunnel module not critical
          }

          // Auto-trigger import then full sync after connect.
          // Import pulls issues first, sync enriches with projects + labels.
          try {
            const port = process.env.PAPERCLIP_LISTEN_PORT || process.env.PORT || "3100";
            const baseUrl = `http://127.0.0.1:${port}/api/auth/linear`;
            void (async () => {
              try {
                // Step 1: Import all issues from Linear
                const importRes = await fetch(`${baseUrl}/import?companyId=${companyId}`, { method: "POST" });
                if (importRes.ok) {
                  const importResult = await importRes.json() as { imported?: number };
                  console.log(`[linear-auth] auto-import: ${importResult.imported} issues`);
                }
                // Step 2: Full sync to pull projects, labels, and update fields
                const syncRes = await fetch(`${baseUrl}/sync?companyId=${companyId}`, { method: "POST" });
                if (syncRes.ok) {
                  const syncResult = await syncRes.json() as { synced?: number; projects?: number; labels?: number };
                  console.log(`[linear-auth] auto-sync: ${syncResult.synced} issues, ${syncResult.projects} projects, ${syncResult.labels} labels`);
                }
              } catch (err) {
                console.warn("[linear-auth] auto-import/sync failed:", err);
              }
            })();
          } catch {
            // Non-critical — user can trigger manually from settings
          }
        }
      } catch (err) {
        console.warn("[linear-auth] could not auto-configure plugin:", err);
      }
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "oauth-callback",
      action: "linear.connected",
      entityType: "secret",
      entityId: LINEAR_SECRET_NAME,
      details: { method: "oauth", teamId },
    });

    res.send(callbackPage("success", "Linear connected! Plugin configured automatically."));
    } catch (err) {
      console.error("[linear-auth] callback error:", err);
      res.status(500).send(callbackPage("error", `Server error: ${err instanceof Error ? err.message : "unknown"}`));
    }
  });

  // GET /api/auth/linear/status?companyId=xxx
  router.get("/status", async (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const existing = await svc.getByName(companyId, LINEAR_SECRET_NAME);

    // If connected, fetch issue stats from Linear
    let openIssueCount: number | null = null;
    let highestIssueNumber: number | null = null;
    let teamKey: string | null = null;
    let currentCounter: number | null = null;

    if (existing) {
      try {
        const tokenValue = await svc.resolveSecretValue(companyId, existing.id, "latest");
        const statsRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: tokenValue, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query {
              teams {
                nodes {
                  id
                  key
                  issueCount
                  issues(filter: { state: { type: { nin: ["completed", "cancelled"] } } }, first: 250) {
                    nodes { id }
                  }
                }
              }
            }`,
          }),
        });
        if (statsRes.ok) {
          const data = (await statsRes.json()) as {
            data?: {
              teams?: { nodes?: Array<{ id: string; key: string; issueCount: number; issues: { nodes: Array<{ id: string }> } }> };
            };
            errors?: Array<{ message: string }>;
          };
          if (data.errors?.length) {
            console.warn("[linear-auth] GraphQL errors:", data.errors);
          }
          const team = data.data?.teams?.nodes?.[0];
          openIssueCount = team?.issues?.nodes?.length ?? null;
          teamKey = team?.key ?? null;

          // Fetch highest issue number (sort by number descending, take first)
          if (team?.id) {
            try {
              const highRes = await fetch("https://api.linear.app/graphql", {
                method: "POST",
                headers: { Authorization: tokenValue, "Content-Type": "application/json" },
                body: JSON.stringify({
                  query: `query($teamId: ID!) {
                    issues(
                      filter: { team: { id: { eq: $teamId } } }
                      orderBy: updatedAt
                      first: 100
                    ) { nodes { number } }
                  }`,
                  variables: { teamId: team.id },
                }),
              });
              if (highRes.ok) {
                const highData = (await highRes.json()) as {
                  data?: { issues?: { nodes?: Array<{ number: number }> } };
                  errors?: Array<{ message: string }>;
                };
                if (highData.errors?.length) {
                  console.warn("[linear-auth] highest number query errors:", highData.errors);
                }
                const numbers = highData.data?.issues?.nodes?.map((n) => n.number) ?? [];
                highestIssueNumber = numbers.length > 0 ? Math.max(...numbers) : null;
              }
            } catch (err) {
              console.warn("[linear-auth] failed to fetch highest issue number:", err);
            }
            if (highestIssueNumber === null) highestIssueNumber = team.issueCount;
          }
        } else {
          console.warn("[linear-auth] status fetch failed:", statsRes.status, await statsRes.text());
        }
      } catch (err) {
        console.warn("[linear-auth] status fetch error:", err);
      }

      // Get the company's current counter
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      currentCounter = company?.issueCounter ?? null;
    }

    res.json({
      connected: !!existing,
      secretId: existing?.id ?? null,
      configured: !!config.clientId,
      openIssueCount,
      highestIssueNumber,
      currentCounter,
      teamKey,
    });
  });

  // POST /api/auth/linear/import?companyId=xxx
  // Server-side import with direct DB access — sets exact issue numbers from Linear
  router.post("/import", async (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    try {
      const { issues, pluginState } = await import("@paperclipai/db");

      // Get the Linear token
      const secret = await svc.getByName(companyId, LINEAR_SECRET_NAME);
      if (!secret) {
        res.status(400).json({ error: "Linear not connected" });
        return;
      }
      const token = await svc.resolveSecretValue(companyId, secret.id, "latest");

      // Get company info for prefix
      const [company] = await db.select().from(companies).where(eq(companies.id, companyId));
      if (!company) {
        res.status(404).json({ error: "Company not found" });
        return;
      }

      // Get the Linear plugin for storing link state
      const [plugin] = await db
        .select()
        .from(plugins)
        .where(eq(plugins.pluginKey, "paperclip-plugin-linear"))
        .limit(1);

      // Get config for teamId
      let teamId = "";
      if (plugin) {
        const [cfg] = await db.select().from(pluginConfig).where(eq(pluginConfig.pluginId, plugin.id));
        teamId = (cfg?.configJson as Record<string, unknown>)?.teamId as string ?? "";
      }

      if (!teamId) {
        res.status(400).json({ error: "No team ID configured" });
        return;
      }

      // ── Sync projects from Linear ──
      const projectMap = new Map<string, string>(); // Linear project ID → Paperclip project ID
      const linearProjectsRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query { projects { nodes { id name description status { name } startDate targetDate } } }`,
        }),
      });
      if (linearProjectsRes.ok) {
        const projData = (await linearProjectsRes.json()) as {
          data?: { projects?: { nodes?: Array<{
            id: string; name: string; description: string | null;
            status: { name: string }; startDate: string | null; targetDate: string | null;
          }> } };
        };
        const linearStatusMap: Record<string, string> = {
          "Planned": "backlog", "Backlog": "backlog",
          "In Progress": "active", "Started": "active",
          "Completed": "completed", "Done": "completed",
          "Canceled": "cancelled", "Cancelled": "cancelled",
          "Paused": "paused",
        };
        for (const lp of projData.data?.projects?.nodes ?? []) {
          const [existing] = await db
            .select()
            .from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.name, lp.name)))
            .limit(1);
          const status = linearStatusMap[lp.status.name] ?? "backlog";
          if (existing) {
            projectMap.set(lp.id, existing.id);
            await db.update(projects)
              .set({ description: lp.description, status, targetDate: lp.targetDate, updatedAt: new Date() })
              .where(eq(projects.id, existing.id));
          } else {
            const [created] = await db.insert(projects).values({
              companyId,
              name: lp.name,
              description: lp.description,
              status,
              targetDate: lp.targetDate,
            }).returning();
            projectMap.set(lp.id, created.id);
            console.log(`[linear-import] created project: ${lp.name}`);
          }
        }
        console.log(`[linear-import] synced ${projectMap.size} projects from Linear`);
      }

      // ── Label cache ──
      const labelCache = new Map<string, string>(); // label name → Paperclip label ID
      const existingLabels = await db
        .select()
        .from(labels)
        .where(eq(labels.companyId, companyId));
      for (const l of existingLabels) {
        labelCache.set(l.name, l.id);
      }
      const defaultColors = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6"];
      let colorIdx = 0;

      // Fetch all open issues from Linear with pagination
      let imported = 0;
      let cursor: string | undefined;
      let hasMore = true;
      let highestImportedNumber = 0;

      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };
      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", cancelled: "cancelled",
      };

      while (hasMore) {
        const issuesRes = await fetch("https://api.linear.app/graphql", {
          method: "POST",
          headers: { Authorization: token, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query($teamId: ID!, $after: String) {
              issues(
                filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "cancelled"] } } }
                first: 50
                after: $after
                orderBy: updatedAt
              ) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id number identifier title description url priority estimate
                  createdAt updatedAt
                  state { name type }
                  assignee { name email }
                  labels { nodes { name color } }
                  project { id name }
                  cycle { id name number startsAt endsAt description }
                }
              }
            }`,
            variables: { teamId, after: cursor ?? null },
          }),
        });

        if (!issuesRes.ok) {
          const text = await issuesRes.text();
          console.error("[linear-import] fetch failed:", issuesRes.status, text);
          break;
        }

        const issuesData = (await issuesRes.json()) as {
          data?: {
            issues?: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{
                id: string; number: number; identifier: string;
                title: string; description: string | null; url: string;
                priority: number; estimate: number | null;
                createdAt: string; updatedAt: string;
                state: { name: string; type: string };
                assignee: { name: string; email: string } | null;
                labels: { nodes: Array<{ name: string; color: string }> };
                project: { id: string; name: string } | null;
                cycle: { id: string; name: string; number: number; startsAt: string; endsAt: string; description: string | null } | null;
              }>;
            };
          };
          errors?: Array<{ message: string }>;
        };

        if (issuesData.errors?.length) {
          console.error("[linear-import] GraphQL errors:", issuesData.errors);
          break;
        }

        const nodes = issuesData.data?.issues?.nodes ?? [];

        for (const li of nodes) {
          // Check if already imported (by identifier)
          const [existingIssue] = await db
            .select({ id: issues.id })
            .from(issues)
            .where(eq(issues.identifier, li.identifier))
            .limit(1);
          if (existingIssue) continue;

          const priority = priorityMap[li.priority] ?? "medium";
          const status = statusMap[li.state.type] ?? "backlog";
          const labelNames = li.labels.nodes.map((l) => l.name);

          // Build description with Linear metadata
          const metaLines = [
            `> **Linear**: [${li.identifier}](${li.url})`,
            `> **Status**: ${li.state.name}`,
            ...(li.assignee ? [`> **Assignee**: ${li.assignee.name}`] : []),
            ...(labelNames.length > 0 ? [`> **Labels**: ${labelNames.join(", ")}`] : []),
          ];
          const description = [metaLines.join("\n"), "", li.description ?? ""].join("\n").trim() || null;

          // Map project if available
          const projectId = li.project?.id ? projectMap.get(li.project.id) : undefined;

          try {
            // Insert directly with exact issue number from Linear
            await db.insert(issues).values({
              companyId,
              issueNumber: li.number,
              identifier: li.identifier,
              title: li.title,
              description,
              status,
              priority,
              estimate: li.estimate ?? null,
              originKind: "linear",
              originId: li.id,
              ...(projectId ? { projectId } : {}),
              ...(status === "in_progress" ? { startedAt: new Date() } : {}),
            });

            // Track highest number for counter update
            if (li.number > highestImportedNumber) {
              highestImportedNumber = li.number;
            }

            // Get the created issue ID
            const [created] = await db
              .select({ id: issues.id })
              .from(issues)
              .where(eq(issues.identifier, li.identifier))
              .limit(1);

            // Sync labels: create missing labels and link to issue
            if (created && li.labels.nodes.length > 0) {
              for (const ll of li.labels.nodes) {
                let labelId = labelCache.get(ll.name);
                if (!labelId) {
                  const color = ll.color || defaultColors[colorIdx % defaultColors.length];
                  colorIdx++;
                  const [createdLabel] = await db.insert(labels).values({
                    companyId,
                    name: ll.name,
                    color,
                  }).onConflictDoNothing().returning();
                  if (createdLabel) {
                    labelId = createdLabel.id;
                    labelCache.set(ll.name, createdLabel.id);
                  } else {
                    // Already exists (race condition), fetch it
                    const [existing] = await db.select().from(labels)
                      .where(and(eq(labels.companyId, companyId), eq(labels.name, ll.name)))
                      .limit(1);
                    if (existing) {
                      labelId = existing.id;
                      labelCache.set(ll.name, existing.id);
                    }
                  }
                }
                if (labelId) {
                  await db.insert(issueLabels).values({
                    issueId: created.id,
                    labelId,
                    companyId,
                  }).onConflictDoNothing();
                }
              }
            }

            // Sync cycle: find or create, then link to issue
            if (created && li.cycle) {
              const [existingCycle] = await db.select().from(cycles)
                .where(and(eq(cycles.companyId, companyId), eq(cycles.originId, li.cycle.id)))
                .limit(1);
              let cycleId: string;
              if (existingCycle) {
                cycleId = existingCycle.id;
              } else {
                const [createdCycle] = await db.insert(cycles).values({
                  companyId,
                  name: li.cycle.name,
                  description: li.cycle.description,
                  number: li.cycle.number,
                  startsAt: li.cycle.startsAt,
                  endsAt: li.cycle.endsAt,
                  originId: li.cycle.id,
                }).onConflictDoNothing().returning();
                if (createdCycle) {
                  cycleId = createdCycle.id;
                } else {
                  const [fallback] = await db.select().from(cycles)
                    .where(and(eq(cycles.companyId, companyId), eq(cycles.originId, li.cycle.id)))
                    .limit(1);
                  cycleId = fallback?.id ?? "";
                }
              }
              if (cycleId) {
                await db.insert(issueCycles).values({
                  issueId: created.id,
                  cycleId,
                  companyId,
                }).onConflictDoNothing();
              }
            }

            // Store link in plugin state if plugin exists
            if (plugin && created) {
              const linkData = {
                paperclipIssueId: created.id,
                paperclipCompanyId: companyId,
                linearIssueId: li.id,
                linearIdentifier: li.identifier,
                linearUrl: li.url,
                syncDirection: "bidirectional",
                lastSyncAt: new Date().toISOString(),
                lastLinearStateType: li.state.type,
                lastCommentSyncAt: null,
              };

              await db.insert(pluginState).values({
                pluginId: plugin.id,
                scopeKind: "instance",
                scopeId: null,
                namespace: "default",
                stateKey: `link:${created.id}`,
                valueJson: JSON.stringify(linkData),
              }).onConflictDoNothing();

              await db.insert(pluginState).values({
                pluginId: plugin.id,
                scopeKind: "instance",
                scopeId: null,
                namespace: "default",
                stateKey: `linear:${li.id}`,
                valueJson: JSON.stringify(created.id),
              }).onConflictDoNothing();
            }

            imported++;
          } catch (err) {
            console.warn(`[linear-import] failed to import ${li.identifier}:`, err);
          }
        }

        hasMore = issuesData.data?.issues?.pageInfo.hasNextPage ?? false;
        cursor = issuesData.data?.issues?.pageInfo.endCursor ?? undefined;
      }

      // Update company counter to highest imported number (unless user chose "start fresh")
      // Re-read company to pick up any configure call that ran before import
      const [freshCompany] = await db.select().from(companies).where(eq(companies.id, companyId));
      if (freshCompany && freshCompany.issueCounter !== 0 && highestImportedNumber > freshCompany.issueCounter) {
        await db.update(companies)
          .set({ issueCounter: highestImportedNumber, updatedAt: new Date() })
          .where(eq(companies.id, companyId));
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "linear.import_completed",
        entityType: "company",
        entityId: companyId,
        details: { imported, highestNumber: highestImportedNumber, projects: projectMap.size, labels: labelCache.size },
      });

      console.log(`[linear-import] imported ${imported} issues, ${projectMap.size} projects, ${labelCache.size} labels, highest number: ${highestImportedNumber}`);
      res.json({ ok: true, imported, highestNumber: highestImportedNumber, projects: projectMap.size, labels: labelCache.size });
    } catch (err) {
      console.error("[linear-import] error:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Import failed" });
    }
  });

  // POST /api/auth/linear/sync — re-sync all linked issues from Linear
  // Syncs: status, priority, title, description, labels, project
  router.post("/sync", async (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    try {
      const { issues: issuesTable } = await import("@paperclipai/db");

      const secret = await svc.getByName(companyId, LINEAR_SECRET_NAME);
      if (!secret) {
        res.status(400).json({ error: "Linear not connected" });
        return;
      }
      const token = await svc.resolveSecretValue(companyId, secret.id, "latest");

      // Get all Paperclip issues with Linear identifiers
      const paperclipIssues = await db
        .select()
        .from(issuesTable)
        .where(eq(issuesTable.companyId, companyId));

      const linearIssues = paperclipIssues.filter(
        (i) => i.identifier && /^[A-Z]+-\d+$/.test(i.identifier),
      );

      if (linearIssues.length === 0) {
        res.json({ ok: true, synced: 0, message: "No linked issues found" });
        return;
      }

      // Import all Linear projects into Paperclip (not just ones with issues)
      const linearProjectsRes = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `query { projects { nodes { id name description status { name } startDate targetDate } } }`,
        }),
      });
      const projectMap = new Map<string, string>(); // Linear project ID → Paperclip project ID
      if (linearProjectsRes.ok) {
        const projData = (await linearProjectsRes.json()) as {
          data?: { projects?: { nodes?: Array<{
            id: string; name: string; description: string | null;
            status: { name: string }; startDate: string | null; targetDate: string | null;
          }> } };
        };
        const linearStatusMap: Record<string, string> = {
          "Planned": "backlog", "Backlog": "backlog",
          "In Progress": "active", "Started": "active",
          "Completed": "completed", "Done": "completed",
          "Canceled": "cancelled", "Cancelled": "cancelled",
          "Paused": "paused",
        };
        for (const lp of projData.data?.projects?.nodes ?? []) {
          const [existing] = await db
            .select()
            .from(projects)
            .where(and(eq(projects.companyId, companyId), eq(projects.name, lp.name)))
            .limit(1);
          const status = linearStatusMap[lp.status.name] ?? "backlog";
          if (existing) {
            projectMap.set(lp.id, existing.id);
            // Update status/description
            await db.update(projects)
              .set({ description: lp.description, status, targetDate: lp.targetDate, updatedAt: new Date() })
              .where(eq(projects.id, existing.id));
          } else {
            const [created] = await db.insert(projects).values({
              companyId,
              name: lp.name,
              description: lp.description,
              status,
              targetDate: lp.targetDate,
            }).returning();
            projectMap.set(lp.id, created.id);
            console.log(`[linear-sync] created project: ${lp.name}`);
          }
        }
        console.log(`[linear-sync] synced ${projectMap.size} projects from Linear`);
      }

      // Pre-fetch/create label cache
      const labelCache = new Map<string, string>(); // label name → Paperclip label ID
      const existingLabels = await db
        .select()
        .from(labels)
        .where(eq(labels.companyId, companyId));
      for (const l of existingLabels) {
        labelCache.set(l.name, l.id);
      }

      const statusMap: Record<string, string> = {
        backlog: "backlog", unstarted: "todo", started: "in_progress",
        completed: "done", cancelled: "cancelled",
      };
      const priorityMap: Record<number, string> = {
        0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
      };

      // Linear label colors to Paperclip hex colors
      const defaultColors = ["#6366f1", "#ec4899", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ef4444", "#14b8a6"];
      let colorIdx = 0;

      let synced = 0;
      let errors = 0;

      for (const pIssue of linearIssues) {
        if (!pIssue.identifier) continue;
        const [teamKey, numStr] = pIssue.identifier.split("-");
        if (!teamKey || !numStr) continue;
        const num = parseInt(numStr, 10);

        try {
          const fetchRes = await fetch("https://api.linear.app/graphql", {
            method: "POST",
            headers: { Authorization: token, "Content-Type": "application/json" },
            body: JSON.stringify({
              query: `query($teamKey: String!, $number: Float!) {
                issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
                  nodes {
                    id identifier title description url priority estimate number
                    state { name type }
                    assignee { name email }
                    labels { nodes { name color } }
                    project { id name }
                    cycle { id name number startsAt endsAt description }
                  }
                }
              }`,
              variables: { teamKey, number: num },
            }),
          });

          if (!fetchRes.ok) continue;

          const data = (await fetchRes.json()) as {
            data?: {
              issues?: {
                nodes?: Array<{
                  id: string; identifier: string; title: string;
                  description: string | null; url: string; priority: number; estimate: number | null; number: number;
                  state: { name: string; type: string };
                  assignee: { name: string; email: string } | null;
                  labels: { nodes: Array<{ name: string; color: string }> };
                  project: { id: string; name: string } | null;
                  cycle: { id: string; name: string; number: number; startsAt: string; endsAt: string; description: string | null } | null;
                }>;
              };
            };
          };

          const li = data.data?.issues?.nodes?.[0];
          if (!li) continue;

          const newStatus = statusMap[li.state.type] ?? "backlog";
          const newPriority = priorityMap[li.priority] ?? "medium";

          // Update issue fields
          const patch: Record<string, unknown> = {
            title: li.title,
            status: newStatus,
            priority: newPriority,
            estimate: li.estimate ?? null,
            description: li.description,
            updatedAt: new Date(),
          };

          if (newStatus === "in_progress" && !pIssue.startedAt) {
            patch.startedAt = new Date();
          }
          if (newStatus === "done" && !pIssue.completedAt) {
            patch.completedAt = new Date();
          }

          // Map project
          if (li.project?.id && projectMap.has(li.project.id)) {
            patch.projectId = projectMap.get(li.project.id);
          }

          await db.update(issuesTable)
            .set(patch)
            .where(eq(issuesTable.id, pIssue.id));

          // Sync labels: create missing labels, link to issue
          if (li.labels.nodes.length > 0) {
            // Remove existing label links for this issue
            await db.delete(issueLabels)
              .where(eq(issueLabels.issueId, pIssue.id));

            for (const ll of li.labels.nodes) {
              // Find or create the label
              let labelId = labelCache.get(ll.name);
              if (!labelId) {
                const color = ll.color || defaultColors[colorIdx % defaultColors.length];
                colorIdx++;
                const [created] = await db.insert(labels).values({
                  companyId,
                  name: ll.name,
                  color,
                }).onConflictDoNothing().returning();
                if (created) {
                  labelId = created.id;
                  labelCache.set(ll.name, created.id);
                } else {
                  // Already exists (race condition), fetch it
                  const [existing] = await db.select().from(labels)
                    .where(and(eq(labels.companyId, companyId), eq(labels.name, ll.name)))
                    .limit(1);
                  if (existing) {
                    labelId = existing.id;
                    labelCache.set(ll.name, existing.id);
                  }
                }
              }

              // Link label to issue
              if (labelId) {
                await db.insert(issueLabels).values({
                  issueId: pIssue.id,
                  labelId,
                  companyId,
                }).onConflictDoNothing();
              }
            }
          }

          // Sync cycle
          if (li.cycle) {
            // Remove existing cycle links for this issue
            await db.delete(issueCycles).where(eq(issueCycles.issueId, pIssue.id));

            const [existingCycle] = await db.select().from(cycles)
              .where(and(eq(cycles.companyId, companyId), eq(cycles.originId, li.cycle.id)))
              .limit(1);
            let cycleId: string;
            if (existingCycle) {
              cycleId = existingCycle.id;
              // Update cycle details
              await db.update(cycles).set({
                name: li.cycle.name,
                number: li.cycle.number,
                startsAt: li.cycle.startsAt,
                endsAt: li.cycle.endsAt,
                description: li.cycle.description,
                updatedAt: new Date(),
              }).where(eq(cycles.id, existingCycle.id));
            } else {
              const [createdCycle] = await db.insert(cycles).values({
                companyId,
                name: li.cycle.name,
                description: li.cycle.description,
                number: li.cycle.number,
                startsAt: li.cycle.startsAt,
                endsAt: li.cycle.endsAt,
                originId: li.cycle.id,
              }).onConflictDoNothing().returning();
              if (createdCycle) {
                cycleId = createdCycle.id;
              } else {
                const [fallback] = await db.select().from(cycles)
                  .where(and(eq(cycles.companyId, companyId), eq(cycles.originId, li.cycle.id)))
                  .limit(1);
                cycleId = fallback?.id ?? "";
              }
            }
            if (cycleId) {
              await db.insert(issueCycles).values({
                issueId: pIssue.id,
                cycleId,
                companyId,
              }).onConflictDoNothing();
            }
          }

          synced++;
        } catch (err) {
          console.warn(`[linear-sync] failed to sync ${pIssue.identifier}:`, err);
          errors++;
        }
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "linear.full_sync",
        entityType: "company",
        entityId: companyId,
        details: { synced, errors, total: linearIssues.length, projects: projectMap.size, labels: labelCache.size },
      });

      console.log(`[linear-sync] full sync: ${synced} issues, ${projectMap.size} projects, ${labelCache.size} labels`);
      res.json({ ok: true, synced, errors, total: linearIssues.length, projects: projectMap.size, labels: labelCache.size });
    } catch (err) {
      console.error("[linear-sync] error:", err);
      res.status(500).json({ error: err instanceof Error ? err.message : "Sync failed" });
    }
  });

  // POST /api/auth/linear/configure — update prefix and counter
  router.post("/configure", async (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const { prefix, startAt } = req.body as { prefix?: string; startAt?: number };
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (prefix && typeof prefix === "string") {
      const cleanPrefix = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (cleanPrefix.length > 0) {
        updates.issuePrefix = cleanPrefix;
      }
    }

    if (typeof startAt === "number" && startAt >= 0) {
      updates.issueCounter = startAt;
    }

    await db.update(companies).set(updates).where(eq(companies.id, companyId));
    const [updated] = await db.select().from(companies).where(eq(companies.id, companyId));
    res.json({
      issuePrefix: updated.issuePrefix,
      issueCounter: updated.issueCounter,
    });
  });

  // POST /api/auth/linear/disconnect?companyId=xxx
  router.post("/disconnect", async (req, res) => {
    assertBoard(req);
    const companyId = req.query.companyId as string;
    if (!companyId) {
      res.status(400).json({ error: "companyId required" });
      return;
    }
    assertCompanyAccess(req, companyId);

    const existing = await svc.getByName(companyId, LINEAR_SECRET_NAME);
    if (existing) {
      // Try to revoke the token with Linear
      try {
        const tokenValue = await svc.resolveSecretValue(companyId, existing.id, "latest");
        if (tokenValue) {
          await fetch(LINEAR_REVOKE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ access_token: tokenValue }),
          });
        }
      } catch {
        // Best-effort revocation
      }

      await svc.remove(existing.id);

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "linear.disconnected",
        entityType: "secret",
        entityId: LINEAR_SECRET_NAME,
      });
    }

    res.json({ disconnected: true });
  });

  // POST /api/auth/linear/webhook — inbound webhook from Linear
  // No auth required — Linear sends these directly
  router.post("/webhook", async (req, res) => {
    const payload = req.body as Record<string, unknown>;
    if (!payload) {
      res.status(200).json({ ok: true }); // Always return 200 to Linear
      return;
    }

    const action = payload.action as string | undefined;
    const type = payload.type as string | undefined;
    const data = payload.data as Record<string, unknown> | undefined;

    if (!data || !type || !action) {
      res.status(200).json({ ok: true });
      return;
    }

    try {
      const { issues: issuesTable, pluginState: pluginStateTable } = await import("@paperclipai/db");

      // Find the plugin to look up links
      const [plugin] = await db
        .select()
        .from(plugins)
        .where(eq(plugins.pluginKey, "paperclip-plugin-linear"))
        .limit(1);

      if (!plugin) {
        res.status(200).json({ ok: true });
        return;
      }

      const linearIssueId = data.id as string | undefined;
      if (!linearIssueId) {
        res.status(200).json({ ok: true });
        return;
      }

      // Look up the Paperclip issue via plugin state link
      const [linkEntry] = await db
        .select()
        .from(pluginStateTable)
        .where(eq(pluginStateTable.stateKey, `linear:${linearIssueId}`))
        .limit(1);

      if (!linkEntry) {
        res.status(200).json({ ok: true }); // Not a linked issue
        return;
      }

      const paperclipIssueId = JSON.parse(String(linkEntry.valueJson));

      // Handle issue updates
      if (type === "Issue" && action === "update") {
        const statusMap: Record<string, string> = {
          backlog: "backlog", unstarted: "todo", started: "in_progress",
          completed: "done", cancelled: "cancelled",
        };
        const priorityMap: Record<number, string> = {
          0: "low", 1: "critical", 2: "high", 3: "medium", 4: "low",
        };

        const patch: Record<string, unknown> = {};

        // Status
        const state = data.state as Record<string, unknown> | undefined;
        if (state?.type) {
          const newStatus = statusMap[state.type as string];
          if (newStatus) patch.status = newStatus;
        }

        // Priority
        if (data.priority !== undefined) {
          const newPriority = priorityMap[data.priority as number];
          if (newPriority) patch.priority = newPriority;
        }

        // Title
        if (data.title) {
          patch.title = data.title;
        }

        // Estimate
        if (data.estimate !== undefined) {
          patch.estimate = (data.estimate as number) ?? null;
        }

        if (Object.keys(patch).length > 0) {
          await db.update(issuesTable)
            .set({ ...patch, updatedAt: new Date() })
            .where(eq(issuesTable.id, paperclipIssueId));

          console.log(`[linear-webhook] updated ${paperclipIssueId}: ${Object.keys(patch).join(", ")}`);
        }
      }

      // Handle comments
      if (type === "Comment" && action === "create") {
        const commentBody = data.body as string;
        const userName = (data.user as Record<string, unknown>)?.name as string;

        if (commentBody && !commentBody.includes("[synced from Paperclip]")) {
          const { issueComments } = await import("@paperclipai/db");
          // Look up the issue to get companyId
          const [issue] = await db
            .select({ companyId: issuesTable.companyId })
            .from(issuesTable)
            .where(eq(issuesTable.id, paperclipIssueId))
            .limit(1);

          if (issue) {
            await db.insert(issueComments).values({
              issueId: paperclipIssueId,
              companyId: issue.companyId,
              body: `**${userName || "Linear user"}** (from Linear):\n\n${commentBody}`,
            });
            console.log(`[linear-webhook] comment bridged to ${paperclipIssueId}`);
          }
        }
      }
      // Handle project updates (Linear → Paperclip)
      if (type === "Project" && (action === "update" || action === "create")) {
        const projectName = data.name as string;
        const projectDesc = data.description as string | null;
        const projectState = (data.state as Record<string, unknown>)?.name as string | undefined;

        if (projectName) {
          const linearStatusMap: Record<string, string> = {
            "Planned": "backlog", "Backlog": "backlog",
            "In Progress": "active", "Started": "active",
            "Completed": "completed", "Done": "completed",
            "Canceled": "cancelled", "Cancelled": "cancelled",
            "Paused": "paused",
          };
          const status = projectState ? (linearStatusMap[projectState] ?? "backlog") : undefined;

          // Find all companies (local trusted mode = one company)
          const allCompanies = await db.select({ id: companies.id }).from(companies);
          for (const c of allCompanies) {
            const [existing] = await db.select().from(projects)
              .where(and(eq(projects.companyId, c.id), eq(projects.name, projectName)))
              .limit(1);

            if (existing) {
              const patch: Record<string, unknown> = { updatedAt: new Date() };
              if (projectDesc !== undefined) patch.description = projectDesc;
              if (status) patch.status = status;
              await db.update(projects).set(patch).where(eq(projects.id, existing.id));
              console.log(`[linear-webhook] updated project: ${projectName}`);
            } else if (action === "create") {
              await db.insert(projects).values({
                companyId: c.id,
                name: projectName,
                description: projectDesc,
                status: status ?? "backlog",
              });
              console.log(`[linear-webhook] created project: ${projectName}`);
            }
          }
        }
      }

      // Handle label changes (Linear → Paperclip)
      if (type === "IssueLabel" && (action === "create" || action === "update")) {
        const labelName = data.name as string;
        const labelColor = data.color as string ?? "#6366f1";
        if (labelName) {
          const allCompanies = await db.select({ id: companies.id }).from(companies);
          for (const c of allCompanies) {
            const [existing] = await db.select().from(labels)
              .where(and(eq(labels.companyId, c.id), eq(labels.name, labelName)))
              .limit(1);
            if (existing) {
              await db.update(labels).set({ color: labelColor, updatedAt: new Date() }).where(eq(labels.id, existing.id));
            } else {
              await db.insert(labels).values({ companyId: c.id, name: labelName, color: labelColor }).onConflictDoNothing();
              console.log(`[linear-webhook] created label: ${labelName}`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[linear-webhook] error:", err);
    }

    res.status(200).json({ ok: true });
  });

  return router;
}

function callbackPage(status: "success" | "error", message: string): string {
  const color = status === "success" ? "#22c55e" : "#ef4444";
  const icon = status === "success" ? "&#10003;" : "&#10007;";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Linear — ${status}</title>
<style>
  body { background: #0a0a0a; color: #a1a1aa; font-family: ui-monospace, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { text-align: center; padding: 2rem; }
  .icon { font-size: 48px; color: ${color}; margin-bottom: 1rem; }
  h1 { font-size: 14px; font-weight: 500; margin: 0 0 0.5rem; }
  p { font-size: 12px; color: #52525b; margin: 0; }
</style></head>
<body><div class="card">
  <div class="icon">${icon}</div>
  <h1>${message}</h1>
  <p>${status === "success" ? "Return to Paperclip to continue." : "Please try again."}</p>
</div>
<script>if("${status}"==="success")setTimeout(()=>window.close(),2000)</script>
</body></html>`;
}
