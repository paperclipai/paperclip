import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkImportBoundary, scanModuleForImportBoundaryViolations } from "./import-boundary.js";

const modulesRoot = fileURLToPath(new URL(".", import.meta.url));

describe("import boundary gate", () => {
  it("rejects a domain file that imports drizzle-orm", () => {
    const plantedSourceText = [
      'import { eq } from "drizzle-orm";',
      "export function pickRow() { return eq; }",
      "",
    ].join("\n");

    const violations = checkImportBoundary(plantedSourceText, "domain");

    expect(violations).toEqual(["drizzle-orm"]);
  });

  it("rejects a domain file that imports a service", () => {
    const plantedSourceText = 'import { issueService } from "../../../services/issues.js";\n';

    const violations = checkImportBoundary(plantedSourceText, "domain");

    expect(violations).toEqual(["../../../services/issues.js"]);
  });

  it("rejects an application file that imports a concrete adapter", () => {
    const plantedSourceText = 'import { createPostgresWatchdogAdapter } from "../adapters/postgres.js";\n';

    const violations = checkImportBoundary(plantedSourceText, "application");

    expect(violations).toEqual(["../adapters/postgres.js"]);
  });

  it("allows an adapter file to import drizzle-orm", () => {
    const plantedSourceText = 'import { eq } from "drizzle-orm";\n';

    const violations = checkImportBoundary(plantedSourceText, "adapters");

    expect(violations).toEqual([]);
  });

  it("reports zero violations for every file under server/src/modules", () => {
    const violations = scanModuleForImportBoundaryViolations(modulesRoot);

    expect(violations).toEqual([]);
  });
});
