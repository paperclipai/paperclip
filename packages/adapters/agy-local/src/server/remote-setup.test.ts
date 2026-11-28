import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRemoteMcpHomeSetupCommand,
  copyBackAgyConversationState,
} from "./remote-setup.js";

describe("buildRemoteMcpHomeSetupCommand", () => {
  const base = {
    isolatedHomeDir: "/run/root/home",
    isolatedConfigDir: "/run/root/home/.gemini/config",
    stagedMcpFile: "/run/root/mcp-config/mcp_config.json",
    targetMcpConfig: "/run/root/home/.gemini/config/mcp_config.json",
    realGeminiDir: "/home/user/.gemini",
    realConfigDir: "/home/user/.gemini/config",
  };

  it("quotes paths so $ and backticks stay literal", () => {
    const cmd = buildRemoteMcpHomeSetupCommand({
      ...base,
      realGeminiDir: "/home/$(whoami)/.gemini",
      realConfigDir: "/home/`whoami`/.gemini/config",
    });
    // The dangerous characters must appear only inside single quotes.
    expect(cmd).toContain("'/home/$(whoami)/.gemini/antigravity-cli'");
    expect(cmd).toContain("'/home/`whoami`/.gemini/config'");
    expect(cmd).not.toContain('"/home/$(whoami)');
    expect(cmd).not.toContain('"/home/`whoami`');
  });

  it("keeps the mkdir/ln/cp structure for a plain home", () => {
    const cmd = buildRemoteMcpHomeSetupCommand(base);
    expect(cmd).toContain("mkdir -p '/run/root/home/.gemini/config'");
    expect(cmd).toContain(
      "ln -s '/home/user/.gemini/antigravity-cli' '/run/root/home/.gemini/antigravity-cli'",
    );
    expect(cmd).toContain(
      "cp -a '/run/root/mcp-config/mcp_config.json' '/run/root/home/.gemini/config/mcp_config.json'",
    );
    expect(cmd).toContain("for e in '/home/user/.gemini/config'/*");
  });

  it("omits the link loop when there is no real home", () => {
    const cmd = buildRemoteMcpHomeSetupCommand({
      ...base,
      realGeminiDir: null,
      realConfigDir: null,
    });
    expect(cmd).not.toContain("ln -s");
    expect(cmd).toContain("cp -a '/run/root/mcp-config/mcp_config.json'");
  });

  it("escapes an embedded single quote", () => {
    const cmd = buildRemoteMcpHomeSetupCommand({
      ...base,
      realGeminiDir: "/home/o'brien/.gemini",
      realConfigDir: null,
    });
    expect(cmd).toContain(`'/home/o'"'"'brien/.gemini/antigravity-cli'`);
  });
});

