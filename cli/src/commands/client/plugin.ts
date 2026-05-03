import { existsSync, statSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import pc from "picocolors";
import JSZip from "jszip";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types mirroring server-side shapes
// ---------------------------------------------------------------------------

interface PluginRecord {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  displayName?: string;
  lastError?: string | null;
  installedAt: string;
  updatedAt: string;
}


// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

interface PluginListOptions extends BaseClientOptions {
  status?: string;
}

interface PluginInstallOptions extends BaseClientOptions {
  local?: boolean;
  file?: boolean;
  version?: string;
}

interface PluginUninstallOptions extends BaseClientOptions {
  force?: boolean;
}

interface PluginPackOptions {
  out?: string;
  build?: boolean;
}

// ---------------------------------------------------------------------------
// Pack helpers (zip a built plugin into a single .pcplugin artifact)
// ---------------------------------------------------------------------------

const PACKED_PACKAGE_FIELDS = [
  "name",
  "version",
  "type",
  "paperclipPlugin",
  "dependencies",
  "engines",
];

async function addDirToZip(
  zip: JSZip,
  absDir: string,
  zipBase: string,
): Promise<void> {
  const entries = await readdir(absDir, { withFileTypes: true });
  for (const entry of entries) {
    const absChild = path.join(absDir, entry.name);
    const zipChild = zipBase ? `${zipBase}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirToZip(zip, absChild, zipChild);
    } else if (entry.isFile()) {
      const buf = await readFile(absChild);
      zip.file(zipChild, buf);
    }
  }
}

async function loadPackagedManifest(
  pluginDir: string,
): Promise<{ id: string; version: string; pkgJson: Record<string, unknown> }> {
  const pkgPath = path.join(pluginDir, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`No package.json at ${pkgPath}`);
  }
  const pkgJson = JSON.parse(await readFile(pkgPath, "utf-8")) as Record<string, unknown>;
  const paperclipPlugin = pkgJson["paperclipPlugin"] as
    | { manifest?: string; worker?: string }
    | undefined;
  if (!paperclipPlugin?.manifest) {
    throw new Error(
      `package.json at ${pkgPath} is missing paperclipPlugin.manifest. Is this a Paperclip plugin?`,
    );
  }
  const manifestPath = path.resolve(pluginDir, paperclipPlugin.manifest);
  if (!existsSync(manifestPath)) {
    throw new Error(
      `Manifest file not found at ${manifestPath}. Did you run \`pnpm build\` first?`,
    );
  }
  // Dynamic-import with cache-bust so a freshly-rebuilt manifest is read,
  // not a stale cached module from a prior CLI invocation in the same process.
  const importUrl = `${pathToFileURL(manifestPath).href}?t=${Date.now()}`;
  const mod = (await import(importUrl)) as Record<string, unknown>;
  const manifest = (mod["default"] ?? mod) as { id?: string; version?: string };
  if (!manifest.id || !manifest.version) {
    throw new Error(
      `Manifest at ${manifestPath} is missing id or version. Got: ${JSON.stringify(manifest)}`,
    );
  }
  return { id: manifest.id, version: manifest.version, pkgJson };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a local path argument to an absolute path so the server can find the
 * plugin on disk regardless of where the user ran the CLI.
 */
function resolvePackageArg(packageArg: string, isLocal: boolean): string {
  if (!isLocal) return packageArg;
  // Already absolute
  if (path.isAbsolute(packageArg)) return packageArg;
  // Expand leading ~ to home directory
  if (packageArg.startsWith("~")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return path.resolve(home, packageArg.slice(1).replace(/^[\\/]/, ""));
  }
  return path.resolve(process.cwd(), packageArg);
}

function formatPlugin(p: PluginRecord): string {
  const statusColor =
    p.status === "ready"
      ? pc.green(p.status)
      : p.status === "error"
        ? pc.red(p.status)
        : p.status === "disabled"
          ? pc.dim(p.status)
          : pc.yellow(p.status);

  const parts = [
    `key=${pc.bold(p.pluginKey)}`,
    `status=${statusColor}`,
    `version=${p.version}`,
    `id=${pc.dim(p.id)}`,
  ];

  if (p.lastError) {
    parts.push(`error=${pc.red(p.lastError.slice(0, 80))}`);
  }

  return parts.join("  ");
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPluginCommands(program: Command): void {
  const plugin = program.command("plugin").description("Plugin lifecycle management");

  // -------------------------------------------------------------------------
  // plugin list
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("list")
      .description("List installed plugins")
      .option("--status <status>", "Filter by status (ready, error, disabled, installed, upgrade_pending)")
      .action(async (opts: PluginListOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const qs = opts.status ? `?status=${encodeURIComponent(opts.status)}` : "";
          const plugins = await ctx.api.get<PluginRecord[]>(`/api/plugins${qs}`);

          if (ctx.json) {
            printOutput(plugins, { json: true });
            return;
          }

          const rows = plugins ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("No plugins installed."));
            return;
          }

          for (const p of rows) {
            console.log(formatPlugin(p));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin install <package-or-path>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("install <package>")
      .description(
        "Install a plugin from a local path, npm package, or .pcplugin archive.\n" +
          "  Examples:\n" +
          "    paperclipai plugin install ./my-plugin                    # local path\n" +
          "    paperclipai plugin install @acme/plugin-linear            # npm package\n" +
          "    paperclipai plugin install @acme/plugin-linear@1.2        # pinned version\n" +
          "    paperclipai plugin install ./email-tools-0.3.0.pcplugin --file  # .pcplugin upload",
      )
      .option("-l, --local", "Treat <package> as a local filesystem path", false)
      .option("--file", "Treat <package> as a .pcplugin archive to upload", false)
      .option("--version <version>", "Specific npm version to install (npm packages only)")
      .action(async (packageArg: string, opts: PluginInstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);

          if (opts.file) {
            const absFile = path.resolve(process.cwd(), packageArg);
            if (!existsSync(absFile)) {
              throw new Error(`Plugin archive not found at ${absFile}`);
            }
            const buf = await readFile(absFile);
            if (!ctx.json) {
              console.log(pc.dim(`Uploading plugin archive: ${absFile} (${Math.round(buf.byteLength / 1024)} KB)`));
            }
            const installedPlugin = await ctx.api.post<PluginRecord>(
              "/api/plugins/install-file",
              buf,
              { headers: { "content-type": "application/octet-stream" } },
            );

            if (ctx.json) {
              printOutput(installedPlugin, { json: true });
              return;
            }

            if (!installedPlugin) {
              console.log(pc.dim("Install returned no plugin record."));
              return;
            }

            console.log(
              pc.green(
                `✓ Installed ${pc.bold(installedPlugin.pluginKey)} v${installedPlugin.version} (${installedPlugin.status})`,
              ),
            );
            if (installedPlugin.lastError) {
              console.log(pc.red(`  Warning: ${installedPlugin.lastError}`));
            }
            return;
          }

          // Auto-detect local paths: starts with . or / or ~ or is an absolute path
          const isLocal =
            opts.local ||
            packageArg.startsWith("./") ||
            packageArg.startsWith("../") ||
            packageArg.startsWith("/") ||
            packageArg.startsWith("~");

          const resolvedPackage = resolvePackageArg(packageArg, isLocal);

          if (!ctx.json) {
            console.log(
              pc.dim(
                isLocal
                  ? `Installing plugin from local path: ${resolvedPackage}`
                  : `Installing plugin: ${resolvedPackage}${opts.version ? `@${opts.version}` : ""}`,
              ),
            );
          }

          const installedPlugin = await ctx.api.post<PluginRecord>("/api/plugins/install", {
            packageName: resolvedPackage,
            version: opts.version,
            isLocalPath: isLocal,
          });

          if (ctx.json) {
            printOutput(installedPlugin, { json: true });
            return;
          }

          if (!installedPlugin) {
            console.log(pc.dim("Install returned no plugin record."));
            return;
          }

          console.log(
            pc.green(
              `✓ Installed ${pc.bold(installedPlugin.pluginKey)} v${installedPlugin.version} (${installedPlugin.status})`,
            ),
          );

          if (installedPlugin.lastError) {
            console.log(pc.red(`  Warning: ${installedPlugin.lastError}`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin uninstall <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("uninstall <pluginKey>")
      .description(
        "Uninstall a plugin by its plugin key or database ID.\n" +
          "  Use --force to hard-purge all state and config.",
      )
      .option("--force", "Purge all plugin state and config (hard delete)", false)
      .action(async (pluginKey: string, opts: PluginUninstallOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const purge = opts.force === true;
          const qs = purge ? "?purge=true" : "";

          if (!ctx.json) {
            console.log(
              pc.dim(
                purge
                  ? `Uninstalling and purging plugin: ${pluginKey}`
                  : `Uninstalling plugin: ${pluginKey}`,
              ),
            );
          }

          const result = await ctx.api.delete<PluginRecord | null>(
            `/api/plugins/${encodeURIComponent(pluginKey)}${qs}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ Uninstalled ${pc.bold(pluginKey)}${purge ? " (purged)" : ""}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin enable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("enable <pluginKey>")
      .description("Enable a disabled or errored plugin")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/enable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.green(`✓ Enabled ${pc.bold(pluginKey)} — status: ${result?.status ?? "unknown"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin reinstall <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("reinstall <pluginKey>")
      .description(
        "Re-read a local-path plugin from disk: re-copies dist/ into the managed install directory and reloads the worker. Use this after `pnpm build` to pick up code changes WITHOUT losing config or plugin-scoped state. Only works for plugins originally installed with --local; for npm packages use `upgrade`.",
      )
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/reinstall`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(
            pc.green(
              `✓ Reinstalled ${pc.bold(pluginKey)} v${result?.version ?? "?"} — status: ${result?.status ?? "unknown"}`,
            ),
          );
          if (result?.lastError) {
            console.log(pc.red(`  Warning: ${result.lastError}`));
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin disable <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("disable <pluginKey>")
      .description("Disable a running plugin without uninstalling it")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.post<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}/disable`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          console.log(pc.dim(`Disabled ${pc.bold(pluginKey)} — status: ${result?.status ?? "unknown"}`));
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin inspect <plugin-key-or-id>
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("inspect <pluginKey>")
      .description("Show full details for an installed plugin")
      .action(async (pluginKey: string, opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const result = await ctx.api.get<PluginRecord>(
            `/api/plugins/${encodeURIComponent(pluginKey)}`,
          );

          if (ctx.json) {
            printOutput(result, { json: true });
            return;
          }

          if (!result) {
            console.log(pc.red(`Plugin not found: ${pluginKey}`));
            process.exit(1);
          }

          console.log(formatPlugin(result));
          if (result.lastError) {
            console.log(`\n${pc.red("Last error:")}\n${result.lastError}`);
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );

  // -------------------------------------------------------------------------
  // plugin pack <path>
  // -------------------------------------------------------------------------
  plugin
    .command("pack <path>")
    .description(
      "Bundle a built plugin into a single .pcplugin file for distribution.\n" +
        "  The output zip contains the plugin's dist/ folder plus a sanitized package.json.\n" +
        "  Hand the resulting file to anyone running paperclip and they can install it via\n" +
        "  `paperclipai plugin install --file <path>` or by uploading it from the plugin manager UI.\n" +
        "  Examples:\n" +
        "    paperclipai plugin pack ./my-plugin                  # → ./my-plugin-0.1.0.pcplugin\n" +
        "    paperclipai plugin pack ./my-plugin --out dist/      # → dist/<id>-0.1.0.pcplugin\n" +
        "    paperclipai plugin pack ./my-plugin --no-build       # skip pnpm build before pack",
    )
    .option("--out <dir>", "Directory the .pcplugin file is written to (default: current directory)")
    .option("--no-build", "Skip running `pnpm build` in the plugin folder before packing")
    .action(async (pluginPathArg: string, opts: PluginPackOptions) => {
      try {
        const absPluginDir = path.resolve(process.cwd(), pluginPathArg);
        if (!existsSync(absPluginDir) || !statSync(absPluginDir).isDirectory()) {
          throw new Error(`Plugin folder not found at ${absPluginDir}`);
        }

        // 1. Build (unless --no-build was passed)
        const shouldBuild = opts.build !== false;
        if (shouldBuild) {
          console.log(pc.dim(`Running pnpm build in ${absPluginDir}…`));
          try {
            const { stdout, stderr } = await execFileAsync("pnpm", ["build"], {
              cwd: absPluginDir,
              shell: true,
            });
            if (stdout.trim()) console.log(pc.dim(stdout.trim()));
            if (stderr.trim()) console.error(pc.yellow(stderr.trim()));
          } catch (err) {
            const stderr = (err as { stderr?: string }).stderr ?? "";
            const stdout = (err as { stdout?: string }).stdout ?? "";
            throw new Error(
              `pnpm build failed in ${absPluginDir}.\n${stderr}${stdout ? "\n" + stdout : ""}\n` +
                `If the plugin is already built, retry with --no-build.`,
            );
          }
        }

        // 2. Load the manifest and validate dist/
        const { id, version, pkgJson } = await loadPackagedManifest(absPluginDir);
        const distDir = path.join(absPluginDir, "dist");
        if (!existsSync(distDir)) {
          throw new Error(
            `No dist/ folder at ${distDir}. Run \`pnpm build\` (or remove --no-build) before packing.`,
          );
        }

        // 3. Build the zip
        const zip = new JSZip();
        await addDirToZip(zip, distDir, "dist");
        const sanitized: Record<string, unknown> = {};
        for (const k of PACKED_PACKAGE_FIELDS) {
          if (k in pkgJson) sanitized[k] = pkgJson[k];
        }
        zip.file("package.json", JSON.stringify(sanitized, null, 2) + "\n");

        const buf = await zip.generateAsync({
          type: "nodebuffer",
          compression: "DEFLATE",
          compressionOptions: { level: 6 },
        });

        // 4. Write to disk
        const outDir = opts.out
          ? path.resolve(process.cwd(), opts.out)
          : process.cwd();
        const outPath = path.join(outDir, `${id}-${version}.pcplugin`);
        await writeFile(outPath, buf);

        const sizeKb = Math.round(buf.byteLength / 1024);
        console.log(
          pc.green(`✓ Packed ${pc.bold(id)} v${version} → ${outPath} (${sizeKb} KB)`),
        );
      } catch (err) {
        handleCommandError(err);
      }
    });

  // -------------------------------------------------------------------------
  // plugin examples
  // -------------------------------------------------------------------------
  addCommonClientOptions(
    plugin
      .command("examples")
      .description("List bundled example plugins available for local install")
      .action(async (opts: BaseClientOptions) => {
        try {
          const ctx = resolveCommandContext(opts);
          const examples = await ctx.api.get<
            Array<{
              packageName: string;
              pluginKey: string;
              displayName: string;
              description: string;
              localPath: string;
              tag: string;
            }>
          >("/api/plugins/examples");

          if (ctx.json) {
            printOutput(examples, { json: true });
            return;
          }

          const rows = examples ?? [];
          if (rows.length === 0) {
            console.log(pc.dim("No bundled examples available."));
            return;
          }

          for (const ex of rows) {
            console.log(
              `${pc.bold(ex.displayName)}  ${pc.dim(ex.pluginKey)}\n` +
                `  ${ex.description}\n` +
                `  ${pc.cyan(`paperclipai plugin install ${ex.localPath}`)}`,
            );
          }
        } catch (err) {
          handleCommandError(err);
        }
      }),
  );
}
