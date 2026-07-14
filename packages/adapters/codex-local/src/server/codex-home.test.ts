import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codexHomeHasUsableAuth,
  ensureSymlink,
  evaluateCodexCredentialReadiness,
  mergeManagedCodexMcpGateways,
  isManagedCodexHomePath,
  prepareManagedCodexHome,
  reconcileManagedCodexHome,
  seedManagedCodexHome,
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
