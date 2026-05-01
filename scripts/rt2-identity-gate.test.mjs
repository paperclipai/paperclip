import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRt2IdentityGate } from "./rt2-identity-gate.mjs";

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "rt2-identity-gate-"));
  mkdirSync(join(root, "ui", "src", "components"), { recursive: true });
  mkdirSync(join(root, "ui", "public"), { recursive: true });
  mkdirSync(join(root, "doc"), { recursive: true });
  mkdirSync(join(root, "server", "src", "routes"), { recursive: true });
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

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "doc", "PRODUCT.md"),
    "# RealTycoon2\n\nPaperclip dashboard를 제품 표면 이름으로 노출합니다.\n",
  );

  const result = run(root, [{ path: "doc/PRODUCT.md", surface: "product_doc" }]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /product_doc\/legacy-product-name/);
  assert.match(result.errors.join("\n"), /Paperclip/);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "doc", "REALTYCOON2-COMPATIBILITY.md"),
    [
      "# RealTycoon2 Compatibility Boundary",
      "",
      "RealTycoon2 is the product identity.",
      "Paperclip is the inherited control-plane infrastructure and compatibility reference layer.",
      "Multica can appear only as a reference runtime comparison, not as product-facing copy.",
      "",
    ].join("\n"),
  );

  const result = run(root, [
    { path: "doc/REALTYCOON2-COMPATIBILITY.md", surface: "compatibility_doc", allowCompatibilityBoundary: true },
  ]);
  assert.equal(result.code, 0);
}

{
  const root = fixtureRoot();
  writeFileSync(
    join(root, "server", "src", "routes", "llms.ts"),
    'export const text = "# Paperclip Agent Configuration Index";\n',
  );

  const result = run(root, [{ path: "server/src/routes/llms.ts", surface: "server_operator_copy" }]);
  assert.equal(result.code, 1);
  assert.match(result.errors.join("\n"), /server_operator_copy\/legacy-product-name/);
}

console.log("rt2-identity-gate tests passed");
