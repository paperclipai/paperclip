#!/usr/bin/env node

/**
 * Uses `pnpm deploy` to produce a proper flat node_modules for the server
 * (no pnpm symlinks, all nested dependencies resolved) then patches
 * @paperclipai/* workspace packages to use their publishConfig.exports
 * (pointing to dist/) instead of the dev exports (pointing to src/*.ts).
 */

import { execSync, execFileSync } from "node:child_process";
import { rmSync, existsSync, readdirSync, readFileSync, writeFileSync, lstatSync, symlinkSync, realpathSync, mkdirSync, cpSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, "..");
const monorepoRoot = path.resolve(electronDir, "..");

const deployDir = path.join(electronDir, "build", "server-deploy");

// ── Step 1: pnpm deploy ───────────────────────────────────────────────────────
console.log("[prepare-server] Running pnpm deploy for @paperclipai/server...");

if (existsSync(deployDir)) {
  rmSync(deployDir, { recursive: true, force: true });
}

execSync(
  `pnpm --filter @paperclipai/server deploy --prod --ignore-scripts "${deployDir}"`,
  { cwd: monorepoRoot, stdio: "inherit" }
);

// ── Step 1b: remove self-referencing @paperclipai/server symlink from .pnpm ──
// pnpm deploy creates node_modules/.pnpm/node_modules/@paperclipai/server ->
// ../../../../../../../server (pointing back to the monorepo source). This
// broken symlink gets copied into the bundle and causes codesign to fail.
const pnpmHoistedPaperclip = path.join(deployDir, "node_modules", ".pnpm", "node_modules", "@paperclipai");
const selfRef = path.join(pnpmHoistedPaperclip, "server");
if (existsSync(selfRef)) {
  rmSync(selfRef, { recursive: true, force: true });
  console.log("[prepare-server] Removed self-referencing @paperclipai/server symlink from .pnpm/node_modules");
}

// ── Step 2: patch @paperclipai/* package.json exports ────────────────────────
const scopeDir = path.join(deployDir, "node_modules", "@paperclipai");
if (existsSync(scopeDir)) {
  for (const pkg of readdirSync(scopeDir)) {
    const pkgDir = path.join(scopeDir, pkg);
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    // Replace symlinked workspace packages with production-ready copies.
    // We only copy dist/ and package.json (not node_modules or src/) so that
    // Node resolves transitive deps from the deploy dir's top-level node_modules.
    if (lstatSync(pkgDir).isSymbolicLink()) {
      const realPath = realpathSync(pkgDir);
      rmSync(pkgDir);
      mkdirSync(pkgDir, { recursive: true });
      // Copy package.json
      cpSync(path.join(realPath, "package.json"), path.join(pkgDir, "package.json"));
      // Copy dist/ (compiled output)
      const distSrc = path.join(realPath, "dist");
      if (existsSync(distSrc)) {
        cpSync(distSrc, path.join(pkgDir, "dist"), { recursive: true });
      }
      // Copy skills/ if present (adapter packages may have skills/)
      const skillsSrc = path.join(realPath, "skills");
      if (existsSync(skillsSrc)) {
        cpSync(skillsSrc, path.join(pkgDir, "skills"), { recursive: true });
      }
      console.log(`[prepare-server] Replaced symlink with copy for @paperclipai/${pkg}`);
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    if (pkgJson.publishConfig?.exports) {
      pkgJson.exports = pkgJson.publishConfig.exports;
      writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2));
      console.log(`[prepare-server] Patched exports for @paperclipai/${pkg}`);
    }
  }
}

