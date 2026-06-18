import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSymlink, prepareManagedCodexHome } from "./codex-home.js";

type CodexHomePaths = {
  root: string;
  sharedCodexHome: string;
  paperclipHome: string;
  managedCodexHome: string;
  sharedAuth: string;
  managedAuth: string;
};

async function makeCodexHomePaths(companyId = "company-1"): Promise<CodexHomePaths> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-home-"));
  const sharedCodexHome = path.join(root, "shared-codex-home");
  const paperclipHome = path.join(root, "paperclip-home");
  const managedCodexHome = path.join(
    paperclipHome,
    "instances",
    "default",
    "companies",
    companyId,
    "codex-home",
  );
  return {
    root,
    sharedCodexHome,
    paperclipHome,
    managedCodexHome,
    sharedAuth: path.join(sharedCodexHome, "auth.json"),
    managedAuth: path.join(managedCodexHome, "auth.json"),
  };
}

function envFor(paths: CodexHomePaths): NodeJS.ProcessEnv {
  return {
    CODEX_HOME: paths.sharedCodexHome,
    PAPERCLIP_HOME: paths.paperclipHome,
    PAPERCLIP_INSTANCE_ID: "default",
  };
}

async function makeAuthFile(filePath: string, contents: string, mtime: Date): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
  await fs.utimes(filePath, mtime, mtime);
}

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
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");

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
    await fs.writeFile(sharedAuth, '{"token":"shared"}\n', "utf8");
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

  it("prepareManagedCodexHome restores symlink and writes back a newer detached auth.json", async () => {
    const paths = await makeCodexHomePaths();
    const logs: Array<{ stream: "stdout" | "stderr"; message: string }> = [];

    try {
      await makeAuthFile(paths.sharedAuth, '{"token":"source"}\n', new Date("2026-01-01T00:00:00.000Z"));
      await makeAuthFile(paths.managedAuth, '{"token":"rotated"}\n', new Date("2026-01-01T00:01:00.000Z"));

      await expect(
        prepareManagedCodexHome(
          envFor(paths),
          async (stream, message) => {
            logs.push({ stream, message });
          },
          "company-1",
        ),
      ).resolves.toBe(paths.managedCodexHome);

      expect((await fs.lstat(paths.managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(paths.managedAuth)).toBe(await fs.realpath(paths.sharedAuth));
      expect(await fs.readFile(paths.sharedAuth, "utf8")).toBe('{"token":"rotated"}\n');
      expect(logs.some(({ stream, message }) =>
        stream === "stdout" &&
        message.includes("Restored auth.json symlink (target was detached regular file; wrote rotated token back to source)")
      )).toBe(true);
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  });

  it("prepareManagedCodexHome restores symlink without write-back when detached auth.json is older", async () => {
    const paths = await makeCodexHomePaths();
    const logs: Array<{ stream: "stdout" | "stderr"; message: string }> = [];

    try {
      await makeAuthFile(paths.sharedAuth, '{"token":"source-newer"}\n', new Date("2026-01-01T00:01:00.000Z"));
      await makeAuthFile(paths.managedAuth, '{"token":"stale-target"}\n', new Date("2026-01-01T00:00:00.000Z"));

      await prepareManagedCodexHome(
        envFor(paths),
        async (stream, message) => {
          logs.push({ stream, message });
        },
        "company-1",
      );

      expect((await fs.lstat(paths.managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(paths.managedAuth)).toBe(await fs.realpath(paths.sharedAuth));
      expect(await fs.readFile(paths.sharedAuth, "utf8")).toBe('{"token":"source-newer"}\n');
      expect(logs.some(({ message }) => message.includes("wrote rotated token back to source"))).toBe(false);
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  });

  it("prepareManagedCodexHome leaves a correct auth.json symlink untouched", async () => {
    const paths = await makeCodexHomePaths();
    const logs: Array<{ stream: "stdout" | "stderr"; message: string }> = [];

    try {
      await fs.mkdir(paths.sharedCodexHome, { recursive: true });
      await fs.mkdir(paths.managedCodexHome, { recursive: true });
      await fs.writeFile(paths.sharedAuth, '{"token":"shared"}\n', "utf8");
      await fs.symlink(paths.sharedAuth, paths.managedAuth);
      const beforeLink = await fs.readlink(paths.managedAuth);

      await prepareManagedCodexHome(
        envFor(paths),
        async (stream, message) => {
          logs.push({ stream, message });
        },
        "company-1",
      );

      expect((await fs.lstat(paths.managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(paths.managedAuth)).toBe(beforeLink);
      expect(await fs.readFile(paths.sharedAuth, "utf8")).toBe('{"token":"shared"}\n');
      expect(logs.some(({ message }) => message.includes("wrote rotated token back to source"))).toBe(false);
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
    }
  });

  it("prepareManagedCodexHome concurrent invocations do not corrupt rotated auth.json write-back", async () => {
    const paths = await makeCodexHomePaths();

    try {
      await makeAuthFile(paths.sharedAuth, '{"token":"source"}\n', new Date("2026-01-01T00:00:00.000Z"));
      await makeAuthFile(paths.managedAuth, '{"token":"rotated"}\n', new Date("2026-01-01T00:01:00.000Z"));

      await Promise.all([
        prepareManagedCodexHome(envFor(paths), async () => {}, "company-1"),
        prepareManagedCodexHome(envFor(paths), async () => {}, "company-1"),
      ]);

      expect((await fs.lstat(paths.managedAuth)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(paths.managedAuth)).toBe(await fs.realpath(paths.sharedAuth));
      expect(await fs.readFile(paths.sharedAuth, "utf8")).toBe('{"token":"rotated"}\n');
    } finally {
      await fs.rm(paths.root, { recursive: true, force: true });
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
      await fs.utimes(
        sharedAuth,
        new Date("2026-01-01T00:01:00.000Z"),
        new Date("2026-01-01T00:01:00.000Z"),
      );

      // Simulate a stale copy left by a previous Paperclip version.
      await fs.mkdir(managedCodexHome, { recursive: true });
      await fs.writeFile(managedAuth, '{"token":"stale-from-copy"}', "utf8");
      await fs.utimes(
        managedAuth,
        new Date("2026-01-01T00:00:00.000Z"),
        new Date("2026-01-01T00:00:00.000Z"),
      );

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
