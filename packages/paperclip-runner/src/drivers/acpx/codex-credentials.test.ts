import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stageManagedCodexCredential } from "./codex-credentials.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  (
    globalThis as typeof globalThis & {
      __paperclipDirectorySyncHelperRegistryV1?: {
        activeParentOperations: Set<symbol>;
      };
    }
  ).__paperclipDirectorySyncHelperRegistryV1?.activeParentOperations.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("managed Codex credentials", () => {
  it("derives deterministic quorum candidates from distinct user scopes", () => {
    expect(credentialLeasePortsForScope("1000", "/canonical/home")).toEqual(
      credentialLeasePortsForScope("1000", "/canonical/home"),
    );
    expect(credentialLeasePortsForScope("1000", "/canonical/home")).not.toEqual(
      credentialLeasePortsForScope("1001", "/canonical/home"),
    );
    expect(credentialLeasePortsForScope("1000", "/canonical/home")).not.toEqual(
      credentialLeasePortsForScope("1000", "/canonical/other-home"),
    );
  });

  it("stages inline JSON privately and removes it idempotently", async () => {
    const fixture = await credentialFixture();
    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: JSON.stringify({
          tokens: { access_token: "inline-canary" },
        }),
      },
    });

    expect(lease.mode).toBe("inline_json");
    expect(lease.lifetimeFenceCandidates).toEqual(
      credentialLeasePorts(await realpath(fixture.home)),
    );
    expect(lease.lifetimeFenceFds).toHaveLength(2);
    expect(lease.lifetimeFenceFds.every(Number.isSafeInteger)).toBe(true);
    expect(lease.lifetimeFenceFds[0]).not.toBe(lease.lifetimeFenceFds[1]);
    await expect(
      lease.activateLifetimeOwner(process.pid),
    ).resolves.toBeUndefined();
    await expect(lease.activateLifetimeOwner(0)).rejects.toThrow(
      "lifetime owner is invalid",
    );
    const cleanupIntent = join(
      fixture.home,
      ".paperclip-auth-cleanup-required",
    );
    await expect(readFile(lease.path, "utf8")).resolves.toContain(
      "inline-canary",
    );
    await expect(readFile(cleanupIntent, "utf8")).resolves.toBe(
      "paperclip-managed-codex-cleanup-v1\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(lease.path)).mode & 0o777).toBe(0o600);
    }
    await lease.close();
    await lease.close();
    await expect(readFile(lease.path)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(cleanupIntent)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fences overlapping leases for the same isolated home", async () => {
    const fixture = await credentialFixture();
    const firstLease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"first"}',
      },
    });

    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");
    await expect(readFile(firstLease.path, "utf8")).resolves.toBe(
      '{"owner":"first"}',
    );

    await firstLease.close();
    const secondLease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
      },
    });
    await expect(readFile(secondLease.path, "utf8")).resolves.toBe(
      '{"owner":"second"}',
    );
    await secondLease.close();
  });

  it("fences a contender loaded through a fresh module instance", async () => {
    const fixture = await credentialFixture();
    const firstLease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"first"}',
      },
    });

    vi.resetModules();
    const freshCredentials = await import("./codex-credentials.js");
    await expect(
      freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
        },
      }),
    ).rejects.toThrow("already has an active lease");

    await firstLease.close();
  });

  it.each([
    ["primary", 0],
    ["non-primary", 1],
  ] as const)(
    "tolerates one unrelated silent %s quorum listener",
    async (_label, occupiedIndex) => {
      const fixture = await credentialFixture();
      const ports = credentialLeasePorts(await realpath(fixture.home));
      const occupied = await listenSilently(ports[occupiedIndex]);
      try {
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"paperclip"}',
          },
        });
        await expect(readFile(lease.path, "utf8")).resolves.toBe(
          '{"owner":"paperclip"}',
        );
        await lease.close();
      } finally {
        await occupied.close();
      }
    },
  );

  it("fails before auth mutation when two quorum candidates are occupied", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    await writeFile(destination, '{"sentinel":true}', { mode: 0o600 });
    const ports = credentialLeasePorts(await realpath(fixture.home));
    const first = await listenSilently(ports[0]);
    const second = await listenSilently(ports[1]);
    try {
      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
          },
        }),
      ).rejects.toThrow("already has an active lease");
      await expect(readFile(destination, "utf8")).resolves.toBe(
        '{"sentinel":true}',
      );
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("admits only one of two concurrent fresh-module contenders", async () => {
    const fixture = await credentialFixture();
    vi.resetModules();
    const firstCredentials = await import("./codex-credentials.js");
    vi.resetModules();
    const secondCredentials = await import("./codex-credentials.js");

    const results = await Promise.allSettled([
      firstCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"first"}',
        },
      }),
      secondCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
        },
      }),
    ]);
    const winners = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof stageManagedCodexCredential>>
      > => result.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    await winners[0].value.close();
  });

  it("fences another process and recovers only after its kernel lease dies", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    const childScript = join(fixture.root, "credential-owner.mjs");
    const credentialModule = new URL("./codex-credentials.ts", import.meta.url)
      .href;
    // paperclip-runner intentionally does not ship a TS runtime dependency.
    // Resolve the existing monorepo dev loader from a workspace that declares
    // it, instead of asking the child to resolve an undeclared bare package.
    const tsxLoader = createRequire(
      new URL("../../../../../server/package.json", import.meta.url),
    ).resolve("tsx");
    await writeFile(
      childScript,
      [
        `const { stageManagedCodexCredential } = await import(${JSON.stringify(credentialModule)});`,
        "const lease = await stageManagedCodexCredential({",
        "  agentHomeDirectory: process.argv[2],",
        '  environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: \'{"owner":"first"}\' },',
        "});",
        'process.send?.({ type: "ready", path: lease.path });',
        "process.on('message', async (message) => {",
        "  if (message?.type !== 'close') return;",
        "  await lease.close();",
        "  process.exit(0);",
        "});",
      ].join("\n"),
    );
    const owner = fork(childScript, [fixture.home], {
      execArgv: ["--import", tsxLoader],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    try {
      await waitForChildMessage(owner, "ready");
      await expect(readFile(destination, "utf8")).resolves.toBe(
        '{"owner":"first"}',
      );

      if (process.platform !== "win32") {
        owner.kill("SIGSTOP");
        await new Promise<void>((resolveSignal) =>
          setTimeout(resolveSignal, 50),
        );
      }
      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
          },
        }),
      ).rejects.toThrow("already has an active lease");
      await expect(readFile(destination, "utf8")).resolves.toBe(
        '{"owner":"first"}',
      );

      if (process.platform !== "win32") owner.kill("SIGCONT");
      owner.kill(process.platform === "win32" ? undefined : "SIGKILL");
      await waitForChildExit(owner);

      const successor = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
        },
      });
      await expect(readFile(destination, "utf8")).resolves.toBe(
        '{"owner":"second"}',
      );
      await successor.close();
      expect(
        (await readdir(fixture.home)).filter(
          (name) =>
            name.includes("paperclip-auth-lease") ||
            name.includes("paperclip-auth-home-claim"),
        ),
      ).toEqual([]);
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        if (process.platform !== "win32") owner.kill("SIGCONT");
        owner.kill(process.platform === "win32" ? undefined : "SIGKILL");
        await waitForChildExit(owner).catch(() => undefined);
      }
    }
  });
  it.runIf(process.platform !== "win32")(
    "holds kernel ownership until credential cleanup is durable",
    async () => {
      const fixture = await credentialFixture();
      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      });
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let releaseCleanup!: () => void;
      const cleanupGate = new Promise<void>((resolveCleanup) => {
        releaseCleanup = resolveCleanup;
      });
      let signalCleanupStarted!: () => void;
      const cleanupStarted = new Promise<void>((resolveStarted) => {
        signalCleanupStarted = resolveStarted;
      });
      let heldCleanup = false;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if (!heldCleanup && (await this.stat()).isDirectory()) {
            heldCleanup = true;
            signalCleanupStarted();
            await cleanupGate;
          }
          await originalSync.call(this);
        });
      try {
        const closing = lease.close();
        await cleanupStarted;
        vi.resetModules();
        const freshCredentials = await import("./codex-credentials.js");
        await expect(
          freshCredentials.stageManagedCodexCredential({
            agentHomeDirectory: fixture.home,
            environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
          }),
        ).rejects.toThrow("already has an active lease");

        releaseCleanup();
        await expect(closing).resolves.toBeUndefined();
        const successor = await freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        });
        await successor.close();
      } finally {
        releaseCleanup();
        syncSpy.mockRestore();
      }
    },
  );

  it("does not let an older failed close remove a successor credential", async () => {
    const fixture = await credentialFixture();
    const firstLease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"first"}',
      },
    });
    await rm(firstLease.path, { force: true });
    await mkdir(firstLease.path);

    await expect(firstLease.close()).rejects.toThrow(
      "credential destination is a directory",
    );
    await rm(firstLease.path, { force: true, recursive: true });

    const secondLease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"second"}',
      },
    });
    await expect(firstLease.close()).resolves.toBeUndefined();
    await expect(readFile(secondLease.path, "utf8")).resolves.toBe(
      '{"owner":"second"}',
    );
    await secondLease.close();
  });

  it("leaves no ownership artifacts in the credential home", async () => {
    const fixture = await credentialFixture();
    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: { OPENAI_API_KEY: "launch-only-key" },
    });
    await lease.close();

    expect(
      (await readdir(fixture.home)).filter(
        (name) =>
          name.includes("paperclip-auth-lease") ||
          name.includes("paperclip-auth-home-claim") ||
          name.includes("paperclip-auth-lock"),
      ),
    ).toEqual([]);
  });
  it("recovers a persisted cleanup intent before admitting another provider", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    const cleanupIntent = join(
      fixture.home,
      ".paperclip-auth-cleanup-required",
    );
    await writeFile(destination, '{"crash_stale":true}', { mode: 0o600 });
    await writeFile(cleanupIntent, "paperclip-managed-codex-cleanup-v1\n", {
      mode: 0o600,
    });

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: { OPENAI_API_KEY: "launch-only-key" },
    });
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(cleanupIntent, "utf8")).resolves.toBe(
      "paperclip-managed-codex-cleanup-v1\n",
    );
    await lease.close();
    await expect(readFile(cleanupIntent)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scrubs a crash-left credential staging file before admission", async () => {
    const fixture = await credentialFixture();
    const stagingPath = join(fixture.home, ".paperclip-auth-staging-v1");
    const cleanupIntent = join(
      fixture.home,
      ".paperclip-auth-cleanup-required",
    );
    await writeFile(stagingPath, '{"crash_secret":"must-not-survive"}', {
      mode: 0o600,
    });
    await writeFile(cleanupIntent, "paperclip-managed-codex-cleanup-v1\n", {
      mode: 0o600,
    });

    vi.resetModules();
    const freshCredentials = await import("./codex-credentials.js");
    const lease = await freshCredentials.stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"successor"}',
      },
    });
    await expect(readFile(stagingPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(lease.path, "utf8")).resolves.toBe(
      '{"owner":"successor"}',
    );
    await lease.close();
  });

  it.runIf(process.platform !== "win32")(
    "unlinks a crash-left staging symlink without touching its target",
    async () => {
      const fixture = await credentialFixture();
      const target = join(fixture.root, "external-secret.json");
      const stagingPath = join(fixture.home, ".paperclip-auth-staging-v1");
      await writeFile(target, '{"external":"unchanged"}', { mode: 0o600 });
      await symlink(target, stagingPath);

      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await expect(readFile(stagingPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(target, "utf8")).resolves.toBe(
        '{"external":"unchanged"}',
      );
      await lease.close();
    },
  );

  it("fails closed instead of recursively removing a staging directory", async () => {
    const fixture = await credentialFixture();
    const stagingPath = join(fixture.home, ".paperclip-auth-staging-v1");
    await mkdir(stagingPath, { mode: 0o700 });

    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      }),
    ).rejects.toThrow("credential destination is a directory");
    expect((await stat(stagingPath)).isDirectory()).toBe(true);
    await expect(
      readFile(join(fixture.home, "auth.json")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "retries the directory sync after unlink already succeeded",
    async () => {
      const fixture = await credentialFixture();
      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      });
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let syncAttempts = 0;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            syncAttempts += 1;
            if (syncAttempts === 1) {
              throw new Error("injected directory sync failure");
            }
          }
          await originalSync.call(this);
        });
      try {
        await expect(lease.close()).resolves.toBeUndefined();
        await expect(readFile(lease.path)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(syncAttempts).toBe(3);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "retries preflight, installation, and removal until each is durable",
    async () => {
      const fixture = await credentialFixture();
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let directorySyncAttempts = 0;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            directorySyncAttempts += 1;
          }
          // The first attempt at each namespace boundary fails; the durable
          // helper must retry before staging or cleanup reports success.
          if ([1, 3, 5].includes(directorySyncAttempts)) {
            throw new Error("injected directory sync failure");
          }
          await originalSync.call(this);
        });
      try {
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        });
        await expect(readFile(lease.path, "utf8")).resolves.toBe("{}");
        await expect(lease.close()).resolves.toBeUndefined();
        await expect(readFile(lease.path)).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(directorySyncAttempts).toBe(8);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it("copies an explicit private source without changing the source", async () => {
    const fixture = await credentialFixture();
    const source = join(fixture.root, "managed-auth.json");
    await writeFile(
      source,
      JSON.stringify({ tokens: { access_token: "managed-canary" } }),
      { mode: 0o600 },
    );
    await chmod(source, 0o600);

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      sourcePath: source,
    });
    expect(lease.mode).toBe("managed_file");
    await expect(readFile(lease.path, "utf8")).resolves.toContain(
      "managed-canary",
    );
    await lease.close();
    await expect(readFile(source, "utf8")).resolves.toContain("managed-canary");
  });

  it("replaces a stale regular auth destination in JSON modes", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    await writeFile(destination, '{"stale":true}', { mode: 0o600 });

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: {
        PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"fresh":true}',
      },
    });
    await expect(readFile(destination, "utf8")).resolves.toBe('{"fresh":true}');
    await lease.close();
  });

  it("cleans stale and provider-generated auth in API-key mode", async () => {
    const fixture = await credentialFixture();
    const destination = join(fixture.home, "auth.json");
    await writeFile(destination, '{"stale":true}');

    const lease = await stageManagedCodexCredential({
      agentHomeDirectory: fixture.home,
      environment: { OPENAI_API_KEY: "launch-only-key" },
    });
    expect(lease.mode).toBe("api_key");
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await writeFile(destination, '{"provider_generated":true}');
    await lease.close();
    await expect(readFile(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps API-key staging pending until stale removal is durable",
    async () => {
      const fixture = await credentialFixture();
      const destination = join(fixture.home, "auth.json");
      await writeFile(destination, '{"stale":true}', { mode: 0o600 });
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let syncAttempts = 0;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            syncAttempts += 1;
            if (syncAttempts === 1) {
              throw new Error("injected directory sync failure");
            }
          }
          await originalSync.call(this);
        });
      try {
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(readFile(destination)).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(lease.close()).resolves.toBeUndefined();
        expect(syncAttempts).toBe(5);
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails a non-durable admission within a bound and scrubs again on retry",
    async () => {
      const fixture = await credentialFixture();
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            throw new Error("persistent directory sync failure");
          }
          await originalSync.call(this);
        });
      try {
        const staging = stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(staging).rejects.toThrow(
          "remained non-durable after 8 attempts",
        );
        expect(syncSpy.mock.calls.length).toBeGreaterThanOrEqual(8);
        syncSpy.mockRestore();
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await expect(lease.close()).resolves.toBeUndefined();
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "shares the four-slot parent filesystem budget across fresh modules",
    async () => {
      const fixtures = await Promise.all(
        Array.from({ length: 5 }, () => credentialFixture()),
      );
      const retainedHomes = new Set(
        fixtures.slice(0, 4).map((fixture) => fixture.home),
      );
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let directoryOpenAttempts = 0;
      let fifthHomeOpenAttempts = 0;
      let observeFourOpens!: () => void;
      const fourOpens = new Promise<void>((resolveOpens) => {
        observeFourOpens = resolveOpens;
      });
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          const pathname = String(path);
          if (retainedHomes.has(pathname)) {
            directoryOpenAttempts += 1;
            if (directoryOpenAttempts === 4) observeFourOpens();
            return await new Promise<FileHandle>(() => undefined);
          }
          if (pathname === fixtures[4].home) fifthHomeOpenAttempts += 1;
          return await actualFs.open(path, flags, mode);
        },
      }));
      const spawnMock = vi.fn(() => {
        const child = Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
          pid: 12345,
          unref: vi.fn(),
        }) as unknown as ChildProcess;
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      });
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      vi.resetModules();
      const firstCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const firstStaging = Promise.all(
        fixtures.slice(0, 4).map((fixture) =>
          firstCredentials.stageManagedCodexCredential({
            agentHomeDirectory: fixture.home,
            environment: { OPENAI_API_KEY: "launch-only-key" },
          }),
        ),
      );
      let leases: Awaited<ReturnType<typeof stageManagedCodexCredential>>[] =
        [];
      try {
        await fourOpens;
        await vi.advanceTimersByTimeAsync(1_001);
        leases = await firstStaging;
        const registry = (
          globalThis as typeof globalThis & {
            __paperclipDirectorySyncHelperRegistryV1?: {
              activeParentOperations: Set<symbol>;
            };
          }
        ).__paperclipDirectorySyncHelperRegistryV1;
        expect(registry?.activeParentOperations.size).toBe(4);

        vi.resetModules();
        const freshCredentials = await import("./codex-credentials.js");
        const fifthLease = await freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixtures[4].home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        leases.push(fifthLease);
        expect(directoryOpenAttempts).toBe(4);
        expect(fifthHomeOpenAttempts).toBe(0);
        expect(spawnMock).toHaveBeenCalled();
      } finally {
        await Promise.allSettled(leases.map((lease) => lease.close()));
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "isolates retries after a directory open never settles",
    async () => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let directoryOpenAttempts = 0;
      let observeFirstOpen!: () => void;
      const firstOpen = new Promise<void>((resolveOpen) => {
        observeFirstOpen = resolveOpen;
      });
      const retainedOpen = new Promise<FileHandle>(() => undefined);
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            directoryOpenAttempts += 1;
            if (directoryOpenAttempts === 1) {
              observeFirstOpen();
              return await retainedOpen;
            }
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await firstOpen;
      await vi.advanceTimersByTimeAsync(1_001);
      const lease = await staging;
      expect(directoryOpenAttempts).toBe(1);
      await lease.close();
      const successor = await freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await successor.close();
      expect(directoryOpenAttempts).toBe(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "isolates retries after a directory fsync never settles",
    async () => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let directorySyncAttempts = 0;
      let observeFirstSync!: () => void;
      const firstSync = new Promise<void>((resolveSync) => {
        observeFirstSync = resolveSync;
      });
      const stalledDirectoryHandle = {
        close: async (): Promise<void> => undefined,
        sync: async (): Promise<void> => {
          directorySyncAttempts += 1;
          observeFirstSync();
          return await new Promise<void>(() => undefined);
        },
      } as FileHandle;
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) return stalledDirectoryHandle;
          return await actualFs.open(path, flags, mode);
        },
      }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await firstSync;
      await vi.advanceTimersByTimeAsync(1_001);
      const lease = await staging;
      await lease.close();
      const successor = await freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await successor.close();
      expect(directorySyncAttempts).toBe(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "isolates later syncs after a directory close never settles",
    async () => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let directoryCloseAttempts = 0;
      let observeFirstClose!: () => void;
      const firstClose = new Promise<void>((resolveClose) => {
        observeFirstClose = resolveClose;
      });
      const retainedClose = new Promise<void>(() => undefined);
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            return {
              close: async (): Promise<void> => {
                directoryCloseAttempts += 1;
                if (directoryCloseAttempts === 1) {
                  observeFirstClose();
                  return await retainedClose;
                }
              },
              sync: async (): Promise<void> => undefined,
            } as FileHandle;
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await firstClose;
      await vi.advanceTimersByTimeAsync(1_001);
      const lease = await staging;
      expect(directoryCloseAttempts).toBe(1);
      await lease.close();
      const successor = await freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      await successor.close();
      expect(directoryCloseAttempts).toBe(1);
    },
  );

  it.runIf(process.platform !== "win32")(
    "permanently fails closed when a killed sync helper never exits",
    async () => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let observeDirectoryOpen!: () => void;
      const directoryOpen = new Promise<void>((resolveOpen) => {
        observeDirectoryOpen = resolveOpen;
      });
      let directoryOpenAttempts = 0;
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            directoryOpenAttempts += 1;
            observeDirectoryOpen();
            return await new Promise<FileHandle>(() => undefined);
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      let spawnAttempts = 0;
      const stuckChild = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        // Signal-0 must observe a live process for this retained-helper fixture.
        pid: process.pid,
        unref: vi.fn(),
      }) as unknown as ChildProcess;
      vi.doMock("node:child_process", () => ({
        spawn: vi.fn(() => {
          spawnAttempts += 1;
          return stuckChild;
        }),
      }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      const rejection = expect(staging).rejects.toThrow(
        /remained non-durable after 1 attempt/,
      );
      await directoryOpen;
      await vi.advanceTimersByTimeAsync(1_001);
      await vi.advanceTimersByTimeAsync(1_001);
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      expect(spawnAttempts).toBe(1);
      expect(directoryOpenAttempts).toBe(1);
      expect(stuckChild.unref).toHaveBeenCalledOnce();

      await expect(
        freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        }),
      ).rejects.toThrow(/remained non-durable after 1 attempt/);
      expect(spawnAttempts).toBe(1);
      expect(directoryOpenAttempts).toBe(1);
      stuckChild.emit("exit", null, "SIGKILL");
    },
  );

  it.runIf(process.platform !== "win32").each([
    ["returns false", (): boolean => false],
    [
      "throws",
      (): boolean => {
        throw new Error("injected kill failure");
      },
    ],
  ])(
    "permanently fences a home when helper kill %s",
    async (_label, killImplementation) => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let observeDirectoryOpen!: () => void;
      const directoryOpen = new Promise<void>((resolveOpen) => {
        observeDirectoryOpen = resolveOpen;
      });
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            observeDirectoryOpen();
            return await new Promise<FileHandle>(() => undefined);
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(killImplementation),
        // Signal-0 must observe a live process for this retained-helper fixture.
        pid: process.pid,
        unref: vi.fn(),
      }) as unknown as ChildProcess;
      const spawnMock = vi.fn(() => child);
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      const rejection = expect(staging).rejects.toThrow(
        /remained non-durable after 1 attempt/,
      );
      await directoryOpen;
      await vi.advanceTimersByTimeAsync(1_001);
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      await expect(
        freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        }),
      ).rejects.toThrow(/remained non-durable after 1 attempt/);
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      child.emit("exit", null, "SIGKILL");
    },
  );

  it.runIf(process.platform !== "win32")(
    "permanently fences a home after an asynchronous helper error",
    async () => {
      const fixture = await credentialFixture();
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let observeDirectoryOpen!: () => void;
      const directoryOpen = new Promise<void>((resolveOpen) => {
        observeDirectoryOpen = resolveOpen;
      });
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            observeDirectoryOpen();
            return await new Promise<FileHandle>(() => undefined);
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        // Signal-0 must observe a live process for this retained-helper fixture.
        pid: process.pid,
        unref: vi.fn(),
      }) as unknown as ChildProcess;
      const spawnMock = vi.fn(() => {
        queueMicrotask(() => child.emit("error", new Error("spawn failed")));
        return child;
      });
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();

      const staging = freshCredentials.stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { OPENAI_API_KEY: "launch-only-key" },
      });
      const rejection = expect(staging).rejects.toThrow(
        /remained non-durable after 1 attempt/,
      );
      await directoryOpen;
      await vi.advanceTimersByTimeAsync(1_001);
      await rejection;
      await expect(
        freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        }),
      ).rejects.toThrow(/remained non-durable after 1 attempt/);
      expect(spawnMock).toHaveBeenCalledOnce();
      child.emit("exit", null, null);
    },
  );

  it.runIf(process.platform !== "win32")(
    "shares the helper process cap across fresh module instances",
    async () => {
      const fixture = await credentialFixture();
      const registry = (
        globalThis as typeof globalThis & {
          __paperclipDirectorySyncHelperRegistryV1?: {
            activeChildren: Set<ChildProcess>;
          };
        }
      ).__paperclipDirectorySyncHelperRegistryV1;
      expect(registry).toBeDefined();
      const reservations = Array.from(
        { length: 4 },
        () => new EventEmitter() as unknown as ChildProcess,
      );
      for (const reservation of reservations) {
        registry!.activeChildren.add(reservation);
      }
      const actualFs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      let observeDirectoryOpen!: () => void;
      const directoryOpen = new Promise<void>((resolveOpen) => {
        observeDirectoryOpen = resolveOpen;
      });
      vi.doMock("node:fs/promises", () => ({
        ...actualFs,
        open: async (
          path: Parameters<typeof open>[0],
          flags: Parameters<typeof open>[1],
          mode?: Parameters<typeof open>[2],
        ): Promise<FileHandle> => {
          if (String(path) === fixture.home) {
            observeDirectoryOpen();
            return await new Promise<FileHandle>(() => undefined);
          }
          return await actualFs.open(path, flags, mode);
        },
      }));
      const spawnMock = vi.fn(() => {
        throw new Error("helper cap was bypassed");
      });
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");
      vi.useFakeTimers();
      try {
        const staging = freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        const rejection = expect(staging).rejects.toThrow(
          /remained non-durable after 8 attempts/,
        );
        await directoryOpen;
        await vi.advanceTimersByTimeAsync(3_000);
        await rejection;
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        for (const reservation of reservations) {
          registry!.activeChildren.delete(reservation);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "reclaims kernel-confirmed helper exits when child events are lost",
    async () => {
      const fixture = await credentialFixture();
      const registry = (
        globalThis as typeof globalThis & {
          __paperclipDirectorySyncHelperRegistryV1?: {
            activeChildren: Set<ChildProcess>;
            childDirectories: Map<ChildProcess, string>;
            activeParentOperations: Set<symbol>;
            failedHomes: Set<string>;
            stuckChildren: Map<string, ChildProcess>;
          };
        }
      ).__paperclipDirectorySyncHelperRegistryV1;
      expect(registry).toBeDefined();

      const parentReservations = Array.from({ length: 4 }, () => Symbol());
      for (const reservation of parentReservations) {
        registry!.activeParentOperations.add(reservation);
      }
      const departedPids = new Set<number>();
      const departedHelpers = Array.from({ length: 4 }, (_, index) => {
        const pid = 41_000 + index;
        departedPids.add(pid);
        const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          kill: vi.fn(() => true),
          pid,
          signalCode: null,
          unref: vi.fn(),
        }) as unknown as ChildProcess;
        const directory = `/departed-credential-helper-${String(index)}`;
        registry!.activeChildren.add(child);
        registry!.childDirectories.set(child, directory);
        if (index < 2) {
          registry!.failedHomes.add(directory);
          registry!.stuckChildren.set(directory, child);
        }
        return { child, directory };
      });
      const killSpy = vi
        .spyOn(process, "kill")
        .mockImplementation((pid, signal) => {
          if (signal === 0 && departedPids.has(Number(pid))) {
            throw Object.assign(new Error("process no longer exists"), {
              code: "ESRCH",
            });
          }
          return true;
        });
      const observedActiveChildren: number[] = [];
      let nextPid = 42_000;
      const spawnMock = vi.fn(() => {
        observedActiveChildren.push(registry!.activeChildren.size);
        const child = Object.assign(new EventEmitter(), {
          exitCode: null,
          kill: vi.fn(() => true),
          pid: nextPid++,
          signalCode: null,
          unref: vi.fn(),
        }) as unknown as ChildProcess;
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
        return child;
      });
      vi.doMock("node:child_process", () => ({ spawn: spawnMock }));
      vi.resetModules();
      const freshCredentials = await import("./codex-credentials.js");

      try {
        const lease = await freshCredentials.stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        });
        await lease.close();

        expect(spawnMock).toHaveBeenCalled();
        expect(observedActiveChildren.every((count) => count < 4)).toBe(true);
        for (const { child, directory } of departedHelpers) {
          expect(registry!.activeChildren).not.toContain(child);
          expect(registry!.childDirectories.has(child)).toBe(false);
          expect(registry!.failedHomes).not.toContain(directory);
          expect(registry!.stuckChildren.has(directory)).toBe(false);
        }
      } finally {
        killSpy.mockRestore();
        for (const reservation of parentReservations) {
          registry!.activeParentOperations.delete(reservation);
        }
        for (const { child, directory } of departedHelpers) {
          registry!.activeChildren.delete(child);
          registry!.childDirectories.delete(child);
          registry!.failedHomes.delete(directory);
          registry!.stuckChildren.delete(directory);
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps intent-publication failure before credential mutation and scrubs without process memory",
    async () => {
      const fixture = await credentialFixture();
      const destination = join(fixture.home, "auth.json");
      const cleanupIntent = join(
        fixture.home,
        ".paperclip-auth-cleanup-required",
      );
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let directorySyncAttempts = 0;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            directorySyncAttempts += 1;
            if (directorySyncAttempts > 1) {
              throw new Error("persistent intent sync failure");
            }
          }
          await originalSync.call(this);
        });
      try {
        await expect(
          stageManagedCodexCredential({
            agentHomeDirectory: fixture.home,
            environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
          }),
        ).rejects.toThrow("remained non-durable after 8 attempts");
        await expect(readFile(destination)).rejects.toMatchObject({
          code: "ENOENT",
        });

        // Model a crash losing the unsynced intent directory entry and the
        // next process finding an unexpected auth file. A fresh module has no
        // quarantine map from the failed process, so admission must rely on
        // the isolated-home scrub rather than process memory.
        syncSpy.mockRestore();
        await rm(cleanupIntent, { force: true });
        await writeFile(destination, '{"orphaned":true}', { mode: 0o600 });
        vi.resetModules();
        const freshCredentials = await import("./codex-credentials.js");
        const persistentSyncFailure = vi
          .spyOn(prototype, "sync")
          .mockImplementation(async function (this: FileHandle): Promise<void> {
            if ((await this.stat()).isDirectory()) {
              throw new Error("persistent recovery sync failure");
            }
            await originalSync.call(this);
          });
        try {
          await expect(
            freshCredentials.stageManagedCodexCredential({
              agentHomeDirectory: fixture.home,
              environment: { OPENAI_API_KEY: "launch-only-key" },
            }),
          ).rejects.toThrow("remained non-durable after 8 attempts");
          await expect(readFile(destination)).rejects.toMatchObject({
            code: "ENOENT",
          });
        } finally {
          persistentSyncFailure.mockRestore();
        }
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "owns cleanup when post-rename directory durability fails",
    async () => {
      const fixture = await credentialFixture();
      const destination = join(fixture.home, "auth.json");
      const probe = await open(fixture.home, "r");
      const prototype = Object.getPrototypeOf(probe) as {
        sync(this: FileHandle): Promise<void>;
      };
      await probe.close();
      const originalSync = prototype.sync;
      let directorySyncAttempts = 0;
      const syncSpy = vi
        .spyOn(prototype, "sync")
        .mockImplementation(async function (this: FileHandle): Promise<void> {
          if ((await this.stat()).isDirectory()) {
            directorySyncAttempts += 1;
            if (directorySyncAttempts > 2) {
              throw new Error("persistent post-rename sync failure");
            }
          }
          await originalSync.call(this);
        });
      try {
        await expect(
          stageManagedCodexCredential({
            agentHomeDirectory: fixture.home,
            environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
          }),
        ).rejects.toThrow("remained non-durable after 8 attempts");
        await expect(readFile(destination, "utf8")).resolves.toBe("{}");

        syncSpy.mockRestore();
        const lease = await stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
        });
        await expect(readFile(destination, "utf8")).resolves.toBe("{}");
        await lease.close();
      } finally {
        syncSpy.mockRestore();
      }
    },
  );

  it("rejects missing, ambiguous, malformed, and unsafe sources", async () => {
    const fixture = await credentialFixture();
    await expect(
      stageManagedCodexCredential({ agentHomeDirectory: fixture.home }),
    ).rejects.toThrow(/credential missing/);
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: {
          OPENAI_API_KEY: "key",
          PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}",
        },
      }),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "[]" },
      }),
    ).rejects.toThrow(/malformed/);

    const source = join(fixture.root, "unsafe-auth.json");
    await writeFile(source, "{}", { mode: 0o644 });
    await chmod(source, 0o644);
    if (process.platform !== "win32") {
      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          sourcePath: source,
        }),
      ).rejects.toThrow(/permissions are unsafe/);
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects a credential home that is not private",
    async () => {
      const fixture = await credentialFixture();
      await chmod(fixture.home, 0o755);

      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          environment: { OPENAI_API_KEY: "launch-only-key" },
        }),
      ).rejects.toThrow(/home permissions are unsafe/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects a symbolic-link source",
    async () => {
      const fixture = await credentialFixture();
      const target = join(fixture.root, "auth-target.json");
      const source = join(fixture.root, "auth-link.json");
      await writeFile(target, "{}", { mode: 0o600 });
      await symlink(target, source);

      await expect(
        stageManagedCodexCredential({
          agentHomeDirectory: fixture.home,
          sourcePath: source,
        }),
      ).rejects.toThrow(/credential missing/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "replaces a stale destination link without touching its target",
    async () => {
      const fixture = await credentialFixture();
      const target = join(fixture.root, "outside.json");
      const destination = join(fixture.home, "auth.json");
      await writeFile(target, '{"outside":true}', { mode: 0o600 });
      await symlink(target, destination);

      const lease = await stageManagedCodexCredential({
        agentHomeDirectory: fixture.home,
        environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: "{}" },
      });
      await expect(readFile(target, "utf8")).resolves.toBe('{"outside":true}');
      expect((await stat(lease.path)).isFile()).toBe(true);
      await lease.close();
    },
  );
});

