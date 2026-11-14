import { afterEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({ command: "" }));
vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  ensureCommandResolvable: vi.fn(async () => {}),
  resolveCommandForLogs: vi.fn(async () => mocks.command),
}));
vi.mock("../vendor/paperclip-runner/index.js", () => ({ resolveCodexCommand: vi.fn() }));
import { startLocalBrowserLogin, type LocalBrowserLoginState } from "./local-ai-browser-login.js";
import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";

let root: string | undefined;
let login: LocalBrowserLoginState | undefined;
afterEach(async () => {
  await login?.abort();
  if (root) await rm(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== "win32")("runs a terminal-only Claude fixture through real Windows ConPTY", async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "claude-conpty-")));
  const cli = path.join(root, "Claude's CLI");
  const home = path.join(root, "login");
  await mkdir(cli);
  await mkdir(home);
  const script = path.join(cli, "fixture.cjs");
  const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
  const token = "sk-ant-oat01-AAAABBBBCCCCDDDDEEEE11112222FFFFGGGG_HHHH-IIII";
  await writeFile(script, `
if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv[2] !== 'setup-token') process.exit(42);
process.stdin.setRawMode(true);
process.stdout.write(${JSON.stringify("Browser didn't open? Use the url below to sign in (c to copy)\r\n" + url + "\r\nPaste code here if prompted >\r\n")});
let input = '';
process.stdin.on('data', bytes => {
  input += bytes.toString('utf8');
  if (!input.includes('\\r')) return;
  if (input !== 'synthetic-browser-code\\r') process.exit(43);
  process.stdout.write(${JSON.stringify("Your OAuth token (valid for 1 year):\r\n" + token + "\r\nStore this token securely. You won't be able to see it again.\r\n")}, () => process.exit(0));
});
`);
  mocks.command = path.join(cli, "claude.cmd");
  await writeFile(mocks.command, `@"${process.execPath}" "${script}" %*\r\n`);
  login = startLocalBrowserLogin("anthropic", home);
  await vi.waitFor(() => expect(login?.authorizationUrl).toBe(url), { timeout: 10_000 });
  login.submitCode!("synthetic-browser-code");
  await vi.waitFor(() => expect(login?.outcome).toBe("success"), { timeout: 10_000 });
  expect(JSON.parse(await readLocalAiCredentialFile(path.join(home, ".credentials.json"))))
    .toEqual({ claudeAiOauth: { accessToken: token } });
}, 30_000);
