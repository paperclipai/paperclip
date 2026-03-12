import { Router } from "express";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  pluginActionResponseSchema,
  pluginConfigDescribeResponseSchema,
  pluginConfigUpdateBodySchema,
  pluginConfigUpdateResponseSchema,
  pluginInstallBodySchema,
  pluginListResponseSchema,
  pluginRestartResponseSchema,
  pluginToggleBodySchema,
} from "@paperclipai/shared";
import { assertBoard } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";

type CliJson = Record<string, unknown>;

function resolveRepoRoot(): string {
  return path.resolve(process.cwd());
}

function resolvePaperclipHomeDir(): string {
  const envHome = process.env.PAPERCLIP_HOME?.trim();
  if (envHome) {
    const expanded = envHome === "~" ? os.homedir() : envHome.startsWith("~/") ? path.join(os.homedir(), envHome.slice(2)) : envHome;
    return path.resolve(expanded);
  }
  return path.resolve(os.homedir(), ".paperclip");
}

function getAllowedPluginInstallBases(): string[] {
  const home = resolvePaperclipHomeDir();
  return [path.resolve(home, "plugins", "local")];
}

function assertAllowedPluginInstallPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const allowedBases = getAllowedPluginInstallBases();
  const allowed = allowedBases.some((base) => resolved === base || resolved.startsWith(`${base}${path.sep}`));
  if (!allowed) {
    throw badRequest(
      `Plugin install path is not allowed: ${resolved}. Allowed base(s): ${allowedBases.join(", ")}`,
    );
  }
  return resolved;
}

function maybeInstanceArgs(instanceId: string | null): string[] {
  if (!instanceId) return [];
  return ["--instance", instanceId];
}

function readInstanceQuery(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function runPluginCliJson(args: string[]): Promise<CliJson> {
  const repoRoot = resolveRepoRoot();
  const tsxCli = path.resolve(repoRoot, "cli/node_modules/tsx/dist/cli.mjs");
  const cliEntrypoint = path.resolve(repoRoot, "cli/src/index.ts");

  const hasLocalTsxCli = existsSync(tsxCli) && existsSync(cliEntrypoint);

  const command = hasLocalTsxCli ? process.execPath : "paperclipai";
  const commandArgs = hasLocalTsxCli
    ? [tsxCli, cliEntrypoint, "plugin", ...args, "--json"]
    : ["plugin", ...args, "--json"];

  const { stdout, stderr, code } = await new Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, code: exitCode });
    });
  });

  if (code !== 0) {
    const message = stderr.trim() || stdout.trim() || `plugin command failed (exit ${String(code)})`;
    throw badRequest(message);
  }

  try {
    return JSON.parse(stdout) as CliJson;
  } catch {
    throw badRequest("plugin command returned invalid JSON");
  }
}

export function pluginRoutes() {
  const router = Router();

  router.get("/instance/plugins", async (req, res) => {
    assertBoard(req);
    const instanceId = readInstanceQuery(req.query.instance);
    const payload = await runPluginCliJson(["list", ...maybeInstanceArgs(instanceId)]);
    const parsed = pluginListResponseSchema.parse(payload);
    res.json(parsed);
  });

  router.post("/instance/plugins/install", validate(pluginInstallBodySchema), async (req, res) => {
    assertBoard(req);
    const instanceId = readInstanceQuery(req.query.instance);
    const safePath = assertAllowedPluginInstallPath(req.body.path);
    const payload = await runPluginCliJson([
      "install",
      safePath,
      ...(req.body.skipBootstrap ? ["--skip-bootstrap"] : []),
      ...maybeInstanceArgs(instanceId),
    ]);
    const parsed = pluginActionResponseSchema.parse(payload);
    res.status(201).json(parsed);
  });

  router.patch("/instance/plugins/:pluginId/enabled", validate(pluginToggleBodySchema), async (req, res) => {
    assertBoard(req);
    const instanceId = readInstanceQuery(req.query.instance);
    const command = req.body.enabled ? "enable" : "disable";
    const payload = await runPluginCliJson([
      command,
      String(req.params.pluginId),
      ...maybeInstanceArgs(instanceId),
    ]);
    const parsed = pluginActionResponseSchema.parse(payload);
    res.json(parsed);
  });

  router.post("/instance/plugins/:pluginId/restart", async (req, res) => {
    assertBoard(req);
    const instanceId = readInstanceQuery(req.query.instance);

    const payload = await runPluginCliJson([
      "restart",
      String(req.params.pluginId),
      ...maybeInstanceArgs(instanceId),
    ]);

    const parsed = pluginRestartResponseSchema.parse(payload);
    res.json(parsed);
  });

  router.get("/instance/plugins/:pluginId/config", async (req, res) => {
    assertBoard(req);
    const instanceId = readInstanceQuery(req.query.instance);

    const payload = await runPluginCliJson([
      "config",
      "describe",
      String(req.params.pluginId),
      ...maybeInstanceArgs(instanceId),
    ]);

    const parsed = pluginConfigDescribeResponseSchema.parse(payload);
    res.json(parsed);
  });

  router.patch(
    "/instance/plugins/:pluginId/config",
    validate(pluginConfigUpdateBodySchema),
    async (req, res) => {
      assertBoard(req);
      const instanceId = readInstanceQuery(req.query.instance);

      const payload = await runPluginCliJson([
        "config",
        "set",
        String(req.params.pluginId),
        "--value-json",
        JSON.stringify(req.body.config),
        ...(req.body.restart ? ["--restart"] : []),
        ...maybeInstanceArgs(instanceId),
      ]);

      const parsed = pluginConfigUpdateResponseSchema.parse(payload);
      res.json(parsed);
    },
  );

  return router;
}
