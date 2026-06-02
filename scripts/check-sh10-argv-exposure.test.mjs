import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOW_MARKER,
  SHELL_PATTERNS,
  JS_PATTERNS,
  stripShellComment,
  findShellOffenses,
  findJsOffenses,
  collectScannableFiles,
  runCheck,
} from "./check-sh10-argv-exposure.mjs";

// ---------------------------------------------------------------------------
// stripShellComment
// ---------------------------------------------------------------------------

test("stripShellComment returns line unchanged when no comment", () => {
  assert.equal(stripShellComment('curl -sS "$URL"'), 'curl -sS "$URL"');
});

test("stripShellComment strips from # outside quotes", () => {
  assert.equal(stripShellComment("curl # comment"), "curl ");
});

test("stripShellComment preserves # inside double quotes", () => {
  const line = 'curl -H "Authorization: Bearer $TOKEN" # comment';
  assert.equal(
    stripShellComment(line),
    'curl -H "Authorization: Bearer $TOKEN" ',
  );
});

test("stripShellComment preserves # inside single quotes", () => {
  const line = "echo 'hello # world'  # outer comment";
  assert.equal(stripShellComment(line), "echo 'hello # world'  ");
});

// ---------------------------------------------------------------------------
// SHELL_PATTERNS — positive matches
// ---------------------------------------------------------------------------

