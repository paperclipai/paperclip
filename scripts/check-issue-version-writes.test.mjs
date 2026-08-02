import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as scanner from "./check-issue-version-writes.mjs";
import {
  canonicalObservedDigest,
  collectIssueWrites,
  collectIssueWritesFromSource,
  validateBaseline,
  validateStrict,
} from "./check-issue-version-writes.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function createScanRepo(t) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-issue-writes-"));
  t.after(() => fs.rmSync(repoRoot, { recursive: true, force: true }));
  for (const root of [
    "server/src/routes",
    "server/src/services",
    "cli/src/commands",
    "packages/db/src",
  ]) {
    fs.mkdirSync(path.join(repoRoot, ...root.split("/")), { recursive: true });
  }
  return repoRoot;
}

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

test("collects namespace imports from the database package", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    "await tx.update(dbTables.issues).set({ status: 'done' });",
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
        tableToken: "dbTables.issues",
      },
    ],
  );
});

test("collects object-destructured aliases from database namespaces", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    "const { issues: issueRows } = dbTables;",
    "await tx.update(issueRows).set({ status: 'done' });",
  ].join("\n");

  assert.deepEqual(
    collectIssueWritesFromSource("server/src/services/example.ts", source),
    [
      {
        path: "server/src/services/example.ts",
        line: 3,
        receiver: "tx",
        operation: "update",
        table: "issues",
        tableToken: "issueRows",
      },
    ],
  );
});

test("resolves issue tables through local re-exports", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    'export { issues as issueRows } from "@paperclipai/db";\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issueRows } from "./db-tables.js";',
      "await tx.update(issueRows).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.deepEqual(collectIssueWrites(repoRoot), [
    {
      path: "server/src/services/writer.ts",
      line: 2,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "issueRows",
    },
  ]);
});

test("resolves local const bindings through export lists", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    [
      'import { issues } from "@paperclipai/db";',
      "const issueRows = issues;",
      "export { issueRows };",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issueRows } from "./db-tables.js";',
      "await tx.update(issueRows).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.equal(collectIssueWrites(repoRoot)[0].table, "issues");
});

test("resolves re-exported database namespaces", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    [
      'import * as dbTables from "@paperclipai/db";',
      "export { dbTables as tables };",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { tables } from "./db-tables.js";',
      "await tx.update(tables.issues).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.equal(collectIssueWrites(repoRoot)[0].table, "issues");
});

test("resolves namespace imports through local re-exports", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    'export { issues } from "@paperclipai/db";\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import * as tables from "./db-tables.js";',
      "await tx.update(tables.issues).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.deepEqual(collectIssueWrites(repoRoot), [
    {
      path: "server/src/services/writer.ts",
      line: 2,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "tables.issues",
    },
  ]);
});

test("resolves aliased namespace imports through export-star chains", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    'export { issues as issueRows } from "@paperclipai/db";\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "table-index.ts"),
    'export * from "./db-tables.js";\n',
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import * as tables from "./table-index.js";',
      "await tx.update(tables.issueRows).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.deepEqual(collectIssueWrites(repoRoot), [
    {
      path: "server/src/services/writer.ts",
      line: 2,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "tables.issueRows",
    },
  ]);
});

test("fails closed when a governed local namespace import cannot be resolved", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import * as tables from "./missing-db-tables.js";',
      "await tx.update(tables.issues).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.throws(
    () => collectIssueWrites(repoRoot),
    /cannot resolve local issue-table namespace import/,
  );
});

test("resolves local export lists backed by database imports", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "db-tables.ts"),
    [
      'import { issues as importedIssues } from "@paperclipai/db";',
      "export { importedIssues as issueRows };",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issueRows } from "./db-tables.js";',
      "await tx.update(issueRows).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.equal(collectIssueWrites(repoRoot)[0].table, "issues");
});

test("fails closed when a local issue-table re-export cannot be resolved", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issues } from "./missing-db-tables.js";',
      "await tx.update(issues).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.throws(
    () => collectIssueWrites(repoRoot),
    /cannot resolve local issue-table import/,
  );
});

test("fails closed when an unresolved local import uses a noncanonical alias", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issueRows } from "./missing-db-tables.js";',
      "await tx.update(issueRows).set({ status: 'done' });",
    ].join("\n"),
  );

  assert.throws(
    () => collectIssueWrites(repoRoot),
    /cannot resolve local issue-table import/,
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

test("fails closed for compound const aliases containing governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "const target = true ? issues : issues;",
    "await tx.update(target).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("fails closed for mutable aliases of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "let target = issues;",
    "await tx.update(target).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("fails closed for later-assigned mutable aliases of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "let target;",
    "target = issues;",
    "await tx.update(target).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("fails closed for parenthesized nested destructuring assignments of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "let target;",
    "([, [target]] = [, [issues]]);",
    "await tx.update(target).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias target/,
  );
});

test("fails closed for array-destructured aliases of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "const [target] = [issues];",
    "await tx.update(target).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("fails closed for function-return aliases of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "const target = () => issues;",
    "await tx.update(target()).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("fails closed for named function-return aliases of governed tables", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "function target() { return issues; }",
    "await tx.update(target()).set({ status: 'done' });",
  ].join("\n");

  assert.throws(
    () => collectIssueWritesFromSource("server/src/services/example.ts", source),
    /unsafe issue-table alias/,
  );
});

test("collects governed tables forwarded through local function parameters", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "function remove(target) {",
    "  return tx.delete(target);",
    "}",
    "remove(issues);",
  ].join("\n");

  assert.deepEqual(
    collectIssueWritesFromSource("server/src/services/example.ts", source),
    [
      {
        path: "server/src/services/example.ts",
        line: 3,
        receiver: "tx",
        operation: "delete",
        table: "issues",
        tableToken: "target",
      },
    ],
  );
});

test("fails closed for unresolved relative imported calls used as write targets", () => {
  const source = [
    'import { getIssueTable } from "./missing-table.js";',
    "await tx.insert(getIssueTable()).values({ title: 'raw' });",
  ].join("\n");

  assert.throws(
    () =>
      collectIssueWritesFromSource("server/src/services/example.ts", source, {
        resolveNamedImport: () => ({ kind: "unresolved" }),
      }),
    /cannot resolve local issue-table import getIssueTable/,
  );
});

test("does not trust a locally shadowed imported approved helper", () => {
  const source = [
    'import { issues, versionedIssuePatch } from "@paperclipai/db";',
    "function write() {",
    "  function versionedIssuePatch(patch) { return patch; }",
    "  return tx.update(issues).set(versionedIssuePatch({ status: 'done' }));",
    "}",
  ].join("\n");

  const [observed] = collectIssueWritesFromSource(
    "server/src/services/example.ts",
    source,
  );

  assert.equal(observed.versionedBy, null);
});

test("does not trust catch-shadowed versionedIssuePatch helpers", () => {
  const source = [
    'import { issues, versionedIssuePatch } from "@paperclipai/db";',
    "try { throw new Error('failure'); } catch (versionedIssuePatch) {",
    "  await tx.update(issues).set(versionedIssuePatch({ status: 'done' }));",
    "}",
  ].join("\n");

  const [observed] = collectIssueWritesFromSource(
    "server/src/services/example.ts",
    source,
  );

  assert.equal(observed.versionedBy, null);
});

test("does not trust catch-shadowed runIssueMutation helpers", () => {
  const source = [
    'import { issueComments } from "@paperclipai/db";',
    'import { runIssueMutation } from "./issue-versioning.js";',
    "try { throw new Error('failure'); } catch (runIssueMutation) {",
    "  await runIssueMutation({ mutate: async (tx) => {",
    "    await tx.insert(issueComments).values({ issueId: 'i', body: 'raw' });",
    "  }});",
    "}",
  ].join("\n");

  const [observed] = collectIssueWritesFromSource(
    "server/src/services/example.ts",
    source,
    {
      resolveNamedImport: (_filePath, _moduleSpecifier, exported) =>
        exported === "runIssueMutation"
          ? {
              kind: "helper",
              helper: "runIssueMutation",
              helperPath: "server/src/services/issue-versioning.ts",
            }
          : { kind: "unresolved" },
    },
  );

  assert.equal(observed.insideRunIssueMutation, false);
});

test("retains all accepted catalog identities and resolves the current source", () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "scripts", "issue-version-write-catalog.json"), "utf8"),
  );
  const observed = collectIssueWrites(process.cwd());

  assert.equal(catalog.entries.length, 76);
    assert.equal(catalog.entries.filter((entry) => entry.table === "issues").length, 58);
    assert.equal(catalog.entries.filter((entry) => entry.table === "issueComments").length, 18);
  assert.deepEqual(
    catalog.entries.map((entry) => entry.id),
    Array.from({ length: 76 }, (_, index) => `M${String(index + 1).padStart(3, "0")}`),
  );
  assert.equal(catalog.baseline.extension.baseEntryCount, 70);
    assert.equal(observed.length, catalog.entries.length);
    assert.equal(canonicalObservedDigest(observed), catalog.baseline.observedDigestSha256);
    assert.deepEqual(validateBaseline(observed, catalog, { repoRoot: process.cwd() }), {
      ok: true,
      errors: [],
    });
    assert.deepEqual(validateStrict(observed, catalog, { repoRoot: process.cwd() }), {
    ok: true,
    errors: [],
  });
});

test("baseline validation rejects catalog entries absent from discovery", () => {
  const observed = collectIssueWritesFromSource(
    "server/src/services/current.ts",
    [
      'import { issues, versionedIssuePatch } from "@paperclipai/db";',
      "await tx.update(issues).set(versionedIssuePatch({ status: 'done' }));",
    ].join("\n"),
  );
  const catalogEntry = {
    id: "M001",
    ...observed[0],
    classification: "versioned",
    state: "versioned",
    resolution: {
      kind: "versioned_helper",
      path: "server/src/services/issue-versioning.ts",
      export: "versionedIssuePatch",
    },
  };
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      observedDigestSha256: canonicalObservedDigest(observed),
      counts: { total: 2 },
    },
    entries: [
      catalogEntry,
      {
        ...catalogEntry,
        id: "M002",
        path: "server/src/services/stale.ts",
      },
    ],
  };

  const result = validateBaseline(observed, catalog);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /catalog entry has no observed write/);
});

test("strict validation rejects exempt classifications on raw issue updates", () => {
  const observed = collectIssueWritesFromSource(
    "server/src/services/current.ts",
    [
      'import { issues } from "@paperclipai/db";',
      "await tx.update(issues).set({ status: 'done' });",
    ].join("\n"),
  );
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: { counts: { total: 1 } },
    entries: [
      {
        id: "M001",
        ...observed[0],
        classification: "issue_created_at_version_1",
        state: "verified_create",
        resolution: {
          kind: "schema_default",
          column: "issues.version",
          value: 1,
        },
      },
    ],
  };

  const result = validateStrict(observed, catalog);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /incompatible catalog classification/);
});

test("catalog entry digest covers authority metadata", () => {
  const catalog = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "scripts", "issue-version-write-catalog.json"), "utf8"),
  );
  catalog.entries[0].state = "tampered";

  const result = validateStrict([], catalog);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /catalog accepted-entry digest differs/);
});

test("catalog validation requires an accepted-entry digest", () => {
  const result = validateStrict([], {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: { counts: { total: 0 } },
    entries: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /catalog accepted-entry digest is missing or invalid/);
});

test("canonical source hashing accepts LF, CRLF, and bare CR repositories", (t) => {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, canonicalize(nested)]),
      );
    }
    return value;
  };
  const source = [
    'import { issues } from "@paperclipai/db";',
    "await tx.insert(issues).values({ title: 'created' });",
    "",
  ].join("\n");
  const sourceHash = scanner.canonicalSourceSha256(source);

  for (const [label, variant] of [
    ["LF", source],
    ["CRLF", source.replaceAll("\n", "\r\n")],
    ["bare CR", source.replaceAll("\n", "\r")],
  ]) {
    assert.equal(scanner.canonicalSourceSha256(variant), sourceHash, `${label} digest`);
    const repoRoot = createScanRepo(t);
    fs.writeFileSync(
      path.join(repoRoot, "server", "src", "services", "writer.ts"),
      variant,
    );
    const observed = collectIssueWrites(repoRoot);
    assert.equal(observed[0].sourceFileSha256, sourceHash, `${label} collected digest`);
    const entry = {
      id: "M001",
      ...observed[0],
      containingFunction: "<module>",
      sourceFileSha256: sourceHash,
      classification: "issue_created_at_version_1",
      state: "verified_create",
      resolution: {
        kind: "schema_default",
        column: "issues.version",
        value: 1,
      },
    };
    const projection = canonicalize({
      id: entry.id,
      path: entry.path,
      line: entry.line,
      receiver: entry.receiver,
      operation: entry.operation,
      table: entry.table,
      tableToken: entry.tableToken,
      containingFunction: entry.containingFunction,
      sourceFileSha256: entry.sourceFileSha256,
      classification: entry.classification,
      state: entry.state,
      resolution: entry.resolution,
    });
    const catalog = {
      schemaVersion: "paperclip_issue_version_write_catalog_v2",
      baseline: {
        counts: { total: 1 },
        acceptedEntryDigestSha256: createHash("sha256")
          .update(JSON.stringify([projection]))
          .digest("hex")
          .toUpperCase(),
      },
      entries: [entry],
    };

    assert.deepEqual(
      validateStrict(observed, catalog, { repoRoot }),
      { ok: true, errors: [] },
      `${label} strict validation`,
    );
  }
});

function canonicalAuthorityValue(value) {
  if (Array.isArray(value)) return value.map(canonicalAuthorityValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalAuthorityValue(nested)]),
    );
  }
  return value;
}

function authorityDigest(value) {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .toUpperCase();
}

function trustedHelperDigestForTest(records) {
  return authorityDigest(
    [...records]
      .sort((left, right) =>
        left.path.localeCompare(right.path) ||
        left.export.localeCompare(right.export) ||
        left.kind.localeCompare(right.kind))
      .map(canonicalAuthorityValue),
  );
}

function helperAuthorityFixture(
  t,
  {
    packageSource: packageOverride,
    serverSource: serverOverride,
    pinnedPackageSource,
    pinnedServerSource,
    lineEnding = "\n",
    transformRecords = (records) => records,
  } = {},
) {
  const repoRoot = createScanRepo(t);
  const canonical = (value) => value.replace(/\r\n?/g, "\n");
  const packageSource = canonical(
    packageOverride ??
      fs.readFileSync(path.join(process.cwd(), "packages", "db", "src", "issue-versioning.ts"), "utf8"),
  );
  const serverSource = canonical(
    serverOverride ??
      fs.readFileSync(path.join(process.cwd(), "server", "src", "services", "issue-versioning.ts"), "utf8"),
  );
  const writerSource = [
    'import { issues, versionedIssuePatch } from "@paperclipai/db";',
    "await tx.update(issues).set(versionedIssuePatch({ title: 'changed' }));",
    "",
  ].join("\n");
  const withEnding = (value) => value.replaceAll("\n", lineEnding);
  fs.writeFileSync(
    path.join(repoRoot, "packages", "db", "src", "issue-versioning.ts"),
    withEnding(packageSource),
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "issue-versioning.ts"),
    withEnding(serverSource),
  );
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    withEnding(writerSource),
  );

  const observed = collectIssueWritesFromSource(
    "server/src/services/writer.ts",
    withEnding(writerSource),
  );
  const entry = {
    id: "M001",
    ...observed[0],
    containingFunction: "<module>",
    sourceFileSha256: scanner.canonicalSourceSha256(writerSource),
    classification: "versioned",
    state: "versioned",
    resolution: {
      kind: "versioned_helper",
      path: "packages/db/src/issue-versioning.ts",
      export: "versionedIssuePatch",
    },
  };
  const entryProjection = canonicalAuthorityValue({
    id: entry.id,
    path: entry.path,
    line: entry.line,
    receiver: entry.receiver,
    operation: entry.operation,
    table: entry.table,
    tableToken: entry.tableToken,
    containingFunction: entry.containingFunction,
    sourceFileSha256: entry.sourceFileSha256,
    classification: entry.classification,
    state: entry.state,
    resolution: entry.resolution,
  });
  const pinnedPackage = canonical(pinnedPackageSource ?? packageSource);
  const pinnedServer = canonical(pinnedServerSource ?? serverSource);
  let trustedHelpers = [
    {
      path: "packages/db/src/issue-versioning.ts",
      export: "versionedIssuePatch",
      kind: "implementation",
      sourceFileSha256: scanner.canonicalSourceSha256(pinnedPackage),
    },
    {
      path: "server/src/services/issue-versioning.ts",
      export: "versionedIssuePatch",
      kind: "reexport",
      module: "@paperclipai/db",
      sourceFileSha256: scanner.canonicalSourceSha256(pinnedServer),
    },
    {
      path: "server/src/services/issue-versioning.ts",
      export: "runIssueMutation",
      kind: "implementation",
      sourceFileSha256: scanner.canonicalSourceSha256(pinnedServer),
    },
  ];
  trustedHelpers = transformRecords(trustedHelpers);
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      counts: { total: 1 },
      acceptedEntryDigestSha256: authorityDigest([entryProjection]),
      trustedHelpers,
      acceptedTrustedHelperDigestSha256: trustedHelperDigestForTest(trustedHelpers),
    },
    entries: [entry],
  };
  return { catalog, observed, repoRoot };
}

test("trusted helper authority accepts canonical helpers for every line ending", (t) => {
  for (const [label, lineEnding] of [
    ["LF", "\n"],
    ["CRLF", "\r\n"],
    ["bare CR", "\r"],
  ]) {
    const fixture = helperAuthorityFixture(t, { lineEnding });
    assert.deepEqual(
      validateStrict(fixture.observed, fixture.catalog, { repoRoot: fixture.repoRoot }),
      { ok: true, errors: [] },
      label,
    );
  }
});

