import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRt2IdentityGate } from "./rt2-identity-gate.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "rt2-identity-gate-"));
  mkdirSync(join(root, "ui", "src", "components"), { recursive: true });
  mkdirSync(join(root, "ui", "public"), { recursive: true });
  return root;
}

function run(root, targets = ["ui/src/components"]) {
  const output = [];
  const errors = [];
  const code = runRt2IdentityGate({
    cwd: root,
    targets,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });
  return { code, output, errors };
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "ui", "src", "components", "Clean.tsx"),
    'export function Clean() { return <div>RealTycoon2 보조 근거를 불러오는 중입니다.</div>; }\n',
  );

  const result = run(root);
  assert.equal(result.code, 0);
  assert.match(result.output.join("\n"), /passed/);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "ui", "src", "components", "Legacy.tsx"),
    'export function Legacy() { return <div>Paper Company dashboard</div>; }\n',
  );

  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /legacy-product-name/);
  assert.match(result.errors.join("\n"), /Paper Company/);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "ui", "src", "components", "EnglishDefault.tsx"),
    'export function EnglishDefault() { return <div>Loading graph... No graph data available.</div>; }\n',
  );

  const result = run(root);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /english-loading-default/);
  assert.match(result.errors.join("\n"), /english-empty-default/);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "ui", "src", "components", "Example.test.tsx"),
    'it("allows legacy fixtures", () => expect("Paper Company").toBeTruthy());\n',
  );

  const result = run(root);
  assert.equal(result.code, 0);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "ui", "public", "site.webmanifest"),
    JSON.stringify({
      name: "Paperclip",
      short_name: "Paperclip",
      description: "Legacy install metadata",
    }),
  );

  const result = run(root, ["ui/public/site.webmanifest"]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /legacy-product-name/);
  assert.match(result.errors.join("\n"), /site\.webmanifest/);
}

console.log("rt2-identity-gate tests passed");