test("SHELL_PATTERNS match curl -H Authorization Bearer with $VAR", () => {
  const line = 'curl -H "Authorization: Bearer $TOKEN" "$URL"';
  assert.ok(SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS match curl -H Authorization Bearer with ${VAR}", () => {
  const line = 'curl -H "Authorization: Bearer ${PAPERCLIP_API_KEY}" "$URL"';
  assert.ok(SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS match wget --header Authorization Bearer", () => {
  const line = 'wget --header "Authorization: Bearer $API_KEY" "$URL"';
  assert.ok(SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS match connection URI with password variable", () => {
  const line = 'psql "postgresql://user:$PGPASSWORD@host/db"';
  assert.ok(SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS match connection URI with ${VAR} password", () => {
  const line = 'psql "postgresql://user:${DB_PASS}@host/db"';
  assert.ok(SHELL_PATTERNS.some((p) => p.test(line)));
});

// ---------------------------------------------------------------------------
// SHELL_PATTERNS — negative (safe patterns should not match)
// ---------------------------------------------------------------------------

test("SHELL_PATTERNS do not match curl --config safe pattern", () => {
  const line =
    "curl --config <(printf 'header = \"Authorization: Bearer %s\"\\n' \"$TOKEN\")";
  assert.ok(!SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS do not match PGPASSWORD env-var pattern", () => {
  const line = 'PGPASSWORD="$DB_PASSWORD" psql -U user -h host -d db';
  assert.ok(!SHELL_PATTERNS.some((p) => p.test(line)));
});

test("SHELL_PATTERNS do not match URL without credential", () => {
  const line = 'curl -sS "$PAPERCLIP_API_URL/api/agents/me"';
  assert.ok(!SHELL_PATTERNS.some((p) => p.test(line)));
});

// ---------------------------------------------------------------------------
// JS_PATTERNS — positive matches
// ---------------------------------------------------------------------------

test("JS_PATTERNS match execSync with Bearer template literal", () => {
  const line = 'execSync(`curl -H "Authorization: Bearer ${TOKEN}" ${url}`);';
  assert.ok(JS_PATTERNS.some((p) => p.test(line)));
});

test("JS_PATTERNS match spawnSync with connection URI template literal", () => {
  const line = 'spawnSync("psql", [`postgresql://user:${PGPASSWORD}@host/db`]);';
  assert.ok(JS_PATTERNS.some((p) => p.test(line)));
});

test("JS_PATTERNS match exec with Bearer template literal", () => {
  const line =
    'exec(`curl -H "Authorization: Bearer ${API_KEY}" ${url}`, callback);';
  assert.ok(JS_PATTERNS.some((p) => p.test(line)));
});

// ---------------------------------------------------------------------------
// JS_PATTERNS — negative (safe or unrelated patterns)
// ---------------------------------------------------------------------------

test("JS_PATTERNS do not match fetch() with Bearer header (not shell argv)", () => {
  const line =
    'await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });';
  assert.ok(!JS_PATTERNS.some((p) => p.test(line)));
});

test("JS_PATTERNS do not match $VAR string literal in JS (not template interpolation)", () => {
  // $TOKEN in a regular JS string is a literal — not an interpolation, not dangerous
  const line = 'const ex = "curl -H \\"Authorization: Bearer $TOKEN\\"";';
  assert.ok(!JS_PATTERNS.some((p) => p.test(line)));
});

test("JS_PATTERNS do not match example string not in exec call", () => {
  const line =
    'const description = `curl -H "Authorization: Bearer ${TOKEN}"`;';
  assert.ok(!JS_PATTERNS.some((p) => p.test(line)));
});

// ---------------------------------------------------------------------------
// findShellOffenses
// ---------------------------------------------------------------------------

test("findShellOffenses flags Authorization Bearer line in shell", () => {
  const text = 'curl -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$URL"\n';
  const offenses = findShellOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findShellOffenses ignores line with allow marker on same line", () => {
  const text = `curl -H "Authorization: Bearer $TOKEN" "$URL" # ${ALLOW_MARKER}: doc example\n`;
  assert.deepEqual(findShellOffenses(text), []);
});

test("findShellOffenses ignores line with allow marker on previous line", () => {
  const text = `# ${ALLOW_MARKER}: test fixture\ncurl -H "Authorization: Bearer $TOKEN" "$URL"\n`;
  assert.deepEqual(findShellOffenses(text), []);
});

test("findShellOffenses ignores comment-only mention of pattern", () => {
  // The pattern appears only in the comment portion of the line
  const text = '# example: curl -H "Authorization: Bearer $TOKEN"\necho ok\n';
  assert.deepEqual(findShellOffenses(text), []);
});

test("findShellOffenses flags connection URI with password variable", () => {
  const text = 'psql "postgresql://admin:$DB_PASS@localhost/mydb"\n';
  const offenses = findShellOffenses(text);
  assert.equal(offenses.length, 1);
});

test("findShellOffenses does not flag safe curl --config pattern", () => {
  const text =
    "curl -sS --config <(printf 'header = \"Authorization: Bearer %s\"\\n' \"$PAPERCLIP_API_KEY\") \"$URL\"\n";
  assert.deepEqual(findShellOffenses(text), []);
});

// ---------------------------------------------------------------------------
// findJsOffenses
// ---------------------------------------------------------------------------

test("findJsOffenses flags execSync with Bearer template literal", () => {
  const text =
    'execSync(`curl -H "Authorization: Bearer ${TOKEN}" ${url}`);\n';
  const offenses = findJsOffenses(text);
  assert.equal(offenses.length, 1);
  assert.equal(offenses[0].lineNumber, 1);
});

test("findJsOffenses ignores line with allow marker on same line", () => {
  const text = `execSync(\`curl -H "Authorization: Bearer \${TOKEN}" \${url}\`); // ${ALLOW_MARKER}: test\n`;
  assert.deepEqual(findJsOffenses(text), []);
});

test("findJsOffenses ignores line with allow marker on previous line", () => {
  const text = `// ${ALLOW_MARKER}: test fixture\nexecSync(\`curl -H "Authorization: Bearer \${TOKEN}" \${url}\`);\n`;
  assert.deepEqual(findJsOffenses(text), []);
});

test("findJsOffenses does not flag fetch() with Bearer credential", () => {
  const text =
    'await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });\n';
  assert.deepEqual(findJsOffenses(text), []);
});

// ---------------------------------------------------------------------------
// runCheck integration
// ---------------------------------------------------------------------------

test("runCheck passes on a clean scripts tree", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-pass-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/safe-curl.sh"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'curl -sS --config <(printf \'header = "Authorization: Bearer %s"\\n\' "$PAPERCLIP_API_KEY") "$URL"',
      ].join("\n") + "\n",
    );
    const logs = [];
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["scripts"],
      log: (m) => logs.push(m),
      error: (m) => errors.push(m),
    });
    assert.equal(code, 0);
    assert.equal(errors.length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck fails on a shell script with inline Bearer credential", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-fail-sh-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/bad-curl.sh"),
      [
        "#!/usr/bin/env bash",
        'curl -H "Authorization: Bearer $MY_TOKEN" "$URL"',
      ].join("\n") + "\n",
    );
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["scripts"],
      log: () => {},
      error: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("scripts/bad-curl.sh:2")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck fails on a JS file with execSync Bearer template literal", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-fail-js-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/bad-exec.mjs"),
      'import { execSync } from "node:child_process";\nexecSync(`curl -H "Authorization: Bearer ${TOKEN}" ${url}`);\n',
    );
    const errors = [];
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["scripts"],
      log: () => {},
      error: (m) => errors.push(m),
    });
    assert.equal(code, 1);
    assert.ok(errors.some((line) => line.includes("scripts/bad-exec.mjs:2")));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck passes when violation has allow marker", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-allow-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts"), { recursive: true });
    writeFileSync(
      path.join(tmpRoot, "scripts/allowed.sh"),
      [
        "#!/usr/bin/env bash",
        `# ${ALLOW_MARKER}: usage example in docs, not executed`,
        'curl -H "Authorization: Bearer $MY_TOKEN" "$URL"',
      ].join("\n") + "\n",
    );
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["scripts"],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("collectScannableFiles skips node_modules and dist", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-collect-"));
  try {
    mkdirSync(path.join(tmpRoot, "scripts/node_modules/pkg"), { recursive: true });
    mkdirSync(path.join(tmpRoot, "scripts/dist"), { recursive: true });
    writeFileSync(path.join(tmpRoot, "scripts/ok.sh"), "#!/usr/bin/env bash\n");
    writeFileSync(path.join(tmpRoot, "scripts/node_modules/pkg/index.js"), "");
    writeFileSync(path.join(tmpRoot, "scripts/dist/index.js"), "");

    const files = collectScannableFiles(
      path.join(tmpRoot, "scripts"),
      tmpRoot,
    );
    const relatives = files.map((f) => f.relative);
    assert.deepEqual(relatives, ["scripts/ok.sh"]);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("runCheck ignores scan roots that do not exist", () => {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "sh10-missing-root-"));
  try {
    const code = runCheck({
      repoRoot: tmpRoot,
      scanRoots: ["nonexistent-dir"],
      log: () => {},
      error: () => {},
    });
    assert.equal(code, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
