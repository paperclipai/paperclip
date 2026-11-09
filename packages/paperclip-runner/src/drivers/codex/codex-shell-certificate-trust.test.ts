import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIsolatedCodexAppServerArgs } from "./codex-security-config.js";
import { createSanitizedCodexEnvironment } from "./app-server-transport.js";

const execFileAsync = promisify(execFile);
const gitBinary = existsSync("/usr/bin/git") ? "/usr/bin/git" : "git";
const toolsAvailable = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore", timeout: 10_000 });
    execFileSync(gitBinary, ["--version"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

/** Codex applies the configured policy to the app-server's own environment:
 * `inherit` seeds the shell environment, `include_only` filters it by name,
 * and `set` entries override afterwards (also bounded by `include_only`). */
function shellEnvironmentFromPolicy(
  args: string[],
  appServerEnvironment: NodeJS.ProcessEnv,
): Record<string, string> {
  const serialized = args.join("\n");
  expect(serialized).toContain('shell_environment_policy.inherit="all"');
  const includeOnlySetting = args.find((value) =>
    value.startsWith("shell_environment_policy.include_only="),
  )!;
  const includeOnly = new Set<string>(
    JSON.parse(includeOnlySetting.slice(includeOnlySetting.indexOf("=") + 1)),
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(appServerEnvironment)) {
    if (value !== undefined && includeOnly.has(key)) environment[key] = value;
  }
  const setSetting = args.find((value) =>
    value.startsWith("shell_environment_policy.set={"),
  );
  if (setSetting) {
    const body = setSetting.slice("shell_environment_policy.set={".length, -1);
    for (const match of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*")/g)) {
      if (includeOnly.has(match[1]!)) environment[match[1]!] = JSON.parse(match[2]!) as string;
    }
  }
  return environment;
}

describe.skipIf(!toolsAvailable)("Codex shell certificate trust (synthetic private-CA journey)", () => {
  let root: string;
  let caCertificatePath: string;
  let server: Server;
  let remoteUrl: string;
  let launchEnvironment: NodeJS.ProcessEnv;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-ca-trust-"));
    const home = join(root, "home");
    mkdirSync(home);
    const setupEnvironment = { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: "1" };

    // Synthetic private CA and a 127.0.0.1 server certificate signed by it.
    caCertificatePath = join(root, "ca.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "2", "-nodes",
      "-keyout", join(root, "ca.key"), "-out", caCertificatePath, "-subj", "/CN=paperclip-test-ca"], { stdio: "ignore" });
    execFileSync("openssl", ["req", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", join(root, "server.key"), "-out", join(root, "server.csr"), "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
    writeFileSync(join(root, "ext.cnf"), "subjectAltName=IP:127.0.0.1\n");
    execFileSync("openssl", ["x509", "-req", "-in", join(root, "server.csr"), "-CA", caCertificatePath,
      "-CAkey", join(root, "ca.key"), "-CAcreateserial", "-out", join(root, "server.pem"), "-days", "2",
      "-sha256", "-extfile", join(root, "ext.cnf")], { stdio: "ignore" });

    // A bare repository served over the dumb HTTP protocol.
    const work = join(root, "work");
    execFileSync(gitBinary, ["init", work], { env: setupEnvironment, stdio: "ignore" });
    execFileSync(gitBinary, ["-C", work, "-c", "user.email=test@example.invalid", "-c", "user.name=test",
      "commit", "--allow-empty", "-m", "fixture"], { env: setupEnvironment, stdio: "ignore" });
    const bare = join(root, "repo.git");
    execFileSync(gitBinary, ["clone", "--bare", work, bare], { env: setupEnvironment, stdio: "ignore" });
    execFileSync(gitBinary, ["--git-dir", bare, "update-server-info"], { env: setupEnvironment, stdio: "ignore" });

    server = createServer(
      { key: readFileSync(join(root, "server.key")), cert: readFileSync(join(root, "server.pem")) },
      (request, response) => {
        const path = normalize((request.url ?? "/").split("?")[0]!);
        if (!path.startsWith("/repo.git/") || path.includes("..")) {
          response.writeHead(404).end();
          return;
        }
        try {
          const body = readFileSync(join(bare, path.slice("/repo.git/".length)));
          response.writeHead(200, { "content-type": "text/plain" }).end(body);
        } catch {
          response.writeHead(404).end();
        }
      },
    );
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    remoteUrl = `https://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/repo.git`;
    launchEnvironment = {
      PATH: process.env.PATH,
      PAPERCLIP_GITHUB_AUTH_MODE: "host",
      PAPERCLIP_GITHUB_HOST_HOME: home,
    };
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolveClose) => server?.close(() => resolveClose()));
    rmSync(root, { recursive: true, force: true });
  });

  it("fails TLS verification when the shell environment carries no CA trust", async () => {
    const args = createIsolatedCodexAppServerArgs(launchEnvironment);
    const untrusted = shellEnvironmentFromPolicy(args, createSanitizedCodexEnvironment(launchEnvironment));
    const result = await execFileAsync(gitBinary, ["ls-remote", remoteUrl], {
      env: untrusted, timeout: 30_000,
    }).catch((error: Error & { stderr?: string; code?: number }) => error);
    expect(result).toBeInstanceOf(Error);
    expect(String((result as { stderr?: string }).stderr ?? "")).toMatch(/SSL|certificate|CA/i);
  }, 60_000);

  it("verifies TLS through git when the sandbox injects CA trust after policy construction", async () => {
    // The policy is constructed from the launch environment, which carries no
    // CA variables. The sandbox injects them into the execution environment
    // afterwards; the shell policy must still let them through by name.
    const args = createIsolatedCodexAppServerArgs(launchEnvironment);
    const injectedEnvironment = {
      ...createSanitizedCodexEnvironment(launchEnvironment),
      GIT_SSL_CAINFO: caCertificatePath,
      SSL_CERT_FILE: caCertificatePath,
    };
    const shellEnvironment = shellEnvironmentFromPolicy(args, injectedEnvironment);
    expect(shellEnvironment.GIT_SSL_CAINFO).toBe(caCertificatePath);
    expect(shellEnvironment.SSL_CERT_FILE).toBe(caCertificatePath);
    const { stdout } = await execFileAsync(gitBinary, ["ls-remote", remoteUrl], {
      env: shellEnvironment, timeout: 30_000,
    });
    expect(stdout).toContain("refs/heads/");
  }, 60_000);
});
