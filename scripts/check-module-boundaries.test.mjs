import "./check-agent-lifecycle-boundaries.test.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractImportSpecifiers, scanModuleBoundaries } from "./check-module-boundaries.mjs";

test("extractImportSpecifiers recognizes supported TypeScript dependency forms", () => {
  assert.deepEqual(
    extractImportSpecifiers([
      'import type { Db } from "@paperclipai/db";',
      'export { helper } from "./helper.js";',
      'const adapter = await import("../adapters/postgres.js");',
      'const postgres = require("postgres");',
      'import fs = require("node:fs");',
    ].join("\n")),
    ["@paperclipai/db", "./helper.js", "../adapters/postgres.js", "postgres", "node:fs"],
  );
});

test("scanModuleBoundaries rejects outward dependencies and module-internal imports", () => {
  const serverSrc = mkdtempSync(join(tmpdir(), "paperclip-module-boundaries-"));
  const modulesRoot = join(serverSrc, "modules");

  const write = (relativePath, source) => {
    const filePath = join(serverSrc, relativePath);
    mkdirSync(join(filePath, ".."), { recursive: true });
    writeFileSync(filePath, source);
  };

  try {
    write("modules/watchdog/domain/policy.ts", [
      'import { eq } from "drizzle-orm";',
      'import { service } from "../../../services/example.js";',
      'import { parse } from "../../../adapters/utils.js";',
      'import { run } from "../application/run.js";',
    ].join("\n"));
    write(
      "modules/watchdog/application/run.ts",
      [
        'import { adapter } from "../adapters/postgres.js";',
        'import { parse } from "../../../adapters/application-utils.js";',
        'import { forbidden } from "../../../errors.js";',
        'import { helper } from "../../../services/example.js";',
        'import db = require("@paperclipai/db");',
      ].join("\n"),
    );
    write("modules/watchdog/adapters/postgres.ts", 'import { eq } from "drizzle-orm";\n');
    write("modules/watchdog/index.ts", 'export { run } from "./application/run.js";\n');
    write("services/example.ts", 'import { run } from "../modules/watchdog/application/run.js";\n');

    const violations = scanModuleBoundaries({ serverSrc, modulesRoot });
    assert.deepEqual(
      violations.map(({ specifier, reason }) => ({ specifier, reason })),
      [
        { specifier: "../adapters/postgres.js", reason: "application cannot import concrete adapters" },
        {
          specifier: "../../../adapters/application-utils.js",
          reason: "application cannot import concrete adapters",
        },
        { specifier: "../../../errors.js", reason: "application cannot import HTTP error helpers" },
        {
          specifier: "../../../services/example.js",
          reason: "application cannot import server services or routes",
        },
        { specifier: "@paperclipai/db", reason: "application cannot import database packages" },
        { specifier: "drizzle-orm", reason: "domain cannot import database packages" },
        {
          specifier: "../../../services/example.js",
          reason: "domain cannot import server services, routes, or adapters",
        },
        {
          specifier: "../../../adapters/utils.js",
          reason: "domain cannot import server services, routes, or adapters",
        },
        { specifier: "../application/run.js", reason: "domain cannot depend on outer module layers" },
        {
          specifier: "../modules/watchdog/application/run.js",
          reason: "imports inside module watchdog instead of its index",
        },
      ],
    );
  } finally {
    rmSync(serverSrc, { recursive: true, force: true });
  }
});

test("the repository's feature modules satisfy their import boundaries", () => {
  assert.deepEqual(scanModuleBoundaries(), []);
});

test("only the company deletion coordinator can import module deletion entry points", () => {
  const serverSrc = mkdtempSync(join(tmpdir(), "paperclip-company-deletion-boundaries-"));
  const modulesRoot = join(serverSrc, "modules");
  try {
    mkdirSync(join(serverSrc, "services"));
    mkdirSync(join(serverSrc, "routes"));
    const integration = 'import { deletion } from "../modules/example/company-deletion.js";';
    writeFileSync(join(serverSrc, "services", "company-deletion.ts"), integration);
    writeFileSync(join(serverSrc, "services", "other.ts"), integration);
    writeFileSync(join(serverSrc, "routes", "companies.ts"), integration);
    const violations = scanModuleBoundaries({ serverSrc, modulesRoot });
    assert.equal(violations.length, 2);
    assert(violations.some(({ file }) => file.endsWith("services/other.ts")));
    assert(violations.some(({ file }) => file.endsWith("routes/companies.ts")));
  } finally {
    rmSync(serverSrc, { recursive: true, force: true });
  }
});

test("agent lifecycle adapters and entry point cannot depend on services", () => {
  const serverSrc = mkdtempSync(join(tmpdir(), "paperclip-lifecycle-boundaries-"));
  const modulesRoot = join(serverSrc, "modules");
  try {
    mkdirSync(join(modulesRoot, "agent-lifecycle", "adapters"), { recursive: true });
    writeFileSync(join(modulesRoot, "agent-lifecycle", "index.ts"), 'import "../../services/example.js";');
    writeFileSync(join(modulesRoot, "agent-lifecycle", "adapters", "records.ts"), 'import "../../../services/example.js";');
    assert.equal(scanModuleBoundaries({ serverSrc, modulesRoot }).filter(item =>
      item.reason === "agent lifecycle must receive service integrations through its ports").length, 2);
  } finally {
    rmSync(serverSrc, { recursive: true, force: true });
  }
});
