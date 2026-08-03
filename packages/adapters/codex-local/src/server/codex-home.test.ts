import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CODEX_SYNC_ALLOWLIST,
  codexHomeHasUsableAuth,
  ensureSymlink,
  evaluateCodexCredentialReadiness,
  mergeManagedCodexMcpGateways,
  isManagedCodexHomePath,
  prepareManagedCodexHome,
  reconcileManagedCodexHome,
  seedManagedCodexHome,
  stageCodexHomeForSync,
  writeManagedCodexMcpConfig,
} from "./codex-home.js";

describe("mergeManagedCodexMcpGateways", () => {
  it("keeps runtime gateways and appends non-overlapping context gateways", () => {
    expect(
      mergeManagedCodexMcpGateways(
        [{ name: "runtime", endpointPath: "/runtime", bearerToken: "runtime-token" }],
        [
          { name: "runtime", endpointPath: "/stale", bearerToken: "stale-token" },
          { name: "manual", endpointPath: "/manual", bearerToken: "manual-token" },
        ],
      ),
    ).toEqual([
      { name: "runtime", endpointPath: "/runtime", bearerToken: "runtime-token" },
      { name: "manual", endpointPath: "/manual", bearerToken: "manual-token" },
    ]);
  });
});

describe("codex managed home", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a concurrently-created expected auth symlink as success", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"OPENAI_API_KEY":"shared"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (source, target, type) => {
      await originalSymlink(source, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).resolves.toBe(managedCodexHome);

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(managedAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("still throws on EEXIST when a raced-in auth symlink points elsewhere", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const managedCodexHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const wrongAuth = path.join(sharedCodexHome, "other-auth.json");
    const managedAuth = path.join(managedCodexHome, "auth.json");

    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"OPENAI_API_KEY":"shared"}\n', "utf8");
    await fs.writeFile(wrongAuth, '{"token":"other"}\n', "utf8");

    const originalSymlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementationOnce(async (_source, target, type) => {
      await originalSymlink(wrongAuth, target, type);
      const error = new Error("file already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    });

    try {
      await expect(
        prepareManagedCodexHome(
          {
            CODEX_HOME: sharedCodexHome,
            PAPERCLIP_HOME: paperclipHome,
            PAPERCLIP_INSTANCE_ID: "default",
          },
          async () => {},
          "company-1",
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(managedAuth)).toBe(wrongAuth);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Regression for #5028: older Paperclip versions copied auth.json into the
  // managed home instead of symlinking. After upgrading to the symlink-based
  // logic, the stale regular file at the target stayed in place and every
  // subsequent codex_local run failed with refresh_token_reused as soon as the
  // source token rotated. `ensureSymlink` now heals the upgrade path by
  // unlinking the stale copy and creating a symlink to the live source.
  it("replaces a stale regular-file auth.json with a symlink to the live source (#5028)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const paperclipHome = path.join(root, "paperclip-home");
      const managedCodexHome = path.join(
        paperclipHome,
        "instances",
        "default",
        "companies",
        "company-1",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const managedAuth = path.join(managedCodexHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      // The live source has rotated since the stale copy was written.
      await fs.writeFile(sharedAuth, '{"token":"fresh"}', "utf8");

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");

      await prepareManagedCodexHome(
        {
          CODEX_HOME: sharedCodexHome,
          PAPERCLIP_HOME: paperclipHome,
          PAPERCLIP_INSTANCE_ID: "default",
        },
        async () => {},
        "company-1",
      );

      expect((await fs.lstat(managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(managedAuth, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Direct unit coverage for the new ensureSymlink branch (#5028). The
  // regression test above goes through prepareManagedCodexHome, whose
  // pre-existing apikey-mode cleanup `fs.rm`s the stale auth.json before
  // ensureSymlink runs — so the heal branch never executes there. Call
  // ensureSymlink directly to prove the unlink-and-recreate path itself.
  it("ensureSymlink: unlinks a stale regular file and recreates the symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "stale-target.json");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.writeFile(target, '{"token":"stale-from-copy"}', "utf8");

      await ensureSymlink(target, source);

      expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(target, "utf8")).toBe('{"token":"fresh"}');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The isDirectory() guard added with the heal branch must keep an unexpected
  // directory in place rather than throwing EISDIR. We treat a directory at
  // this path as operator-owned, not a stale Paperclip copy.
  it("ensureSymlink: leaves an unexpected directory in place instead of throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-ensure-symlink-dir-"));
    try {
      const source = path.join(root, "live-source.json");
      const target = path.join(root, "unexpected-dir");
      await fs.writeFile(source, '{"token":"fresh"}', "utf8");
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, "sentinel"), "keep-me", "utf8");

      await expect(ensureSymlink(target, source)).resolves.toBeUndefined();

      expect((await fs.lstat(target)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(target, "sentinel"), "utf8")).toBe("keep-me");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

});

describe("isManagedCodexHomePath", () => {
  const env = {
    PAPERCLIP_HOME: "/srv/paperclip",
    PAPERCLIP_INSTANCE_ID: "default",
  } satisfies NodeJS.ProcessEnv;
  const companyRoot = path.resolve(
    "/srv/paperclip/instances/default/companies/company-1",
  );

  it("treats the per-agent managed home as managed", () => {
    expect(
      isManagedCodexHomePath(
        env,
        "company-1",
        path.join(companyRoot, "agents", "agent-7", "codex-home"),
      ),
    ).toBe(true);
  });

  it("treats the shared company home as managed", () => {
    expect(
      isManagedCodexHomePath(env, "company-1", path.join(companyRoot, "codex-home")),
    ).toBe(true);
  });

  it("treats a path outside the company tree as an external override", () => {
    expect(isManagedCodexHomePath(env, "company-1", "/home/dev/.codex")).toBe(false);
    expect(
      isManagedCodexHomePath(
        env,
        "company-1",
        path.resolve("/srv/paperclip/instances/default/companies/company-2/codex-home"),
      ),
    ).toBe(false);
  });

  it("returns false without a companyId", () => {
    expect(isManagedCodexHomePath(env, undefined, path.join(companyRoot, "codex-home"))).toBe(
      false,
    );
  });
});

describe("codexHomeHasUsableAuth", () => {
  it("is true for credential-bearing auth.json and false when missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-"));
    try {
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), "{}", "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"foo":"bar"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"token":"shared"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"access_token":"shared"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
      await fs.writeFile(path.join(root, "auth.json"), '{"OPENAI_API_KEY":"shared"}', "utf8");
      expect(await codexHomeHasUsableAuth(root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("recognizes the Codex 0.143 AuthDotJson subscription shape", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-modern-"));
    try {
      await fs.writeFile(
        path.join(root, "auth.json"),
        JSON.stringify({
          tokens: {
            id_token: "synthetic-id-token",
            access_token: "synthetic-access-token",
            refresh_token: "synthetic-refresh-token",
            account_id: "acct-modern",
          },
          last_refresh: "2026-07-09T00:00:00Z",
        }),
        "utf8",
      );

      expect(await codexHomeHasUsableAuth(root)).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats subscription auth without account_id or token material as unusable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-modern-invalid-"));
    try {
      await fs.writeFile(
        path.join(root, "auth.json"),
        JSON.stringify({
          tokens: {
            id_token: "synthetic-id-token",
            access_token: "synthetic-access-token",
            refresh_token: "synthetic-refresh-token",
          },
          last_refresh: "2026-07-09T00:00:00Z",
        }),
        "utf8",
      );
      expect(await codexHomeHasUsableAuth(root)).toBe(false);

      await fs.writeFile(
        path.join(root, "auth.json"),
        JSON.stringify({
          tokens: {
            account_id: "acct-modern",
          },
          last_refresh: "2026-07-09T00:00:00Z",
        }),
        "utf8",
      );
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("is false for a dangling auth.json symlink", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-auth-dangling-"));
    try {
      await fs.symlink(path.join(root, "missing-source.json"), path.join(root, "auth.json"));
      expect(await codexHomeHasUsableAuth(root)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("seedManagedCodexHome", () => {
  it("symlinks auth.json from the shared source into an explicit per-agent home", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-"));
    try {
      const sharedCodexHome = path.join(root, "shared-codex-home");
      const agentHome = path.join(
        root,
        "instances",
        "default",
        "companies",
        "company-1",
        "agents",
        "agent-7",
        "codex-home",
      );
      const sharedAuth = path.join(sharedCodexHome, "auth.json");
      const agentAuth = path.join(agentHome, "auth.json");

      await fs.mkdir(sharedCodexHome, { recursive: true });
      await fs.writeFile(sharedAuth, '{"OPENAI_API_KEY":"shared"}', "utf8");

      await seedManagedCodexHome(agentHome, { CODEX_HOME: sharedCodexHome }, async () => {});

      expect((await fs.lstat(agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(agentAuth)).toBe(await fs.realpath(sharedAuth));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("writes an API-key auth.json into the home when an apiKey is supplied", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-apikey-"));
    try {
      const agentHome = path.join(root, "agent-home");
      const emptyShared = path.join(root, "empty-shared");
      await fs.mkdir(emptyShared, { recursive: true });
      await seedManagedCodexHome(agentHome, { CODEX_HOME: emptyShared }, async () => {}, {
        apiKey: "sk-test-123",
      });

      const written = JSON.parse(await fs.readFile(path.join(agentHome, "auth.json"), "utf8"));
      expect(written).toEqual({ OPENAI_API_KEY: "sk-test-123" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Startup backfill for already-isolated managed homes.
describe("reconcileManagedCodexHome", () => {
  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-reconcile-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const agentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
      "agents",
      "agent-7",
      "codex-home",
    );
    const sharedAuth = path.join(sharedCodexHome, "auth.json");
    const agentAuth = path.join(agentHome, "auth.json");
    await fs.mkdir(sharedCodexHome, { recursive: true });
    await fs.writeFile(sharedAuth, '{"OPENAI_API_KEY":"shared"}', "utf8");
    const env = {
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    } satisfies NodeJS.ProcessEnv;
    return { root, sharedCodexHome, sharedAuth, agentHome, agentAuth, env };
  }

  it("seeds a previously-stranded managed home and is a no-op on re-run", async () => {
    const fx = await makeFixture();
    try {
      // The isolation guard created the per-agent home with no auth.json.
      expect(await codexHomeHasUsableAuth(fx.agentHome)).toBe(false);

      const first = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });
      expect(first.status).toBe("seeded");
      expect(first.home).toBe(fx.agentHome);
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));

      const second = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });
      expect(second.status).toBe("already_seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports source_auth_missing when shared auth is unavailable", async () => {
    const fx = await makeFixture();
    try {
      await fs.rm(fx.sharedAuth, { force: true });

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        env: fx.env,
      });

      expect(result.status).toBe("source_auth_missing");
      await expect(fs.lstat(fx.agentAuth)).rejects.toThrow();
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("leaves a genuine external override untouched", async () => {
    const fx = await makeFixture();
    try {
      const external = path.join(fx.root, "user-codex");
      await fs.mkdir(external, { recursive: true });

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: external,
        env: fx.env,
      });
      expect(result.status).toBe("external_override");
      expect(await codexHomeHasUsableAuth(external)).toBe(false);
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("reports no_managed_home when no CODEX_HOME is configured", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: null,
        env: fx.env,
      });
      expect(result).toEqual({ status: "no_managed_home", home: null });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("preserves an existing API-key auth.json when the key is secret-bound", async () => {
    const fx = await makeFixture();
    try {
      // A prior execute-time run resolved the secret and wrote a regular-file
      // auth.json containing the key.
      await fs.mkdir(fx.agentHome, { recursive: true });
      await fs.writeFile(
        fx.agentAuth,
        JSON.stringify({ OPENAI_API_KEY: "sk-secret-resolved" }),
        { mode: 0o600 },
      );

      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKeySecretBound: true,
        env: fx.env,
      });

      expect(result.status).toBe("already_seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await fs.readFile(fx.agentAuth, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-secret-resolved",
      });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("seeds the shared symlink for a secret-bound key when no auth exists yet", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKeySecretBound: true,
        env: fx.env,
      });

      expect(result.status).toBe("seeded");
      expect((await fs.lstat(fx.agentAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(fx.agentAuth)).toBe(await fs.realpath(fx.sharedAuth));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("writes an API-key auth.json into a managed home when an apiKey is supplied", async () => {
    const fx = await makeFixture();
    try {
      const result = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKey: "sk-reconcile-1",
        env: fx.env,
      });
      expect(result.status).toBe("seeded");
      const written = JSON.parse(await fs.readFile(fx.agentAuth, "utf8"));
      expect(written).toEqual({ OPENAI_API_KEY: "sk-reconcile-1" });

      const second = await reconcileManagedCodexHome({
        companyId: "company-1",
        configuredCodexHome: fx.agentHome,
        apiKey: "sk-reconcile-1",
        env: fx.env,
      });
      expect(second.status).toBe("already_seeded");
      expect(JSON.parse(await fs.readFile(fx.agentAuth, "utf8"))).toEqual({
        OPENAI_API_KEY: "sk-reconcile-1",
      });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });
});

describe("evaluateCodexCredentialReadiness", () => {
  async function makeFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-readiness-"));
    const sharedCodexHome = path.join(root, "shared-codex-home");
    const paperclipHome = path.join(root, "paperclip-home");
    const companyRoot = path.join(
      paperclipHome,
      "instances",
      "default",
      "companies",
      "company-1",
    );
    const managedCompanyHome = path.join(companyRoot, "codex-home");
    const managedAgentHome = path.join(companyRoot, "agents", "agent-1", "codex-home");
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: sharedCodexHome,
      PAPERCLIP_HOME: paperclipHome,
      PAPERCLIP_INSTANCE_ID: "default",
    };
    await fs.mkdir(sharedCodexHome, { recursive: true });
    return { root, sharedCodexHome, managedCompanyHome, managedAgentHome, env };
  }

  async function writeUsableAuth(home: string) {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"sk-live"}\n', "utf8");
  }

  it("flags a managed home with no source auth and empty OPENAI_API_KEY as not ready", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: false });
      expect(result.effectiveHome).toBe(path.resolve(fx.managedAgentHome));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("treats a non-empty resolved OPENAI_API_KEY as ready without touching disk", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "sk-agent-key",
      });
      expect(result).toMatchObject({ managed: true, authMode: "api", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("is ready when the shared source home carries usable subscription auth", async () => {
    const fx = await makeFixture();
    try {
      await writeUsableAuth(fx.sharedCodexHome);
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("is ready when the already-seeded effective home carries usable auth", async () => {
    const fx = await makeFixture();
    try {
      await writeUsableAuth(fx.managedAgentHome);
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: fx.managedAgentHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("defaults to the managed company home when no CODEX_HOME is configured", async () => {
    const fx = await makeFixture();
    try {
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: null,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: true, authMode: "subscription", ready: false });
      expect(result.effectiveHome).toBe(path.resolve(fx.managedCompanyHome));
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("treats an external/user-supplied CODEX_HOME override as self-managed and ready", async () => {
    const fx = await makeFixture();
    try {
      const externalHome = path.join(fx.root, "user-codex-home");
      await fs.mkdir(externalHome, { recursive: true });
      const result = await evaluateCodexCredentialReadiness({
        env: fx.env,
        companyId: "company-1",
        configuredCodexHome: externalHome,
        configuredApiKey: "",
      });
      expect(result).toMatchObject({ managed: false, ready: true });
    } finally {
      await fs.rm(fx.root, { recursive: true, force: true });
    }
  });

  it("replaces the managed MCP block and clears stale servers for an empty runtime set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-config-"));
    try {
      const alphaHome = path.join(root, "agent-alpha");
      const zeroHome = path.join(root, "agent-zero");
      await writeManagedCodexMcpConfig({
        codexHome: alphaHome,
        apiBaseUrl: "https://paperclip.example",
        gateways: [{
          name: "alpha",
          endpointPath: "https://paperclip.example/api/tool-gateway/gateways/alpha/mcp",
          bearerToken: "alpha-token",
        }],
      });
      await writeManagedCodexMcpConfig({
        codexHome: zeroHome,
        apiBaseUrl: "https://paperclip.example",
        gateways: [{
          name: "stale",
          endpointPath: "/api/tool-gateway/gateways/stale/mcp",
          bearerToken: "stale-token",
        }],
      });
      await writeManagedCodexMcpConfig({
        codexHome: zeroHome,
        apiBaseUrl: "https://paperclip.example",
        gateways: [],
      });

      const alpha = await fs.readFile(path.join(alphaHome, "config.toml"), "utf8");
      const zero = await fs.readFile(path.join(zeroHome, "config.toml"), "utf8");
      expect(alpha).toContain('[mcp_servers."alpha"]');
      expect(alpha).toContain('Authorization = "Bearer alpha-token"');
      expect(zero).not.toContain("mcp_servers.");
      expect(zero).not.toContain("stale-token");
      expect(alphaHome).not.toBe(zeroHome);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("restricts permissions on an existing managed MCP config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-mcp-config-"));
    try {
      const configPath = path.join(root, "config.toml");
      await fs.writeFile(configPath, "model = \"gpt-5\"\n", { mode: 0o644 });

      await writeManagedCodexMcpConfig({
        codexHome: root,
        apiBaseUrl: "https://paperclip.example",
        gateways: [],
      });

      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("stageCodexHomeForSync", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Builds a fake managed CODEX_HOME containing the full allowlist (with
  // `auth.json` as a symlink into a separate source-bytes file and a populated
  // `skills/` symlink, mirroring the real managed home) plus decoy runtime
  // state the allowlist must NOT copy.
  async function buildFakeHome(root: string): Promise<{ home: string; authBytes: string; skillBytes: string }> {
    const home = path.join(root, "codex-home");
    const authSource = path.join(root, "shared", "auth.json");
    const skillSource = path.join(root, "shared", "skill-src.md");
    const authBytes = '{"tokens":{"account_id":"acct","refresh_token":"r"}}\n';
    const skillBytes = "# injected skill\n";

    await fs.mkdir(path.join(root, "shared"), { recursive: true });
    await fs.writeFile(authSource, authBytes, "utf8");
    await fs.writeFile(skillSource, skillBytes, "utf8");

    await fs.mkdir(home, { recursive: true });
    // auth.json is a symlink into the shared source (single-use rotating tokens).
    await fs.symlink(authSource, path.join(home, "auth.json"));
    await fs.writeFile(path.join(home, "config.toml"), "model_provider = \"paperclip\"\n", "utf8");
    await fs.writeFile(path.join(home, "config.json"), "{}\n", "utf8");
    await fs.writeFile(path.join(home, "instructions.md"), "hi\n", "utf8");
    // skills/ is a directory of symlinks.
    await fs.mkdir(path.join(home, "skills"), { recursive: true });
    await fs.symlink(skillSource, path.join(home, "skills", "demo.md"));

    // Decoys: large runtime state the 4-name denylist missed.
    await fs.writeFile(path.join(home, "logs_2.sqlite"), "x", "utf8");
    await fs.writeFile(path.join(home, "state_5.sqlite"), "x", "utf8");
    await fs.mkdir(path.join(home, "plugins", "cache"), { recursive: true });
    await fs.writeFile(path.join(home, "plugins", "cache", "x"), "x", "utf8");
    await fs.mkdir(path.join(home, "sessions"), { recursive: true });
    await fs.writeFile(path.join(home, "sessions", "y"), "x", "utf8");
    await fs.mkdir(path.join(home, "tmp"), { recursive: true });
    await fs.symlink("/usr/bin/env", path.join(home, "tmp", "arg0"));

    return { home, authBytes, skillBytes };
  }

  it("stages exactly the allowlist, derefs auth.json to bytes, and excludes decoys", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-"));
    let staged: string | null = null;
    try {
      const { home, authBytes, skillBytes } = await buildFakeHome(root);
      staged = await stageCodexHomeForSync(home, { runId: "run-1" });

      const entries = (await fs.readdir(staged)).sort();
      expect(entries).toEqual([...CODEX_SYNC_ALLOWLIST].sort());

      // Decoys must be absent.
      for (const decoy of ["logs_2.sqlite", "state_5.sqlite", "plugins", "sessions", "tmp"]) {
        expect(entries).not.toContain(decoy);
      }

      // auth.json is a regular file (symlink dereferenced) whose bytes equal the target.
      const stagedAuth = path.join(staged, "auth.json");
      expect((await fs.lstat(stagedAuth)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(stagedAuth, "utf8")).toBe(authBytes);

      // skills/ copied recursively with the symlink dereferenced to bytes.
      const stagedSkill = path.join(staged, "skills", "demo.md");
      expect((await fs.lstat(stagedSkill)).isSymbolicLink()).toBe(false);
      expect(await fs.readFile(stagedSkill, "utf8")).toBe(skillBytes);

      // config.toml (post-rewrite state) carried through.
      expect(await fs.readFile(path.join(staged, "config.toml"), "utf8")).toContain("model_provider");
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // C1 — staged credential file must be mode 0600 (not the world-readable default).
  it("writes the staged auth.json with mode 0600", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-mode-"));
    let staged: string | null = null;
    try {
      const { home } = await buildFakeHome(root);
      staged = await stageCodexHomeForSync(home, { runId: "run-mode" });
      const mode = (await fs.stat(path.join(staged, "auth.json"))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // config.toml carries the managed MCP `Authorization: Bearer …` header and is
  // secret-bearing; the staged copy must be 0600, not the world-readable default.
  it("writes the staged config.toml (managed MCP bearer header) with mode 0600", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-toml-mode-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      await fs.mkdir(home, { recursive: true });
      // Mirror the source writer: config.toml holds an MCP gateway bearer token
      // and is persisted 0600 on disk.
      await fs.writeFile(
        path.join(home, "config.toml"),
        "[mcp_servers.paperclip]\nheaders = { Authorization = \"Bearer secret-token\" }\n",
        { mode: 0o600 },
      );
      staged = await stageCodexHomeForSync(home, { runId: "run-toml-mode" });
      const mode = (await fs.stat(path.join(staged, "config.toml"))).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Least privilege: no staged regular file needs group/other read, so every
  // one (config.json, instructions.md — not just credentials) is staged 0600.
  it("writes every staged regular file with mode 0600", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-all-mode-"));
    let staged: string | null = null;
    try {
      const { home } = await buildFakeHome(root);
      staged = await stageCodexHomeForSync(home, { runId: "run-all-mode" });
      for (const entry of ["auth.json", "config.toml", "config.json", "instructions.md"]) {
        const mode = (await fs.stat(path.join(staged, entry))).mode & 0o777;
        expect(mode, `${entry} should be staged 0600`).toBe(0o600);
      }
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // C2 — staged dir must be 0700 (mkdtemp guarantees this on POSIX).
  it("creates the staged dir with mode 0700", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-dir-"));
    let staged: string | null = null;
    try {
      const { home } = await buildFakeHome(root);
      staged = await stageCodexHomeForSync(home, { runId: "run-dir" });
      const mode = (await fs.stat(staged)).mode & 0o777;
      expect(mode).toBe(0o700);
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("skips absent optional entries without throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-absent-"));
    let staged: string | null = null;
    try {
      // Keyring-credential mode: no auth.json, no config.json.
      const home = path.join(root, "codex-home");
      await fs.mkdir(home, { recursive: true });
      await fs.writeFile(path.join(home, "config.toml"), "x\n", "utf8");

      staged = await stageCodexHomeForSync(home, { runId: "run-absent" });
      const entries = await fs.readdir(staged);
      expect(entries).toEqual(["config.toml"]);
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("treats a dangling auth.json symlink as absent (skips it, no throw)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-dangling-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      await fs.mkdir(home, { recursive: true });
      await fs.symlink(path.join(root, "gone", "auth.json"), path.join(home, "auth.json"));
      await fs.writeFile(path.join(home, "config.toml"), "x\n", "utf8");

      staged = await stageCodexHomeForSync(home, { runId: "run-dangling" });
      expect(await fs.readdir(staged)).toEqual(["config.toml"]);
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // C3 + C4 — an unexpected I/O error must reject (fail-closed, not partial)
  // AND remove the temp dir it created (cleanup on the error path).
  it("fails closed and removes the temp dir on an unexpected I/O error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-fail-"));
    try {
      const { home } = await buildFakeHome(root);

      let createdDir: string | null = null;
      const realMkdtemp = fs.mkdtemp.bind(fs);
      vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix: string, ...rest: unknown[]) => {
        const dir = await (realMkdtemp as typeof fs.mkdtemp)(prefix, ...(rest as []));
        createdDir = dir as string;
        return dir;
      });
      vi.spyOn(fs, "readFile").mockRejectedValue(
        Object.assign(new Error("boom"), { code: "EACCES" }),
      );

      await expect(stageCodexHomeForSync(home, { runId: "run-fail" })).rejects.toThrow("boom");
      expect(createdDir).not.toBeNull();
      // The staged temp dir was cleaned up despite the failure.
      await expect(fs.access(createdDir as unknown as string)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Circular symlinks inside skills/ must be silently skipped (not throw ELOOP).
  // Skill symlinks that point OUTSIDE skills/ are intentional design (Paperclip
  // stores skill packages in a shared location) and are dereferenced normally;
  // all resulting files land 0600 inside the 0700 staged dir.
  it("skips circular skill symlinks (ELOOP) without throwing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-circular-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      await fs.mkdir(path.join(home, "skills"), { recursive: true });
      // Self-referential symlink: would loop forever — must be skipped.
      const circularLink = path.join(home, "skills", "loop.md");
      await fs.symlink(circularLink, circularLink);
      // A normal skill file — must still be staged.
      await fs.writeFile(path.join(home, "skills", "legit.md"), "# ok\n", "utf8");

      staged = await stageCodexHomeForSync(home, { runId: "run-circular" });
      const stagedSkillEntries = await fs.readdir(path.join(staged, "skills"));
      // Circular link must be absent.
      expect(stagedSkillEntries).not.toContain("loop.md");
      // Normal skill file must be present.
      expect(stagedSkillEntries).toContain("legit.md");
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Mode normalization: nested skill files must be staged 0600 regardless of
  // their source mode (0644 documents, 0755 scripts, etc.).
  it("writes nested skill files with mode 0600 regardless of source mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-skill-mode-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      await fs.mkdir(path.join(home, "skills", "my-skill"), { recursive: true });
      // Typical source modes: readable doc (0644) and executable script (0755);
      // both must land 0600 in the staged dir.
      await fs.writeFile(path.join(home, "skills", "my-skill", "SKILL.md"), "# skill\n", { mode: 0o644 });
      await fs.writeFile(path.join(home, "skills", "my-skill", "run.sh"), "#!/bin/sh\n", { mode: 0o755 });

      staged = await stageCodexHomeForSync(home, { runId: "run-skill-mode" });
      for (const rel of ["my-skill/SKILL.md", "my-skill/run.sh"]) {
        const mode = (await fs.stat(path.join(staged, "skills", rel))).mode & 0o777;
        expect(mode, `skills/${rel} should be staged 0600`).toBe(0o600);
      }
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Finding 1 (Greptile): a directory symlink such as `back -> .` inside a skill
  // resolves to an ancestor directory (it does NOT raise ELOOP), so naive
  // recursion would traverse the same tree forever until disk/memory is
  // exhausted. Cycle detection must let staging finish while still copying the
  // real content and skipping the self-referential link.
  it("does not infinitely traverse an ancestor directory link (back -> .) inside a skill", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-cycle-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      const skillDir = path.join(home, "skills", "my-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# skill\n", "utf8");
      // Directory symlink pointing at the skill's own dir — resolves to a
      // directory already on the active traversal path; must be skipped.
      await fs.symlink(".", path.join(skillDir, "back"));

      staged = await stageCodexHomeForSync(home, { runId: "run-cycle" });

      // Completed without hanging; the real file is staged and the cyclic link
      // produced no runaway nested `back/back/…` chain (it is skipped entirely).
      expect(await fs.readdir(path.join(staged, "skills", "my-skill"))).toEqual(["SKILL.md"]);
      expect(await fs.readFile(path.join(staged, "skills", "my-skill", "SKILL.md"), "utf8")).toBe(
        "# skill\n",
      );
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Finding 2 (Greptile): a symlink *inside* a skill that points to a host file
  // or directory OUTSIDE that skill (e.g. `~/.ssh/id_rsa`) must NOT be
  // dereferenced into the staged asset — otherwise a malformed/compromised skill
  // could smuggle host secrets past CODEX_SYNC_ALLOWLIST.
  it("does not stage a nested skill symlink that escapes the skill root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-escape-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      const skillDir = path.join(home, "skills", "my-skill");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), "# skill\n", "utf8");

      // A host "secret" file and directory living OUTSIDE the skill dir.
      const secretFile = path.join(root, "host-secret.txt");
      await fs.writeFile(secretFile, "TOP SECRET\n", "utf8");
      const secretDir = path.join(root, "host-secret-dir");
      await fs.mkdir(secretDir, { recursive: true });
      await fs.writeFile(path.join(secretDir, "creds"), "creds\n", "utf8");

      // Nested symlinks inside the skill escaping to those host paths.
      await fs.symlink(secretFile, path.join(skillDir, "stolen.txt"));
      await fs.symlink(secretDir, path.join(skillDir, "stolen-dir"));

      staged = await stageCodexHomeForSync(home, { runId: "run-escape" });

      const stagedEntries = await fs.readdir(path.join(staged, "skills", "my-skill"));
      // The legit in-skill file is staged…
      expect(stagedEntries).toContain("SKILL.md");
      // …but neither escaping link is followed into the staged asset.
      expect(stagedEntries).not.toContain("stolen.txt");
      expect(stagedEntries).not.toContain("stolen-dir");
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Defense-in-depth for finding 1: a degenerate top-level `skills/<x> -> ..`
  // link resolves to an ancestor of `skills/` (the home). It must be skipped,
  // never adopted as a containment root — otherwise the whole home
  // (`sessions/`, `*.sqlite`, …) would be dragged into the staged skills asset.
  it("skips a top-level skills entry that resolves to an ancestor of skills/", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-stage-ancestor-"));
    let staged: string | null = null;
    try {
      const home = path.join(root, "codex-home");
      await fs.mkdir(path.join(home, "skills"), { recursive: true });
      await fs.writeFile(path.join(home, "skills", "legit.md"), "# ok\n", "utf8");
      // Runtime state in the home that must never reach the staged asset.
      await fs.writeFile(path.join(home, "logs.sqlite"), "x", "utf8");
      // `up -> ..` resolves to the home dir (an ancestor of skills/).
      await fs.symlink("..", path.join(home, "skills", "up"));

      staged = await stageCodexHomeForSync(home, { runId: "run-ancestor" });

      const stagedSkillEntries = await fs.readdir(path.join(staged, "skills"));
      expect(stagedSkillEntries).toContain("legit.md");
      // The ancestor link is skipped, so the home's runtime state is not dragged in.
      expect(stagedSkillEntries).not.toContain("up");
    } finally {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
