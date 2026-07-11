import { and, count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companyGithubConnections,
  companySecretBindings,
  companySecrets,
  projects,
} from "@paperclipai/db";
import type {
  CompanyGithubConnection,
  GithubConnectionTestResult,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { secretService } from "./secrets.js";

const GITHUB_SECRET_CONFIG_PATH = "github.token";

type GithubConnectionRow = typeof companyGithubConnections.$inferSelect;

function normalizeHostname(value: string) {
  return value.trim().toLowerCase();
}

export function githubApiBase(hostname: string) {
  return hostname === "github.com" ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function buildGithubCredentialEnv(input: {
  token: string;
  hostname: string;
  baseEnv?: Record<string, string>;
}): Record<string, string> {
  const helperKey = `credential.https://${input.hostname}.helper`;
  return {
    ...(input.baseEnv ?? {}),
    GH_TOKEN: input.token,
    GITHUB_TOKEN: input.token,
    GH_HOST: input.hostname,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: helperKey,
    GIT_CONFIG_VALUE_0: '!f() { echo username=x-access-token; echo password="$GH_TOKEN"; }; f',
  };
}

export function githubConnectionService(db: Db) {
  const secrets = secretService(db);

  async function getRow(companyId: string, id: string): Promise<GithubConnectionRow | null> {
    return db
      .select()
      .from(companyGithubConnections)
      .where(and(eq(companyGithubConnections.companyId, companyId), eq(companyGithubConnections.id, id)))
      .then((rows) => rows[0] ?? null);
  }

  async function assertSecret(companyId: string, secretId: string) {
    const secret = await db
      .select({ id: companySecrets.id, status: companySecrets.status })
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, secretId)))
      .then((rows) => rows[0] ?? null);
    if (!secret) throw unprocessable("GitHub connection secret must belong to this company");
    if (secret.status !== "active") throw unprocessable("GitHub connection secret must be active");
  }

  async function toConnection(row: GithubConnectionRow): Promise<CompanyGithubConnection> {
    const [secret, usage] = await Promise.all([
      db
        .select({ name: companySecrets.name })
        .from(companySecrets)
        .where(eq(companySecrets.id, row.secretId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.githubConnectionId, row.id))
        .then((rows) => Number(rows[0]?.value ?? 0)),
    ]);
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      hostname: row.hostname,
      secretId: row.secretId,
      secretName: secret?.name ?? "Unavailable secret",
      enabled: row.enabled,
      accountLogin: row.accountLogin,
      lastTestedAt: row.lastTestedAt,
      lastTestStatus: row.lastTestStatus === "success" || row.lastTestStatus === "error" ? row.lastTestStatus : null,
      lastTestMessage: row.lastTestMessage,
      projectCount: usage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async function syncProjectBinding(companyId: string, projectId: string, connectionId: string | null) {
    await db
      .delete(companySecretBindings)
      .where(and(
        eq(companySecretBindings.companyId, companyId),
        eq(companySecretBindings.targetType, "project"),
        eq(companySecretBindings.targetId, projectId),
        eq(companySecretBindings.configPath, GITHUB_SECRET_CONFIG_PATH),
      ));
    if (!connectionId) return;
    const connection = await getRow(companyId, connectionId);
    if (!connection) throw unprocessable("GitHub connection must belong to this company");
    await db.insert(companySecretBindings).values({
      companyId,
      secretId: connection.secretId,
      targetType: "project",
      targetId: projectId,
      configPath: GITHUB_SECRET_CONFIG_PATH,
      versionSelector: "latest",
      required: true,
      label: connection.name,
    });
  }

  return {
    async list(companyId: string) {
      const rows = await db
        .select()
        .from(companyGithubConnections)
        .where(eq(companyGithubConnections.companyId, companyId))
        .orderBy(companyGithubConnections.name);
      return Promise.all(rows.map(toConnection));
    },

    getRow,

    async assertConnection(companyId: string, connectionId: string) {
      const row = await getRow(companyId, connectionId);
      if (!row) throw unprocessable("GitHub connection must belong to this company");
      if (!row.enabled) throw unprocessable("GitHub connection is disabled");
      return row;
    },

    async create(companyId: string, input: { name: string; hostname: string; secretId: string; enabled?: boolean }, actor?: { userId?: string | null; agentId?: string | null }) {
      await assertSecret(companyId, input.secretId);
      const existing = await db
        .select({ id: companyGithubConnections.id })
        .from(companyGithubConnections)
        .where(and(eq(companyGithubConnections.companyId, companyId), eq(companyGithubConnections.name, input.name)))
        .then((rows) => rows[0] ?? null);
      if (existing) throw conflict(`GitHub connection already exists: ${input.name}`);
      const row = await db.insert(companyGithubConnections).values({
        companyId,
        name: input.name,
        hostname: normalizeHostname(input.hostname),
        secretId: input.secretId,
        enabled: input.enabled ?? true,
        createdByAgentId: actor?.agentId ?? null,
        createdByUserId: actor?.userId ?? null,
      }).returning().then((rows) => rows[0]!);
      return toConnection(row);
    },

    async update(companyId: string, id: string, input: { name?: string; hostname?: string; secretId?: string; enabled?: boolean }) {
      const existing = await getRow(companyId, id);
      if (!existing) throw notFound("GitHub connection not found");
      if (input.secretId) await assertSecret(companyId, input.secretId);
      const row = await db.update(companyGithubConnections).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.hostname !== undefined ? { hostname: normalizeHostname(input.hostname) } : {}),
        ...(input.secretId !== undefined ? { secretId: input.secretId } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.secretId !== undefined || input.hostname !== undefined
          ? { accountLogin: null, lastTestedAt: null, lastTestStatus: null, lastTestMessage: null }
          : {}),
        updatedAt: new Date(),
      }).where(and(eq(companyGithubConnections.companyId, companyId), eq(companyGithubConnections.id, id)))
        .returning().then((rows) => rows[0]!);
      if (input.secretId !== undefined) {
        const boundProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.githubConnectionId, id));
        await Promise.all(boundProjects.map((project) => syncProjectBinding(companyId, project.id, id)));
      }
      return toConnection(row);
    },

    async remove(companyId: string, id: string) {
      const existing = await getRow(companyId, id);
      if (!existing) throw notFound("GitHub connection not found");
      const boundProjects = await db.select({ id: projects.id }).from(projects).where(eq(projects.githubConnectionId, id));
      await Promise.all(boundProjects.map((project) => syncProjectBinding(companyId, project.id, null)));
      await db.delete(companyGithubConnections).where(and(eq(companyGithubConnections.companyId, companyId), eq(companyGithubConnections.id, id)));
      return existing;
    },

    syncProjectBinding,

    async resolveForProject(input: {
      companyId: string;
      projectId: string;
      actorId?: string | null;
      issueId?: string | null;
      heartbeatRunId?: string | null;
    }): Promise<{ connectionId: string; hostname: string; token: string; env: Record<string, string> } | null> {
      const row = await db
        .select({
          id: companyGithubConnections.id,
          hostname: companyGithubConnections.hostname,
          secretId: companyGithubConnections.secretId,
          enabled: companyGithubConnections.enabled,
        })
        .from(projects)
        .innerJoin(companyGithubConnections, eq(projects.githubConnectionId, companyGithubConnections.id))
        .where(and(eq(projects.companyId, input.companyId), eq(projects.id, input.projectId)))
        .then((rows) => rows[0] ?? null);
      if (!row || !row.enabled) return null;
      const token = await secrets.resolveSecretValue(input.companyId, row.secretId, "latest", {
        consumerType: "project",
        consumerId: input.projectId,
        configPath: GITHUB_SECRET_CONFIG_PATH,
        actorType: input.actorId ? "agent" : "system",
        actorId: input.actorId ?? null,
        issueId: input.issueId ?? null,
        heartbeatRunId: input.heartbeatRunId ?? null,
      });
      return {
        connectionId: row.id,
        hostname: row.hostname,
        token,
        env: buildGithubCredentialEnv({ token, hostname: row.hostname }),
      };
    },

    async test(companyId: string, id: string): Promise<GithubConnectionTestResult> {
      const row = await getRow(companyId, id);
      if (!row) throw notFound("GitHub connection not found");
      if (!row.enabled) throw unprocessable("GitHub connection is disabled");
      const testedAt = new Date();
      let result: GithubConnectionTestResult;
      try {
        const token = await secrets.resolveSecretValue(companyId, row.secretId, "latest");
        const response = await fetch(`${githubApiBase(row.hostname)}/user`, {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": "paperclip-github-integration",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const payload = await response.json().catch(() => ({})) as { login?: unknown; message?: unknown };
        if (!response.ok) {
          throw new Error(typeof payload.message === "string" ? payload.message : `GitHub returned ${response.status}`);
        }
        const login = typeof payload.login === "string" ? payload.login : null;
        result = { ok: true, accountLogin: login, hostname: row.hostname, message: login ? `Connected as ${login}` : "Connection verified", testedAt };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : "Connection failed";
        const message = /unable to authenticate data|unsupported state/i.test(rawMessage)
          ? "Stored secret cannot be decrypted with the active master key. Rotate the secret and try again."
          : rawMessage;
        result = { ok: false, accountLogin: null, hostname: row.hostname, message, testedAt };
      }
      await db.update(companyGithubConnections).set({
        accountLogin: result.accountLogin,
        lastTestedAt: testedAt,
        lastTestStatus: result.ok ? "success" : "error",
        lastTestMessage: result.message,
        updatedAt: new Date(),
      }).where(eq(companyGithubConnections.id, id));
      return result;
    },
  };
}
