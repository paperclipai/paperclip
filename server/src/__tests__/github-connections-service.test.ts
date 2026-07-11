import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  companyGithubConnections,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  projects,
  secretAccessEvents,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { buildGithubCredentialEnv, githubConnectionService } from "../services/github-connections.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("buildGithubCredentialEnv", () => {
  it("supports gh and ordinary git without embedding the token in helper config", () => {
    const env = buildGithubCredentialEnv({ token: "github_pat_private", hostname: "github.com" });
    expect(env.GH_TOKEN).toBe("github_pat_private");
    expect(env.GITHUB_TOKEN).toBe("github_pat_private");
    expect(env.GH_HOST).toBe("github.com");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$GH_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("github_pat_private");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describeEmbeddedPostgres("githubConnectionService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-github-connections-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("github-connections");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(secretAccessEvents);
    await db.delete(companySecretBindings);
    await db.delete(projects);
    await db.delete(companyGithubConnections);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(companySecretProviderConfigs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  it("keeps multiple credentials and resolves the one bound to each project", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `G${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
    });
    const secrets = secretService(db);
    const personalSecret = await secrets.create(companyId, { name: "personal-token", provider: "local_encrypted", value: "personal-value" });
    const orgSecret = await secrets.create(companyId, { name: "org-token", provider: "local_encrypted", value: "org-value" });
    const svc = githubConnectionService(db);
    const personal = await svc.create(companyId, { name: "Personal", hostname: "github.com", secretId: personalSecret.id });
    const org = await svc.create(companyId, { name: "Work org", hostname: "github.example.com", secretId: orgSecret.id });
    const projectA = randomUUID();
    const projectB = randomUUID();
    await db.insert(projects).values([
      { id: projectA, companyId, name: "A", githubConnectionId: personal.id },
      { id: projectB, companyId, name: "B", githubConnectionId: org.id },
    ]);
    await svc.syncProjectBinding(companyId, projectA, personal.id);
    await svc.syncProjectBinding(companyId, projectB, org.id);

    const [resolvedA, resolvedB, listed] = await Promise.all([
      svc.resolveForProject({ companyId, projectId: projectA }),
      svc.resolveForProject({ companyId, projectId: projectB }),
      svc.list(companyId),
    ]);

    expect(resolvedA?.token).toBe("personal-value");
    expect(resolvedA?.env.GH_HOST).toBe("github.com");
    expect(resolvedB?.token).toBe("org-value");
    expect(resolvedB?.env.GH_HOST).toBe("github.example.com");
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personal.id, projectCount: 1 }),
      expect.objectContaining({ id: org.id, projectCount: 1 }),
    ]));
  });
});
