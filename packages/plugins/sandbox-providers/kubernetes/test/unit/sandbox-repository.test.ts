import { describe, expect, it } from "vitest";
import { realizeSandboxRepository, validateSandboxRepositoryRequest } from "../../src/sandbox-repository.js";

const sha = "0123456789abcdef0123456789abcdef01234567";

describe("sandbox-native repository realization", () => {
  it("clones and verifies the exact detached SHA without using a host workspace", async () => {
    const commands: string[] = [];
    const snapshot = await realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/repo.git", revisionSha: sha },
      execute: async (command) => {
        commands.push(command.join(" "));
        if (commands.length === 1) return { exitCode: 0, stdout: "", stderr: "" };
        return {
          exitCode: 0,
          stdout: `PAPERCLIP_HEAD=${sha}\nPAPERCLIP_STATUS_BEGIN\nPAPERCLIP_STATUS_END\n`,
          stderr: "",
        };
      },
    });

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("git clone --no-checkout");
    expect(commands[0]).toContain("/workspace/repository");
    expect(commands[0]).not.toContain("secret");
    expect(commands[0]).toContain(`checkout --detach '${sha}'`);
    expect(commands.join("\n")).not.toContain("project_primary");
    expect(snapshot).toEqual({
      workspacePath: "/workspace/repository",
      repoUrl: "https://github.com/org/repo.git",
      revisionSha: sha,
      headSha: sha,
      clean: true,
      strategy: "sandbox_repository",
    });
  });

  it("rejects missing repository or non-SHA revisions before executing anything", () => {
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "", revisionSha: sha })).toThrow(/repoUrl/);
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "https://github.com/org/repo.git", revisionSha: "main" })).toThrow(/exact 40-character/);
  });

  it("fails closed before clone when credentials are required but unbound", () => {
    expect(() => validateSandboxRepositoryRequest({
      repoUrl: "https://github.com/org/private.git",
      revisionSha: sha,
      credentialRequired: true,
    })).toThrow(/explicit read-only Git credential binding/);
  });

  it("creates loader directories before Git and keeps public clones credential-free", async () => {
    const commands: string[] = [];
    await realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/public.git", revisionSha: sha },
      execute: async (command) => {
        commands.push(command.join(" "));
        return commands.length === 1
          ? { exitCode: 0, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: `PAPERCLIP_HEAD=${sha}\nPAPERCLIP_STATUS_BEGIN\nPAPERCLIP_STATUS_END\n`, stderr: "" };
      },
    });
    expect(commands[0]).toContain("mkdir -p /home/loader/tmp /home/loader/.config");
    expect(commands[0]).toContain("git clone --no-checkout");
    expect(commands[0]).not.toContain("GIT_ASKPASS");
  });

  it("fails on a real SHA mismatch", async () => {
    await expect(realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/repo.git", revisionSha: sha },
      execute: async (command) => command.join(" ").includes("rev-parse")
        ? { exitCode: 0, stdout: `PAPERCLIP_HEAD=${"fedcba9876543210fedcba9876543210fedcba98"}\nPAPERCLIP_STATUS_BEGIN\nPAPERCLIP_STATUS_END\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    })).rejects.toThrow(/did not match/);
  });

  it("supports private auth without placing credentials in the URL or output", async () => {
    const error = await realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/repo.git", revisionSha: sha, credentialRequired: true, credentialSecretName: "git-read-only" },
      execute: async () => ({ exitCode: 128, stdout: "token=secret", stderr: "fatal: https://user:secret@github.com/org/repo.git?token=secret#frag" }),
    }).catch((err: unknown) => err as Error);
    expect(error.message).toContain("during Git preparation");
    expect(error.message).not.toMatch(/user|secret|token|\?|#/i);

    const snapshot = await realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/repo.git", revisionSha: sha, credentialRequired: true, credentialSecretName: "git-read-only" },
      execute: async (command) => command.join(" ").includes("rev-parse")
        ? { exitCode: 0, stdout: `PAPERCLIP_HEAD=${sha}\nPAPERCLIP_STATUS_BEGIN\nPAPERCLIP_STATUS_END\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/user|secret|token|[?#]/i);
  });

  it("rejects invalid URLs and caller-controlled workspace paths", () => {
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "http://github.com/org/repo.git", revisionSha: sha })).toThrow(/approved HTTPS Git URL/);
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "https://github.com/org/repo.git?token=secret", revisionSha: sha })).toThrow(/without credentials/);
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "https://github.com/org/repo.git", revisionSha: sha, workspacePath: "/tmp/repo" })).toThrow(/fixed \/workspace\/repository/);
    expect(() => validateSandboxRepositoryRequest({ repoUrl: "https://github.com/org/repo.git", revisionSha: sha, workspacePath: "/workspace" })).toThrow(/fixed \/workspace\/repository/);
  });

  it("fails on a dirty checkout", async () => {
    await expect(realizeSandboxRepository({
      request: { repoUrl: "https://github.com/org/repo.git", revisionSha: sha },
      execute: async (command) => command.join(" ").includes("rev-parse")
        ? { exitCode: 0, stdout: `PAPERCLIP_HEAD=${sha}\nPAPERCLIP_STATUS_BEGIN\n M file\nPAPERCLIP_STATUS_END\n`, stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" },
    })).rejects.toThrow(/not clean/);
  });
});
