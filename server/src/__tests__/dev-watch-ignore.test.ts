import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveServerDevWatchIgnorePaths } from "../dev-watch-ignore.js";

describe("resolveServerDevWatchIgnorePaths", () => {
  it("includes both the worktree UI paths and their real shared targets", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-watch-"));
    const sharedUiRoot = path.join(tempRoot, "shared-ui");
    const sharedDbSchemaRoot = path.join(tempRoot, "shared-db-schema");
    const worktreeRoot = path.join(tempRoot, "repo", ".paperclip", "worktrees", "PAP-884");
    const serverRoot = path.join(worktreeRoot, "server");
    const worktreeUiRoot = path.join(worktreeRoot, "ui");
    const worktreeDbSchemaRoot = path.join(worktreeRoot, "packages", "db", "src", "schema");

    fs.mkdirSync(path.join(sharedUiRoot, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(sharedUiRoot, ".vite"), { recursive: true });
    fs.mkdirSync(path.join(sharedUiRoot, "dist"), { recursive: true });
    fs.mkdirSync(serverRoot, { recursive: true });
    fs.mkdirSync(worktreeUiRoot, { recursive: true });
    fs.mkdirSync(sharedDbSchemaRoot, { recursive: true });
    fs.mkdirSync(path.dirname(worktreeDbSchemaRoot), { recursive: true });

    fs.symlinkSync(path.join(sharedUiRoot, "node_modules"), path.join(worktreeUiRoot, "node_modules"));
    fs.symlinkSync(path.join(sharedUiRoot, ".vite"), path.join(worktreeUiRoot, ".vite"));
    fs.symlinkSync(path.join(sharedUiRoot, "dist"), path.join(worktreeUiRoot, "dist"));
    fs.symlinkSync(sharedDbSchemaRoot, worktreeDbSchemaRoot);

    const ignorePaths = resolveServerDevWatchIgnorePaths(serverRoot);

    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "node_modules"));
    expect(ignorePaths).toContain(`${path.join(worktreeUiRoot, "node_modules").replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, "node_modules")));
    expect(ignorePaths).toContain(`${fs.realpathSync(path.join(sharedUiRoot, "node_modules")).replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "node_modules", ".vite-temp"));
    expect(ignorePaths).toContain(
      `${path.join(worktreeUiRoot, "node_modules", ".vite-temp").replaceAll(path.sep, "/")}/**`,
    );
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, ".vite"));
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, ".vite")));
    expect(ignorePaths).toContain(path.join(worktreeUiRoot, "dist"));
    expect(ignorePaths).toContain(fs.realpathSync(path.join(sharedUiRoot, "dist")));
    expect(ignorePaths).toContain(worktreeDbSchemaRoot);
    expect(ignorePaths).toContain(`${worktreeDbSchemaRoot.replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain(fs.realpathSync(sharedDbSchemaRoot));
    expect(ignorePaths).toContain(`${fs.realpathSync(sharedDbSchemaRoot).replaceAll(path.sep, "/")}/**`);
    expect(ignorePaths).toContain("**/{node_modules,bower_components,vendor}/**");
    expect(ignorePaths).toContain("**/.vite-temp/**");
  });
});
