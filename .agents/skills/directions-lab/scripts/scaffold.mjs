#!/usr/bin/env node
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, helpText, parseArgs, UsageError } from "./lib/args.mjs";
import { validateCapabilities } from "./lib/capabilities.mjs";
import { checkLab, verificationBlock } from "./lib/check.mjs";
import { assembleContext, buildContext, deriveDirection, deriveSurface, upperSnake } from "./lib/context.mjs";
import { pickPorts } from "./lib/ports.mjs";
import { findLabs, insertDirection, insertDirectionStory, readRegistry, RegistryShapeError } from "./lib/registry-edit.mjs";
import { launchEntries, renderDirection, renderLab } from "./lib/render.mjs";
import { addGitignoreLine, addLaunchEntries, restoreShared } from "./lib/shared-files.mjs";
import { describeFailure, runVerification, verificationSteps } from "./lib/verify.mjs";
import { checkRendered, newJournal, rollback, writeFiles } from "./lib/write.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "../../../..");

const log = (...parts) => console.log(...parts);

function resolveRoot(flags) {
  const root = path.resolve(flags.root ?? DEFAULT_ROOT);
  if (!existsSync(root)) throw new UsageError(`--root ${root} does not exist`);
  return root;
}

function nextCommands(ctx) {
  return [
    `preview_start ${ctx.slug}-directions-dev   (or: cd ui && npx vite --config ${ctx.configFile} --port ${ctx.ports.dev} --strictPort)`,
    `open http://127.0.0.1:${ctx.ports.dev}/  ·  /?d=today&s=${ctx.surfaces[0].id}  ·  /?d=${ctx.directions[0].id}&s=${ctx.surfaces[0].id}`,
    `cd ui && npx vitest run src/${ctx.slug}-directions`,
    `node .agents/skills/directions-lab/scripts/scaffold.mjs check --slug ${ctx.slug}`,
    `node ${ctx.labDir}/shot.cjs --port ${ctx.ports.dev} --d all --out <scratch> [--hover]`,
  ];
}

function plan(ctx, files, launch) {
  return {
    lab: { slug: ctx.slug, title: ctx.title, storyId: ctx.storyId, group: ctx.group, capabilities: ctx.capabilities, exception: ctx.capabilities.length ? null : ctx.exception },
    directions: ctx.kits.map(({ id, key, name, tagline }) => ({ id, key, name, tagline })),
    surfaces: ctx.surfaces.map(({ id, label, width, nav }) => ({ id, label, width, nav })),
    toolbar: { surfacesRow: ctx.multiSurface, views: ctx.multiSurface ? ["board", ...ctx.surfaces.map((surface) => surface.id)] : ["board", ctx.surfaces[0].id] },
    cells: ctx.cells,
    landing: `?d=${ctx.landing.direction}&s=${ctx.landing.view}`,
    ports: ctx.ports,
    paths: [...files.keys()],
    shared: { launch: launch.names, gitignore: ctx.distDir },
    commands: nextCommands(ctx),
  };
}