async function credentialFixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-credential-"));
  temporaryDirectories.push(root);
  const home = join(root, "codex-home");
  await mkdir(home, { mode: 0o700 });
  await chmod(home, 0o700);
  return { root, home };
}

function credentialLeasePorts(home: string): readonly number[] {
  const userScope =
    typeof process.getuid === "function" ? String(process.getuid()) : "win32";
  return credentialLeasePortsForScope(userScope, home);
}

function credentialLeasePortsForScope(
  userScope: string,
  home: string,
): readonly number[] {
  const digest = createHash("sha256")
    .update("paperclip-managed-codex-lease-v2:")
    .update(userScope)
    .update("\0")
    .update(home)
    .digest();
  const start = digest.readUInt16BE(0) % 16_384;
  const step = (digest.readUInt16BE(2) | 1) % 16_384;
  return Array.from(
    { length: 3 },
    (_, index) => 49_152 + ((start + index * step) % 16_384),
  );
}

async function listenSilently(
  port: number,
): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pause();
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(
      {
        exclusive: true,
        host: "127.0.0.1",
        port,
      },
      resolveListen,
    );
  });
  return {
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        });
      });
    },
  };
}

async function waitForChildMessage(
  child: ChildProcess,
  type: string,
): Promise<void> {
  let diagnostic = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-4_096);
  });
  await new Promise<void>((resolveMessage, rejectMessage) => {
    const timeout = setTimeout(() => {
      rejectMessage(new Error(`child message timed out: ${diagnostic}`));
    }, 10_000);
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) rejectMessage(error);
      else resolveMessage();
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message as { type?: unknown }).type === type
      ) {
        finish();
      }
    };
    const onExit = (code: number | null): void => {
      finish(
        new Error(
          `credential owner exited before ${type} (code ${String(code)}): ${diagnostic}`,
        ),
      );
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, rejectExit) => {
    const timeout = setTimeout(
      () => rejectExit(new Error("credential owner exit timed out")),
      10_000,
    );
    child.once("exit", () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}