test("trusted version helper rejects forged increment implementations", (t) => {
  const goodSource = fs.readFileSync(
    path.join(process.cwd(), "packages", "db", "src", "issue-versioning.ts"),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  const mutations = new Map([
    ["removed increment", goodSource.replace("version: sql`${issues.version} + 1`,", "version: sql`${issues.version}`,")],
    ["increment by two", goodSource.replace("+ 1`,", "+ 2`,")],
    ["decrement", goodSource.replace("+ 1`,", "- 1`,")],
    ["literal version", goodSource.replace("version: sql`${issues.version} + 1`,", "version: 1,")],
    ["wrong column", goodSource.replace("issues.version} + 1", "issues.issueNumber} + 1")],
    [
      "spread after version",
      goodSource.replace(
        "    ...patch,\n    updatedAt: now,\n    version: sql`${issues.version} + 1`,",
        "    updatedAt: now,\n    version: sql`${issues.version} + 1`,\n    ...patch,",
      ),
    ],
    [
      "spread after updatedAt",
      goodSource.replace(
        "    ...patch,\n    updatedAt: now,\n    version: sql`${issues.version} + 1`,",
        "    updatedAt: now,\n    ...patch,\n    version: sql`${issues.version} + 1`,",
      ),
    ],
    [
      "named properties reordered",
      goodSource.replace(
        "    ...patch,\n    updatedAt: now,\n    version: sql`${issues.version} + 1`,",
        "    ...patch,\n    version: sql`${issues.version} + 1`,\n    updatedAt: now,",
      ),
    ],
    [
      "computed duplicate",
      goodSource.replace(
        "version: sql`${issues.version} + 1`,",
        "version: sql`${issues.version} + 1`,\n    [\"version\"]: sql`${issues.version} + 1`,",
      ),
    ],
    ["mutable patch", goodSource.replace("  return {", "  patch = {};\n  return {")],
    ["alternate return", goodSource.replace("  return {", "  if (now) return patch;\n  return {")],
    [
      "forged body",
      goodSource.replace(
        /  return \{\n    \.\.\.patch,\n    updatedAt: now,\n    version: sql`\$\{issues\.version\} \+ 1`,\n  \};/,
        "  return patch;",
      ),
    ],
  ]);

  for (const [label, packageSource] of mutations) {
    assert.notEqual(packageSource, goodSource, `${label} fixture must mutate source`);
    const fixture = helperAuthorityFixture(t, { packageSource });
    const result = validateStrict(fixture.observed, fixture.catalog, {
      repoRoot: fixture.repoRoot,
    });
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /versionedIssuePatch implementation contract/, label);
  }
});

test("trusted helper authority rejects re-export drift and pinned implementation drift", (t) => {
  const goodServer = fs.readFileSync(
    path.join(process.cwd(), "server", "src", "services", "issue-versioning.ts"),
    "utf8",
  ).replace(/\r\n?/g, "\n");
  for (const [label, serverSource] of [
    [
      "removed",
      goodServer.replace(
        'export { versionedIssuePatch, type IssueMutationPatch } from "@paperclipai/db";',
        "export type { IssueMutationPatch } from \"@paperclipai/db\";",
      ),
    ],
    [
      "redirected",
      goodServer.replace(
        'export { versionedIssuePatch, type IssueMutationPatch } from "@paperclipai/db";',
        'export { versionedIssuePatch, type IssueMutationPatch } from "./forged.js";',
      ),
    ],
  ]) {
    const fixture = helperAuthorityFixture(t, { serverSource });
    const result = validateStrict(fixture.observed, fixture.catalog, {
      repoRoot: fixture.repoRoot,
    });
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /versionedIssuePatch re-export contract/, label);
  }

  const driftedServer = `${goodServer}\n// implementation drift\n`;
  const driftFixture = helperAuthorityFixture(t, {
    serverSource: driftedServer,
    pinnedServerSource: goodServer,
  });
  const driftResult = validateStrict(driftFixture.observed, driftFixture.catalog, {
    repoRoot: driftFixture.repoRoot,
  });
  assert.equal(driftResult.ok, false);
  assert.match(
    driftResult.errors.join("\n"),
    /trusted helper source hash differs.*runIssueMutation/,
  );
});

test("trusted helper records require exact unique completeness", (t) => {
  for (const [label, transformRecords] of [
    ["missing", (records) => records.slice(1)],
    ["duplicate", (records) => [...records, records[0]]],
    [
      "unknown",
      (records) => [
        ...records.slice(0, 2),
        { ...records[2], export: "forgedMutation" },
      ],
    ],
  ]) {
    const fixture = helperAuthorityFixture(t, { transformRecords });
    const result = validateStrict(fixture.observed, fixture.catalog, {
      repoRoot: fixture.repoRoot,
    });
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /trusted helper records/, label);
  }
});

test("strict validation rejects stale catalog source hashes", (t) => {
  const repoRoot = createScanRepo(t);
  fs.writeFileSync(
    path.join(repoRoot, "server", "src", "services", "writer.ts"),
    [
      'import { issues } from "@paperclipai/db";',
      "await tx.insert(issues).values({ title: 'created' });",
    ].join("\n"),
  );
  const observed = collectIssueWrites(repoRoot);
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      counts: { total: 1 },
      acceptedEntryDigestSha256: "0".repeat(64),
    },
    entries: [
      {
        id: "M001",
        ...observed[0],
        containingFunction: "<module>",
        sourceFileSha256: "0".repeat(64),
        classification: "issue_created_at_version_1",
        state: "verified_create",
        resolution: {
          kind: "schema_default",
          column: "issues.version",
          value: 1,
        },
      },
    ],
  };

  const result = validateStrict(observed, catalog, { repoRoot });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /catalog source hash differs/);
});

test("strict validation rejects locally forged version helpers", () => {
  const observed = collectIssueWritesFromSource(
    "server/src/services/forged-helper.ts",
    [
      'import { issues } from "@paperclipai/db";',
      "function versionedIssuePatch(patch) { return patch; }",
      "await tx.update(issues).set(versionedIssuePatch({ status: 'done' }));",
    ].join("\n"),
  );
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      counts: { total: 1 },
      acceptedEntryDigestSha256: "0".repeat(64),
    },
    entries: [
      {
        id: "M001",
        ...observed[0],
        classification: "versioned",
        state: "versioned",
        resolution: {
          kind: "versioned_helper",
          path: "packages/db/src/issue-versioning.ts",
          export: "versionedIssuePatch",
        },
      },
    ],
  };

  const result = validateStrict(observed, catalog);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /raw write outside issue-version helper/);
});

test("strict validation rejects locally forged mutation wrappers", () => {
  const observed = collectIssueWritesFromSource(
    "server/src/services/forged-wrapper.ts",
    [
      'import { issueComments } from "@paperclipai/db";',
      "function runIssueMutation(input) { return input; }",
      "await runIssueMutation({",
      "  mutate: async (tx) => {",
      "    await tx.insert(issueComments).values({ issueId: 'i', body: 'raw' });",
      "    return { result: null };",
      "  },",
      "});",
    ].join("\n"),
  );
  const catalog = {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      counts: { total: 1 },
      acceptedEntryDigestSha256: "0".repeat(64),
    },
    entries: [
      {
        id: "M001",
        ...observed[0],
        classification: "versioned",
        state: "versioned",
        resolution: {
          kind: "versioned_helper",
          path: "server/src/services/issue-versioning.ts",
          export: "runIssueMutation",
        },
      },
    ],
  };

  const result = validateStrict(observed, catalog);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /comment write is outside runIssueMutation/);
});

test("scans every production issue write root", () => {
  const observed = collectIssueWrites(process.cwd());
  const cliWrites = observed.filter(
    (entry) => entry.path === "cli/src/commands/worktree.ts",
  );
  const dbSeedWrites = observed.filter(
    (entry) => entry.path === "packages/db/src/seed.ts",
  );

  assert.equal(cliWrites.length, 5);
  assert.deepEqual(
    cliWrites.map(({ operation, table }) => ({ operation, table })),
    [
      { operation: "update", table: "issues" },
      { operation: "insert", table: "issueComments" },
      { operation: "insert", table: "issues" },
      { operation: "insert", table: "issueComments" },
      { operation: "update", table: "issues" },
    ],
  );
  assert.deepEqual(
    dbSeedWrites.map(({ operation, table }) => ({ operation, table })),
    [{ operation: "insert", table: "issues" }],
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

const CONTRACT_FILE = "server/src/services/example.ts";
const contractResolver = (_filePath, _moduleSpecifier, exported) =>
  exported === "runIssueMutation"
    ? {
        kind: "helper",
        helper: "runIssueMutation",
        helperPath: "server/src/services/issue-versioning.ts",
      }
    : { kind: "unresolved" };

function canonicalContractValue(value) {
  if (Array.isArray(value)) return value.map(canonicalContractValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalContractValue(nested)]),
    );
  }
  return value;
}

function contractCatalog(write, id = "M055", resolutionExport = "runIssueMutation") {
  const entry = {
    id,
    ...write,
    containingFunction: write.functionName,
    sourceFileSha256: "A".repeat(64),
    classification: "versioned",
    state: "versioned",
    resolution: {
      kind: "versioned_helper",
      path: resolutionExport === "runIssueMutation"
        ? "server/src/services/issue-versioning.ts"
        : "packages/db/src/issue-versioning.ts",
      export: resolutionExport,
    },
  };
  const digestProjection = canonicalContractValue({
    id: entry.id,
    path: entry.path,
    line: entry.line,
    receiver: entry.receiver,
    operation: entry.operation,
    table: entry.table,
    tableToken: entry.tableToken,
    containingFunction: entry.containingFunction,
    sourceFileSha256: entry.sourceFileSha256,
    classification: entry.classification,
    state: entry.state,
    resolution: entry.resolution,
  });
  return {
    schemaVersion: "paperclip_issue_version_write_catalog_v2",
    baseline: {
      counts: { total: 1 },
      acceptedEntryDigestSha256: createHash("sha256")
        .update(JSON.stringify([digestProjection]))
        .digest("hex")
        .toUpperCase(),
    },
    entries: [entry],
  };
}

function transactionAnalysis(source, file = CONTRACT_FILE) {
  assert.equal(
    typeof scanner.analyzeTransactionContractFromSource,
    "function",
    "the v12 transaction analyzer must be exported",
  );
  return scanner.analyzeTransactionContractFromSource(file, source, {
    resolveNamedImport: contractResolver,
  });
}

function analyzedFunction(analysis, name) {
  const result = analysis.functions.find((candidate) => candidate.name === name);
  assert.ok(result, `missing analyzed function ${name}`);
  return result;
}

function parseFunctionShapes(source) {
  const sourceFile = ts.createSourceFile(
    CONTRACT_FILE,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const shapes = new Map();
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name) shapes.set(node.name.text, node);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))
    ) {
      shapes.set(node.name.text, node);
    }
    if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      shapes.set(node.name.text, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { sourceFile, shapes };
}

test("C01 object assignment from database namespace", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    "let target;",
    "({ issues: target } = dbTables);",
    'await tx.update(target).set({ status: "done" });',
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), [
    {
      path: CONTRACT_FILE,
      line: 4,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "target",
    },
  ]);
});

test("C02 computed object-assignment key fails closed", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    "let target;",
    "({ [key]: target } = dbTables);",
    'await tx.update(target).set({ status: "done" });',
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, source),
    { name: "Error", message: `unsafe issue-table alias target in ${CONTRACT_FILE}` },
  );
});

test("C03 rest object assignment fails closed", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    "let target;",
    "({ ...target } = dbTables);",
    'await tx.update(target).set({ status: "done" });',
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, source),
    { name: "Error", message: `unsafe issue-table alias target in ${CONTRACT_FILE}` },
  );
});

test("C04 two-hop local parameter forwarding", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    'function write(target) { return tx.update(target).set({ status: "done" }); }',
    "function forward(target) { return write(target); }",
    "forward(issues);",
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), [
    {
      path: CONTRACT_FILE,
      line: 2,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "target",
    },
  ]);
});

test("C05 dynamic namespace member has the exact diagnostic", () => {
  const source = [
    'import * as dbTables from "@paperclipai/db";',
    'await tx.update(dbTables[key]).set({ status: "done" });',
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, source),
    {
      name: "Error",
      message: "cannot resolve dynamic local issue-table namespace import",
    },
  );
});

test("C06 wrapped unresolved relative factory has the exact diagnostic", () => {
  const source = [
    'import { getIssueTable } from "./missing-table.js";',
    "function target() { return getIssueTable(); }",
    'await tx.update(target()).set({ status: "done" });',
  ].join("\n");
  assert.throws(
    () =>
      collectIssueWritesFromSource(CONTRACT_FILE, source, {
        resolveNamedImport: () => ({ kind: "unresolved" }),
      }),
    {
      name: "Error",
      message:
        `cannot resolve local issue-table import getIssueTable ` +
        `from ./missing-table.js in ${CONTRACT_FILE}`,
    },
  );

  const importLine = 'import { getIssueTable } from "./missing.js";';
  for (const [name, body] of [
    ["direct receiver", "await connection.update(getIssueTable()).set({});"],
    [
        "parameter receiver",
        "async function write(connection) { await connection.update(getIssueTable()).set({}); }",
    ],
    [
        "immutable receiver alias",
        "async function write(connection) { const query = connection; await query.update(getIssueTable()).set({}); }",
    ],
    [
        "local target factory",
        "function target() { return getIssueTable(); }\nawait conduit.update(target()).set({});",
    ],
  ]) {
    assert.throws(
        () =>
          collectIssueWritesFromSource(CONTRACT_FILE, `${importLine}\n${body}`, {
            resolveNamedImport: () => ({ kind: "unresolved" }),
          }),
        {
          name: "Error",
          message:
            `cannot resolve local issue-table import getIssueTable ` +
            `from ./missing.js in ${CONTRACT_FILE}`,
        },
        name,
    );
  }
  assert.deepEqual(
    collectIssueWritesFromSource(
        CONTRACT_FILE,
        'const model = {}; await model.update({ name: "ordinary" });',
    ),
    [],
  );
});

test("C07 immutable write-operation alias", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    'const op = "update";',
    'await tx[op](issues).set({ status: "done" });',
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), [
    {
      path: CONTRACT_FILE,
      line: 3,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "issues",
    },
  ]);
});

test("C08 immutable non-write operation alias", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    'const op = "select";',
    "await tx[op](issues);",
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), []);
});

test("C09 mutable operation alias is unknown", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    'let op = "select";',
    'op = "update";',
    "await tx[op](issues);",
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, source),
    {
      name: "Error",
      message: `dynamic issue-table write operation in ${CONTRACT_FILE}:4`,
    },
  );
});

test("C10 literal element write operation", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    'await tx["delete"](issues);',
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), [
    {
      path: CONTRACT_FILE,
      line: 2,
      receiver: "tx",
      operation: "delete",
      table: "issues",
      tableToken: "issues",
    },
  ]);
});

test("C11 static local-factory member target", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "function box() { return { issueRows: issues }; }",
    "const target = box().issueRows;",
    'await tx.update(target).set({ status: "done" });',
  ].join("\n");
  assert.deepEqual(collectIssueWritesFromSource(CONTRACT_FILE, source), [
    {
      path: CONTRACT_FILE,
      line: 4,
      receiver: "tx",
      operation: "update",
      table: "issues",
      tableToken: "target",
    },
  ]);
});

test("C12 unknown static member on governed-bearing factory fails closed", () => {
  const source = [
    'import { issues } from "@paperclipai/db";',
    "function box() { return { issueRows: issues }; }",
    "const target = box().other;",
    'await tx.update(target).set({ status: "done" });',
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, source),
    { name: "Error", message: `unsafe issue-table alias target in ${CONTRACT_FILE}` },
  );
});

