import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { azureDevOpsGitInvocation } from "./git-auth.js";

describe("Azure DevOps Git credentials", () => {
  const url = "https://dev.azure.com/org/project/_git/repo";
  it("only supplies a PAT for the exact authorized repository", () => {
    const auth = azureDevOpsGitInvocation(url, { kind: "pat", token: "test-token" });
    const fill = (path: string) => {
      try {
        return execFileSync("git", ["credential", "fill"], { cwd: os.tmpdir(), input: `protocol=https\nhost=dev.azure.com\npath=${path}\n\n`, env: { ...process.env, ...auth.env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
      } catch { return ""; }
    };
    expect(fill("org/project/_git/repo")).toContain("password=test-token");
    expect(fill("other/project/_git/repo")).toBe("");
    expect(fill("org/project/_git/other")).toBe("");
    expect(auth.env.GIT_ASKPASS).toBe("");
    expect(auth.env.SSH_ASKPASS).toBe("");
    expect(JSON.stringify(auth.configArgs)).not.toContain("test-token");
  });
  it("rejects credentialed, cross-host and unsafe remotes", () => {
    for (const remote of ["https://evil.example/org/project/_git/repo", "http://dev.azure.com/org/project/_git/repo", "https://user:secret@dev.azure.com/org/project/_git/repo", "https://dev.azure.com/org/project/_git/repo?token=x"]) {
      expect(() => azureDevOpsGitInvocation(remote, { kind: "pat", token: "test-token" })).toThrow();
    }
  });
  it("authenticates repository names with escaped spaces", () => {
    const auth = azureDevOpsGitInvocation("https://dev.azure.com/org/My%20Project/_git/Source%20Repo", { kind: "pat", token: "test-token" });
    const result = execFileSync("git", ["credential", "fill"], { cwd: os.tmpdir(), input: "url=https://dev.azure.com/org/My%20Project/_git/Source%20Repo\n\n", env: { ...process.env, ...auth.env }, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    expect(result).toContain("password=test-token");
  });
  it("scopes an Entra bearer header to the configured remote", () => {
    const auth = azureDevOpsGitInvocation(url, { kind: "entra", token: "test-entra" });
    const read = (target: string) => {
      try { return execFileSync("git", ["config", "--get-urlmatch", "http.extraheader", target], { cwd: os.tmpdir(), env: { ...process.env, ...auth.env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
      catch { return ""; }
    };
    expect(read(url)).toBe("AUTHORIZATION: bearer test-entra");
    expect(read("https://dev.azure.com/other/project/_git/repo")).toBe("");
    expect(read("https://evil.example/org/project/_git/repo")).toBe("");
    expect(JSON.stringify(auth.configArgs)).not.toContain("test-entra");
  });
  it("scopes an Entra bearer header to a remote with escaped spaces", () => {
    const remote = "https://dev.azure.com/org/My%20Project/_git/Source%20Repo";
    const auth = azureDevOpsGitInvocation(remote, { kind: "entra", token: "test-entra" });
    const value = execFileSync("git", ["config", "--get-urlmatch", "http.extraheader", remote], { cwd: os.tmpdir(), env: { ...process.env, ...auth.env }, encoding: "utf8" }).trim();
    expect(value).toBe("AUTHORIZATION: bearer test-entra");
  });
  it("does not forward an Entra token when Git rewrites the remote to another host", async () => {
    let received: string | undefined;
    let visited = false;
    const server = createServer((request, response) => { visited = true; received = request.headers.authorization; response.writeHead(404).end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No local port");
      const auth = azureDevOpsGitInvocation(url, { kind: "entra", token: "test-entra" });
      await promisify(execFile)("git", ["-c", `url.http://127.0.0.1:${address.port}/.insteadOf=https://dev.azure.com/`, "ls-remote", url], { cwd: os.tmpdir(), env: { ...process.env, ...auth.env }, timeout: 10000 }).catch(() => undefined);
      expect(visited).toBe(true);
      expect(received).toBeUndefined();
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