// ── Step 3: hoist missing dependencies from .pnpm store ─────────────────────
// pnpm deploy may not hoist transitive deps of workspace packages (since they
// were symlinks). Scan the .pnpm store and create top-level symlinks for any
// package that isn't already accessible from node_modules/.
const pnpmDir = path.join(deployDir, "node_modules", ".pnpm");
const topNodeModules = path.join(deployDir, "node_modules");
if (existsSync(pnpmDir)) {
  for (const entry of readdirSync(pnpmDir)) {
    // Each .pnpm entry is like "postgres@3.4.8" or "@scope+name@ver"
    const innerNm = path.join(pnpmDir, entry, "node_modules");
    if (!existsSync(innerNm)) continue;
    for (const innerPkg of readdirSync(innerNm)) {
      // Skip .pnpm itself and already-hoisted packages
      if (innerPkg === ".pnpm") continue;
      if (innerPkg.startsWith("@")) {
        // Scoped package: @scope/name lives in @scope/ dir
        const scopeInner = path.join(innerNm, innerPkg);
        const scopeTop = path.join(topNodeModules, innerPkg);
        if (!existsSync(scopeTop)) mkdirSync(scopeTop, { recursive: true });
        for (const scopedPkg of readdirSync(scopeInner)) {
          const dest = path.join(scopeTop, scopedPkg);
          if (!existsSync(dest)) {
            const src = path.join(scopeInner, scopedPkg);
            // Resolve through any symlinks in .pnpm to get the real dir
            const realSrc = realpathSync(src);
            symlinkSync(realSrc, dest);
            console.log(`[prepare-server] Hoisted ${innerPkg}/${scopedPkg}`);
          }
        }
      } else {
        const dest = path.join(topNodeModules, innerPkg);
        if (!existsSync(dest)) {
          const src = path.join(innerNm, innerPkg);
          const realSrc = realpathSync(src);
          symlinkSync(realSrc, dest);
          console.log(`[prepare-server] Hoisted ${innerPkg}`);
        }
      }
    }
  }
}

// ── Step 4: restore dylib soname symlinks stripped by pnpm store ─────────────
// pnpm's content-addressable store only keeps real files, not the soname
// symlinks (e.g. libzstd.1.dylib -> libzstd.1.5.7.dylib) that macOS dyld
// needs to resolve @loader_path references. Recreate them.
const embeddedPostgresScope = path.join(deployDir, "node_modules", ".pnpm");
if (existsSync(embeddedPostgresScope)) {
  for (const entry of readdirSync(embeddedPostgresScope)) {
    if (!entry.startsWith("@embedded-postgres")) continue;
    const nativeLib = path.join(embeddedPostgresScope, entry, "node_modules", "@embedded-postgres");
    if (!existsSync(nativeLib)) continue;
    for (const arch of readdirSync(nativeLib)) {
      const libDir = path.join(nativeLib, arch, "native", "lib");
      if (!existsSync(libDir)) continue;
      for (const file of readdirSync(libDir)) {
        // Match versioned dylibs: libfoo.A.B.C.dylib or libfoo.A.B.dylib
        const m = file.match(/^(lib[^.]+)\.(\d+)(\..+)?\.dylib$/);
        if (!m) continue;
        const base = m[1]; // e.g. libzstd, libicui18n
        const major = m[2]; // e.g. 1, 77

        // Create libfoo.A.dylib (soname) and libfoo.dylib (bare link)
        for (const alias of [`${base}.${major}.dylib`, `${base}.dylib`]) {
          const aliasPath = path.join(libDir, alias);
          if (!existsSync(aliasPath)) {
            symlinkSync(file, aliasPath);
            console.log(`[prepare-server] Created dylib symlink ${alias} -> ${file}`);
          }
        }
      }
    }
  }
}

// ── Step 5: download bundled Node.js binaries ───────────────────────────────
// Download Node.js binaries for the current platform so the packaged app
// doesn't depend on the user having Node installed.
const NODE_VERSION = "v22.15.0"; // LTS
const platform = process.platform; // darwin, win32, linux

// Map to Node download naming
const nodePlatform = platform === "win32" ? "win" : platform;
// electron-builder uses "mac"/"linux"/"win" for ${os}
const ebPlatform = platform === "darwin" ? "mac" : platform === "win32" ? "win" : "linux";
const arches = platform === "darwin" ? ["x64", "arm64"] : ["x64"];

const nodeBinDir = path.join(electronDir, "build", "node-bin");