describe("copyBackAgyConversationState", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-copyback-brain-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  // The "remote" is a local temp dir standing in for the staged asset dir.
  // The fake runRemoteCommand records the command and writes the manifest
  // the real `find` would produce (NUL-joined ./relative entries); the fake
  // readFile serves files out of the fake remote dir.
  function makeFakeRemote(remoteAssetDir: string) {
    const commands: string[] = [];
    const readFile = async (remotePath: string): Promise<Buffer> => {
      const local = path.join(remoteAssetDir, path.posix.relative("/remote/asset", remotePath));
      try {
        return await fs.promises.readFile(local);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") throw Object.assign(new Error("not found"), { code: "ENOENT" });
        throw error;
      }
    };
    const runRemoteCommand = async (command: string) => {
      commands.push(command);
      // Simulate the real remote command: walk the fake remote brain dir
      // and write NUL-joined "<size>\t./relative" records.
      const brainDir = path.join(remoteAssetDir, "brain");
      const records: string[] = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        let names: string[] = [];
        try {
          names = await fs.promises.readdir(dir);
        } catch {
          return;
        }
        for (const name of names) {
          const full = path.join(dir, name);
          const relPath = rel ? `${rel}/${name}` : name;
          const stat = await fs.promises.stat(full);
          if (stat.isDirectory()) await walk(full, relPath);
          else records.push(`${stat.size}\t./${relPath}`);
        }
      };
      await walk(brainDir, "");
      await fs.promises.writeFile(
        path.join(remoteAssetDir, ".paperclip-brain-manifest"),
        records.join("\0"),
      );
      return { exitCode: 0 as number | null };
    };
    return { commands, readFile, runRemoteCommand };
  }

  it("copies the remote brain/ tree back to the host CLI home", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    for (const [conv, file, content] of [
      ["conv-1", "session.json", JSON.stringify({ turns: 3 })],
      ["conv-2", "notes.txt", "hello"],
    ] as const) {
      const dir = path.join(remoteAssetDir, "brain", conv);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), content);
    }
    const fake = makeFakeRemote(remoteAssetDir);

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: fake.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
    });

    expect(fs.readFileSync(path.join(hostCliHome, "brain", "conv-1", "session.json"), "utf8")).toBe(
      JSON.stringify({ turns: 3 }),
    );
    expect(fs.readFileSync(path.join(hostCliHome, "brain", "conv-2", "notes.txt"), "utf8")).toBe("hello");
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toContain("find . -type f -exec sh -c");
    expect(fake.commands[0]).toContain("wc -c");
    expect(fake.commands[0]).toContain("head -c");
    expect(fake.commands[0]).toContain("'/remote/asset/brain'");
  });

  it("is a no-op when the remote has no brain/ directory", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const fake = makeFakeRemote(remoteAssetDir);
    // The real `[ -d brain ]` guard means no manifest is produced; simulate
    // that by using a runRemoteCommand that records but writes nothing.
    const noManifest = {
      ...fake,
      runRemoteCommand: async (command: string) => {
        fake.commands.push(command);
        return { exitCode: 0 as number | null };
      },
    };

    await expect(
      copyBackAgyConversationState({
        assetDir: "/remote/asset",
        hostCliHomeDir: hostCliHome,
        runRemoteCommand: noManifest.runRemoteCommand,
        readFile: fake.readFile,
        log: () => {},
      }),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(hostCliHome, "brain"))).toBe(false);
  });

  it("rejects manifest entries that escape brain/", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const dir = path.join(remoteAssetDir, "brain", "conv-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.json"), "ok");
    const fake = makeFakeRemote(remoteAssetDir);
    // Override the manifest with hostile entries alongside the good one.
    const hostile = {
      ...fake,
      runRemoteCommand: async (command: string) => {
        fake.commands.push(command);
        await fs.promises.writeFile(
          path.join(remoteAssetDir, ".paperclip-brain-manifest"),
          ["2\t./conv-1/session.json", "9\t../evil.txt", "9\t/abs/path.txt", "9\t./../escape.txt", ""].join("\0"),
        );
        return { exitCode: 0 as number | null };
      },
    };

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: hostile.runRemoteCommand,
      readFile: async (remotePath: string) => {
        if (remotePath.endsWith("evil.txt") || remotePath.endsWith("escape.txt") || remotePath.endsWith("path.txt")) {
          throw new Error("must not read outside brain/");
        }
        return fake.readFile(remotePath);
      },
      log: () => {},
    });

    expect(fs.readFileSync(path.join(hostCliHome, "brain", "conv-1", "session.json"), "utf8")).toBe("ok");
    expect(fs.existsSync(path.join(hostCliHome, "evil.txt"))).toBe(false);
    expect(fs.existsSync(path.join(hostCliHome, "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(hostCliHome, "abs", "path.txt"))).toBe(false);
  });

  it("never throws when the remote command fails", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const fake = makeFakeRemote(remoteAssetDir);

    await expect(
      copyBackAgyConversationState({
        assetDir: "/remote/asset",
        hostCliHomeDir: hostCliHome,
        runRemoteCommand: async () => ({ exitCode: 1 as number | null }),
        readFile: fake.readFile,
        log: () => {},
      }),
    ).resolves.toBeUndefined();
  });

  it("respects the file-count bound", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    for (const conv of ["conv-1", "conv-2", "conv-3"]) {
      const dir = path.join(remoteAssetDir, "brain", conv);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "session.json"), conv);
    }
    const fake = makeFakeRemote(remoteAssetDir);

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: fake.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
      limits: { maxFiles: 2 },
    });

    const copied = fs
      .readdirSync(path.join(hostCliHome, "brain"))
      .sort();
    expect(copied).toHaveLength(2);
  });

  // The manifest carries each file's declared size, so the copy-back can
  // enforce the byte limits BEFORE downloading anything. The fake remote
  // below writes the sized manifest the real remote command produces.
  function makeFakeRemoteWithSizes(remoteAssetDir: string) {
    const commands: string[] = [];
    const readCalls: string[] = [];
    const base = makeFakeRemote(remoteAssetDir);
    const runRemoteCommand = async (command: string) => {
      commands.push(command);
      const brainDir = path.join(remoteAssetDir, "brain");
      const records: string[] = [];
      const walk = async (dir: string, rel: string): Promise<void> => {
        let names: string[] = [];
        try {
          names = await fs.promises.readdir(dir);
        } catch {
          return;
        }
        for (const name of names) {
          const full = path.join(dir, name);
          const relPath = rel ? `${rel}/${name}` : name;
          const stat = await fs.promises.stat(full);
          if (stat.isDirectory()) await walk(full, relPath);
          else records.push(`${stat.size}\t./${relPath}`);
        }
      };
      await walk(brainDir, "");
      await fs.promises.writeFile(
        path.join(remoteAssetDir, ".paperclip-brain-manifest"),
        records.join("\0"),
      );
      return { exitCode: 0 as number | null };
    };
    const readFile = async (remotePath: string): Promise<Buffer> => {
      readCalls.push(remotePath);
      return base.readFile(remotePath);
    };
    return { commands, readCalls, readFile, runRemoteCommand };
  }

  it("skips a remote file whose declared size exceeds maxFileBytes without downloading it", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const dir = path.join(remoteAssetDir, "brain", "conv-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "big.bin"), "x".repeat(100));
    fs.writeFileSync(path.join(dir, "small.txt"), "ok");
    const fake = makeFakeRemoteWithSizes(remoteAssetDir);

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: fake.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
      limits: { maxFileBytes: 10 },
    });

    expect(fs.readFileSync(path.join(hostCliHome, "brain", "conv-1", "small.txt"), "utf8")).toBe("ok");
    expect(fs.existsSync(path.join(hostCliHome, "brain", "conv-1", "big.bin"))).toBe(false);
    expect(fake.readCalls.filter((call) => call.endsWith("big.bin"))).toHaveLength(0);
  });

  it("stops at the total size limit using declared sizes, without downloading the rest", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    for (const [conv, file] of [["conv-1", "a.json"], ["conv-2", "b.json"]] as const) {
      const dir = path.join(remoteAssetDir, "brain", conv);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), "x".repeat(60));
    }
    const fake = makeFakeRemoteWithSizes(remoteAssetDir);

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: fake.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
      limits: { maxFileBytes: 1000, maxTotalBytes: 100 },
    });

    expect(fs.existsSync(path.join(hostCliHome, "brain", "conv-1", "a.json"))).toBe(true);
    expect(fs.existsSync(path.join(hostCliHome, "brain", "conv-2", "b.json"))).toBe(false);
    expect(fake.readCalls.filter((call) => call.endsWith("b.json"))).toHaveLength(0);
  });

  it("ignores a manifest record with no usable size", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const dir = path.join(remoteAssetDir, "brain", "conv-1");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "session.json"), "ok");
    const fake = makeFakeRemoteWithSizes(remoteAssetDir);
    const malformed = {
      ...fake,
      runRemoteCommand: async (command: string) => {
        fake.commands.push(command);
        await fs.promises.writeFile(
          path.join(remoteAssetDir, ".paperclip-brain-manifest"),
          ["not-a-size\t./conv-1/session.json", "2\t./conv-1/session.json"].join("\0"),
        );
        return { exitCode: 0 as number | null };
      },
    };

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: malformed.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
    });

    expect(fs.readFileSync(path.join(hostCliHome, "brain", "conv-1", "session.json"), "utf8")).toBe("ok");
  });

  it("bounds the remote manifest with head -c", async () => {
    const remoteAssetDir = makeTmpDir();
    const hostCliHome = makeTmpDir();
    const fake = makeFakeRemoteWithSizes(remoteAssetDir);

    await copyBackAgyConversationState({
      assetDir: "/remote/asset",
      hostCliHomeDir: hostCliHome,
      runRemoteCommand: fake.runRemoteCommand,
      readFile: fake.readFile,
      log: () => {},
      limits: { maxFiles: 2 },
    });

    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toContain("head -c 1024");
  });
});
