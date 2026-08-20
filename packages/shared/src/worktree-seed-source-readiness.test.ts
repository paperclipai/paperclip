import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWorktreeSeedSourceReady,
  evaluateWorktreeSeedSourceReadiness,
  formatWorktreeSeedSourceReadinessFailure,
  isWorktreeSeedSourceReadinessError,
  WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE,
} from "./worktree-seed-source-readiness.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRoot(suffix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pap17628-${suffix}-`));
  cleanup.push(root);
  return root;
}

/**
 * Write a host-shaped source workspace: `<workspace>/.paperclip/config.json` plus the
 * adjacent `.env` instance pointer, with instance state under `<home>/instances/<id>`.
 */
function writeSource(input: {
  root: string;
  instanceId: string;
  instanceStateRoot?: string;
  homeDir?: string;
  createDataDir?: boolean;
  initializeDataDir?: boolean;
  database?: Record<string, unknown>;
  omitEnv?: boolean;
  omitInstanceId?: boolean;
  configBody?: string;
}) {
  const workspaceCwd = path.join(input.root, "workspace");
  const configDir = path.join(workspaceCwd, ".paperclip");
  const configPath = path.join(configDir, "config.json");
  const homeDir = input.homeDir ?? path.join(input.root, "home", ".paperclip");
  const instanceRoot = input.instanceStateRoot ?? path.join(homeDir, "instances", input.instanceId);
  const dataDir = path.join(instanceRoot, "db");
  fs.mkdirSync(configDir, { recursive: true });

  const config = {
    $meta: { version: 1, updatedAt: "2026-08-19T00:00:00.000Z", source: "configure" },
    database: input.database ?? {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: dataDir,
      embeddedPostgresPort: 54329,
      backup: { enabled: true, intervalMinutes: 60, retentionDays: 30, dir: path.join(instanceRoot, "data", "backups") },
    },
    logging: { mode: "file", logDir: path.join(instanceRoot, "logs") },
    server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port: 3100, allowedHostnames: [], serveUi: true },
    storage: { provider: "local_disk", localDisk: { baseDir: path.join(instanceRoot, "data", "storage") } },
    secrets: { provider: "local_encrypted", strictMode: false, localEncrypted: { keyFilePath: path.join(instanceRoot, "secrets", "master.key") } },
    telemetry: { enabled: true },
  };
  fs.writeFileSync(configPath, input.configBody ?? `${JSON.stringify(config, null, 2)}\n`);
  if (!input.omitEnv) {
    const lines = [
      `PAPERCLIP_HOME="${homeDir}"`,
      ...(input.omitInstanceId ? [] : [`PAPERCLIP_INSTANCE_ID="${input.instanceId}"`]),
      `PAPERCLIP_CONFIG="${path.join(homeDir, "instances", input.instanceId, "config.json")}"`,
    ];
    fs.writeFileSync(path.join(configDir, ".env"), `${lines.join("\n")}\n`);
  }
  if (input.createDataDir !== false) {
    fs.mkdirSync(dataDir, { recursive: true });
    if (input.initializeDataDir !== false) fs.writeFileSync(path.join(dataDir, "PG_VERSION"), "16\n");
  }
  return { workspaceCwd, configPath, dataDir, homeDir, instanceRoot };
}

const closedPort = vi.fn(async () => false);
const openPort = vi.fn(async () => true);

