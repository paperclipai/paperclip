import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  canonicalObservedDigest,
  collectIssueWrites,
  collectIssueWritesFromSource,
  validateStrict,
} from "./check-issue-version-writes.mjs";

test("collects imported aliases for issue and comment writes", () => {
  const source = [
    'import { issues as issueRows, issueComments } from "@paperclipai/db";',
    "await tx.update(issueRows).set({ status: 'done' });",
    "await tx.insert(issueComments).values({ issueId: 'i' });",
  ].join("\n");

  assert.deepEqual(
    collectIssueWritesFromSource("server/src/services/example.ts", source),
    [
      {
        path: "server/src/services/example.ts",
        line: 2,
        receiver: "tx",
        operation: "update",
        table: "issues",
        tableToken: "issueRows",
      },
      {
        path: "server/src/services/example.ts",
        line: 3,
        receiver: "tx",
        operation: "insert",
        table: "issueComments",
        tableToken: "issueComments",
      },
    ],
  );
});

test("collects safe const aliases and rejects dynamic write operations", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "const issueTable = issues;",
    "await tx.delete(issueTable);",
  ].join("\n");
  assert.equal(
    collectIssueWritesFromSource("server/src/services/example.ts", source)[0].table,
    "issues",
  );

  assert.throws(
    () =>
      collectIssueWritesFromSource(
        "server/src/services/example.ts",
        [
          'import { issues } from "@paperclipai/db";',
          "await tx[operation](issues);",
        ].join("\n"),
      ),
    /dynamic issue-table write operation/,
  );
});

test("retains all accepted catalog identities and resolves the current source", () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "scripts", "issue-version-write-catalog.json"), "utf8"),
  );
  const observed = collectIssueWrites(process.cwd());

  assert.equal(catalog.entries.length, 83);
  assert.equal(catalog.entries.filter((entry) => entry.table === "issues").length, 67);
  assert.equal(catalog.entries.filter((entry) => entry.table === "issueComments").length, 16);
  assert.deepEqual(
    catalog.entries.map((entry) => entry.id),
    Array.from({ length: 83 }, (_, index) => `M${String(index + 1).padStart(3, "0")}`),
  );
  assert.equal(
    catalog.baseline.acceptedArtifactSha256,
    "D549C40F4E1592DF482F3FAB92591CD171DC821111B833EA9DF5E0E403C19F1B",
  );
  assert.deepEqual(validateStrict(observed, catalog, { repoRoot: process.cwd() }), {
    ok: true,
    errors: [],
  });
});

test("collects aliases from relative schema imports inside packages/db", () => {
  const source = [
    'import { issues, issueComments } from "./schema/index.js";',
    "await db.update(issues).set({ title: 'x' });",
    "await db.insert(issueComments).values({ issueId: 'i' });",
  ].join("\n");

  assert.deepEqual(
    collectIssueWritesFromSource("packages/db/src/example.ts", source).map((entry) => entry.table),
    ["issues", "issueComments"],
  );
  assert.deepEqual(
    collectIssueWritesFromSource("server/src/services/example.ts", source),
    [],
  );
});

test("covers cli and packages/db production writes in the repository scan", () => {
  const observed = collectIssueWrites(process.cwd());
  const paths = new Set(observed.map((entry) => entry.path));
  assert.ok(paths.has("cli/src/commands/worktree.ts"));
  assert.ok(paths.has("packages/db/src/seed.ts"));
  assert.ok(paths.has("packages/db/src/issue-versioning.ts"));
});

test("comment writes accept and require same-transaction bumpIssueVersions", () => {
  const helperPath = "packages/db/src/issue-versioning.ts";
  const catalogFor = (line) => ({
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {},
    entries: [
      {
        id: "M001",
        path: "cli/src/commands/example.ts",
        line,
        receiver: "tx",
        operation: "insert",
        table: "issueComments",
        tableToken: "issueComments",
        containingFunction: "<module>",
        sourceFileSha256: "0".repeat(64),
        classification: "versioned",
        state: "versioned",
        resolution: { kind: "versioned_helper", path: helperPath, export: "bumpIssueVersions" },
      },
    ],
  });

  const pairedSource = [
    'import { bumpIssueVersions, issueComments } from "@paperclipai/db";',
    "await db.transaction(async (tx) => {",
    "  await tx.insert(issueComments).values({ issueId: 'i' });",
    "  await bumpIssueVersions(tx, ['i']);",
    "});",
  ].join("\n");
  const paired = collectIssueWritesFromSource("cli/src/commands/example.ts", pairedSource);
  const pairedResult = validateStrict(paired, catalogFor(3));
  assert.equal(
    pairedResult.errors.some((error) => error.includes("bumpIssueVersions")),
    false,
  );

  const unpairedSource = [
    'import { issueComments } from "@paperclipai/db";',
    "await db.transaction(async (tx) => {",
    "  await tx.insert(issueComments).values({ issueId: 'i' });",
    "});",
  ].join("\n");
  const unpaired = collectIssueWritesFromSource("cli/src/commands/example.ts", unpairedSource);
  const unpairedResult = validateStrict(unpaired, catalogFor(3));
  assert.equal(
    unpairedResult.errors.some((error) =>
      error.includes("comment write lacks same-transaction bumpIssueVersions"),
    ),
    true,
  );
});

test("strict mode rejects injected raw issue and comment writes", () => {
  const source = [
    'import { issues, issueComments } from "@paperclipai/db";',
    "await tx.update(issues).set({ status: 'done' });",
    "await tx.insert(issueComments).values({ issueId: 'i' });",
  ].join("\n");
  const observed = collectIssueWritesFromSource("server/src/services/injected.ts", source);
  const result = validateStrict(observed, {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: { observedDigestSha256: canonicalObservedDigest([]) },
    entries: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.errors.filter((error) => error.startsWith("unapproved raw write:")).length, 2);
});
