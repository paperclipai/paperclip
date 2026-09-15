import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export type ResolveMigrationsFolderOptions = {
  moduleDir: string;
  resolveDbPackageJson: () => string;
  exists?: (candidate: string) => boolean;
};

/**
 * Resolve the directory containing the SQL migration files.
 *
 * In the monorepo (`src/`) and in the published `@paperclipai/db` package
 * (`dist/`), the migrations live next to this module, so the module-relative
 * folder wins. When this code is bundled into another package — the
 * npm-published `paperclipai` CLI bundles `@paperclipai/db` into
 * `paperclipai/dist/index.js` — the module-relative folder does not exist, so
 * fall back to resolving the installed `@paperclipai/db` package, which ships
 * its migrations in `dist/migrations`.
 */
export function resolveMigrationsFolder(options: ResolveMigrationsFolderOptions): string {
  const exists = options.exists ?? existsSync;
  const moduleLocalFolder = path.join(options.moduleDir, "migrations");
  if (exists(moduleLocalFolder)) return moduleLocalFolder;

  try {
    const dbPackageRoot = path.dirname(options.resolveDbPackageJson());
    const candidates = [
      path.join(dbPackageRoot, "dist", "migrations"),
      path.join(dbPackageRoot, "src", "migrations"),
    ];
    for (const candidate of candidates) {
      if (exists(candidate)) return candidate;
    }
  } catch {
    // @paperclipai/db is not resolvable from here. Fall through so downstream
    // errors mention the module-local path that was actually probed.
  }
  return moduleLocalFolder;
}

export const MIGRATIONS_FOLDER = resolveMigrationsFolder({
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  resolveDbPackageJson: () => require.resolve("@paperclipai/db/package.json"),
});
