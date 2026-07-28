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

  assert.equal(catalog.entries.length, 78);
  assert.equal(catalog.entries.filter((entry) => entry.table === "issues").length, 64);
  assert.equal(catalog.entries.filter((entry) => entry.table === "issueComments").length, 14);
  assert.deepEqual(
    catalog.entries.map((entry) => entry.id),
    Array.from({ length: 78 }, (_, index) => `M${String(index + 1).padStart(3, "0")}`),
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
