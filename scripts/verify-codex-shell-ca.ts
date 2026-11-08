import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { codexShellEnvironmentKeys } from "../packages/adapter-utils/src/codex-shell-environment.js";
import { createIsolatedCodexAppServerArgs } from "../packages/paperclip-runner/src/drivers/codex/codex-security-config.js";
import { createSanitizedCodexEnvironment } from "../packages/paperclip-runner/src/drivers/codex/app-server-transport.js";

const run = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "paperclip-shell-ca-"));
let server: ReturnType<typeof createServer> | undefined;
try {
  const certificate = join(directory, "ca.pem");
  const privateKey = join(directory, "key.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-keyout", privateKey, "-out", certificate]);
  await run("git", ["init", "--bare", join(directory, "repo.git")]);
  await run("git", ["--git-dir", join(directory, "repo.git"), "update-server-info"]);
  server = createServer({ key: await readFile(privateKey), cert: await readFile(certificate) }, async (request, response) => {
    if (request.url?.startsWith("/api/v3/")) {
      response.setHeader("content-type", "application/json");
      response.end('{"trusted":true}');
      return;
    }
    const path = request.url?.split("?")[0];
    if (path === "/repo.git/info/refs" || path === "/repo.git/HEAD") {
      response.end(await readFile(join(directory, path)));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const host = `localhost:${address.port}`;
  const nativeArgs = createIsolatedCodexAppServerArgs({});
  const nativeKeys = JSON.parse(nativeArgs.find(arg => arg.startsWith("shell_environment_policy.include_only="))!.split("=", 2)[1]!);
  const legacyKeys = codexShellEnvironmentKeys({}, {}, false);
  const injected = { SSL_CERT_FILE: certificate, GIT_SSL_CAINFO: certificate, HOST_SECRET: "unselected", OPENAI_API_KEY: "unselected-provider" };
  const environment = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", NO_PROXY: "localhost", GH_ENTERPRISE_TOKEN: "fixture-token", GH_CONFIG_DIR: directory };
  const commands = [["git", ["ls-remote", `https://${host}/repo.git`]], ["gh", ["api", "--hostname", host, "/probe"]]] as const;
  for (const keys of [legacyKeys, nativeKeys]) {
    const runtime = keys === nativeKeys ? createSanitizedCodexEnvironment(injected) : injected;
    const shell = Object.fromEntries(Object.entries(runtime).filter(([key]) => keys.includes(key)));
    assert.equal(shell.HOST_SECRET, undefined);
    assert.equal(shell.OPENAI_API_KEY, undefined);
    for (const [command, args] of commands) {
      await assert.rejects(run(command, [...args], { env: environment, timeout: 10_000 }), error => /certificate|issuer|authority/i.test(String(error)));
      await run(command, [...args], { env: { ...environment, ...shell }, timeout: 10_000 });
    }
  }
  process.stdout.write("Legacy and native policies preserve sandbox CA trust for git and gh.\n");
} finally {
  if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
  await rm(directory, { force: true, recursive: true });
}