for (const arch of arches) {
  const destDir = path.join(nodeBinDir, `${ebPlatform}-${arch}`);
  const destBin = path.join(destDir, platform === "win32" ? "node.exe" : "node");

  if (existsSync(destBin)) {
    console.log(`[prepare-server] Node ${NODE_VERSION} ${arch} already downloaded, skipping`);
    continue;
  }

  mkdirSync(destDir, { recursive: true });

  const ext = platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `node-${NODE_VERSION}-${nodePlatform}-${arch}`;
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${archiveName}.${ext}`;
  const archivePath = path.join(destDir, `node.${ext}`);

  console.log(`[prepare-server] Downloading Node ${NODE_VERSION} for ${nodePlatform}-${arch}...`);

  // Download
  if (platform === "win32") {
    execSync(`powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${archivePath}'"`, { stdio: "inherit" });
  } else {
    execSync(`curl -fsSL -o "${archivePath}" "${url}"`, { stdio: "inherit" });
  }

  // Extract just the node binary
  if (platform === "win32") {
    execSync(`powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`, { stdio: "inherit" });
    cpSync(path.join(destDir, archiveName, "node.exe"), destBin);
    rmSync(path.join(destDir, archiveName), { recursive: true, force: true });
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}" --strip-components=2 "${archiveName}/bin/node"`, { stdio: "inherit" });
  }

  rmSync(archivePath, { force: true });
  console.log(`[prepare-server] Node ${NODE_VERSION} ${arch} ready at ${destBin}`);
}

// ── Step 6: detect and remove macOS Finder duplicate files ("* 2.*") ─────────
// iCloud Drive / Finder sometimes creates "file 2.txt" copies when it syncs
// files to a directory that already contains them.  These duplicates silently
// corrupt the deploy: drizzle migration files with " 2" in their name won't be
// recognised as applied, and duplicate JS/map files can shadow real modules.
// Abort the build if any remain so the developer knows to re-run after fixing.
console.log("[prepare-server] Scanning for macOS Finder duplicate files...");
{
  function* walkDir(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue; // don't follow symlinks
      if (stat.isDirectory()) { yield* walkDir(full); } else { yield full; }
    }
  }

  const dupes = [];
  for (const file of walkDir(deployDir)) {
    const base = path.basename(file);
    // Match " 2", " 2.ext", " 3.ext" etc. — but not legitimate names like "v2.js"
    if (/ \d+(\.[^/]+)?$/.test(base) && / \d+/.test(base)) {
      dupes.push(file);
    }
  }

  if (dupes.length > 0) {
    console.warn(`[prepare-server] WARNING: found ${dupes.length} Finder duplicate file(s). Removing them now.`);
    for (const f of dupes) {
      rmSync(f, { force: true });
      console.warn(`[prepare-server]   removed: ${path.relative(deployDir, f)}`);
    }
  } else {
    console.log("[prepare-server] No Finder duplicates found.");
  }
}

// ── Step 7: validate migration files in the deployed @paperclipai/db ─────────
// Ensures that the deployed package has all migration SQL files from source so
// the server can apply them on first run against an existing database.
{
  const srcMigrationsDir = path.join(monorepoRoot, "packages", "db", "src", "migrations");
  const deployedMigrationsDir = path.join(deployDir, "node_modules", "@paperclipai", "db", "dist", "migrations");

  if (existsSync(srcMigrationsDir) && existsSync(deployedMigrationsDir)) {
    const srcSql = readdirSync(srcMigrationsDir).filter(f => f.endsWith(".sql")).sort();
    const deployedSql = readdirSync(deployedMigrationsDir).filter(f => f.endsWith(".sql")).sort();

    const missingSql = srcSql.filter(f => !deployedSql.includes(f));
    if (missingSql.length > 0) {
      console.log(`[prepare-server] Deployed @paperclipai/db is missing ${missingSql.length} migration(s): ${missingSql.join(", ")}`);
      console.log("[prepare-server] Syncing migration files from source...");
      for (const f of missingSql) {
        cpSync(path.join(srcMigrationsDir, f), path.join(deployedMigrationsDir, f));
      }
      // Also sync the meta journal
      const srcMeta = path.join(srcMigrationsDir, "meta");
      const deployedMeta = path.join(deployedMigrationsDir, "meta");
      if (existsSync(srcMeta)) {
        cpSync(srcMeta, deployedMeta, { recursive: true });
      }
      console.log(`[prepare-server] Synced ${missingSql.length} missing migration(s).`);
    } else {
      console.log(`[prepare-server] Migration files validated: ${deployedSql.length} SQL file(s) present.`);
    }
  }
}

console.log("[prepare-server] Done.");