test("C13 exact live proofs, certificates, and M055 authority", () => {
  const observed = collectIssueWrites(process.cwd());
  const catalog = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "scripts", "issue-version-write-catalog.json"), "utf8"),
  );
  const patchRows = new Map([
      ["M002", ["ExactIssue", "direct_patch", "packages/db/src/issue-versioning.ts"]],
      ["M004", ["ExactIssue", "accumulator_bulk_patch", "packages/db/src/issue-versioning.ts"]],
      ["M009", ["ExactIssue", "derived_patch_wrapper", "server/src/services/issue-versioning.ts"]],
      ["M014", ["ExactIssueSet", "predicate_partition", "server/src/services/issue-versioning.ts"]],
    ]);
    const expectedNormalExits = new Map([
      ["M002", [["Block", 1195]]],
      ["M004", [["ReturnStatement", 2990]]],
      ["M009", [["ReturnStatement", 6752]]],
      ["M014", [["ReturnStatement", 784]]],
    ]);
  const sourceFiles = new Map();
  const normalExitRoles = (filePath, keys) => {
    let sourceFile = sourceFiles.get(filePath);
    if (!sourceFile) {
      sourceFile = ts.createSourceFile(
        filePath,
        fs.readFileSync(path.join(process.cwd(), ...filePath.split("/")), "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      sourceFiles.set(filePath, sourceFile);
    }
    const nodes = new Map();
    function index(node) {
      nodes.set(`${node.pos}:${node.end}`, node);
      ts.forEachChild(node, index);
    }
    index(sourceFile);
    return keys.map((key) => {
      const match = /#(\d+):(\d+)$/.exec(key);
      assert.ok(match, `invalid normal-exit key ${key}`);
      const node = nodes.get(`${match[1]}:${match[2]}`);
      assert.ok(node, `normal-exit key does not resolve ${key}`);
      return [
        ts.SyntaxKind[node.kind],
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      ];
    });
  };
  const identityFields = [
    "path",
    "line",
    "receiver",
    "operation",
    "table",
    "tableToken",
  ];
  for (const [id, [scopeKind, coverageKind, helperPath]] of patchRows) {
    const catalogEntry = catalog.entries.find((entry) => entry.id === id);
    assert.ok(catalogEntry, `missing catalog row ${id}`);
    const write = observed.find((candidate) =>
      identityFields.every((field) => candidate[field] === catalogEntry[field]));
    assert.ok(write, `missing complete live identity ${id}`);
    const patchCertificates = observed.authorityCertificates.filter(
      (certificate) => certificate.sinkKey === write.sinkKey,
    );
    assert.equal(patchCertificates.length, 1, `${id} exact certificate count`);
    const [certificate] = patchCertificates;
    assert.equal(certificate.authority, "versionedIssuePatch:same_transaction", id);
    assert.equal(certificate.scopeKind, scopeKind, `${id} scope`);
    assert.equal(certificate.coverageKind, coverageKind, `${id} coverage`);
    assert.equal(certificate.helperExport, "versionedIssuePatch", `${id} helper export`);
    assert.equal(certificate.helperPath, helperPath, `${id} helper path`);
    assert.match(
      certificate.issueKeyEvidence,
      /^(?:LIT:|SYM:|MEM:|SET:|SETEXPR:|PRED:)/,
      `${id} canonical scope evidence`,
    );
    assert.notEqual(certificate.issueKeyEvidence, write.sinkKey, `${id} no sink-key evidence`);
    assert.notEqual(
      certificate.issueKeyEvidence,
      write.sinkKey.split("|issueComments|")[0],
      `${id} no write NodeKey evidence`,
    );
    assert.equal(certificate.obligationKey.includes(write.sinkKey), true, `${id} obligation`);
    assert.deepEqual(
      certificate.coverageScopeKeys,
      [...new Set(certificate.coverageScopeKeys)].sort(),
      `${id} canonical coverage scopes`,
    );
    assert.ok(certificate.coverageScopeKeys.length > 0, `${id} coverage scope`);
    assert.deepEqual(
      certificate.normalExitKeys,
      [...new Set(certificate.normalExitKeys)].sort(),
      `${id} complete normal exits`,
    );
    assert.deepEqual(
      normalExitRoles(write.path, certificate.normalExitKeys),
      expectedNormalExits.get(id),
      `${id} exact normal-exit roles`,
    );
    assert.ok(certificate.proofRoles.includes("normal_exit"), `${id} exit proof role`);
    assert.deepEqual(
      certificate.proofNodes,
      [...new Set(certificate.proofNodes)].sort(),
      `${id} canonical proof nodes`,
    );
  }
  const livePatchCertificates = observed.authorityCertificates.filter(
    (certificate) => certificate.authority === "versionedIssuePatch:same_transaction",
  );
    assert.equal(livePatchCertificates.length, 4);
  assert.deepEqual(
    collectIssueWrites(process.cwd()).authorityCertificates.filter(
      (certificate) => certificate.authority === "versionedIssuePatch:same_transaction",
    ),
    livePatchCertificates,
  );
  const m004Certificate = livePatchCertificates.find((certificate) =>
    certificate.sinkKey.includes("cli/src/commands/worktree.ts") &&
    certificate.coverageKind === "accumulator_bulk_patch");
  assert.deepEqual(m004Certificate?.orderedPredicateKinds, ["eq", "inArray"]);
  const m009Certificate = livePatchCertificates.find(
      (certificate) => certificate.coverageKind === "derived_patch_wrapper",
    );
    assert.ok(m009Certificate?.memberProofNodes?.length > 0);
    const insertIssueCommentWrite = observed.find(
      (entry) =>
        entry.path === "server/src/services/issues.ts" &&
        entry.functionName === "insertIssueComment" &&
        entry.table === "issueComments",
    );
    assert.ok(insertIssueCommentWrite);
    assert.ok(insertIssueCommentWrite.sinkKey);
    assert.ok(Array.isArray(observed.authorityCertificates));
    const certificates = observed.authorityCertificates.filter(
      (certificate) => certificate.sinkKey === insertIssueCommentWrite.sinkKey,
    );
    assert.equal(certificates.length, 1);
    assert.equal(certificates[0].authority, "runIssueMutation:lexical");
    for (const certificate of certificates) {
      assert.equal(certificate.helperExport, "runIssueMutation");
      assert.equal(certificate.helperPath, "server/src/services/issue-versioning.ts");
      assert.equal(certificate.table, "issueComments");
      assert.equal(certificate.operation, "insert");
      assert.equal("callerSymbol" in certificate, false);
      assert.deepEqual(certificate.proofNodes, [...new Set(certificate.proofNodes)].sort());
    }
    const issuesAnalysis = observed.contractAnalyses.find(
      (analysis) => analysis.path === "server/src/services/issues.ts",
    );
    assert.ok(issuesAnalysis);
    for (const helperName of ["labelMapForIssues", "watchdogMapForIssues"]) {
      const helper = analyzedFunction(issuesAnalysis, helperName);
      assert.equal(helper.classification, "READ_ONLY");
      assert.deepEqual(helper.captureFacts.capabilityCaptures, []);
      assert.equal(helper.directReadRoots.length, 1);
      assert.equal(helper.terminalAwaits.length, 1);
    }
    const projector = issuesAnalysis.projectors.find(
      (candidate) => candidate.name === "withIssueLabels",
    );
    assert.deepEqual(
      {
        eligible: projector?.eligible,
        emptyGuard: projector?.emptyGuard,
        cardinality: projector?.cardinality,
        identityPreserving: projector?.identityPreserving,
        noIdOverwrite: projector?.noIdOverwrite,
        transactionEffect: projector?.transactionEffect,
      },
      {
        eligible: true,
        emptyGuard: true,
        cardinality: "PRESERVED",
        identityPreserving: true,
        noIdOverwrite: true,
        transactionEffect: "read-only",
      },
    );
    assert.equal(validateStrict(observed, catalog, { repoRoot: process.cwd() }).ok, true);
  });

function authorityFixture() {
  return [
    'import { issueComments } from "@paperclipai/db";',
    'import { runIssueMutation } from "./issue-versioning.js";',
    "async function readRows(T, rows) {",
    "  const values = await T.select().from(rows);",
    "  return values;",
    "}",
    "async function project(T, rows) {",
    "  if (rows.length === 0) return [];",
    "  const labels = await readRows(T, rows);",
    "  return rows.map((row) => ({ ...row, labels: labels.get?.(row.id) }));",
    "}",
    "function service(T) {",
    "  return {",
    "    update: async (id, data, TN) => {",
    "      const mutation = await runIssueMutation(TN, {",
    "        issueId: id,",
    "        mutate: async () => ({ result: null }),",
    "      });",
    "      if (!mutation) return null;",
    "      const [enriched] = await project(TN, [mutation.issue]);",
    "      return enriched;",
    "    },",
    "  };",
    "}",
    "async function insertComment(T, issue) {",
    "  return await T.insert(issueComments).values({ issueId: issue.id });",
    "}",
    "async function lexical(id, T) {",
    "  const mutation = await runIssueMutation(T, {",
    "    issueId: id,",
    "    mutate: async (TN, current) => ({ result: await insertComment(TN, current) }),",
    "  });",
    "  return mutation;",
    "}",
    "async function sequential(id, T) {",
    "  const updated = await service(T).update(id, {}, T);",
    "  if (!updated) return null;",
    "  return await insertComment(T, updated);",
    "}",
  ].join("\n");
}