async function commandNew(flags) {
  const root = resolveRoot(flags);
  const capabilities = await validateCapabilities(root, flags.capabilities);
  const ports = pickPorts(root, flags.ports);
  const ctx = buildContext(flags, { root, ports, capabilities });
  if (ctx.forceCount) console.warn(`WARN: ${ctx.directions.length} directions; the house rule is 2 or 3 (forced with --force-count)`);
  if (!capabilities.length) console.warn(`NOTE: no --capabilities; the story carries capabilities: [] with the exception sentence: ${ctx.exception}`);
  const files = await renderLab(ctx);
  const launch = await launchEntries(ctx);
  const problems = checkRendered(files, { root });
  if (problems.length) throw new UsageError(`refusing to write:\n  ${problems.join("\n  ")}`);
  const summary = plan(ctx, files, launch);
  if (flags["dry-run"]) {
    if (flags.json) log(JSON.stringify(summary, null, 2));
    else {
      log(`Dry run for ${ctx.labDir} (${ctx.cells} cells, landing ${summary.landing}, ports ${ports.dev}/${ports.preview}, surfaces row ${ctx.multiSurface ? "yes" : "no"})`);
      for (const file of summary.paths) log(`  ${file}`);
      log(`  .claude/launch.json (+${launch.names.join(", ")})`);
      log(`  .gitignore (+${ctx.distDir})`);
    }
    return 0;
  }
  const progress = flags.json ? (...parts) => console.error(...parts) : log;
  const journal = newJournal();
  const shared = [];
  const undo = () => {
    rollback(journal);
    restoreShared(shared);
    for (const dir of [path.join(root, "ui", ctx.staticDir), path.join(root, "ui/node_modules", `.vite-${ctx.slug}-directions-${ctx.ports.dev}`)]) rmSync(dir, { recursive: true, force: true });
  };
  let verification = { ok: true, results: [] };
  try {
    writeFiles(files, { root, journal });
    shared.push(addLaunchEntries(root, launch.entries));
    shared.push(addGitignoreLine(root, ctx.distDir));
    progress(`Wrote ${files.size} files under ${root} for ${ctx.labDir}; edited .claude/launch.json and .gitignore`);
    if (!flags["skip-verify"]) {
      verification = runVerification(root, verificationSteps(ctx, { noBuild: flags["no-build"] }), {
        onStep: (result) => progress(`${result.ok ? "ok  " : "FAIL"} ${result.label}: ${result.command}`),
      });
    }
  } catch (error) {
    undo();
    console.error(`scaffold: ${error.message}`);
    console.error("Rolled back every written path and restored .claude/launch.json and .gitignore.");
    return 1;
  }
  if (!verification.ok) {
    const failed = verification.results.find((result) => !result.ok);
    console.error(describeFailure(failed));
    if (flags["keep-on-failure"]) {
      console.error(`Kept the written files for inspection (--keep-on-failure). Remove them with: rm -rf ${ctx.labDir} ui/${ctx.entry} ui/${ctx.configFile} ${ctx.storyFile}`);
    } else {
      undo();
      console.error("Rolled back every written path and restored .claude/launch.json and .gitignore.");
    }
    return 1;
  }
  if (flags.json) log(JSON.stringify({ ...summary, verification: verification.results.map(({ label, command, ok }) => ({ label, command, ok })) }, null, 2));
  else {
    log(`\n${ctx.title} directions lab: ${ctx.kits.length} kits × ${ctx.surfaces.length} surface(s) = ${ctx.cells} cells; landing ${summary.landing}; story ${ctx.storyId}`);
    log(`Ports: dev ${ports.dev}, preview ${ports.preview}. Surfaces row: ${ctx.multiSurface ? "yes" : "no (legend joins row 1)"}.`);
    log(`Verification: ${verification.results.length ? verification.results.map((result) => `${result.label} ok`).join(", ") : "skipped"}`);
    log("Next:");
    for (const command of summary.commands) log(`  ${command}`);
  }
  return 0;
}

function commandList(flags) {
  const root = resolveRoot(flags);
  const labs = findLabs(root);
  const launch = existsSync(path.join(root, ".claude/launch.json")) ? JSON.parse(readFileSync(path.join(root, ".claude/launch.json"), "utf8")).configurations : [];
  const rows = labs.map(({ dir, registry }) => ({
    slug: registry.slug,
    title: registry.title,
    dir,
    storyId: registry.storyId,
    directions: registry.directions.map((direction) => direction.id),
    surfaces: registry.surfaces.map((surface) => surface.id),
    ports: {
      dev: launch.find((entry) => entry.name === `${registry.slug}-directions-dev`)?.port ?? null,
      preview: launch.find((entry) => entry.name === `${registry.slug}-directions`)?.port ?? null,
    },
  }));
  if (flags.json) log(JSON.stringify(rows, null, 2));
  else if (!rows.length) log("No labs found (ui/src/*-directions/registry.ts).");
  else for (const row of rows) log(`${row.slug}\t${row.title}\t${row.dir}\tdirections: ${row.directions.join(", ")}\tsurfaces: ${row.surfaces.join(", ")}\tports: ${row.ports.dev ?? "?"}/${row.ports.preview ?? "?"}\tstory: ${row.storyId}`);
  return 0;
}

function commandCheck(flags) {
  const root = resolveRoot(flags);
  if (!flags.slug) throw new UsageError("--slug is required");
  const result = checkLab(root, flags.slug, { strict: Boolean(flags.strict), run: Boolean(flags.run), skipVerify: Boolean(flags["skip-verify"]) });
  if (flags.json) log(JSON.stringify({ ok: result.errors.length === 0, errors: result.errors, warnings: result.warnings, verification: result.verification.map(({ label, command, ok }) => ({ label, command, ok })), notRun: result.notRun }, null, 2));
  else {
    for (const warning of result.warnings) log(`WARN ${warning}`);
    for (const error of result.errors) console.error(`FAIL ${error}`);
    if (flags.run) log(`\n${verificationBlock(result.verification, { skipped: result.notRun })}`);
    log(result.errors.length ? `\ncheck: ${result.errors.length} problem(s)` : `check: ok (${result.warnings.length} warning(s))`);
  }
  return result.errors.length ? 1 : 0;
}

