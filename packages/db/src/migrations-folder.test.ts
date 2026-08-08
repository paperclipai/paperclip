import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, resolveMigrationsFolder } from "./migrations-folder.js";

const moduleDir = path.join("monorepo", "packages", "db", "src");
const dbPackageRoot = path.join("npm", "node_modules", "@paperclipai", "db");
const resolveDbPackageJson = () => path.join(dbPackageRoot, "package.json");

describe("resolveMigrationsFolder", () => {
  it("prefers the module-local migrations folder when it exists (monorepo and published db package)", () => {
    const folder = resolveMigrationsFolder({
      moduleDir,
      resolveDbPackageJson,
      exists: (candidate) => candidate === path.join(moduleDir, "migrations"),
    });

    expect(folder).toBe(path.join(moduleDir, "migrations"));
  });

  it("falls back to the installed @paperclipai/db dist migrations when bundled (npm-installed CLI)", () => {
    const bundleDir = path.join("npm", "node_modules", "paperclipai", "dist");
    const folder = resolveMigrationsFolder({
      moduleDir: bundleDir,
      resolveDbPackageJson,
      exists: (candidate) => candidate === path.join(dbPackageRoot, "dist", "migrations"),
    });

    expect(folder).toBe(path.join(dbPackageRoot, "dist", "migrations"));
  });

  it("falls back to the resolved package src migrations when dist is not built (workspace link)", () => {
    const folder = resolveMigrationsFolder({
      moduleDir: path.join("somewhere", "else"),
      resolveDbPackageJson,
      exists: (candidate) => candidate === path.join(dbPackageRoot, "src", "migrations"),
    });

    expect(folder).toBe(path.join(dbPackageRoot, "src", "migrations"));
  });

  it("keeps the module-local path when @paperclipai/db is not resolvable", () => {
    const folder = resolveMigrationsFolder({
      moduleDir,
      resolveDbPackageJson: () => {
        throw new Error("Cannot find package '@paperclipai/db'");
      },
      exists: () => false,
    });

    expect(folder).toBe(path.join(moduleDir, "migrations"));
  });
});

describe("MIGRATIONS_FOLDER", () => {
  it("resolves to an existing migrations directory in this repo", () => {
    expect(existsSync(MIGRATIONS_FOLDER)).toBe(true);
    expect(existsSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"))).toBe(true);
  });
});