test("C14 exact perturbations and all closed operand variants", () => {
  for (const [name, declaration, assignment, storage, expectedAlias] of [
    ["literal property", "const holder = { target: null };", "holder.target = issues;", "holder.target", "holder.target"],
    ["literal element", "const holder = { target: null };", 'holder["target"] = issues;', 'holder["target"]', 'holder["target"]'],
    ["computed element", 'const key = "target"; const holder = {};', "holder[key] = issues;", "holder[key]", "holder[key]"],
    ["nested property", "const outer = { inner: {} };", "outer.inner.target = issues;", "outer.inner.target", "outer.inner.target"],
    [
      "destructured property storage",
      "const bucket = {};",
      "({ value: bucket.slot } = { value: issues });",
      "bucket.slot",
      "bucket.slot",
    ],
  ]) {
    const source = [
      'import { issues } from "@paperclipai/db";',
      declaration,
      assignment,
      `await tx.update(${storage}).set({});`,
    ].join("\n");
    assert.throws(
      () => collectIssueWritesFromSource(CONTRACT_FILE, source),
      {
        name: "Error",
        message: `unsafe issue-table alias ${expectedAlias} in ${CONTRACT_FILE}`,
      },
      `governed property storage ${name}`,
    );
  }

  for (const [name, declaration, assignment, storage, expectedAlias] of [
    [
      "canonical receiver alias and literal keys",
      'const root = { foo: {} }; const alias = root; const first = "foo"; const second = "bar";',
      "alias[first][second] = issues;",
      "root.foo.bar",
      "alias[first][second]",
    ],
    [
      "canonical receiver alias chain",
      'const root = { foo: {} }; const firstAlias = root; const secondAlias = firstAlias; const key = "bar";',
      "secondAlias.foo[key] = issues;",
      'root["foo"].bar',
      "secondAlias.foo[key]",
    ],
    [
      "mixed literal and computed segments",
      'const root = { foo: {} }; const alias = root; const first = "foo";',
      'alias[first]["bar"] = issues;',
      "root.foo.bar",
      'alias[first]["bar"]',
    ],
    [
      "mutable receiver alias",
      'const root = { foo: {} }; let alias = root; const first = "foo";',
      "alias[first].bar = issues;",
      "root.foo.bar",
      "alias[first].bar",
    ],
    [
      "dynamic wildcard prefix",
      'const root = { foo: {} }; const alias = root; let key = "foo";',
      "alias[key] = issues;",
      "root.foo.bar",
      "alias[key]",
    ],
  ]) {
    const source = [
      'import { issues } from "@paperclipai/db";',
      declaration,
      assignment,
      `await tx.update(${storage}).set({});`,
    ].join("\n");
    assert.throws(
      () => collectIssueWritesFromSource(CONTRACT_FILE, source),
      {
        name: "Error",
        message: `unsafe issue-table alias ${expectedAlias} in ${CONTRACT_FILE}`,
      },
      `governed canonical storage ${name}`,
    );
  }

  const distinctLiteralStorage = [
    'import { issues } from "@paperclipai/db";',
    'const root = { foo: {}, other: {} }; const alias = root; const key = "foo";',
    "alias[key].bar = issues;",
    "await tx.update(root.other.bar).set({});",
  ].join("\n");
  assert.deepEqual(
    collectIssueWritesFromSource(CONTRACT_FILE, distinctLiteralStorage),
    [],
    "immutable literal key does not poison a distinct exact path",
  );

  const patchTransactionSource = (declarations, body) => [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq } from "drizzle-orm";',
    declarations,
    "await db.transaction(async (T) => {",
    body,
    "});",
  ].filter(Boolean).join("\n");
  const patchCertificates = (source) => {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, source);
    return writes.authorityCertificates.filter(
      (certificate) => certificate.authority === "versionedIssuePatch:same_transaction",
    );
  };
  for (const [name, declarations, body] of [
    [
      "comment before patch",
      "",
      '  await T.insert(issueComments).values({ issueId: "child-B" });\n' +
        '  await T.update(issues).set(versionedIssuePatch({ id: "parent-A" }));',
    ],
    [
      "mismatched literals",
      "",
      '  await T.update(issues).set(versionedIssuePatch({ id: "parent-A" }));\n' +
        '  await T.insert(issueComments).values({ issueId: "child-B" });',
    ],
    [
      "different immutable bindings",
      'const updatedId = "same"; const commentId = "same";',
      "  await T.update(issues).set(versionedIssuePatch({ id: updatedId }));\n" +
        "  await T.insert(issueComments).values({ issueId: commentId });",
    ],
    [
      "different member paths",
      "const issue = { id: 'same', parentId: 'same' };",
      "  await T.update(issues).set(versionedIssuePatch({ id: issue.id }));\n" +
        "  await T.insert(issueComments).values({ issueId: issue.parentId });",
    ],
    [
      "mutable identity alias",
      'let issueId = "same";',
      "  await T.update(issues).set(versionedIssuePatch({ id: issueId }));\n" +
        '  issueId = "other";\n' +
        "  await T.insert(issueComments).values({ issueId });",
    ],
    [
      "computed identity",
      "const issue = { id: 'same' }; const key = 'id';",
      "  await T.update(issues).set(versionedIssuePatch({ id: issue[key] }));\n" +
        "  await T.insert(issueComments).values({ issueId: issue.id });",
    ],
    [
      "conditional patch",
      'const issueId = "same";',
      "  if (flag) await T.update(issues).set(versionedIssuePatch({ id: issueId }));\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
    [
      "concurrent patch",
      'const issueId = "same";',
      "  await Promise.all([\n" +
        "    T.update(issues).set(versionedIssuePatch({ id: issueId })),\n" +
        "    T.insert(issueComments).values({ issueId }),\n" +
        "  ]);",
    ],
    [
      "unknown intervening effect",
      'const issueId = "same";',
      "  await T.update(issues).set(versionedIssuePatch({ id: issueId }));\n" +
        "  await evil(T);\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
  ]) {
    assert.deepEqual(
      patchCertificates(patchTransactionSource(declarations, body)),
      [],
      `patch authority ${name}`,
    );
  }
  for (const [name, declarations, body] of [
    [
      "same immutable symbol",
      'const issueId = "same";',
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
    [
      "same exact member path",
      "const issue = { id: 'same' };",
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issue.id));\n" +
        "  await T.insert(issueComments).values({ issueId: issue.id });",
    ],
  ]) {
    const certificates = patchCertificates(patchTransactionSource(declarations, body));
    assert.equal(certificates.length, 1, `patch authority positive ${name}`);
    assert.match(certificates[0].issueKeyEvidence, /^(?:SYM:|MEM:)/);
  }

  const exactPatchCertificate = (source, options = {}) => {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, source, options);
    const comment = writes.find((write) => write.table === "issueComments");
    assert.ok(comment, "fixture must contain one governed comment write");
    const certificates = writes.authorityCertificates.filter(
      (certificate) =>
        certificate.sinkKey === comment.sinkKey &&
        certificate.authority === "versionedIssuePatch:same_transaction",
    );
    return { writes, comment, certificates };
  };
  const transactionCallback = (source) => {
    const sourceFile = ts.createSourceFile(
      CONTRACT_FILE,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let callback = null;
    function visit(node) {
      if (
        !callback &&
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "transaction"
      ) {
        const candidate = node.arguments.find((argument) =>
          ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
        if (candidate) callback = candidate;
      }
      if (!callback) ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    assert.ok(callback && ts.isBlock(callback.body), "fixture transaction callback");
    return { callback, sourceFile };
  };
  const exactReturnExitKeys = (source) => {
    const { callback } = transactionCallback(source);
    const exits = [];
    function visit(node) {
      if (node !== callback.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) exits.push(scanner.nodeKey(CONTRACT_FILE, node));
      ts.forEachChild(node, visit);
    }
    visit(callback.body);
    return exits.sort();
  };
  const exactFallthroughExitKey = (source) =>
    scanner.nodeKey(CONTRACT_FILE, transactionCallback(source).callback.body);
  const directAfter = patchTransactionSource(
    'const issueId = "same";',
    "  await T.insert(issueComments).values({ issueId });\n" +
      "  await T.update(issues)\n" +
      "    .set(versionedIssuePatch({}))\n" +
      "    .where(eq(issues.id, issueId));",
  );
  const directAfterResult = exactPatchCertificate(directAfter);
  assert.equal(directAfterResult.certificates.length, 1);
  assert.equal(directAfterResult.certificates[0].coverageKind, "direct_patch");
  assert.equal(directAfterResult.certificates[0].scopeKind, "ExactIssue");
  assert.match(directAfterResult.certificates[0].issueKeyEvidence, /^SYM:/);
  assert.ok(directAfterResult.certificates[0].normalExitKeys.length > 0);

  const directAfterGap = exactPatchCertificate(
    directAfter.replace(
      "  await T.update(issues)",
      "  if (skip) return null;\n  await T.update(issues)",
    ),
  );
  assert.deepEqual(directAfterGap.certificates, []);
  const unawaitedAfter = exactPatchCertificate(
    directAfter.replace("  await T.update(issues)", "  T.update(issues)"),
  );
  assert.deepEqual(unawaitedAfter.certificates, []);
  const unknownAfterCoverage = exactPatchCertificate(
    directAfter.replace(
      "    .where(eq(issues.id, issueId));",
      "    .where(eq(issues.id, issueId));\n  await evil(T);",
    ),
  );
  assert.deepEqual(unknownAfterCoverage.certificates, []);
  const memberMutationAfterCoverage = exactPatchCertificate(
    patchTransactionSource(
      "const issue = { id: 'same' };",
      "  await T.insert(issueComments).values({ issueId: issue.id });\n" +
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issue.id));\n" +
        '  issue.id = "other";',
    ),
  );
  assert.deepEqual(memberMutationAfterCoverage.certificates, []);
  const finallyCoverage = patchTransactionSource(
    'const issueId = "same";',
    "  try {\n" +
      "    await T.insert(issueComments).values({ issueId });\n" +
      "  } finally {\n" +
      "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  }",
  );
  assert.equal(exactPatchCertificate(finallyCoverage).certificates.length, 1);
  const conditionalFinally = finallyCoverage.replace(
    "    await T.update(issues)",
    "    if (flag) await T.update(issues)",
  );
  assert.deepEqual(exactPatchCertificate(conditionalFinally).certificates, []);

  const rootADirectNegatives = new Map([
    [
      "finally invalidation after direct coverage",
      patchTransactionSource(
        'const issueId = "same";',
        "  try {\n" +
          "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "    await T.insert(issueComments).values({ issueId });\n" +
          "  } finally {\n" +
          '    await T.raw("select 1");\n' +
          "  }",
      ),
    ],
    [
      "conditional continue before direct coverage",
      patchTransactionSource(
        'const issueId = "same";',
        "  for (const item of items) {\n" +
          "    await T.insert(issueComments).values({ issueId });\n" +
          "    if (item.skip) continue;\n" +
          "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "  }",
      ),
    ],
    [
      "unknown transaction receiver member between coverage and sink",
      patchTransactionSource(
        'const issueId = "same";',
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "  await T.mysterySideEffect();\n" +
          "  await T.insert(issueComments).values({ issueId });",
      ),
    ],
    [
      "query capability between coverage and sink",
      patchTransactionSource(
        'const issueId = "same";',
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "  const query = T.select();\n" +
          "  await unknownEffect(query);\n" +
          "  await T.insert(issueComments).values({ issueId });",
      ),
    ],
    [
      "rollback in finally",
      patchTransactionSource(
        'const issueId = "same";',
        "  try {\n" +
          "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "    await T.insert(issueComments).values({ issueId });\n" +
          "  } finally {\n" +
          "    await T.rollback();\n" +
          "  }",
      ),
    ],
    [
      "conditional break before coverage",
      patchTransactionSource(
        'const issueId = "same";',
        "  for (const item of items) {\n" +
          "    await T.insert(issueComments).values({ issueId });\n" +
          "    if (item.skip) break;\n" +
          "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "  }",
      ),
    ],
    [
      "zero-iteration loop cannot manufacture coverage",
      patchTransactionSource(
        'const issueId = "same";',
        "  while (false) {\n" +
          "    await T.insert(issueComments).values({ issueId });\n" +
          "  }\n" +
          "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));",
      ),
    ],
    [
      "nested-loop continuation gap",
      patchTransactionSource(
        'const issueId = "same";',
        "  for (const outer of items) {\n" +
          "    for (const inner of outer.items) {\n" +
          "      await T.insert(issueComments).values({ issueId });\n" +
          "      if (inner.skip) continue;\n" +
          "      await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
          "    }\n" +
          "  }",
      ),
    ],
  ]);
  for (const [name, source] of rootADirectNegatives) {
    const result = exactPatchCertificate(source);
    assert.deepEqual(result.certificates, [], name);
    const [obligation] = result.writes.contractAnalysis.patchObligations;
    assert.equal(obligation.status, "REJECT", `${name} obligation`);
    const expectedExit = [exactFallthroughExitKey(source)];
    if (name === "zero-iteration loop cannot manufacture coverage") {
      assert.deepEqual(obligation.unseenExitKeys, expectedExit, `${name} unseen exit`);
    } else if (
      name.includes("continue") ||
      name.includes("continuation") ||
      name.includes("break") ||
      name.includes("between coverage and sink")
    ) {
      assert.deepEqual(obligation.pendingExitKeys, expectedExit, `${name} pending exit`);
    } else {
      assert.deepEqual(
        obligation.invalidatedExitKeys,
        expectedExit,
        `${name} invalidated exit`,
      );
      assert.ok(obligation.invalidationNodeKeys.length > 0, `${name} invalidation`);
    }
  }

  const transactionEvidenceNegatives = [
    ["constructor argument", "  new Box(T);", ts.SyntaxKind.NewExpression],
    ["constructor callee", "  new T.Box();", ts.SyntaxKind.NewExpression],
    ["tag substitution", "  tag`${T}`;", ts.SyntaxKind.TaggedTemplateExpression],
    ["tag position", "  T`value`;", ts.SyntaxKind.TaggedTemplateExpression],
    ["global property storage", "  globalThis.saved = T;", ts.SyntaxKind.Identifier],
    ["property storage", "  holder.tx = T;", ts.SyntaxKind.Identifier],
    ["element storage", '  holder["tx"] = T;', ts.SyntaxKind.Identifier],
    ["object storage", "  const holder = { tx: T };", ts.SyntaxKind.Identifier],
    ["array storage", "  const holder = [T];", ts.SyntaxKind.Identifier],
    ["spread storage", "  const holder = [...[T]];", ts.SyntaxKind.Identifier],
    ["escaped nested capture", "  globalThis.saved = () => T;", ts.SyntaxKind.ArrowFunction],
    ["non-escaping nested capture", "  const read = () => T;", ts.SyntaxKind.ArrowFunction],
    [
      "nested write capture",
      "  const write = () => T.update(issues).set({});",
      ts.SyntaxKind.ArrowFunction,
    ],
    ["void residual", "  void T;", ts.SyntaxKind.Identifier],
    ["binary residual", "  T + 1;", ts.SyntaxKind.Identifier],
    ["comma residual", "  (0, T);", ts.SyntaxKind.Identifier],
    ["return escape", "  return T;", ts.SyntaxKind.Identifier],
    [
      "yield dependency",
      "  function* spill(TN) { yield TN; }\n  await spill(T);",
      ts.SyntaxKind.CallExpression,
    ],
    [
      "stored alias passed unknown",
      "  const holder = { tx: T };\n  await evil(holder);",
      ts.SyntaxKind.Identifier,
    ],
    [
      "query builder passed unknown",
      "  const query = T.select();\n  await evil(query);",
      ts.SyntaxKind.CallExpression,
    ],
    [
      "query intermediate escape",
      "  const query = T.select();\n  const intermediate = query.from(issues);\n" +
        "  await evil(intermediate);",
      ts.SyntaxKind.CallExpression,
    ],
  ];
  for (const [name, effect, expectedKind] of transactionEvidenceNegatives) {
    const source = patchTransactionSource(
      'const issueId = "same"; const holder = {};',
      "  await T.insert(issueComments).values({ issueId });\n" +
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        `${effect}\n` +
        (effect.includes("return ") ? "" : "  return true;"),
    );
    const result = exactPatchCertificate(source);
    assert.deepEqual(result.certificates, [], name);
    const [obligation] = result.writes.contractAnalysis.patchObligations;
    assert.equal(obligation.status, "REJECT", `${name} obligation`);
    assert.deepEqual(
      obligation.invalidatedExitKeys,
      exactReturnExitKeys(source),
      `${name} exits`,
    );
    assert.ok(obligation.invalidationNodeKeys.length > 0, `${name} evidence`);
    assert.equal(
      obligation.invalidationNodeKeys.length,
      new Set(obligation.invalidationNodeKeys).size,
      `${name} unique evidence`,
    );
    assert.deepEqual(
      obligation.invalidationNodeKeys,
      [...obligation.invalidationNodeKeys].sort(),
      `${name} evidence order`,
    );
    const { sourceFile } = transactionCallback(source);
    const invalidationKinds = [];
    const collectInvalidationKinds = (node) => {
      if (obligation.invalidationNodeKeys.includes(scanner.nodeKey(CONTRACT_FILE, node))) {
        invalidationKinds.push(node.kind);
      }
      ts.forEachChild(node, collectInvalidationKinds);
    };
    collectInvalidationKinds(sourceFile);
    assert.ok(
      invalidationKinds.includes(expectedKind),
      `${name} exact node ${JSON.stringify({ invalidationKinds, expectedKind, keys: obligation.invalidationNodeKeys })}`,
    );
  }

  const preSinkEvidence = patchTransactionSource(
    'const issueId = "same";',
    "  new Box(T);\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  await T.insert(issueComments).values({ issueId });\n" +
      "  return true;",
  );
  assert.equal(
    exactPatchCertificate(preSinkEvidence).certificates.length,
    1,
    "pre-obligation evidence does not sticky-invalidate",
  );
  const preSinkStoragePoison = patchTransactionSource(
    'const issueId = "same";',
    "  globalThis.saved = T;\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  await T.insert(issueComments).values({ issueId });\n" +
      "  return true;",
  );
  const preSinkStoragePoisonResult = exactPatchCertificate(preSinkStoragePoison);
  assert.deepEqual(
    preSinkStoragePoisonResult.certificates,
    [],
    "pre-obligation transaction storage poisons later use",
  );
  assert.deepEqual(
    preSinkStoragePoisonResult.writes.contractAnalysis.patchObligations[0]
      .invalidatedExitKeys,
    exactReturnExitKeys(preSinkStoragePoison),
    "storage poison is sticky through the normal exit",
  );
  const preSinkStoredAlias = patchTransactionSource(
    'const issueId = "same";',
    "  const escaped = { tx: T };\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  await T.insert(issueComments).values({ issueId });\n" +
      "  await evil(escaped);\n" +
      "  return true;",
  );
  const preSinkStoredAliasResult = exactPatchCertificate(preSinkStoredAlias);
  assert.deepEqual(
    preSinkStoredAliasResult.certificates,
    [],
    "stored capability remains mapped to its source transaction",
  );
  assert.ok(
    preSinkStoredAliasResult.writes.contractAnalysis.patchObligations[0]
      .invalidationNodeKeys.length > 0,
    "stored capability unknown call has positional evidence",
  );
  const postSinkReadOnly = patchTransactionSource(
    'const issueId = "same";',
    "  await T.insert(issueComments).values({ issueId });\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  const rows = await T.select({ id: issues.id }).from(issues);\n" +
      "  return rows;",
  );
  assert.equal(
    exactPatchCertificate(postSinkReadOnly).certificates.length,
    1,
    "exact read-only query preserves a covered obligation",
  );
  const postSinkReadOnlyDependency = patchTransactionSource(
    'const issueId = "same";\n' +
      "async function readOnly(TN) {\n" +
      "  const rows = await TN.select({ id: issues.id }).from(issues);\n" +
      "  return rows;\n" +
      "}",
    "  await T.insert(issueComments).values({ issueId });\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  const rows = await readOnly(T);\n" +
      "  return rows;",
  );
  assert.equal(
    exactPatchCertificate(postSinkReadOnlyDependency).certificates.length,
    1,
    "exact READ_ONLY dependency preserves a covered obligation",
  );

  for (const [name, body] of [
    [
      "caught throw rejoins covered path",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        '    if (fail) throw new Error("retry");\n' +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch {\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  }",
    ],
    [
      "known select remains safe",
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  await T.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId));\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
    [
      "pre-sink ordinary unknown does not poison later obligation",
      "  await ordinaryUnknown();\n" +
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
    [
      "pre-sink transaction call is superseded by later exact coverage",
      "  await unknownEffect(T);\n" +
        "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  await T.insert(issueComments).values({ issueId });",
    ],
  ]) {
    const source = patchTransactionSource('const issueId = "same";', body);
    assert.equal(exactPatchCertificate(source).certificates.length, 1, name);
  }

  for (const [name, body] of [
    [
      "post-sink rejecting call reaches normal catch",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await mayReject();\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "rejecting patch reaches normal catch with pending sink",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "post-sink select rejection reaches normal catch",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await T.select({ id: issues.id }).from(issues);\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "nested catch and finally preserve pending rejection state",
      "  try {\n" +
        "    try {\n" +
        "      await T.insert(issueComments).values({ issueId });\n" +
        "      await mayReject();\n" +
        "      await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "    } catch { return null; }\n" +
        "  } finally { observe(); }",
    ],
    [
      "post-sink awaited constructor rejection",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await new Task();\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "post-sink awaited tag rejection",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await tag`value`;\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "post-sink awaited thenable rejection",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await maybeThenable;\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
    [
      "post-sink synchronous call throw",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    mayThrow();\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch { return null; }",
    ],
  ]) {
    const source = patchTransactionSource('const issueId = "same";', body);
    assert.deepEqual(
      exactPatchCertificate(source).certificates,
      [],
      `exceptional edge ${name}`,
    );
  }
  for (const [name, body] of [
    [
      "rejecting sink creates no committed obligation",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "  } finally {\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  }",
    ],
    [
      "catch supplies exact patch",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await mayReject();\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch {\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  }",
    ],
    [
      "caught rejection rethrows pending obligation",
      "  try {\n" +
        "    await T.insert(issueComments).values({ issueId });\n" +
        "    await mayReject();\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  } catch (error) { throw error; }",
    ],
    [
      "nested finally supplies patch before outer catch",
      "  try {\n" +
        "    try {\n" +
        "      await T.insert(issueComments).values({ issueId });\n" +
        "      await mayReject();\n" +
        "    } finally {\n" +
        "      await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "    }\n" +
        "  } catch {\n" +
        "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
        "  }",
    ],
  ]) {
    const source = patchTransactionSource('const issueId = "same";', body);
    assert.equal(
      exactPatchCertificate(source).certificates.length,
      1,
      `exceptional edge positive ${name}`,
    );
  }
  const readOnlyHelperRejects = patchTransactionSource(
    'const issueId = "same";\n' +
      "async function readOnly(T) { const rows = await T.select().from(issues); return rows; }",
    "  try {\n" +
      "    await T.insert(issueComments).values({ issueId });\n" +
      "    await readOnly(T);\n" +
      "    await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  } catch { return null; }",
  );
  assert.deepEqual(
    exactPatchCertificate(readOnlyHelperRejects).certificates,
    [],
    "exceptional edge read-only helper rejection",
  );

  const twoReturnExits = patchTransactionSource(
    'const issueId = "same";',
    "  await T.insert(issueComments).values({ issueId });\n" +
      "  await T.update(issues).set(versionedIssuePatch({})).where(eq(issues.id, issueId));\n" +
      "  if (flag) return 1;\n" +
      "  return 2;",
  );
  assert.deepEqual(
    exactPatchCertificate(twoReturnExits).certificates[0].normalExitKeys,
    exactReturnExitKeys(twoReturnExits),
    "complete committing return exits",
  );

  const accumulatorFixture = (terminalPredicate) => [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { and, eq, inArray } from "drizzle-orm";',
    "async function apply(db, companyId, comments) {",
    "  return db.transaction(async (connection) => {",
    "    const touched = new Set();",
    "    for (const comment of comments) {",
    "      const parent = await connection.select({ id: issues.id }).from(issues)",
    "        .where(and(eq(issues.id, comment.issueId), eq(issues.companyId, companyId)))",
    "        .then((rows) => rows[0] ?? null);",
    "      if (!parent) continue;",
    "      await connection.insert(issueComments).values({",
    "        companyId, issueId: comment.issueId, body: comment.body,",
    "      });",
    "      touched.add(comment.issueId);",
    "    }",
    "    if (touched.size > 0) {",
    "      await connection.update(issues).set(versionedIssuePatch({}))",
    `        .where(${terminalPredicate});`,
    "    }",
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  for (const [name, predicate, order] of [
    [
      "bare set",
      "inArray(issues.id, [...touched])",
      ["inArray"],
    ],
    [
      "set then tenant",
      "and(inArray(issues.id, [...touched]), eq(issues.companyId, companyId))",
      ["inArray", "eq"],
    ],
    [
      "tenant then set",
      "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ["eq", "inArray"],
    ],
  ]) {
    const { certificates } = exactPatchCertificate(accumulatorFixture(predicate));
    assert.equal(certificates.length, 1, name);
    assert.equal(certificates[0].coverageKind, "accumulator_bulk_patch", name);
    assert.deepEqual(certificates[0].orderedPredicateKinds, order, name);
  }
  for (const [name, predicate] of [
    ["extra conjunct", "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]), eq(issues.id, commentId))"],
    ["nested conjunct", "and(eq(issues.companyId, companyId), and(inArray(issues.id, [...touched])))"],
    ["wrong column", "and(eq(issues.companyId, companyId), inArray(issues.companyId, [...touched]))"],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(accumulatorFixture(predicate)).certificates,
      [],
      name,
    );
  }
  assert.deepEqual(
    exactPatchCertificate(
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace(
        "      touched.add(comment.issueId);",
        "      if (record) touched.add(comment.issueId);",
      ),
    ).certificates,
    [],
    "accumulator branch gap",
  );
  assert.deepEqual(
    exactPatchCertificate(
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace(
        "and(eq(issues.id, comment.issueId), eq(issues.companyId, companyId))",
        "and(eq(issues.companyId, companyId), eq(issues.id, comment.issueId))",
      ),
    ).certificates,
    [],
    "accumulator reverse parent predicate",
  );
  for (const [name, changed] of [
    [
      "foreign parent query receiver",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace("connection.select({ id: issues.id })", "other.select({ id: issues.id })"),
    ],
    [
      "wrong parent projection",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace("select({ id: issues.id })", "select({ id: issueComments.id })"),
    ],
    [
      "wrong parent table",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace(".from(issues)", ".from(issueComments)"),
    ],
    [
      "missing parent result transform",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace("\n        .then((rows) => rows[0] ?? null)", ""),
    ],
    [
      "changed parent result index",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace("rows[0] ?? null", "rows[1] ?? null"),
    ],
    [
      "parent binding escape",
      accumulatorFixture(
        "and(eq(issues.companyId, companyId), inArray(issues.id, [...touched]))",
      ).replace(
        "      if (!parent) continue;",
        "      auditUnknown(parent);\n      if (!parent) continue;",
      ),
    ],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(changed).certificates,
      [],
      `causal parent ${name}`,
    );
  }

  const wrapperModulePath = "server/src/services/issue-versioning.ts";
  const wrapperModule = [
    'import { inArray } from "drizzle-orm";',
    'import { issues, versionedIssuePatch } from "@paperclipai/db";',
    'export { versionedIssuePatch } from "@paperclipai/db";',
    "export async function advance(connection, issueIds, now = new Date()) {",
    "  const distinctIds = [...new Set(issueIds)];",
    "  if (distinctIds.length === 0) return [];",
    "  return await connection.update(issues).set(versionedIssuePatch({}, now))",
    "    .where(inArray(issues.id, distinctIds))",
    "    .returning({ id: issues.id }).then((rows) => rows.map((row) => row.id));",
    "}",
  ].join("\n");
  const wrapperOptions = {
    resolveNamedImport: contractResolver,
    resolveModuleSource: (_importer, moduleSpecifier) =>
      moduleSpecifier === "./issue-versioning.js"
        ? { path: wrapperModulePath, source: wrapperModule }
        : null,
  };
  const wrapperFixture = (arrayExpression = "[issueId]") => [
    'import { issues, issueComments } from "@paperclipai/db";',
    'import { advance } from "./issue-versioning.js";',
    "async function apply(db, issueId, otherId, ids) {",
    "  return db.transaction(async (connection) => {",
    "    await connection.insert(issueComments).values({ issueId });",
    `    await advance(connection, ${arrayExpression});`,
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  for (const [arrayExpression, expectedScope, expectedMembers] of [
    ["[]", "ExactIssueSet", 0],
    ["[issueId]", "ExactIssue", 1],
    ["[issueId, otherId]", "ExactIssue", 2],
    ["[issueId, issueId]", "ExactIssue", 2],
  ]) {
    const result = exactPatchCertificate(wrapperFixture(arrayExpression), wrapperOptions);
    if (arrayExpression === "[]") {
      assert.deepEqual(result.certificates, [], "empty set cannot cover the issue");
      assert.equal(result.writes.contractAnalysis.setSummaries?.[0]?.memberFacts.length, 0);
      continue;
    }
    assert.equal(result.certificates.length, 1, arrayExpression);
    assert.equal(result.certificates[0].coverageKind, "derived_patch_wrapper");
    assert.equal(result.certificates[0].scopeKind, expectedScope);
    assert.equal(
      result.writes.contractAnalysis.setSummaries.find(
        (summary) => summary.memberFacts.length === expectedMembers,
      )?.memberFacts.length,
      expectedMembers,
    );
  }
  for (const [name, arrayExpression] of [
    ["spread", "[...ids]"],
    ["hole", "[issueId, , otherId]"],
    ["computed", "[lookup()]"],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(wrapperFixture(arrayExpression), wrapperOptions).certificates,
      [],
      `finite array ${name}`,
    );
  }
  for (const [name, changedBody] of [
    ["changed dedup", wrapperModule.replace("[...new Set(issueIds)]", "issueIds.filter(Boolean)")],
    ["changed empty return", wrapperModule.replace("return []", "return issueIds")],
    ["missing await", wrapperModule.replace("return await connection.update", "return connection.update")],
    ["missing re-export", wrapperModule.replace('export { versionedIssuePatch } from "@paperclipai/db";', "")],
    ["shadowed Set", `const Set = FakeSet;\n${wrapperModule}`],
    ["parameter-shadowed Set", wrapperModule.replace(
      "function advance(connection, issueIds, now = new Date())",
      "function advance(connection, issueIds, Set, now = new Date())",
    )],
    ["capability-bearing default", wrapperModule.replace(
      "now = new Date()",
      "now = connection",
    )],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(wrapperFixture(), {
        ...wrapperOptions,
        resolveModuleSource: () => ({ path: wrapperModulePath, source: changedBody }),
      }).certificates,
      [],
      `wrapper ${name}`,
    );
  }
  for (const [name, invocation] of [
    [
      "extra property assignment capability",
      "advance(connection, [issueId], (holder.tx = connection))",
    ],
    ["duplicate transaction capability", "advance(connection, [issueId], connection)"],
    ["nested object capability", "advance(connection, [issueId], { tx: connection })"],
    ["nested array capability", "advance(connection, [issueId], [connection])"],
    ["spread capability", "advance(connection, [issueId], ...[connection])"],
    ["property capability", "advance(connection, [issueId], connection.session)"],
    ["query capability", "advance(connection, [issueId], connection.select())"],
    ["capability-free constructor", "advance(connection, [issueId], new Date())"],
    ["optional wrapper call", "advance?.(connection, [issueId], new Date())"],
  ]) {
    const changed = wrapperFixture().replace(
      "advance(connection, [issueId])",
      invocation,
    );
    assert.deepEqual(
      exactPatchCertificate(changed, wrapperOptions).certificates,
      [],
      `wrapper argument ${name}`,
    );
  }
  for (const [name, invocation] of [
    ["ordinary default omitted", "advance(connection, [issueId])"],
    ["capability-free literal", 'advance(connection, [issueId], "2026-08-01")'],
  ]) {
    const changed = wrapperFixture().replace(
      "advance(connection, [issueId])",
      invocation,
    );
    assert.equal(
      exactPatchCertificate(changed, wrapperOptions).certificates.length,
      1,
      `wrapper argument positive ${name}`,
    );
  }
  const memberWrapperFixture = wrapperFixture("[issue.id]")
    .replace("issueId, otherId, ids", "issue, otherId, ids")
    .replace("values({ issueId })", "values({ issueId: issue.id })");
  for (const [name, changed] of [
    [
      "member path assignment",
      memberWrapperFixture.replace(
        "    await advance(connection, [issue.id]);",
        '    issue.id = "other";\n    await advance(connection, [issue.id]);',
      ),
    ],
    [
      "member root escape",
      memberWrapperFixture.replace(
        "    await advance(connection, [issue.id]);",
        "    stash.push(issue);\n    await advance(connection, [issue.id]);",
      ),
    ],
    [
      "member root mutable storage alias",
      memberWrapperFixture.replace(
        "    await advance(connection, [issue.id]);",
        "    holder.current = issue;\n    await advance(connection, [issue.id]);",
      ),
    ],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(changed, wrapperOptions).certificates,
      [],
      `wrapper membership ${name}`,
    );
  }
  const prefixMemberWrapperFixture = wrapperFixture("[issue.meta.id]")
    .replace("issueId, otherId, ids", "issue, otherId, ids")
    .replace("values({ issueId })", "values({ issueId: issue.meta.id })");
  const deepPrefixMemberWrapperFixture = wrapperFixture("[issue.meta.deep.id]")
    .replace("issueId, otherId, ids", "issue, otherId, ids")
    .replace("values({ issueId })", "values({ issueId: issue.meta.deep.id })");
  for (const [name, inserted, fixture = prefixMemberWrapperFixture] of [
    [
      "prefix alias mutation",
      '    const segment = issue.meta;\n    segment.id = "other";',
    ],
    [
      "deeper prefix alias chain mutation",
      "    const segment = issue.meta;\n" +
        "    const deeper = segment.deep;\n" +
        '    deeper.id = "other";',
      deepPrefixMemberWrapperFixture,
    ],
    [
      "element prefix alias mutation",
      '    const segment = issue["meta"];\n    segment["id"] = "other";',
    ],
    [
      "prefix alias escape",
      "    const segment = issue.meta;\n    holder.current = segment;",
    ],
    [
      "prefix alias unknown call",
      "    const segment = issue.meta;\n    auditUnknown(segment);",
    ],
    [
      "alias-of-alias mutation",
      "    const segment = issue.meta;\n" +
        "    const second = segment;\n" +
        '    second.id = "other";',
    ],
    [
      "prefix alias nested capture",
      "    const segment = issue.meta;\n" +
        "    const nested = () => segment.id;",
    ],
    [
      "direct root nested mutation",
      '    issue.meta.id = "other";',
    ],
    [
      "direct root prefix replacement",
      "    issue.meta = { id: issue.meta.id };",
    ],
    [
      "root prefix unknown call",
      "    auditUnknown(issue.meta);",
    ],
  ]) {
    const invocation = fixture === deepPrefixMemberWrapperFixture
      ? "    await advance(connection, [issue.meta.deep.id]);"
      : "    await advance(connection, [issue.meta.id]);";
    const changed = fixture.replace(
      invocation,
      `${inserted}\n${invocation}`,
    );
    assert.deepEqual(
      exactPatchCertificate(changed, wrapperOptions).certificates,
      [],
      `member prefix ${name}`,
    );
  }
  for (const [name, inserted] of [
    ["no alias", ""],
    [
      "immutable read-only prefix alias",
      "    const segment = issue.meta;\n    const observed = segment.id;",
    ],
  ]) {
    const changed = inserted
      ? prefixMemberWrapperFixture.replace(
          "    await advance(connection, [issue.meta.id]);",
          `${inserted}\n    await advance(connection, [issue.meta.id]);`,
        )
      : prefixMemberWrapperFixture;
    assert.equal(
      exactPatchCertificate(changed, wrapperOptions).certificates.length,
      1,
      `member prefix positive ${name}`,
    );
  }
  const wrapperAfterUnknownEffect = wrapperFixture().replace(
    "    return true;",
    "    await unknownEffect(connection);\n    return true;",
  );
  const wrapperAfterUnknown = exactPatchCertificate(
    wrapperAfterUnknownEffect,
    wrapperOptions,
  );
  assert.deepEqual(
    wrapperAfterUnknown.certificates,
    [],
    "wrapper coverage followed by transaction invalidation",
  );
  assert.deepEqual(
    wrapperAfterUnknown.writes.contractAnalysis.patchObligations.map(({ status }) => status),
    ["REJECT"],
  );
  const [wrapperInvalidation] =
    wrapperAfterUnknown.writes.contractAnalysis.patchObligations;
  assert.deepEqual(
    wrapperInvalidation.invalidatedExitKeys,
    exactReturnExitKeys(wrapperAfterUnknownEffect),
  );
  assert.equal(wrapperInvalidation.invalidationNodeKeys.length, 1);
  const localWrapperFixture = [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq, inArray } from "drizzle-orm";',
    "async function advanceLocal(connection, issueIds) {",
    "  const distinctIds = [...new Set(issueIds)];",
    "  if (distinctIds.length === 0) return [];",
    "  return await connection.update(issues).set(versionedIssuePatch({}))",
    "    .where(inArray(issues.id, distinctIds))",
    "    .returning({ id: issues.id }).then((rows) => rows.map((row) => row.id));",
    "}",
    "async function apply(db, issueId) {",
    "  return db.transaction(async (connection) => {",
    "    await connection.insert(issueComments).values({ issueId });",
    "    await advanceLocal(connection, [issueId]);",
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  const localWrapper = exactPatchCertificate(localWrapperFixture);
  assert.equal(localWrapper.certificates.length, 1);
  assert.equal(localWrapper.certificates[0].coverageKind, "derived_patch_wrapper");
  assert.equal(
    localWrapper.certificates[0].helperPath,
    "packages/db/src/issue-versioning.ts",
  );
  const dangerousWrapperDefault = wrapperModule.replace(
    "now = new Date()",
    'now = connection.raw("UPDATE issues SET version=0")',
  );
  assert.deepEqual(
    exactPatchCertificate(
      wrapperFixture(),
      {
        ...wrapperOptions,
        resolveModuleSource: () => ({
          path: wrapperModulePath,
          source: dangerousWrapperDefault,
        }),
      },
    ).certificates,
    [],
    "derived wrapper omitted dangerous initializer",
  );
  assert.deepEqual(
    exactPatchCertificate(
      wrapperFixture().replace(
        "await advance(connection, [issueId]);",
        "await advance(connection, [issueId], undefined);",
      ),
      {
        ...wrapperOptions,
        resolveModuleSource: () => ({
          path: wrapperModulePath,
          source: dangerousWrapperDefault,
        }),
      },
    ).certificates,
    [],
    "derived wrapper explicit undefined initializer",
  );
  assert.equal(
    exactPatchCertificate(
      wrapperFixture().replace(
        "await advance(connection, [issueId]);",
        "await advance(connection, [issueId], 1);",
      ),
      {
        ...wrapperOptions,
        resolveModuleSource: () => ({
          path: wrapperModulePath,
          source: dangerousWrapperDefault,
        }),
      },
    ).certificates.length,
    1,
    "derived wrapper supplied literal suppresses initializer",
  );

  const importedEffectPath = "server/src/services/foreign-effects.ts";
  const importedEffectFixture = (exportName) => [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq } from "drizzle-orm";',
    `import { ${exportName} } from "./foreign-effects.js";`,
    "async function apply(db, issueId) {",
    "  return db.transaction(async (connection) => {",
    "    await connection.insert(issueComments).values({ issueId });",
    "    await connection.update(issues).set(versionedIssuePatch({}))",
    "      .where(eq(issues.id, issueId));",
    `    await ${exportName}(connection);`,
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  const importedEffectOptions = (source) => ({
    resolveNamedImport: contractResolver,
    resolveModuleSource: (_importer, moduleSpecifier) =>
      moduleSpecifier === "./foreign-effects.js"
        ? { path: importedEffectPath, source }
        : null,
  });
  for (const [name, exportName, body] of [
    [
      "raw transaction member",
      "rawEffect",
      'export async function rawEffect(T) { await T.raw("UPDATE issues SET version=0"); }',
    ],
    [
      "execute transaction member",
      "executeEffect",
      'export async function executeEffect(T) { await T.execute("UPDATE issues SET version=0"); }',
    ],
    [
      "transaction escape",
      "escapeEffect",
      "export async function escapeEffect(T) { await unknownEffect(T); }",
    ],
    [
      "unknown transaction member",
      "unknownEffect",
      "export async function unknownEffect(T) { await T.mystery(); }",
    ],
    [
      "nested transaction capture",
      "nestedEffect",
      "export function nestedEffect(T) { const nested = () => T.select().from(source); return 1; }",
    ],
    [
      "unawaited transaction effect",
      "unawaitedEffect",
      "export function unawaitedEffect(T) { T.select().from(source); return 1; }",
    ],
    [
      "transaction rollback",
      "rollbackEffect",
      "export async function rollbackEffect(T) { await T.rollback(); }",
    ],
    [
      "nested transaction",
      "transactionEffect",
      "export async function transactionEffect(T) { await T.transaction(async () => 1); }",
    ],
  ]) {
    const result = exactPatchCertificate(
      importedEffectFixture(exportName),
      importedEffectOptions(body),
    );
    assert.deepEqual(result.certificates, [], `imported helper ${name}`);
    assert.deepEqual(
      result.writes.contractAnalysis.patchObligations.map(({ status }) => status),
      ["REJECT"],
      `imported helper ${name} obligation`,
    );
  }
  for (const [name, exportName, body, rewrite] of [
    [
      "transaction alias",
      "rawEffect",
      'export async function rawEffect(T) { await T.raw("UPDATE issues SET version=0"); }',
      (source) => source.replace(
        "    await rawEffect(connection);",
        "    const alias = connection;\n    await rawEffect(alias);",
      ),
    ],
    [
      "query capability argument",
      "noUseEffect",
      "export function noUseEffect(T, ordinary = 1) { return ordinary; }",
      (source) => source.replace(
        "noUseEffect(connection)",
        "noUseEffect(connection, connection.select())",
      ),
    ],
    [
      "nested query capability argument",
      "noUseEffect",
      "export function noUseEffect(T, ordinary = 1) { return ordinary; }",
      (source) => source.replace(
        "noUseEffect(connection)",
        "noUseEffect(connection, { query: connection.select() })",
      ),
    ],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(
        rewrite(importedEffectFixture(exportName)),
        importedEffectOptions(body),
      ).certificates,
      [],
      `imported helper ${name}`,
    );
  }
  const dangerousInitializerDefaults = [
    [
      "omitted update expression",
      "export async function indirect(T, ignored = state.value++) {}",
      "    await indirect(connection);",
    ],
    [
      "omitted property read",
      "export async function indirect(T, ignored = state.value) {}",
      "    await indirect(connection);",
    ],
    [
      "later parameter TDZ",
      "export async function indirect(T, ignored = later, later = 1) {}",
      "    await indirect(connection);",
    ],
    [
      "unresolved global",
      "export async function indirect(T, ignored = unresolvedGlobal) {}",
      "    await indirect(connection);",
    ],
    [
      "earlier ordinary parameter property",
      "export async function indirect(T, ordinary, ignored = ordinary.value) {}",
      "    await indirect(connection, 1);",
    ],
    [
      "element read",
      'export async function indirect(T, ignored = state["value"]) {}',
      "    await indirect(connection);",
    ],
    [
      "delete expression",
      "export async function indirect(T, ignored = delete state.value) {}",
      "    await indirect(connection);",
    ],
    [
      "ordinary call",
      "export async function indirect(T, ignored = compute()) {}",
      "    await indirect(connection);",
    ],
    [
      "tagged template",
      "export async function indirect(T, ignored = tag`value`) {}",
      "    await indirect(connection);",
    ],
    [
      "plain nested closure",
      "export async function indirect(T, ignored = () => 1) {}",
      "    await indirect(connection);",
    ],
    [
      "pure-looking conditional",
      "export async function indirect(T, ignored = flag ? 1 : 2) {}",
      "    await indirect(connection);",
    ],
    [
      "pure-looking comma",
      "export async function indirect(T, ignored = (1, 2)) {}",
      "    await indirect(connection);",
    ],
    [
      "explicit void argument",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection, void 0);",
    ],
    [
      "conditional undefined argument",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection, flag ? undefined : 1);",
    ],
    [
      "omitted raw default",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection);",
    ],
    [
      "omitted execute default",
      'export async function indirect(T, ignored = T.execute("UPDATE issues SET version=0")) {}',
      "    await indirect(connection);",
    ],
    [
      "omitted rollback default",
      "export async function indirect(T, ignored = T.rollback()) {}",
      "    await indirect(connection);",
    ],
    [
      "omitted transaction default",
      "export async function indirect(T, ignored = T.transaction(async () => 1)) {}",
      "    await indirect(connection);",
    ],
    [
      "omitted unknown member default",
      "export async function indirect(T, ignored = T.mystery()) {}",
      "    await indirect(connection);",
    ],
    [
      "omitted unknown call default",
      "export async function indirect(T, ignored = unknown(T)) {}",
      "    await indirect(connection);",
    ],
    [
      "nested object and array default",
      "export async function indirect(T, ignored = { nested: [T] }) {}",
      "    await indirect(connection);",
    ],
    [
      "template default",
      "export async function indirect(T, ignored = `value:${T}`) {}",
      "    await indirect(connection);",
    ],
    [
      "conditional default",
      "export async function indirect(T, ignored = flag ? T : 1) {}",
      "    await indirect(connection);",
    ],
    [
      "assignment storage default",
      "export async function indirect(T, ignored = (storage.value = T)) {}",
      "    await indirect(connection);",
    ],
    [
      "earlier transaction alias default",
      'export async function indirect(T, alias = T, ignored = alias.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection);",
    ],
    [
      "nested arrow capture and call default",
      'export async function indirect(T, ignored = (() => T.raw("UPDATE issues SET version=0"))()) {}',
      "    await indirect(connection);",
    ],
    [
      "destructured default",
      "export async function indirect(T, { ignored } = { ignored: T }) {}",
      "    await indirect(connection);",
    ],
    [
      "explicit undefined default",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection, undefined);",
    ],
    [
      "ambiguous supplied default",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection, maybe);",
    ],
    [
      "spread call mapping",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(...[connection]);",
    ],
    [
      "optional call mapping",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect?.(connection);",
    ],
    [
      "dynamic call mapping",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    const dynamic = indirect;\n    await dynamic(connection);",
    ],
    [
      "initializer before body return",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) { return 1; }',
      "    await indirect(connection);",
    ],
    [
      "capability-free constructor default",
      "export async function indirect(T, ignored = new Date()) {}",
      "    await indirect(connection);",
    ],
  ];
  for (const [name, body, invocation] of dangerousInitializerDefaults) {
    const result = exactPatchCertificate(
      importedEffectFixture("indirect").replace(
        "    await indirect(connection);",
        invocation,
      ),
      importedEffectOptions(body),
    );
    assert.deepEqual(result.certificates, [], `imported helper initializer ${name}`);
    assert.deepEqual(
      result.writes.contractAnalysis.patchObligations.map(({ status }) => status),
      ["REJECT"],
      `imported helper initializer ${name} obligation`,
    );
  }
  for (const [name, body, invocation] of [
    [
      "omitted capability-free literal",
      "export async function indirect(T, ignored = 1) {}",
      "    await indirect(connection);",
    ],
    [
      "omitted null literal",
      "export async function indirect(T, ignored = null) {}",
      "    await indirect(connection);",
    ],
    [
      "supplied literal suppresses dangerous default",
      'export async function indirect(T, ignored = T.raw("UPDATE issues SET version=0")) {}',
      "    await indirect(connection, 1);",
    ],
    [
      "ordinary earlier parameter default",
      "export async function indirect(T, ordinary, ignored = ordinary) {}",
      "    await indirect(connection, 1);",
    ],
    [
      "capability-free object default",
      "export async function indirect(T, ignored = { count: 1, values: [true] }) {}",
      "    await indirect(connection);",
    ],
    [
      "exact immutable ordinary binding",
      "const ordinary = 1;\nexport async function indirect(T, ignored = ordinary) {}",
      "    await indirect(connection);",
    ],
  ]) {
    assert.equal(
      exactPatchCertificate(
        importedEffectFixture("indirect").replace(
          "    await indirect(connection);",
          invocation,
        ),
        importedEffectOptions(body),
      ).certificates.length,
      1,
      `imported helper initializer positive ${name}`,
    );
  }
  const localCapturedInitializer = patchTransactionSource(
    'const issueId = "same";',
    [
      '  function indirect(ignored = (() => T.raw("UPDATE issues SET version=0"))()) {}',
      "  await T.insert(issueComments).values({ issueId });",
      "  await T.update(issues).set(versionedIssuePatch({}))",
      "    .where(eq(issues.id, issueId));",
      "  await indirect();",
    ].join("\n"),
  );
  assert.deepEqual(
    patchCertificates(localCapturedInitializer),
    [],
    "local captured parameter initializer",
  );
  assert.equal(
    patchCertificates(
      localCapturedInitializer.replace("await indirect();", "await indirect(1);"),
    ).length,
    1,
    "local supplied literal suppresses captured initializer",
  );
  for (const [name, exportName, body] of [
    [
      "exact select",
      "readEffect",
      "export async function readEffect(T) { const rows = await T.select().from(source); return rows; }",
    ],
    [
      "fully analyzed no-use",
      "noUseEffect",
      "export function noUseEffect(T) { return 1; }",
    ],
  ]) {
    assert.equal(
      exactPatchCertificate(
        importedEffectFixture(exportName),
        importedEffectOptions(body),
      ).certificates.length,
      1,
      `imported helper ${name}`,
    );
  }

  const predicateFixture = [
    'import { activityLog, issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { and, eq, inArray, or, sql } from "drizzle-orm";',
    'import { advance } from "./issue-versioning.js";',
    "async function remove(db, id) {",
    "  return db.transaction(async (connection) => {",
    "    const commentIssueIds = await connection",
    "      .selectDistinct({ issueId: issueComments.issueId }).from(issueComments)",
    "      .where(eq(issueComments.authorAgentId, id))",
    "      .then((rows) => rows.map((row) => row.issueId));",
    "    const directlyUpdatedIds = await connection.update(issues)",
    "      .set(versionedIssuePatch({ assigneeAgentId: null }))",
    "      .where(eq(issues.assigneeAgentId, id)).returning({ id: issues.id })",
    "      .then((rows) => rows.map((row) => row.id));",
    "    const directlyUpdated = new Set(directlyUpdatedIds);",
    "    await advance(connection, commentIssueIds.filter((issueId) => !directlyUpdated.has(issueId)));",
    "    await connection.delete(activityLog).where(or(",
    "      eq(activityLog.agentId, id),",
    "      sql`${activityLog.runId} in (select ${id})`,",
    "    ));",
    "    await connection.delete(issueComments).where(eq(issueComments.authorAgentId, id));",
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  const partition = exactPatchCertificate(predicateFixture, wrapperOptions);
  assert.equal(partition.certificates.length, 1);
  assert.equal(partition.certificates[0].coverageKind, "predicate_partition");
  assert.equal(partition.certificates[0].scopeKind, "ExactIssueSet");
  assert.ok(partition.certificates[0].proofRoles.includes("consumed_sql"));
  for (const [name, changed] of [
    ["predicate mismatch", predicateFixture.replace(
      "delete(issueComments).where(eq(issueComments.authorAgentId, id))",
      'delete(issueComments).where(eq(issueComments.authorAgentId, "other"))',
    )],
    ["positive membership", predicateFixture.replace("!directlyUpdated.has(issueId)", "directlyUpdated.has(issueId)")],
    ["capability sql", predicateFixture.replace("sql`${activityLog.runId} in (select ${id})`", "sql`${connection}`")],
    ["raw sql", predicateFixture.replace("connection.delete(activityLog)", "connection.execute(activityLog)")],
    ["complement callback sibling effect", predicateFixture.replace(
      "commentIssueIds.filter((issueId) => !directlyUpdated.has(issueId))",
      "commentIssueIds.filter((issueId) => { auditUnknown(connection); return !directlyUpdated.has(issueId); })",
    )],
    ["projection callback sibling effect", predicateFixture.replace(
      ".then((rows) => rows.map((row) => row.issueId));",
      ".then((rows) => { auditUnknown(connection); return rows.map((row) => row.issueId); });",
    )],
    ["returned IDs mapper declaration", predicateFixture.replace(
      ".then((rows) => rows.map((row) => row.id));",
      ".then((rows) => rows.map((row) => { const copied = row.id; return copied; }));",
    )],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(changed, wrapperOptions).certificates,
      [],
      `partition ${name}`,
    );
  }
  const blockComplement = predicateFixture.replace(
    "commentIssueIds.filter((issueId) => !directlyUpdated.has(issueId))",
    "commentIssueIds.filter((issueId) => { return !directlyUpdated.has(issueId); })",
  );
  assert.equal(
    exactPatchCertificate(blockComplement, wrapperOptions).certificates.length,
    1,
    "single direct block return remains exact",
  );

  const carrierFixture = [
    'import { documents, issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { and, eq } from "drizzle-orm";',
    'import { advance } from "./issue-versioning.js";',
    "async function promote(db, issue, artifactId, kind) {",
    "  return db.transaction(async (connection) => {",
    "    const updated = await (async () => {",
    '      if (kind === "issue") {',
    "        return connection.update(issues).set(versionedIssuePatch({}))",
    "          .where(eq(issues.id, artifactId)).returning({ id: issues.id });",
    "      }",
    '      if (kind === "comment") {',
    "        return connection.update(issueComments).set({ promoted: true })",
    "          .where(and(eq(issueComments.id, artifactId), eq(issueComments.issueId, issue.id)))",
    "          .returning({ id: issueComments.id });",
    "      }",
    "      return connection.update(documents).set({ promoted: true })",
    "        .where(eq(documents.id, artifactId)).returning({ id: documents.id });",
    "    })();",
    "    if (!updated[0]) return null;",
    '    if (kind !== "issue" || artifactId !== issue.id) {',
    "      await advance(connection, [issue.id]);",
    "    }",
    "    return updated;",
    "  });",
    "}",
  ].join("\n");
  const carrier = exactPatchCertificate(carrierFixture, wrapperOptions);
  assert.equal(carrier.certificates.length, 1);
  assert.equal(carrier.certificates[0].coverageKind, "derived_patch_wrapper");
  assert.ok(carrier.certificates[0].proofRoles.includes("sink_carrier"));
  assert.ok(carrier.certificates[0].proofRoles.includes("literal_implication"));
  for (const [name, changed] of [
    ["unknown sibling", carrierFixture.replace(
      "return connection.update(documents)",
      "return connection[operation](documents)",
    )],
    ["dynamic effect", carrierFixture.replace(
      "    if (!updated[0]) return null;",
      "    await evil(connection);\n    if (!updated[0]) return null;",
    )],
    ["wrong discriminant", carrierFixture.replace('kind !== "issue"', 'otherKind !== "issue"')],
    ["concurrent carrier", carrierFixture.replace("const updated = await (async () =>", "const updated = (async () =>")],
    ["carrier element assignment", carrierFixture.replace(
      "    if (!updated[0]) return null;",
      "    updated[0] = null;\n    if (!updated[0]) return null;",
    )],
    ["carrier alias", carrierFixture.replace(
      "    if (!updated[0]) return null;",
      "    const alias = updated;\n    if (!updated[0]) return null;",
    )],
    ["carrier unknown escape", carrierFixture.replace(
      "    if (!updated[0]) return null;",
      "    auditUnknown(updated);\n    if (!updated[0]) return null;",
    )],
    ["carrier cardinality mutation", carrierFixture.replace(
      "    if (!updated[0]) return null;",
      "    updated.pop();\n    if (!updated[0]) return null;",
    )],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(changed, wrapperOptions).certificates,
      [],
      `carrier ${name}`,
    );
  }

  const foreignPath = "server/src/services/store.ts";
  const helperSource = fs.readFileSync(
    path.join(process.cwd(), "server", "src", "services", "issue-versioning.ts"),
    "utf8",
  );
  const foreignModule = [
    'import { runIssueMutation } from "./issue-versioning.js";',
    "async function readRows(connection, rows) {",
    "  const values = await connection.select().from(rows);",
    "  return values;",
    "}",
    "async function project(connection, rows) {",
    "  if (rows.length === 0) return [];",
    "  const values = await readRows(connection, rows);",
    "  return rows.map((row) => ({ ...row, values }));",
    "}",
    "export function makeStore(db) {",
    "  return {",
    "    save: async (id, data, connection = db) => {",
    "      const mutation = await runIssueMutation(connection, {",
    "        issueId: id,",
    "        mutate: async () => ({ issuePatch: data, result: null }),",
    "      });",
    "      if (!mutation) return null;",
    "      const [enriched] = await project(connection, [mutation.issue]);",
    "      return enriched;",
    "    },",
    "  };",
    "}",
  ].join("\n");
  const foreignOptions = (
    moduleSource = foreignModule,
    helperImplementation = helperSource,
  ) => ({
    resolveNamedImport: contractResolver,
    resolveModuleSource: (importer, moduleSpecifier) => {
      if (importer === CONTRACT_FILE && moduleSpecifier === "./store.js") {
        return { path: foreignPath, source: moduleSource };
      }
      if (importer === foreignPath && moduleSpecifier === "./issue-versioning.js") {
        return { path: wrapperModulePath, source: helperImplementation };
      }
      return null;
    },
  });
  const flagFixture = [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq } from "drizzle-orm";',
    "async function reconcile(db, issueId, mode) {",
    "  return db.transaction(async (connection) => {",
    "    let completed = false;",
    '    if (mode === "parent") {',
    '      const { makeStore } = await import("./store.js");',
    "      const updated = await makeStore(db).save(issueId, {}, connection);",
    '      if (!updated) throw new Error("missing");',
    "      completed = true;",
    "    }",
    "    await connection.insert(issueComments).values({ issueId });",
    "    if (!completed) {",
    "      await connection.update(issues).set(versionedIssuePatch({}))",
    "        .where(eq(issues.id, issueId));",
    "    }",
    "    return true;",
    "  });",
    "}",
  ].join("\n");
  const flag = exactPatchCertificate(flagFixture, foreignOptions());
  assert.equal(flag.certificates.length, 1);
  assert.equal(flag.certificates[0].coverageKind, "parent_or_patch_flag");
  assert.deepEqual(flag.certificates[0].memberArgumentMap, {
    issueIndex: 0,
    transactionIndex: 2,
  });
  assert.ok(flag.certificates[0].proofRoles.includes("ParentCoverage"));
  const forgedMutationHelper = (
    invocation,
    reexport = 'export { versionedIssuePatch } from "@paperclipai/db";',
  ) => [
    'import { issues, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq } from "drizzle-orm";',
    reexport,
    "async function unrelatedPatch(connection, issueId) {",
    "  await connection.update(issues).set(versionedIssuePatch({}))",
    "    .where(eq(issues.id, issueId));",
    "}",
    "export async function runIssueMutation(connection, input) {",
    `  ${invocation}`,
    "  return { issue: { id: input.issueId }, result: null };",
    "}",
  ].join("\n");
  for (const [name, helperImplementation] of [
    [
      "unreachable unrelated patch",
      forgedMutationHelper(
        "if (false) await unrelatedPatch(connection, input.issueId);",
      ),
    ],
    [
      "different patch transaction",
      forgedMutationHelper("await unrelatedPatch(other, input.issueId);"),
    ],
    [
      "different patch identity",
      forgedMutationHelper('await unrelatedPatch(connection, "other");'),
    ],
    [
      "unawaited patch",
      forgedMutationHelper("unrelatedPatch(connection, input.issueId);"),
    ],
    [
      "patch branch gap",
      forgedMutationHelper(
        "if (flag) await unrelatedPatch(connection, input.issueId);",
      ),
    ],
    [
      "patch after return",
      forgedMutationHelper(
        "return { issue: { id: input.issueId }, result: null }; await unrelatedPatch(connection, input.issueId);",
      ),
    ],
    [
      "forged re-export",
      forgedMutationHelper(
        "await unrelatedPatch(connection, input.issueId);",
        'export { versionedIssuePatch } from "./forged.js";',
      ),
    ],
    [
      "live helper wrong update transaction",
      helperSource.replace("const updated = await tx", "const updated = await other"),
    ],
    [
      "live helper wrong update identity",
      helperSource.replace(
        "and(eq(issues.id, issueId), eq(issues.version, current.version))",
        'and(eq(issues.id, "other"), eq(issues.version, current.version))',
      ),
    ],
    [
      "live helper unawaited mutate result",
      helperSource.replace(
        "const planned = await mutate(tx, current);",
        "const planned = mutate(tx, current);",
      ),
    ],
    [
      "live helper unawaited patch",
      helperSource.replace("const updated = await tx", "const updated = tx"),
    ],
    [
      "live helper wrong direct-path map",
      helperSource.replace(
        "return await runInTransaction(dbOrTx, input);",
        "return await runInTransaction(other, input);",
      ),
    ],
    [
      "live helper missing re-export",
      helperSource.replace(
        "export { versionedIssuePatch, type IssueMutationPatch } from \"@paperclipai/db\";",
        "",
      ),
    ],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(
        flagFixture,
        foreignOptions(foreignModule, helperImplementation),
      ).certificates,
      [],
      `foreign helper ${name}`,
    );
  }
  for (const [name, changedSource, changedModule = foreignModule] of [
    ["template import", flagFixture.replace('import("./store.js")', "import(`./store.js`)")],
    ["renamed binding", flagFixture.replace("{ makeStore }", "{ makeStore: localStore }")],
    ["optional member", flagFixture.replace(".save(issueId", ".save?.(issueId")],
    ["wrong transaction", flagFixture.replace("issueId, {}, connection", "issueId, {}, other")],
    ["extra flag assignment", flagFixture.replace("    return true;", "    completed = false;\n    return true;")],
    ["missing caller guard", flagFixture.replace('      if (!updated) throw new Error("missing");', "")],
    ["multiple factory returns", flagFixture, foreignModule.replace(
      "export function makeStore(db) {",
      "export function makeStore(db) { if (other) return {};",
    )],
    ["returned alias", flagFixture, foreignModule.replace("  return {", "  const result = {").replace("  };\n}", "  };\n  return result;\n}")],
    ["missing member guard", flagFixture, foreignModule.replace("      if (!mutation) return null;", "")],
    ["indirect member return", flagFixture, foreignModule.replace("      return enriched;", "      return { ...enriched };")],
    ["mapped transaction reassignment", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      "    save: async (id, data, connection = db) => {\n      connection = db;",
    )],
    ["mapped identity reassignment", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      '    save: async (id, data, connection = db) => {\n      id = "different";',
    )],
    ["mapped transaction storage escape", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      "    save: async (id, data, connection = db) => {\n      holder.connection = connection;",
    )],
    ["mapped identity capture", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      "    save: async (id, data, connection = db) => {\n      const capture = () => id;",
    )],
    ["omitted member initializer effect", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      '    save: async (id, data, connection = db, ignored = connection.raw("UPDATE issues SET version=0")) => {',
    )],
    ["explicit undefined member initializer", flagFixture.replace(
      "save(issueId, {}, connection)",
      "save(issueId, {}, connection, undefined)",
    ), foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      '    save: async (id, data, connection = db, ignored = connection.raw("UPDATE issues SET version=0")) => {',
    )],
    ["member constructor initializer", flagFixture, foreignModule.replace(
      "    save: async (id, data, connection = db) => {",
      "    save: async (id, data, connection = db, ignored = new Date()) => {",
    )],
    ["omitted factory initializer effect", flagFixture, foreignModule.replace(
      "export function makeStore(db) {",
      'export function makeStore(db, ignored = db.raw("UPDATE issues SET version=0")) {',
    )],
    ["factory constructor initializer", flagFixture, foreignModule.replace(
      "export function makeStore(db) {",
      "export function makeStore(db, ignored = new Date()) {",
    )],
    ["omitted projector initializer effect", flagFixture, foreignModule.replace(
      "async function project(connection, rows) {",
      'async function project(connection, rows, ignored = connection.raw("UPDATE issues SET version=0")) {',
    )],
  ]) {
    assert.deepEqual(
      exactPatchCertificate(changedSource, foreignOptions(changedModule)).certificates,
      [],
      `foreign flag ${name}`,
    );
  }
  assert.equal(
    exactPatchCertificate(
      flagFixture.replace(
        "save(issueId, {}, connection)",
        "save(issueId, {}, connection, 1)",
      ),
      foreignOptions(
        foreignModule.replace(
          "    save: async (id, data, connection = db) => {",
          '    save: async (id, data, connection = db, ignored = connection.raw("UPDATE issues SET version=0")) => {',
        ),
      ),
    ).certificates.length,
    1,
    "foreign member supplied literal suppresses initializer",
  );
  assert.equal(
    exactPatchCertificate(
      flagFixture.replace("makeStore(db)", "makeStore(db, 1)"),
      foreignOptions(
        foreignModule.replace(
          "export function makeStore(db) {",
          'export function makeStore(db, ignored = db.raw("UPDATE issues SET version=0")) {',
        ),
      ),
    ).certificates.length,
    1,
    "foreign factory supplied literal suppresses initializer",
  );
  const foreignProjectorInitializer = foreignModule
    .replace(
      "async function project(connection, rows) {",
      'async function project(connection, rows, ignored = connection.raw("UPDATE issues SET version=0")) {',
    )
    .replace(
      "project(connection, [mutation.issue])",
      "project(connection, [mutation.issue], 1)",
    );
  assert.equal(
    exactPatchCertificate(
      flagFixture,
      foreignOptions(foreignProjectorInitializer),
    ).certificates.length,
    1,
    "foreign projector supplied literal suppresses initializer",
  );

  const shadowedOperationSource = [
    'import { issues } from "@paperclipai/db";',
    'const op = "select";',
    '{ let op = "update"; await tx[op](issues); }',
  ].join("\n");
  assert.throws(
    () => collectIssueWritesFromSource(CONTRACT_FILE, shadowedOperationSource),
    {
      name: "Error",
      message: `dynamic issue-table write operation in ${CONTRACT_FILE}:3`,
    },
  );

  const acceptedSource = authorityFixture();
  const acceptedWrites = collectIssueWritesFromSource(CONTRACT_FILE, acceptedSource, {
    resolveNamedImport: contractResolver,
  });
  assert.equal(acceptedWrites.length, 1);
  assert.equal(acceptedWrites.authorityCertificates.length, 2);
  assert.deepEqual(validateStrict(acceptedWrites, contractCatalog(acceptedWrites[0])), {
    ok: true,
    errors: [],
  });
  const localMemberInitializer = authorityFixture().replace(
    "update: async (id, data, TN) => {",
    'update: async (id, data, TN, ignored = TN.raw("UPDATE issues SET version=0")) => {',
  );
  assert.deepEqual(
    collectIssueWritesFromSource(CONTRACT_FILE, localMemberInitializer, {
      resolveNamedImport: contractResolver,
    }).authorityCertificates.map((certificate) => certificate.authority),
    ["runIssueMutation:lexical"],
    "local member omitted initializer effect",
  );
  assert.equal(
    collectIssueWritesFromSource(
      CONTRACT_FILE,
      localMemberInitializer.replace(
        "service(T).update(id, {}, T)",
        "service(T).update(id, {}, T, 1)",
      ),
      { resolveNamedImport: contractResolver },
    ).authorityCertificates.length,
    2,
    "local member supplied literal suppresses initializer",
  );
  const localProjectorInitializer = authorityFixture().replace(
    "async function project(T, rows) {",
    'async function project(T, rows, ignored = T.raw("UPDATE issues SET version=0")) {',
  );
  assert.deepEqual(
    collectIssueWritesFromSource(CONTRACT_FILE, localProjectorInitializer, {
      resolveNamedImport: contractResolver,
    }).authorityCertificates.map((certificate) => certificate.authority),
    ["runIssueMutation:lexical"],
    "local projector omitted initializer effect",
  );
  assert.equal(
    collectIssueWritesFromSource(
      CONTRACT_FILE,
      localProjectorInitializer.replace(
        "project(TN, [mutation.issue])",
        "project(TN, [mutation.issue], 1)",
      ),
      { resolveNamedImport: contractResolver },
    ).authorityCertificates.length,
    2,
    "local projector supplied literal suppresses initializer",
  );

  const closureFixture = (body) => [
    'import { issueComments } from "@paperclipai/db";',
    'import { runIssueMutation } from "./issue-versioning.js";',
    "async function outer(T, id) {",
    body,
    "}",
  ].join("\n");
  for (const [name, body] of [
    [
      "escaped closure",
      [
        "  let escaped;",
        "  await runIssueMutation(T, {",
        "    issueId: id,",
        "    mutate: async (TN, current) => {",
        "      escaped = () => TN.insert(issueComments).values({ issueId: current.id });",
        "      return { result: null };",
        "    },",
        "  });",
        "  await escaped();",
      ].join("\n"),
    ],
    [
      "nested IIFE",
      "  await runIssueMutation(T, { issueId: id, mutate: async (TN, current) => " +
        "({ result: await (() => TN.insert(issueComments).values({ issueId: current.id }))() }) });",
    ],
    [
      "returned closure",
      "  await runIssueMutation(T, { issueId: id, mutate: async (TN, current) => " +
        "({ result: () => TN.insert(issueComments).values({ issueId: current.id }) }) });",
    ],
    [
      "property-stored closure",
      [
        "  const holder = {};",
        "  await runIssueMutation(T, {",
        "    issueId: id,",
        "    mutate: async (TN, current) => {",
        "      holder.run = () => TN.insert(issueComments).values({ issueId: current.id });",
        "      return { result: null };",
        "    },",
        "  });",
      ].join("\n"),
    ],
  ]) {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, closureFixture(body), {
      resolveNamedImport: contractResolver,
    });
    assert.deepEqual(writes.authorityCertificates, [], name);
    assert.equal(writes[0].unknownAuthorityEdge, true, name);
    assert.deepEqual(
      validateStrict(writes, contractCatalog(writes[0])),
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      name,
    );
  }
  const harmlessNestedWrites = collectIssueWritesFromSource(
    CONTRACT_FILE,
    closureFixture(
      "  await runIssueMutation(T, { issueId: id, mutate: async (TN, current) => {\n" +
        "    const harmless = () => 42;\n" +
        "    return { result: await TN.insert(issueComments).values({ issueId: current.id }) };\n" +
        "  } });",
    ),
    { resolveNamedImport: contractResolver },
  );
  assert.deepEqual(
    harmlessNestedWrites.authorityCertificates.map((certificate) => certificate.authority),
    ["runIssueMutation:lexical"],
  );
  assert.deepEqual(
    validateStrict(harmlessNestedWrites, contractCatalog(harmlessNestedWrites[0])),
    { ok: true, errors: [] },
  );

  for (const [name, escape] of [
    [
      "immutable alias",
      [
        "const escapedInsert = insertComment;",
        "async function unauthorized(T, issue) { return escapedInsert(T, issue); }",
      ].join("\n"),
    ],
    [
      "property storage",
      [
        "const escapedHolder = {};",
        "escapedHolder.insert = insertComment;",
      ].join("\n"),
    ],
  ]) {
    const writes = collectIssueWritesFromSource(
      CONTRACT_FILE,
      `${acceptedSource}\n${escape}`,
      { resolveNamedImport: contractResolver },
    );
    assert.equal(writes.authorityCertificates.length, 2, `${name} certificate count`);
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.authority).sort(),
      ["runIssueMutation:lexical", "runIssueMutation:same_transaction"].sort(),
      `${name} certificate authorities`,
    );
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.edgeKey),
      [...writes.authorityCertificates.map((certificate) => certificate.edgeKey)].sort(),
      `${name} certificate order`,
    );
    assert.equal(writes[0].requiredEdgeKeys.length, 2, `${name} direct edge count`);
    assert.deepEqual(
      writes[0].requiredEdgeKeys,
      [...writes[0].requiredEdgeKeys].sort(),
      `${name} edge order`,
    );
    assert.equal(writes[0].unknownAuthorityEdge, true, `${name} unknown edge`);
    assert.deepEqual(
      validateStrict(writes, contractCatalog(writes[0])),
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      name,
    );
  }

  const authorityPerturbations = [
    (source) => `${source}\nasync function third(T, issue) { return insertComment(T, issue); }`,
    (source) => source.replace("service(T).update(id, {}, T)", "service(other).update(id, {}, T)"),
    (source) => source.replace(
      "const updated = await service(T).update(id, {}, T);",
      "const premature = await insertComment(T, { id });\n  const updated = await service(T).update(id, {}, T);",
    ),
    (source) => source.replace("service(T).update", "service(T)[member]"),
    (source) => source.replace("insertComment(T, updated)", "insertComment(T, { id })"),
    (source) => source.replace("return enriched;", "return data;"),
    (source) => source.replace(
      "{ ...row, labels: labels.get?.(row.id) }",
      "{ ...row, id: 'overwritten', labels: labels.get?.(row.id) }",
    ),
    (source) => source.replace(
      "const labels = await readRows(T, rows);",
      'rows.unshift({ id: "forged" });\n  const labels = await readRows(T, rows);',
    ),
    (source) => source.replace(
      "const labels = await readRows(T, rows);",
      "rows.sort((left, right) => left.id.localeCompare(right.id));\n  " +
        "const labels = await readRows(T, rows);",
    ),
    (source) => source.replace("rows.map((row)", "rows.filter(Boolean).map((row)"),
    (source) => source.replace("T.select().from(rows)", "T.update(rows).set({})"),
    (source) => source.replace("rows.length === 0", "rows.length < 0"),
    (source) => source.replace("return [];", "return [rows[0]];"),
    (source) => source.replace("[mutation.issue]", "[mutation.issue, mutation.issue]"),
    (source) => source.replace(
      "const values = await T.select().from(rows);",
      "const values = await readRows(T, rows);",
    ),
    (source) => source.replace("project(TN, [mutation.issue])", "project(other, [mutation.issue])"),
    (source) => source.replace(
      "const mutation = await runIssueMutation(TN, {",
      "const projected = await project(TN, [data]);\n      const mutation = await runIssueMutation(TN, {",
    ),
  ];
  authorityPerturbations.forEach((perturb, index) => {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, perturb(acceptedSource), {
      resolveNamedImport: contractResolver,
    });
    if ([5, 7, 8].includes(index)) {
      assert.equal(writes.authorityCertificates.length, 1, `perturbation ${index + 1}`);
    }
    if ([7, 8].includes(index)) {
      assert.equal(
        writes.contractAnalysis.projectors.find((projector) => projector.name === "project")
          ?.eligible,
        false,
        `projector perturbation ${index + 1}`,
      );
    }
    const result = validateStrict(writes, contractCatalog(writes[0]));
    assert.deepEqual(
      result,
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      `authority perturbation ${index + 1}`,
    );
  });

  const sequentialInvalidations = new Map([
    [
      "result property mutation",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        '  updated.id = "forged";\n  return await insertComment(T, updated);',
      ),
    ],
    [
      "result element mutation",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        '  updated["id"] = "forged";\n  return await insertComment(T, updated);',
      ),
    ],
    [
      "result alias mutation",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        '  const alias = updated;\n  alias.id = "forged";\n' +
          "  return await insertComment(T, updated);",
      ),
    ],
    [
      "unknown transaction effect",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        "  await evil(T);\n  return await insertComment(T, updated);",
      ),
    ],
    [
      "unknown issue escape",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        "  await evil(updated);\n  return await insertComment(T, updated);",
      ),
    ],
    [
      "conditional exit",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        "  if (flag) return null;\n  return await insertComment(T, updated);",
      ),
    ],
    [
      "non-normal exit",
      (source) => source.replace(
        "  return await insertComment(T, updated);",
        '  if (flag) throw new Error("stop");\n  return await insertComment(T, updated);',
      ),
    ],
    [
      "projected identity mutation",
      (source) => source.replace(
        "      return enriched;",
        '      enriched.id = "forged";\n      return enriched;',
      ),
    ],
    [
      "mutation issue replacement",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        '      mutation.issue = { id: "forged" };\n' +
          "      const [enriched] = await project(TN, [mutation.issue]);",
      ),
    ],
    [
      "mutation issue alias mutation",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const issueAlias = mutation.issue;\n" +
          '      issueAlias["id"] = "forged";\n' +
          "      const [enriched] = await project(TN, [mutation.issue]);",
      ),
    ],
    [
      "mutation issue escape",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      await evil(mutation.issue);\n" +
          "      const [enriched] = await project(TN, [mutation.issue]);",
      ),
    ],
  ]);
  for (const [name, perturb] of sequentialInvalidations) {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, perturb(acceptedSource), {
      resolveNamedImport: contractResolver,
    });
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.authority),
      ["runIssueMutation:lexical"],
      name,
    );
    assert.deepEqual(
      validateStrict(writes, contractCatalog(writes[0])),
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      name,
    );
  }

  const projectorSetupInvalidations = new Map([
    [
      "unknown direct setup call",
      (source) => source.replace(
        "  const labels = await readRows(T, rows);",
        "  evil();\n  const labels = await readRows(T, rows);",
      ),
    ],
    [
      "local unknown setup helper",
      (source) =>
        `function setupHelper() { evil(); }\n${source.replace(
          "  const labels = await readRows(T, rows);",
          "  setupHelper();\n  const labels = await readRows(T, rows);",
        )}`,
    ],
    [
      "optional setup call",
      (source) => source.replace(
        "  const labels = await readRows(T, rows);",
        "  maybe?.();\n  const labels = await readRows(T, rows);",
      ),
    ],
    [
      "dynamic setup call",
      (source) => source.replace(
        "  const labels = await readRows(T, rows);",
        "  handlers[key]();\n  const labels = await readRows(T, rows);",
      ),
    ],
  ]);
  for (const [name, perturb] of projectorSetupInvalidations) {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, perturb(acceptedSource), {
      resolveNamedImport: contractResolver,
    });
    const projector = writes.contractAnalysis.projectors.find(
      (candidate) => candidate.name === "project",
    );
    assert.equal(projector?.eligible, false, name);
    assert.equal(projector?.transactionEffect, "unknown", name);
    assert.equal(
      analyzedFunction(writes.contractAnalysis, "project").localDependencies.length,
      1,
      `${name} retains only the exact read-only dependency`,
    );
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.authority),
      ["runIssueMutation:lexical"],
      name,
    );
    assert.deepEqual(
      validateStrict(writes, contractCatalog(writes[0])),
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      name,
    );
  }

  const projectorControlInvalidations = new Map([
    [
      "guard else effect",
      (source) => source.replace(
        "  if (rows.length === 0) return [];",
        "  if (rows.length === 0) return []; else evil();",
      ),
    ],
    [
      "guard nested alternate effect",
      (source) => source.replace(
        "  if (rows.length === 0) return [];",
        "  if (rows.length === 0) return []; else { if (flag) evil(); }",
      ),
    ],
    [
      "conditional guard body",
      (source) => source.replace(
        "  if (rows.length === 0) return [];",
        "  if (rows.length === 0) { if (flag) return []; return []; }",
      ),
    ],
    [
      "guard non-normal control",
      (source) => source.replace(
        "  if (rows.length === 0) return [];",
        '  if (rows.length === 0) { if (flag) throw new Error("stop"); return []; }',
      ),
    ],
  ]);
  for (const [name, perturb] of projectorControlInvalidations) {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, perturb(acceptedSource), {
      resolveNamedImport: contractResolver,
    });
    assert.equal(
      writes.contractAnalysis.projectors.find((projector) => projector.name === "project")
        ?.eligible,
      false,
      name,
    );
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.authority),
      ["runIssueMutation:lexical"],
      name,
    );
  }

  const projectionStatementInvalidations = new Map([
    [
      "sibling declarator mutation",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const [enriched] = await project(TN, [mutation.issue]),\n" +
          '        forged = (enriched.id = "forged");',
      ),
    ],
    [
      "sibling declarator unknown call",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const [enriched] = await project(TN, [mutation.issue]), forged = evil(enriched);",
      ),
    ],
    [
      "sibling mutation issue assignment",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const [enriched] = await project(TN, [mutation.issue]),\n" +
          '        forged = (mutation.issue.id = "forged");',
      ),
    ],
    [
      "sequence projection initializer",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        '      const [enriched] = (await project(TN, [mutation.issue]), [{ id: "forged" }]);',
      ),
    ],
    [
      "conditional projection initializer",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const [enriched] = flag\n" +
          "        ? await project(TN, [mutation.issue])\n" +
          "        : [mutation.issue];",
      ),
    ],
    [
      "destructure fallback effect",
      (source) => source.replace(
        "      const [enriched] = await project(TN, [mutation.issue]);",
        "      const [enriched = evil(mutation.issue)] = await project(TN, [mutation.issue]);",
      ),
    ],
  ]);
  for (const [name, perturb] of projectionStatementInvalidations) {
    const writes = collectIssueWritesFromSource(CONTRACT_FILE, perturb(acceptedSource), {
      resolveNamedImport: contractResolver,
    });
    assert.deepEqual(
      writes.authorityCertificates.map((certificate) => certificate.authority),
      ["runIssueMutation:lexical"],
      name,
    );
    assert.deepEqual(
      validateStrict(writes, contractCatalog(writes[0])),
      { ok: false, errors: ["comment write is outside runIssueMutation: M055"] },
      name,
    );
  }

  const pureSetupWrites = collectIssueWritesFromSource(
    CONTRACT_FILE,
    acceptedSource.replace(
      "  const labels = await readRows(T, rows);",
      '  const marker = { kind: "labels" };\n' +
        "  const labels = await readRows(T, rows);",
    ),
    { resolveNamedImport: contractResolver },
  );
  const pureSetupProjector = pureSetupWrites.contractAnalysis.projectors.find(
    (candidate) => candidate.name === "project",
  );
  assert.equal(pureSetupProjector?.eligible, true);
  assert.equal(pureSetupProjector?.transactionEffect, "read-only");
  assert.equal(pureSetupWrites.authorityCertificates.length, 2);
  assert.deepEqual(validateStrict(pureSetupWrites, contractCatalog(pureSetupWrites[0])), {
    ok: true,
    errors: [],
  });

  const variants = new Map([
    [15, "evil(T.select().from(rows));"],
    [16, "const query = T.select(); const rows = await query.from(source);"],
    [17, "return T.select().from(source);"],
    [18, "const query = T.select(); await query.update(source);"],
    [19, "const query = T.select(); await query[member](source);"],
    [20, "const query = T.select(); const alias = query; return alias;"],
    [21, "const inner = () => T.update(source).set({}); return 1;"],
    [22, "(() => T.select().from(source))(); return 1;"],
    [23, "const query = T.select(); const inner = () => query.from(source); return 1;"],
    [24, "async function inner(TN) { const rows = await TN.select().from(source); return rows; } return await inner(T);"],
    [25, "async function inner(TN) { const capture = () => T.update(source); return await TN.select().from(source); } return await inner(T);"],
    [26, "function inner(...args) { return args[0].update(source); } return inner(T);"],
    [27, "function inner([tx]) { return tx.update(source); } return inner(T);"],
    [28, "function inner({ tx }) { return tx.update(source); } return inner(T);"],
    [29, "function inner(tx = fallback) { return tx.update(source); } return inner(T);"],
    [30, "function inner(tx?) { return tx.update(source); } return inner(T);"],
    [31, "function inner() { return 1; } return inner(T);"],
    [32, "return dynamic[T](T);"],
    [33, "function inner(TN) { return 1; } return inner(...T);"],
    [34, "function inner(TN, other) { return 1; } return inner(T, T);"],
    [35, "function inner(TN) { return 1; } return inner({ tx: T });"],
    [36, "function inner(TN) { return 1; } return inner(condition ? T : other);"],
    [37, "function inner(TN) { return 1; } return inner?.(T);"],
    [38, "function inner(this: void, TN) { return TN.update(source); } return inner(T);"],
    [39, "new Box(T); return 1;"],
    [40, "tag`${T}`; return 1;"],
    [41, "void T; return 1;"],
  ]);
  for (const [number, body] of variants) {
    const source = `async function outer(T) { ${body} }`;
    const analysis = transactionAnalysis(source);
    const outer = analyzedFunction(analysis, "outer");
    if (number === 24) {
      assert.equal(outer.classification, "READ_ONLY");
      assert.equal(outer.localDependencies.length, 1);
      assert.equal(analyzedFunction(analysis, "inner").classification, "READ_ONLY");
      continue;
    }
    assert.ok(
      outer.classification === "UNKNOWN" || outer.classification === "MAY_WRITE_OR_CONTROL",
      `variant ${number} was ${outer.classification}`,
    );
    assert.equal(outer.localDependencies.length, number === 25 ? 1 : 0, `variant ${number}`);
    const expectedMessage = number === 41
      ? "unclassified transaction/query capability use"
      : number >= 26 && number <= 40
        ? "non-exact transaction argument mapping"
        : null;
    if (expectedMessage) {
      assert.ok(
        outer.evidence.some((evidence) => evidence.message === expectedMessage),
        `variant ${number} missing ${expectedMessage}`,
      );
    }
  }

  const shapeSource = [
    "function byDeclaration(this: void, TN) { return TN.update(source); }",
    "const byExpression = function(this: void, TN) { return TN.update(source); };",
    "const byArrow = (this: void, TN) => TN.update(source);",
    "const holder = { byMethod(this: void, TN) { return TN.update(source); } };",
    "function plain(TN) { return TN.select().from(source); }",
  ].join("\n");
  const { sourceFile, shapes } = parseFunctionShapes(shapeSource);
  for (const name of ["byDeclaration", "byExpression", "byArrow", "byMethod"]) {
    const declaration = shapes.get(name);
    const executable = scanner.resolveExecutableFunctionLike(declaration);
    assert.ok(executable);
    assert.equal(ts.getThisParameter(executable), executable.parameters[0]);
    assert.equal(executable.parameters[0].getText(sourceFile), "this: void");
    assert.equal(ts.parameterIsThisKeyword(executable.parameters[0]), true);
    assert.equal(ts.parameterIsThisKeyword(executable.parameters[1]), false);
    assert.equal(executable.parameters[1].name.text, "TN");
    assert.equal(scanner.hasSyntheticThisParameter(executable), true);
  }
  const plain = scanner.resolveExecutableFunctionLike(shapes.get("plain"));
  assert.equal(ts.getThisParameter(plain), undefined);
  assert.equal(scanner.hasSyntheticThisParameter(plain), false);
});

