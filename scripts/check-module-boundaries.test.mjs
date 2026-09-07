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
      'import { run } from "../application/run.js";',
    ].join("\n"));
    write(
      "modules/watchdog/application/run.ts",
      [
        'import { adapter } from "../adapters/postgres.js";',
        'import { forbidden } from "../../../errors.js";',
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
        { specifier: "../../../errors.js", reason: "application cannot import HTTP error helpers" },
        { specifier: "@paperclipai/db", reason: "application cannot import database packages" },
        { specifier: "drizzle-orm", reason: "domain cannot import database packages" },
        { specifier: "../../../services/example.js", reason: "domain cannot import server services or routes" },
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
