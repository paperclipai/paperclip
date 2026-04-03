/**
 * FleetOS proxy routes (RAA-292).
 *
 * Proxies FleetOS API calls through the dashboard server so that:
 * 1. The FleetOS API key stays server-side (never exposed to the browser).
 * 2. Responses can be transformed to shapes the UI expects.
 * 3. FleetOS remains internal infrastructure.
 *
 * Tenant isolation (RAA-288) is automatic — FleetOS scopes results by API key.
 */

import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard } from "./authz.js";
import {
  createFleetOSClient,
  FleetOSProxyError,
  type FleetContainer,
  type FleetHealth,
  type ProvisionValidateRequest,
  type ProvisionRequest,
} from "../services/fleetos-client.js";
import { logActivity } from "../services/activity-log.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Helpers
/**
 * Create a FleetOS API client from the authenticated request.
 *
 * @param req - Express request whose `actor` is expected to contain `fleetosApiKey`
 * @returns A FleetOS API client instance configured with the actor's API key
 * @throws FleetOSProxyError if no FleetOS API key is present on the request actor
 */

function getClientFromRequest(req: Request, baseUrl?: string) {
  const apiKey = req.actor.fleetosApiKey;
  if (!apiKey) {
    throw new FleetOSProxyError("No FleetOS API key in session", 401, null);
  }
  return createFleetOSClient(apiKey, baseUrl);
}

/**
 * Convert an uptime duration in seconds into a concise human-readable string.
 *
 * @param seconds - Total uptime in seconds.
 * @returns A formatted uptime string:
 * - "Xs" for durations less than 60 seconds (rounded),
 * - "Ym" for durations less than 1 hour (whole minutes),
 * - "Xh Ym" for durations less than 1 day (hours and whole minutes),
 * - "Xd Xh" for durations of 1 day or more (days and whole hours).
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/**
 * Produce a UI-friendly container object that includes normalized health information.
 *
 * When `health` is `null`, the returned object's `health` property is `null`.
 * When `health` is provided, the returned `health` object contains a restricted set of fields:
 * `cpu_percent`, `mem_percent`, `disk_percent`, `agent_status`, `uptime_seconds`, `uptime_display`, and `last_heartbeat`.
 *
 * @param container - The original container object to merge into the response
 * @param health - The container's health data or `null`
 * @returns The merged container object with a `health` property formatted for the UI
 */