test("C15 deterministic certificates and exact trusted helper pairs", () => {
  const first = collectIssueWrites(process.cwd());
  const second = collectIssueWrites(process.cwd());
  assert.deepEqual(first.authorityCertificates, second.authorityCertificates);
  const identities = first.authorityCertificates.map((certificate) =>
    JSON.stringify(canonicalContractValue(certificate)));
  assert.equal(new Set(identities).size, identities.length);
  assert.deepEqual(
    first.authorityCertificates.map((certificate) => certificate.edgeKey),
    [...first.authorityCertificates.map((certificate) => certificate.edgeKey)].sort(),
  );
  assert.equal(
    scanner.isTrustedHelperPair({
      helperExport: "runIssueMutation",
      helperPath: "packages/db/src/issue-versioning.ts",
    }),
    false,
  );
  const insertIssueCommentWrite = first.find(
      (entry) =>
        entry.path === "server/src/services/issues.ts" &&
        entry.functionName === "insertIssueComment",
    );
    assert.ok(insertIssueCommentWrite, "insertIssueComment write must remain discoverable");
    assert.equal(
      first.authorityCertificates.filter(
        (certificate) => certificate.sinkKey === insertIssueCommentWrite.sinkKey,
      ).length,
      1,
    );
  });

test("C16 deterministic classifications, SCC rejection, and residual keys", () => {
  const declarations = [
    "async function directRead(T) { const rows = await T.select().from(source); return rows; }",
    "async function forwardRead(T) { return await directRead(T); }",
    "function noUseHelper(T) { return 1; }",
    "function evilBuilder(T) { return evil(T.select().from(source)); }",
    "async function storedBuilder(T) { const q = T.select(); return await q.from(source); }",
    "function returnedBuilder(T) { return T.select().from(source); }",
    "function aliasedBuilder(T) { const q = T.select(); const alias = q; return alias; }",
    "function forbiddenBuilder(T) { const q = T.select(); return q.update(source); }",
    "function computedBuilder(T) { const q = T.select(); return q[member](source); }",
    "function capturedWrite(T) { const fn = () => T.update(source); return 1; }",
    "function capturedIife(T) { return (() => T.select().from(source))(); }",
    "function capturedIntermediateQuery(T) { const q = T.select(); const fn = () => q.from(source); return 1; }",
    "async function explicitForward(T) { async function inner(TN) { const rows = await TN.select().from(source); return rows; } return await inner(T); }",
    "async function explicitForwardWithOuterCapture(T) { async function inner(TN) { const fn = () => void T; return await TN.select().from(source); } return await inner(T); }",
    "function thisParameterForward(T) { function inner(this: void, TN) { return TN.update(source); } return inner(T); }",
    "function constructedCapability(T) { return new Box(T); }",
    "function taggedCapability(T) { return tag`${T}`; }",
    "function residualVoidUse(T) { void T; return 1; }",
    "async function selectRootArgument(T) { const rows = await T.select(T as any).from(source); return rows; }",
    "async function selectLaterArgument(T) { const rows = await T.select().from(T); return rows; }",
    "async function selectObjectArgument(T) { const rows = await T.select().from({ tx: T }); return rows; }",
    "async function selectArrayArgument(T) { const rows = await T.select().from(source).where([T]); return rows; }",
    "async function selectTemplateArgument(T) { const rows = await T.select().from(source).where(`${T}`); return rows; }",
    "async function selectSpreadArgument(T) { const rows = await T.select(...[T]).from(source); return rows; }",
    "async function selectConditionalArgument(T) { const rows = await T.select().from(source).where(flag ? T : source); return rows; }",
    "async function selectUnknownCallArgument(T) { const rows = await T.select(evil(T)).from(source); return rows; }",
    "function readA(T) { return readB(T); }",
    "function readB(T) { return readA(T); }",
    "function unknownA(T) { return unknownB(T); }",
    "function unknownB(T) { void T; return unknownA(T); }",
    "async function liveProjector(T, rows) { if (rows.length === 0) return []; const values = await directRead(T); return rows.map((row) => ({ ...row, values })); }",
    "function blocker(T) { return T.update(source); }",
    'async function defaultRaw(T, ignored = T.raw("UPDATE issues SET version=0")) { return 1; }',
    "async function defaultRawCaller(T) { return await defaultRaw(T); }",
    "async function defaultRawSuppliedCaller(T) { return await defaultRaw(T, 1); }",
    "async function defaultUnknown(T, ignored = unknown(T)) { return 1; }",
    "async function defaultUnknownCaller(T) { return await defaultUnknown(T); }",
    "async function defaultLiteral(T, ignored = 1) { return 1; }",
    "async function defaultLiteralCaller(T) { return await defaultLiteral(T); }",
    "async function defaultEarlierOrdinary(T, ordinary, ignored = ordinary) { return 1; }",
    "async function defaultEarlierOrdinaryCaller(T) { return await defaultEarlierOrdinary(T, 1); }",
    "const defaultArrow = async (T, ignored = T.execute('UPDATE issues SET version=0')) => 1;",
    "async function defaultArrowCaller(T) { return await defaultArrow(T); }",
    "const defaultExpression = async function (T, ignored = new Date()) { return 1; };",
    "async function defaultExpressionCaller(T) { return await defaultExpression(T); }",
    "const defaultMethods = { safe(T, ignored = 1) { return 1; }, unsafe(T, ignored = (() => T.raw('UPDATE issues SET version=0'))()) { return 1; } };",
    "async function defaultMethodSafeCaller(T) { return await defaultMethods.safe(T); }",
    "async function defaultMethodUnsafeCaller(T) { return await defaultMethods.unsafe(T); }",
    "function projectorCycleA(T) { return projectorCycleB(T); }",
    "function projectorCycleB(T) { return projectorCycleA(T); }",
  ];
  const expected = {
    directRead: "READ_ONLY",
    forwardRead: "READ_ONLY",
    noUseHelper: "READ_ONLY",
    evilBuilder: "UNKNOWN",
    storedBuilder: "UNKNOWN",
    returnedBuilder: "UNKNOWN",
    aliasedBuilder: "UNKNOWN",
    forbiddenBuilder: "MAY_WRITE_OR_CONTROL",
    computedBuilder: "UNKNOWN",
    capturedWrite: "MAY_WRITE_OR_CONTROL",
    capturedIife: "UNKNOWN",
    capturedIntermediateQuery: "UNKNOWN",
    explicitForward: "READ_ONLY",
    explicitForwardWithOuterCapture: "UNKNOWN",
    thisParameterForward: "UNKNOWN",
    constructedCapability: "UNKNOWN",
    taggedCapability: "UNKNOWN",
    residualVoidUse: "UNKNOWN",
    selectRootArgument: "UNKNOWN",
    selectLaterArgument: "UNKNOWN",
    selectObjectArgument: "UNKNOWN",
    selectArrayArgument: "UNKNOWN",
    selectTemplateArgument: "UNKNOWN",
    selectSpreadArgument: "UNKNOWN",
    selectConditionalArgument: "UNKNOWN",
    selectUnknownCallArgument: "UNKNOWN",
    readA: "UNKNOWN",
    readB: "UNKNOWN",
    unknownA: "UNKNOWN",
    unknownB: "UNKNOWN",
    liveProjector: "READ_ONLY",
    blocker: "MAY_WRITE_OR_CONTROL",
    defaultRaw: "MAY_WRITE_OR_CONTROL",
    defaultRawCaller: "MAY_WRITE_OR_CONTROL",
    defaultRawSuppliedCaller: "READ_ONLY",
    defaultUnknown: "UNKNOWN",
    defaultUnknownCaller: "UNKNOWN",
    defaultLiteral: "READ_ONLY",
    defaultLiteralCaller: "READ_ONLY",
    defaultEarlierOrdinary: "READ_ONLY",
    defaultEarlierOrdinaryCaller: "READ_ONLY",
    defaultArrow: "MAY_WRITE_OR_CONTROL",
    defaultArrowCaller: "MAY_WRITE_OR_CONTROL",
    defaultExpression: "UNKNOWN",
    defaultExpressionCaller: "UNKNOWN",
    safe: "READ_ONLY",
    unsafe: "MAY_WRITE_OR_CONTROL",
    defaultMethodSafeCaller: "READ_ONLY",
    defaultMethodUnsafeCaller: "MAY_WRITE_OR_CONTROL",
    projectorCycleA: "UNKNOWN",
    projectorCycleB: "UNKNOWN",
  };
  const analyzeOrder = (items) => transactionAnalysis(items.join("\n"));
  const first = analyzeOrder(declarations);
  const reordered = analyzeOrder([...declarations].reverse());
  for (const [name, classification] of Object.entries(expected)) {
    assert.equal(analyzedFunction(first, name).classification, classification, name);
    assert.equal(analyzedFunction(reordered, name).classification, classification, `${name} reordered`);
  }
  for (const [name, syntaxKind, message] of [
    ["thisParameterForward", ts.SyntaxKind.CallExpression, "non-exact transaction argument mapping"],
    ["constructedCapability", ts.SyntaxKind.NewExpression, "non-exact transaction argument mapping"],
    ["taggedCapability", ts.SyntaxKind.TaggedTemplateExpression, "non-exact transaction argument mapping"],
    ["residualVoidUse", ts.SyntaxKind.Identifier, "unclassified transaction/query capability use"],
  ]) {
    const record = analyzedFunction(first, name);
    assert.equal(record.localDependencies.length, 0);
    const evidence = record.evidence.find((candidate) => candidate.message === message);
    assert.ok(evidence, name);
    assert.equal(evidence.syntaxKind, syntaxKind);
    assert.match(evidence.nodeKey, new RegExp(`^${CONTRACT_FILE.replaceAll("/", "\\/")}#\\d+:\\d+$`));
  }
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expected).map((name) => [name, analyzedFunction(first, name).classification]),
    ),
    Object.fromEntries(
      Object.keys(expected).map((name) => [name, analyzedFunction(reordered, name).classification]),
    ),
  );

  const arbitraryParameter = transactionAnalysis([
    "async function inner(connection) {",
    "  await connection.update(target).set({});",
    "}",
    "async function outer(T) { await inner(T); }",
  ].join("\n"));
  assert.equal(analyzedFunction(arbitraryParameter, "inner").classification, "MAY_WRITE_OR_CONTROL");
  assert.equal(analyzedFunction(arbitraryParameter, "outer").classification, "MAY_WRITE_OR_CONTROL");
  assert.equal(analyzedFunction(arbitraryParameter, "outer").localDependencies.length, 1);

  const trustedHelperEffects = transactionAnalysis([
    'import { runIssueMutation } from "./issue-versioning.js";',
    "async function helperMutation(T, rows) {",
    '  await runIssueMutation(T, { issueId: "other", mutate: async () => ({ result: null }) });',
    "  return rows;",
    "}",
    "async function nestedHelperMutation(T) {",
    '  return await Promise.all([runIssueMutation(T, { issueId: "other", mutate: async () => ({ result: null }) })]);',
    "}",
  ].join("\n"));
  for (const name of ["helperMutation", "nestedHelperMutation"]) {
    assert.equal(
      analyzedFunction(trustedHelperEffects, name).classification,
      "MAY_WRITE_OR_CONTROL",
      `${name} applies trusted helper effects`,
    );
  }

  const shadowedHelper = transactionAnalysis([
    "async function runIssueMutation(TN) { return 1; }",
    "async function shadowedMutation(T) { return await runIssueMutation(T); }",
  ].join("\n"));
  assert.equal(analyzedFunction(shadowedHelper, "shadowedMutation").classification, "UNKNOWN");
  assert.equal(analyzedFunction(shadowedHelper, "shadowedMutation").localDependencies.length, 0);

  const forgedHelpers = scanner.analyzeTransactionContractFromSource(
    CONTRACT_FILE,
    [
      'import { runIssueMutation, versionedIssuePatch } from "./forged.js";',
      "async function forgedMutation(T) { return await runIssueMutation(T); }",
      "async function genericPatch(T) { return versionedIssuePatch(T); }",
    ].join("\n"),
    {
      resolveNamedImport: (_file, _module, exported) => ({
        kind: "helper",
        helper: exported,
        helperPath: "packages/db/src/forged.ts",
      }),
    },
  );
  for (const name of ["forgedMutation", "genericPatch"]) {
    assert.equal(analyzedFunction(forgedHelpers, name).classification, "UNKNOWN", name);
    assert.equal(analyzedFunction(forgedHelpers, name).localDependencies.length, 0, name);
  }

  const readOnlyDependency = transactionAnalysis([
    "async function exactRead(TN) { const rows = await TN.select().from(source); return rows; }",
    "async function exactReadCaller(T) { return await exactRead(T); }",
  ].join("\n"));
  assert.equal(analyzedFunction(readOnlyDependency, "exactReadCaller").classification, "READ_ONLY");
  assert.equal(analyzedFunction(readOnlyDependency, "exactReadCaller").localDependencies.length, 1);

  const obligationFixture = (issueExpression, declarations = "") => [
    'import { issues, issueComments, versionedIssuePatch } from "@paperclipai/db";',
    'import { eq } from "drizzle-orm";',
    declarations,
    "async function apply(db, issueId, otherId) {",
    "  return db.transaction(async (connection) => {",
    "    const finite0 = [];",
    "    const finite1 = [issueId];",
    "    const finiteN = [issueId, otherId];",
    "    await connection.insert(issueComments).values({ issueId });",
    "    await connection.update(issues).set(versionedIssuePatch({}))",
    `      .where(eq(issues.id, ${issueExpression}));`,
    "    return true;",
    "  });",
    "}",
  ].filter(Boolean).join("\n");
  const acceptedObligation = collectIssueWritesFromSource(
    CONTRACT_FILE,
    obligationFixture("issueId"),
  );
  assert.deepEqual(
    acceptedObligation.contractAnalysis.patchObligations.map(
      ({ scopeKind, coverageKind, status }) => ({ scopeKind, coverageKind, status }),
    ),
    [{ scopeKind: "ExactIssue", coverageKind: "direct_patch", status: "ACCEPT" }],
  );
  assert.deepEqual(
    acceptedObligation.contractAnalysis.setSummaries.map((summary) =>
      summary.memberFacts.length),
    [0, 1, 2],
  );
  const rejectedObligation = collectIssueWritesFromSource(
    CONTRACT_FILE,
    obligationFixture("otherId"),
  );
  assert.deepEqual(
    rejectedObligation.contractAnalysis.patchObligations.map(
      ({ scopeKind, status }) => ({ scopeKind, status }),
    ),
    [{ scopeKind: "ExactIssue", status: "REJECT" }],
  );
  const reorderedObligation = collectIssueWritesFromSource(
    CONTRACT_FILE,
    obligationFixture("issueId", "const ordinary = 1;"),
  );
  assert.deepEqual(
    reorderedObligation.contractAnalysis.patchObligations.map(
      ({ scopeKind, coverageKind, status }) => ({ scopeKind, coverageKind, status }),
    ),
    acceptedObligation.contractAnalysis.patchObligations.map(
      ({ scopeKind, coverageKind, status }) => ({ scopeKind, coverageKind, status }),
    ),
  );
  for (const writes of [acceptedObligation, reorderedObligation]) {
    assert.deepEqual(
      writes.authorityCertificates,
      [...writes.authorityCertificates].sort((left, right) =>
        left.edgeKey.localeCompare(right.edgeKey)),
    );
    for (const certificate of writes.authorityCertificates) {
      assert.deepEqual(certificate.proofNodes, [...new Set(certificate.proofNodes)].sort());
      assert.deepEqual(
        certificate.normalExitKeys,
        [...new Set(certificate.normalExitKeys)].sort(),
      );
    }
  }
});
