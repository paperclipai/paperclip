import { Router } from "express";
import { execFile } from "node:child_process";
import { promises as dns } from "node:dns";
import { promisify } from "node:util";
import { count, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { instanceUserRoles } from "@paperclipai/db";
import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { forbidden, badRequest, unauthorized } from "../errors.js";
import { accessService } from "../services/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logger } from "../middleware/logger.js";

const execFileAsync = promisify(execFile);

function isPublicVpsMode(deploymentMode: DeploymentMode, deploymentExposure: DeploymentExposure): boolean {
  return deploymentMode === "authenticated" && deploymentExposure === "public";
}

async function getAdminCount(db: Db): Promise<number> {
  return db
    .select({ count: count() })
    .from(instanceUserRoles)
    .where(sql`${instanceUserRoles.role} = 'instance_admin'`)
    .then((rows) => Number(rows[0]?.count ?? 0));
}

export function vpsSetupRoutes(
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    deploymentExposure: DeploymentExposure;
  },
) {
  const router = Router();
  const access = accessService(db);
  const settings = instanceSettingsService(db);

  // POST /vps/bootstrap-admin
  // Promotes the currently authenticated user to instance_admin.
  // Only works when no admin exists yet and deployment is public.
  // The frontend should call POST /api/auth/sign-up/email first to create the
  // BetterAuth user and establish a session, then call this endpoint.
  router.post("/vps/bootstrap-admin", async (req, res) => {
    if (!isPublicVpsMode(opts.deploymentMode, opts.deploymentExposure)) {
      throw forbidden("VPS bootstrap is only available in authenticated+public mode");
    }

    const adminCount = await getAdminCount(db);
    if (adminCount > 0) {
      throw forbidden("An admin account already exists");
    }

    if (req.actor.type !== "board" || !req.actor.userId) {
      throw unauthorized("You must be signed in to claim admin access");
    }

    const userId = req.actor.userId;
    await access.promoteInstanceAdmin(userId);
    logger.info({ userId }, "VPS bootstrap: promoted user to instance_admin");

    res.json({ ok: true, userId, role: "instance_admin" });
  });

  // GET /vps/network-info
  // Returns the server's public IP and port for domain setup instructions.
  router.get("/vps/network-info", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }

    let ip = "unknown";
    try {
      const { stdout } = await execFileAsync("curl", [
        "-4", "-sf", "--max-time", "5", "https://icanhazip.com",
      ]);
      ip = stdout.trim();
    } catch {
      try {
        const { stdout } = await execFileAsync("curl", [
          "-4", "-sf", "--max-time", "5", "https://ifconfig.me",
        ]);
        ip = stdout.trim();
      } catch {
        // Fall back to config-derived hostname
        const publicUrl = process.env.PAPERCLIP_PUBLIC_URL;
        if (publicUrl) {
          try {
            ip = new URL(publicUrl).hostname;
          } catch { /* ignore */ }
        }
      }
    }

    const port = Number(process.env.PORT) || 3100;
    res.json({ ip, port });
  });

  // POST /vps/verify-dns
  // Checks whether a domain's A record resolves to the VPS IP.
  router.post("/vps/verify-dns", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }

    const domain = (req.body?.domain as string)?.trim();
    if (!domain) throw badRequest("domain is required");

    // Basic domain format validation
    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) {
      throw badRequest("Invalid domain format");
    }

    // Get expected IP
    let expectedIp = "unknown";
    try {
      const { stdout } = await execFileAsync("curl", [
        "-4", "-sf", "--max-time", "5", "https://icanhazip.com",
      ]);
      expectedIp = stdout.trim();
    } catch { /* ignore */ }

    // Resolve domain
    let resolvedIps: string[] = [];
    try {
      resolvedIps = await dns.resolve4(domain);
    } catch { /* DNS not found */ }

    const matches = resolvedIps.includes(expectedIp);
    res.json({
      domain,
      resolved: resolvedIps.length > 0,
      resolvedIps,
      expectedIp,
      matches,
    });
  });

  // POST /vps/configure-domain
  // Writes a Caddyfile and starts/reloads Caddy for HTTPS.
  // Also updates the instance settings with the configured domain.
  router.post("/vps/configure-domain", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }

    const domain = (req.body?.domain as string)?.trim();
    if (!domain) throw badRequest("domain is required");

    if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/.test(domain)) {
      throw badRequest("Invalid domain format");
    }

    const port = Number(process.env.PORT) || 3100;

    // Write Caddyfile
    const caddyfileContent = `# Managed by Paperclip VPS setup
${domain} {
    reverse_proxy localhost:${port}
}
`;

    try {
      const { writeFile } = await import("node:fs/promises");
      await writeFile("/etc/caddy/Caddyfile", caddyfileContent, "utf-8");
      logger.info({ domain }, "Caddyfile written");
    } catch (err) {
      logger.error({ err, domain }, "Failed to write Caddyfile");
      throw badRequest(
        "Failed to write Caddyfile. Ensure the paperclip user has write access to /etc/caddy/Caddyfile.",
      );
    }

    // Enable and start/reload Caddy
    try {
      await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", "enable", "caddy"]);
      await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", "start", "caddy"]);
      // Give Caddy a moment to start and obtain the certificate
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", "reload", "caddy"]).catch(() => {
        // reload may fail if caddy just started, which is fine
      });
      logger.info({ domain }, "Caddy started/reloaded");
    } catch (err) {
      logger.warn({ err, domain }, "Failed to start Caddy via systemctl. You may need to start it manually: sudo systemctl enable --now caddy");
    }

    // Save domain to instance settings
    await settings.updateGeneral({
      domain,
      domainConfiguredAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      domain,
      url: `https://${domain}`,
    });
  });

  // POST /vps/skip-domain
  // Marks domain setup as complete without configuring a domain.
  router.post("/vps/skip-domain", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }

    // Mark as "skipped" so the setup phase moves to complete
    await settings.updateGeneral({
      domain: "skipped",
      domainConfiguredAt: new Date().toISOString(),
    });

    res.json({ ok: true });
  });

  return router;
}