async function commandAddDirection(flags) {
  const root = resolveRoot(flags);
  if (!flags.slug) throw new UsageError("--slug is required");
  if (!flags.name) throw new UsageError("--name is required");
  const labDir = path.join(root, `ui/src/${flags.slug}-directions`);
  const registryFile = path.join(labDir, "registry.ts");
  if (!existsSync(registryFile)) throw new UsageError(`no lab at ui/src/${flags.slug}-directions`);
  const text = readFileSync(registryFile, "utf8");
  const registry = readRegistry(text, path.relative(root, registryFile));
  const explorations = registry.directions.filter((direction) => !direction.baseline);
  const digit = explorations.length + 1;
  if (digit > 9) throw new UsageError("a lab holds at most nine explorations (one digit each)");
  if (digit > 3 && !flags["force-count"]) throw new UsageError(`this lab already has ${explorations.length} explorations; a ${digit}th needs --force-count`);
  const direction = deriveDirection(digit, flags.name);
  if (registry.directions.some((entry) => entry.id === direction.id)) throw new UsageError(`direction ${direction.id} already exists`);
  const ctx = assembleContext({
    root,
    slug: registry.slug,
    title: registry.title,
    group: registry.group,
    surfaces: registry.surfaces.map(deriveSurface),
    directions: [...explorations.map((entry) => ({ ...entry, digit: Number(entry.key), prefix: entry.id.replace(/^d\d+-/, "") })), direction],
    company: { id: `company-${registry.slug}`, name: registry.slug, issuePrefix: upperSnake(registry.slug).slice(0, 3) },
    landing: registry.landing,
    ports: { dev: 0, preview: 0 },
    capabilities: [],
    forceCount: digit > 3,
  });
  const files = await renderDirection(ctx, direction);
  const problems = checkRendered(files, { root });
  if (problems.length) throw new UsageError(`refusing to write:\n  ${problems.join("\n  ")}`);
  const storyFile = path.join(root, `ui/storybook/stories/design-proposals/${registry.slug}-directions.stories.tsx`);
  if (!existsSync(storyFile)) throw new UsageError(`${path.relative(root, storyFile)} is missing`);
  const storyText = readFileSync(storyFile, "utf8");
  const kitFile = path.join(labDir, "kit.ts");
  const changed = changedSlotContracts(existsSync(kitFile) ? readFileSync(kitFile, "utf8") : "", ctx.surfaces);
  if (changed.length) {
    throw new UsageError(
      `the slot props in ui/src/${registry.slug}-directions/kit.ts no longer match the scaffold's placeholder (${changed.join(", ")}), ` +
        "so a generated kit would not fit them. Add the direction by hand: copy an existing exploration's directory to " +
        `directions/${direction.id}, rename its id, name, tagline and --<prefix>- tokens, then add its registry entry and the D${digit} story export.`,
    );
  }
  const next = insertDirection(text, direction, { file: path.relative(root, registryFile), allowMore: digit > 3 });
  const nextStory = insertDirectionStory(storyText, direction, path.relative(root, storyFile));
  const journal = newJournal();
  const undo = () => {
    rollback(journal);
    writeFileSync(registryFile, text);
    writeFileSync(storyFile, storyText);
  };
  let errors = [];
  try {
    writeFiles(files, { root, journal });
    writeFileSync(registryFile, next);
    writeFileSync(storyFile, nextStory);
    errors = checkLab(root, registry.slug, { skipVerify: Boolean(flags["skip-verify"]) }).errors;
    if (!errors.length && !flags["skip-verify"]) {
      const steps = verificationSteps(ctx, { noBuild: true }).filter((step) => step.label === "lab vitest");
      const verification = runVerification(root, steps);
      if (!verification.ok) errors = [describeFailure(verification.results.find((result) => !result.ok))];
    }
  } catch (error) {
    errors = [error.message];
  }
  if (errors.length) {
    undo();
    for (const error of errors) console.error(`FAIL ${error}`);
    console.error("Rolled the new direction back.");
    return 1;
  }
  if (flags.json) log(JSON.stringify({ direction: { id: direction.id, key: direction.key, name: direction.name, tagline: direction.tagline }, paths: [...files.keys(), path.relative(root, registryFile), path.relative(root, storyFile)] }, null, 2));
  else {
    log(`Added ${direction.id} (${direction.name}): ${files.size} files, a registry entry and the story export D${digit}.`);
    log(`Next: cd ui && npx vitest run src/${registry.slug}-directions`);
  }
  return 0;
}

export function changedSlotContracts(kitText, surfaces) {
  if (!/export interface LabRecord \{/.test(kitText)) return ["LabRecord"];
  return surfaces
    .filter((surface) => ![`  ${JSON.stringify(surface.id)}: { items: LabRecord[] };`, `  ${surface.id}: { items: LabRecord[] };`].some((line) => kitText.includes(line)))
    .map((surface) => surface.id);
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`scaffold: ${error.message}\n`);
      console.error(helpText());
      return 1;
    }
    throw error;
  }
  if (parsed.command === "help") {
    log(helpText());
    return 0;
  }
  try {
    if (parsed.command === "new") return await commandNew(parsed.flags);
    if (parsed.command === "list") return commandList(parsed.flags);
    if (parsed.command === "check") return commandCheck(parsed.flags);
    if (parsed.command === "add-direction") return await commandAddDirection(parsed.flags);
    throw new UsageError(`unknown subcommand ${parsed.command}; expected ${Object.keys(COMMANDS).join(", ")}`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof RegistryShapeError) {
      console.error(`scaffold ${parsed.command}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`scaffold: ${error.stack ?? error.message}`);
      process.exit(1);
    },
  );
}
