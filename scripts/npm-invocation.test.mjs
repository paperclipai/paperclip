import assert from "node:assert/strict";
import test from "node:test";
import { resolveNpmInvocation } from "./npm-invocation.mjs";

test("Windows invokes the real npm CLI through Node with paths containing spaces", () => {
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(resolveNpmInvocation({ platform: "win32", execPath: node, env: { npm_execpath: "C:/tools/pnpm.cjs" }, exists: file => file === cli }), { command: node, argsPrefix: [cli] });
});
test("Windows honors npm_execpath and searches the npm installation on Path", () => {
  const cli = "D:\\npm tools\\node_modules\\npm\\bin\\npm-cli.js";
  for (const env of [{ npm_execpath: cli }, { Path: "D:\\npm tools;C:\\other" }]) {
    assert.deepEqual(resolveNpmInvocation({ platform: "win32", execPath: "C:/node/node.exe", env, exists: file => file === cli }), { command: "C:/node/node.exe", argsPrefix: [cli] });
  }
});
test("a missing Windows npm CLI fails explicitly and POSIX preserves PATH resolution", () => {
  assert.throws(() => resolveNpmInvocation({ platform: "win32", env: {}, exists: () => false }), /Cannot find npm-cli/);
  assert.deepEqual(resolveNpmInvocation({ platform: "linux" }), { command: "npm", argsPrefix: [] });
});