function mergeContainerAndHealth(container: FleetContainer, health: FleetHealth | null) {
  return {
    ...container,
    health: health
      ? {
          cpu_percent: health.cpu_percent,
          mem_percent: health.mem_percent,
          disk_percent: health.disk_percent,
          agent_status: health.agent_status,
          uptime_seconds: health.uptime_seconds,
          uptime_display: formatUptime(health.uptime_seconds),
          last_heartbeat: health.last_heartbeat,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Route factory
/**
 * Create an Express Router that proxies FleetOS API endpoints through the dashboard server.
 *
 * The router enforces board-level authorization, reads the FleetOS API key from the authenticated
 * session (so keys are never exposed to the browser), normalizes FleetOS responses for UI use,
 * and maps FleetOS errors to consistent HTTP JSON responses.
 *
 * @param db - Database handle used for writing audit log entries for container lifecycle actions
 * @returns An Express Router mounting FleetOS proxy endpoints (containers listing and detail, health,
 * agent status, and start/stop/restart lifecycle actions)
 */

export function fleetosProxyRoutes(db: Db, fleetosApiUrl?: string) {
  const router = Router();

  // --- List all containers ---
  router.get("/fleetos/containers", async (req, res) => {
    assertBoard(req);
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const containers = await client.listContainers();

      // Best-effort health fetch for each container (don't fail if one errors)
      const withHealth = await Promise.all(
        containers.map(async (c) => {
          let health: FleetHealth | null = null;
          if (c.status === "running") {
            try {
              health = await client.getHealth(c.id);
            } catch {
              // health unavailable — continue without it
            }
          }
          return mergeContainerAndHealth(c, health);
        }),
      );

      res.json({ containers: withHealth });
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Single container detail (merged with health) ---
  router.get("/fleetos/containers/:containerId", async (req, res) => {
    assertBoard(req);
    const { containerId } = req.params;
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const container = await client.getContainer(containerId!);
      let health: FleetHealth | null = null;
      if (container.status === "running") {
        try {
          health = await client.getHealth(containerId!);
        } catch {
          // continue without health
        }
      }
      res.json(mergeContainerAndHealth(container, health));
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Health endpoint (for polling) ---
  router.get("/fleetos/containers/:containerId/health", async (req, res) => {
    assertBoard(req);
    const { containerId } = req.params;
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const health = await client.getHealth(containerId!);
      res.json(health);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Agent process status ---
  router.get("/fleetos/containers/:containerId/agent", async (req, res) => {
    assertBoard(req);
    const { containerId } = req.params;
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const agentProcess = await client.getAgentProcess(containerId!);
      res.json(agentProcess);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Lifecycle actions: start, stop, restart ---
  router.post("/fleetos/containers/:containerId/:action", async (req, res) => {
    assertBoard(req);

    // Explicit FleetOS actor check — board auth alone isn't sufficient for mutations
    if (!req.actor.fleetosApiKey) {
      res.status(403).json({ error: "FleetOS actor required for lifecycle actions" });
      return;
    }

    const { containerId, action } = req.params;

    if (!["start", "stop", "restart"].includes(action!)) {
      res.status(400).json({ error: `Invalid action: ${action}` });
      return;
    }

    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      let container: FleetContainer;
      switch (action) {
        case "start":
          container = await client.startContainer(containerId!);
          break;
        case "stop":
          container = await client.stopContainer(containerId!);
          break;
        case "restart":
          container = await client.restartContainer(containerId!);
          break;
        default:
          res.status(400).json({ error: `Invalid action: ${action}` });
          return;
      }

      // Audit log for lifecycle actions
      const companyId = req.actor.companyId;
      if (companyId) {
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "unknown",
          action: `fleetos.container.${action}`,
          entityType: "fleetos_container",
          entityId: containerId!,
          details: { action, containerName: container.name },
        }).catch((err) => {
          logger.warn({ err, containerId, action }, "Failed to log FleetOS lifecycle audit entry");
        });
      } else {
        logger.warn(
          { action: `fleetos.container.${action}`, containerId, actorType: req.actor.type, userId: req.actor.userId },
          "Skipped FleetOS audit log: actor has no companyId",
        );
      }

      res.json(container);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Templates ---
  router.get("/fleetos/templates", async (req, res) => {
    assertBoard(req);
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const templates = await client.listTemplates();
      res.json({ templates });
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  router.get("/fleetos/templates/:name", async (req, res) => {
    assertBoard(req);
    const { name } = req.params;
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const template = await client.getTemplate(name!);
      res.json(template);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  // --- Provisioning ---
  router.post("/fleetos/provision/validate", async (req, res) => {
    assertBoard(req);
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const body = req.body as ProvisionValidateRequest;
      const result = await client.validateProvision(body);
      res.json(result);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  router.post("/fleetos/provision", async (req, res) => {
    assertBoard(req);

    // Explicit FleetOS actor check — board auth alone isn't sufficient for mutations
    if (!req.actor.fleetosApiKey) {
      res.status(403).json({ error: "FleetOS actor required for provisioning" });
      return;
    }

    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const body = req.body as ProvisionRequest;
      const job = await client.startProvision(body);

      // Audit log for provisioning
      const companyId = req.actor.companyId;
      if (companyId) {
        logActivity(db, {
          companyId,
          actorType: "user",
          actorId: req.actor.userId ?? "unknown",
          action: "fleetos.provision.start",
          entityType: "fleetos_provision_job",
          entityId: job.id,
          details: {
            template: body.template,
            tenant_id: body.tenant_id,
            agent_name: body.agent_name,
            agent_role: body.agent_role,
            container_name: job.container_name,
          },
        }).catch((err) => {
          logger.warn({ err, jobId: job.id }, "Failed to log FleetOS provision audit entry");
        });
      } else {
        logger.warn(
          { action: "fleetos.provision.start", jobId: job.id, actorType: req.actor.type, userId: req.actor.userId },
          "Skipped FleetOS audit log: actor has no companyId",
        );
      }

      res.json(job);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  router.get("/fleetos/provision/:jobId", async (req, res) => {
    assertBoard(req);
    const { jobId } = req.params;
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const job = await client.getProvisionJob(jobId!);
      res.json(job);
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  router.get("/fleetos/provision", async (req, res) => {
    assertBoard(req);
    try {
      const client = getClientFromRequest(req, fleetosApiUrl);
      const jobs = await client.listProvisionJobs();
      res.json({ jobs });
    } catch (err) {
      if (err instanceof FleetOSProxyError) {
        res.status(err.statusCode || 502).json({
          error: err.message,
          detail: err.detail,
        });
        return;
      }
      res.status(502).json({ error: "Failed to reach FleetOS" });
    }
  });

  return router;
}