describe("evaluateWorktreeSeedSourceReadiness", () => {
  it("accepts a healthy but stopped embedded source", async () => {
    const source = writeSource({ root: makeRoot("stopped"), instanceId: "default" });

    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    });

    expect(readiness).toMatchObject({
      ok: true,
      phase: WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE,
      reason: null,
      findings: [],
      // A closed port is not a defect: the seed starts the source from its data directory.
      databaseState: "stopped",
      sourceInstanceId: "default",
    });
    await expect(assertWorktreeSeedSourceReady({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: true });
  });

  it("reports a running embedded source as reachable", async () => {
    const source = writeSource({ root: makeRoot("running"), instanceId: "default" });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: openPort,
    })).resolves.toMatchObject({ ok: true, databaseState: "reachable" });
  });

  it("resolves relative persistent-state paths from the source config directory", async () => {
    const source = writeSource({ root: makeRoot("relative-paths"), instanceId: "default" });
    const configDir = path.dirname(source.configPath);
    const config = JSON.parse(fs.readFileSync(source.configPath, "utf8")) as {
      database: { embeddedPostgresDataDir: string; backup: { dir: string } };
      logging: { logDir: string };
      storage: { localDisk: { baseDir: string } };
      secrets: { localEncrypted: { keyFilePath: string } };
    };
    config.database.embeddedPostgresDataDir = path.relative(configDir, source.dataDir);
    config.database.backup.dir = path.relative(configDir, path.join(source.instanceRoot, "data", "backups"));
    config.logging.logDir = path.relative(configDir, path.join(source.instanceRoot, "logs"));
    config.storage.localDisk.baseDir = path.relative(configDir, path.join(source.instanceRoot, "data", "storage"));
    config.secrets.localEncrypted.keyFilePath = path.relative(configDir, path.join(source.instanceRoot, "secrets", "master.key"));
    fs.writeFileSync(source.configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: true, findings: [], databaseState: "stopped" });
  });

  it("rejects a deleted embedded data directory", async () => {
    const root = makeRoot("deleted-datadir");
    const source = writeSource({ root, instanceId: "default" });
    fs.rmSync(source.dataDir, { recursive: true, force: true });

    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("source_data_dir_missing");
    expect(readiness.findings).toEqual([
      expect.objectContaining({
        reason: "source_data_dir_missing",
        configKeys: ["database.embeddedPostgresDataDir"],
        detail: "missing",
      }),
    ]);
    expect(readiness.remediation).toMatch(/stopped database is fine/i);
    // A data directory that exists but was never initialized is equally unusable.
    fs.mkdirSync(source.dataDir, { recursive: true });
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_data_dir_missing",
      findings: [expect.objectContaining({ detail: "uninitialized" })],
    });
  });

  it("rejects a config whose paths disagree with the adjacent .env instance pointer", async () => {
    const root = makeRoot("identity");
    const source = writeSource({
      root,
      instanceId: "default",
      instanceStateRoot: path.join(root, "home", ".paperclip", "instances", "other-instance"),
    });

    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.reason).toBe("source_instance_mismatch");
    // One finding per (reason, detail), listing every key that carries it.
    expect(readiness.findings).toEqual([
      expect.objectContaining({
        reason: "source_instance_mismatch",
        detail: "instance_segment_mismatch",
        configKeys: [
          "database.embeddedPostgresDataDir",
          "database.backup.dir",
          "logging.logDir",
          "storage.localDisk.baseDir",
          "secrets.localEncrypted.keyFilePath",
        ],
      }),
    ]);
    expect(readiness.message).toContain("`default`");
  });

  it("rejects a caller identity that disagrees with the registered source", async () => {
    const source = writeSource({ root: makeRoot("caller-identity"), instanceId: "default" });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      expectedSourceInstanceId: "some-other-instance",
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_instance_mismatch",
      findings: [expect.objectContaining({ detail: "registered_instance_mismatch" })],
    });
  });

  it("rejects a registered primary workspace contaminated by a pcvt- worktree test", async () => {
    const root = makeRoot("pcvt");
    // Reproduce the observed shape: `paperclip configure` inside a virtualized
    // test run rewrote the shared checkout's config to point at its own scratch tree.
    const contaminated = path.join(
      root,
      ".p16582",
      "pcvt-2140811-1-VA2N3o",
      "t",
      "paperclip-worktrees-sM1nDa",
      "instances",
      "pap-885-show-worktree-banner-0bb51a0ce24e",
    );
    const source = writeSource({
      root,
      instanceId: "default",
      instanceStateRoot: contaminated,
      createDataDir: false,
    });

    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    });

    expect(readiness.ok).toBe(false);
    const reasons = new Set(readiness.findings.map((finding) => finding.reason));
    expect(reasons).toEqual(new Set([
      "source_instance_mismatch",
      "source_transient_worktree_identity",
      "source_data_dir_missing",
    ]));
    expect(readiness.findings.find((finding) => finding.reason === "source_transient_worktree_identity"))
      .toMatchObject({
        configKeys: expect.arrayContaining(["database.embeddedPostgresDataDir", "logging.logDir"]),
        detail: "ephemeral_worktree_home+pcvt_test_harness+virtualized_test_scratch",
      });
    // Identity is reported before existence: the pointer, not the missing directory, is the defect.
    expect(readiness.reason).toBe("source_instance_mismatch");

    // The same tree is only a diagnostic for a manual `--from-config` boot.
    const permissive = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: false,
      probeTcp: closedPort,
    });
    expect(permissive.findings.some((finding) => finding.reason === "source_transient_worktree_identity"))
      .toBe(false);
  });

  it("keeps the sanctioned worktree home provisionable", async () => {
    const root = makeRoot("worktree-home");
    const source = writeSource({
      root,
      instanceId: "pap-17628-worktree",
      homeDir: path.join(root, ".paperclip-worktrees"),
    });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: true, findings: [] });
  });

  it("ignores a transient-looking ancestor shared by the source workspace and its state", async () => {
    const harnessRoot = path.join(makeRoot("harness-ancestor"), "pcvt-test-run", "t");
    fs.mkdirSync(harnessRoot, { recursive: true });
    const source = writeSource({ root: harnessRoot, instanceId: "default" });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: true, findings: [] });
  });

  it("stays permissive about identity for a manual --from-config source", async () => {
    const root = makeRoot("manual");
    // An operator's explicit source may predate the adjacent instance pointer, so a
    // manual boot only has to prove its persistent state is intact.
    const source = writeSource({ root, instanceId: "default", omitEnv: true });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: true, findings: [], sourceInstanceId: null });

    fs.rmSync(source.dataDir, { recursive: true, force: true });
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      probeTcp: closedPort,
    })).resolves.toMatchObject({ ok: false, reason: "source_data_dir_missing" });
  });

  it("rejects an unusable config or a missing instance pointer", async () => {
    const missingRoot = makeRoot("missing");
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: path.join(missingRoot, "workspace", ".paperclip", "config.json"),
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_config_invalid",
      findings: [expect.objectContaining({ detail: "missing" })],
    });

    const malformed = writeSource({
      root: makeRoot("malformed"),
      instanceId: "default",
      configBody: "{ not json",
    });
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: malformed.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_config_invalid",
      findings: [expect.objectContaining({ detail: "malformed_json" })],
    });

    const noEnv = writeSource({ root: makeRoot("no-env"), instanceId: "default", omitEnv: true });
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: noEnv.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_config_invalid",
      findings: [expect.objectContaining({ detail: "instance_pointer_missing" })],
    });

    const noInstanceId = writeSource({
      root: makeRoot("no-instance"),
      instanceId: "default",
      omitInstanceId: true,
    });
    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: noInstanceId.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    })).resolves.toMatchObject({
      ok: false,
      reason: "source_config_invalid",
      findings: [expect.objectContaining({ detail: "instance_id_missing" })],
    });
  });

  it("requires an external source database to be reachable", async () => {
    const root = makeRoot("external");
    const source = writeSource({
      root,
      instanceId: "default",
      database: {
        mode: "postgres",
        connectionString: "postgres://paperclip:sup3r-s3cret@db.internal:6543/paperclip",
      },
      createDataDir: false,
    });

    const probeTcp = vi.fn(async () => false);
    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      probeTcp,
    });

    expect(probeTcp).toHaveBeenCalledWith({ host: "db.internal", port: 6543 });
    expect(readiness).toMatchObject({
      ok: false,
      reason: "source_database_unreachable",
      databaseState: "unknown",
    });

    await expect(evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: openPort,
    })).resolves.toMatchObject({ ok: true, databaseState: "reachable" });
  });

  it("never leaks secrets, config values or private paths into the surfaced failure", async () => {
    const root = makeRoot("redaction");
    const source = writeSource({
      root,
      instanceId: "default",
      database: {
        mode: "postgres",
        connectionString: "postgres://paperclip:sup3r-s3cret@db.internal:6543/paperclip",
      },
      createDataDir: false,
    });

    const readiness = await evaluateWorktreeSeedSourceReadiness({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    });
    const error = await assertWorktreeSeedSourceReady({
      sourceConfigPath: source.configPath,
      registeredPrimaryWorkspace: true,
      probeTcp: closedPort,
    }).catch((thrown: unknown) => thrown);

    expect(isWorktreeSeedSourceReadinessError(error)).toBe(true);
    const surfaced = [
      formatWorktreeSeedSourceReadinessFailure(readiness),
      (error as Error).message,
      JSON.stringify(readiness),
    ].join("\n");
    expect(surfaced).not.toContain("sup3r-s3cret");
    expect(surfaced).not.toContain("db.internal");
    expect(surfaced).not.toContain(root);
    expect(surfaced).not.toContain(os.tmpdir());
    // It still names the phase, the machine-readable reason and the remediation.
    expect((error as Error).message).toContain(WORKTREE_SEED_SOURCE_PREFLIGHT_PHASE);
    expect((error as Error).message).toContain("source_database_unreachable");
    expect((error as Error).message).toMatch(/Start the source database/);
  });
});
