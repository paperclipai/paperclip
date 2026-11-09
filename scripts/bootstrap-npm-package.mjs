#!/usr/bin/env node

// One-time npm bootstrap for a brand-new release package. Publishes a minimal
// placeholder at version 0.0.0 — never the package's real build output — so:
//
// - the PR CI gate (scripts/check-release-package-bootstrap.mjs) passes, since
//   it only requires the name to resolve on the registry
// - trusted publishing can be configured on npmjs.com (the package page must
//   exist before a trusted publisher rule can be added)
// - real package content only ever reaches npm from CI, after the PR that adds
//   the package has been reviewed and merged
//
// The first real calver release supersedes the placeholder, and a stable
// release moves `latest` off it. The placeholder needs no local build and no
// workspace state, so it can run from any checkout (including master, before
// the package's PR merges).
//
// npm one-time passwords are single-use and time-limited, so the helper
// prompts for them interactively (publish and deprecate each need their own
// code) and hands them to npm through its environment (npm_config_otp) —
// codes never appear on a command line, in shell history, or in a process
// listing. It also waits for the registry to show the package before
// deprecating — a first publish can take a few minutes to become visible on
// the read/write endpoints.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PLACEHOLDER_VERSION = "0.0.0";

const SCOPE_RE = /^@paperclipai\/[a-z0-9][a-z0-9._-]*$/;

const REGISTRY_POLL_INTERVAL_MS = 15_000;
const REGISTRY_POLL_ATTEMPTS = 40; // ~10 minutes
// Require back-to-back sightings: the write endpoint used by `npm deprecate`
// can trail the read endpoint, so one extra interval is cheap insurance.
const REGISTRY_POLL_CONSECUTIVE = 2;

const OTP_ATTEMPTS = 3;

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/bootstrap-npm-package.mjs <package-name> [--publish]",
      "",
      "Publishes an empty placeholder at version 0.0.0 that reserves <package-name> on npm",
      "so the release-bootstrap CI gate passes and trusted publishing can be configured.",
      "Real package content is only ever published by CI. Without --publish this is a dry run.",
      "",
      "With --publish the helper prompts for npm one-time passwords interactively",
      "(publish and deprecate each need their own code) and hands them to npm via its",
      "environment, so codes never appear on a command line.",
      "",
      "Examples:",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package",
      "  node scripts/bootstrap-npm-package.mjs @paperclipai/new-package --publish",
      "",
    ].join("\n"),
  );
}

export function parseArgs(argv) {
  const flags = new Set();
  let packageName = null;

  for (const arg of argv) {
    if (arg === "--") {
      continue;
    }

    if (arg === "--publish") {
      flags.add(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return { help: true, packageName: null, publish: false };
    }

    if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    }

    if (packageName) {
      throw new Error("expected exactly one package name");
    }

    packageName = arg;
  }

  return {
    help: false,
    packageName,
    publish: flags.has("--publish"),
  };
}

export function validatePackageName(packageName) {
  if (!SCOPE_RE.test(packageName)) {
    throw new Error(
      `refusing to publish a placeholder for ${JSON.stringify(packageName)}: ` +
        "the name must be a lowercase package inside the @paperclipai scope " +
        "(this guard prevents accidental publishes to names we do not own).",
    );
  }
}

export function buildPlaceholderFiles(packageName) {
  const deprecationNote =
    `${packageName}@${PLACEHOLDER_VERSION} is a placeholder that reserves the package name ` +
    "for Paperclip's release pipeline. It contains no functionality; the first real release " +
    "supersedes it. See https://github.com/paperclipai/paperclip";

  const packageJson = {
    name: packageName,
    version: PLACEHOLDER_VERSION,
    description:
      "Placeholder publish reserving this name for Paperclip's release pipeline. Do not install this version.",
    license: "MIT",
    main: "index.js",
    files: ["index.js"],
    repository: {
      type: "git",
      url: "git+https://github.com/paperclipai/paperclip.git",
    },
    homepage: "https://github.com/paperclipai/paperclip",
    publishConfig: {
      access: "public",
    },
  };

  const indexJs = `throw new Error(${JSON.stringify(deprecationNote)});\n`;

  const readme = [
    `# ${packageName}`,
    "",
    `Version ${PLACEHOLDER_VERSION} is a **placeholder publish**. It reserves this package name so`,
    "Paperclip's release-bootstrap CI gate can pass before the package's first real",
    "release ships from CI. It intentionally contains no functionality.",
    "",
    "Real versions are published by the release workflow of",
    "[paperclipai/paperclip](https://github.com/paperclipai/paperclip).",
    "",
  ].join("\n");

  return {
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "index.js": indexJs,
    "README.md": readme,
    deprecationNote,
  };
}

function runNpm(args, options = {}) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);

  return result;
}

export function ensureNpmAuth() {
  const result = runNpm(["whoami"]);

  if (result.status === 0) {
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE401\b|401 Unauthorized/i.test(output)) {
    throw new Error(
      [
        "npm auth check failed.",
        "This usually means the machine is either not logged into npm yet or has a stale token in ~/.npmrc.",
        "Run `npm logout --registry=https://registry.npmjs.org/` and then `npm login` or `npm adduser` on this maintainer machine with an npm account that can publish to the @paperclipai scope, then rerun with --publish.",
        "Do not use this auth flow in CI; it is only for the one-time human bootstrap publish.",
      ].join(" "),
    );
  }

  throw new Error("npm whoami failed");
}

export function inspectNpmPackage(packageName) {
  // Deliberately quiet: for a fresh bootstrap the expected outcome is E404
  // ("the name is free"), and npm's error dump for that reads like a failure.
  // Output is only surfaced when the query fails for an unexpected reason.
  const result = spawnSync("npm", ["view", packageName, "version", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    const version = JSON.parse((result.stdout ?? "").trim());
    return { exists: true, version };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (/\bE404\b|404 Not Found|could not be found/i.test(output)) {
    return { exists: false };
  }

  if (output) process.stderr.write(`${output}\n`);
  throw new Error(`failed to query npm for ${packageName}`);
}

export async function promptOtp(rl, purpose) {
  for (;;) {
    const answer = (await rl.question(`Enter the npm one-time password to ${purpose}: `)).trim();
    if (answer) return answer;
    process.stdout.write("A one-time password is required.\n");
  }
}

export async function waitForPackageVisible(
  packageName,
  {
    attempts = REGISTRY_POLL_ATTEMPTS,
    intervalMs = REGISTRY_POLL_INTERVAL_MS,
    consecutive = REGISTRY_POLL_CONSECUTIVE,
    inspect = inspectNpmPackage,
    sleep = delay,
  } = {},
) {
  let seen = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await sleep(intervalMs);

    let state = null;
    try {
      state = inspect(packageName);
    } catch {
      state = null; // transient registry error: keep polling
    }

    if (state?.exists) {
      seen += 1;
      if (seen >= consecutive) return true;
    } else {
      seen = 0;
    }
  }
  return false;
}

async function publishPlaceholder(packageName, stageDir, rl) {
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `publish ${packageName}@${PLACEHOLDER_VERSION}`);
    // Hand the code to npm through its environment (npm_config_otp), not argv,
    // so it never appears in a process listing.
    const result = runNpm(["publish", "--access", "public"], {
      cwd: stageDir,
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output) && attempt < OTP_ATTEMPTS) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    throw new Error(`npm publish failed with status ${result.status ?? "unknown"}`);
  }
  throw new Error("npm publish failed: too many rejected one-time passwords");
}

async function deprecatePlaceholder(packageName, deprecationNote, rl) {
  const spec = `${packageName}@${PLACEHOLDER_VERSION}`;
  for (let attempt = 1; attempt <= OTP_ATTEMPTS; attempt += 1) {
    const otp = await promptOtp(rl, `deprecate ${spec}`);
    const result = runNpm(["deprecate", spec, deprecationNote], {
      env: { ...process.env, npm_config_otp: otp },
    });
    if (result.status === 0) return true;

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    if (/\bEOTP\b|one-time password/i.test(output)) {
      process.stdout.write("The code was rejected or expired. Try a fresh one.\n");
      continue;
    }
    if (/\bE404\b|404 Not Found/i.test(output)) {
      process.stdout.write(
        "The registry's write endpoint has not caught up yet; waiting 30s before retrying...\n",
      );
      await delay(30_000);
      continue;
    }
    break;
  }
  return false;
}

function printManualDeprecateFallback(packageName, deprecationNote) {
  process.stdout.write(
    [
      "",
      "The placeholder could not be deprecated automatically. Once `npm view` resolves the package, run:",
      `npm deprecate ${packageName}@${PLACEHOLDER_VERSION} ${JSON.stringify(deprecationNote)} --otp <code>`,
      "",
    ].join("\n"),
  );
}

function printNextSteps(packageName) {
  process.stdout.write(
    [
      "",
      "Next:",
      `1. Open https://www.npmjs.com/package/${packageName}`,
      "2. Go to Settings -> Trusted publishing",
      "3. Add repository paperclipai/paperclip",
      "4. Set workflow filename to release.yml",
      "5. Optionally enable Settings -> Publishing access -> Require two-factor authentication and disallow tokens",
      `6. Only then flip the package to "publishFromCi": true in scripts/release-package-manifest.json`,
      "",
    ].join("\n"),
  );
}

async function stageAndPublish(packageName, { publish }) {
  const files = buildPlaceholderFiles(packageName);
  const stageDir = mkdtempSync(join(tmpdir(), "paperclip-npm-placeholder-"));

  try {
    for (const fileName of ["package.json", "index.js", "README.md"]) {
      writeFileSync(join(stageDir, fileName), files[fileName]);
    }

    process.stdout.write(`Staged placeholder for ${packageName} in ${stageDir}\n`);
    process.stdout.write(`Previewing publish payload (npm publish --dry-run)...\n`);
    const dryRun = runNpm(["publish", "--dry-run", "--access", "public"], { cwd: stageDir });
    if (dryRun.status !== 0) {
      throw new Error(`npm publish --dry-run failed with status ${dryRun.status ?? "unknown"}`);
    }

    if (!publish) {
      process.stdout.write(
        [
          "",
          "Dry run complete. To publish the placeholder from an authenticated maintainer machine, run:",
          `node scripts/bootstrap-npm-package.mjs ${packageName} --publish`,
          "",
        ].join("\n"),
      );
      return;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await publishPlaceholder(packageName, stageDir, rl);
      process.stdout.write(`Placeholder ${packageName}@${PLACEHOLDER_VERSION} published.\n`);

      process.stdout.write(
        "Waiting for the registry to show the package before deprecating (a first publish can take a few minutes)...\n",
      );
      const visible = await waitForPackageVisible(packageName);

      let deprecated = false;
      if (visible) {
        deprecated = await deprecatePlaceholder(packageName, files.deprecationNote, rl);
      } else {
        process.stdout.write("Timed out waiting for the registry to show the package.\n");
      }

      if (deprecated) {
        process.stdout.write(`Deprecated ${packageName}@${PLACEHOLDER_VERSION}.\n`);
      } else {
        printManualDeprecateFallback(packageName, files.deprecationNote);
      }

      printNextSteps(packageName);
    } finally {
      rl.close();
    }
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

async function main(argv) {
  const { help, packageName, publish } = parseArgs(argv);

  if (help) {
    usage();
    return;
  }

  if (!packageName) {
    usage();
    throw new Error("missing package name");
  }

  validatePackageName(packageName);

  if (publish && !process.stdin.isTTY) {
    throw new Error(
      "--publish needs an interactive terminal: the helper prompts for npm one-time passwords instead of taking them as arguments.",
    );
  }

  const npmState = inspectNpmPackage(packageName);
  if (npmState.exists) {
    throw new Error(
      `${packageName} already exists on npm at version ${npmState.version}; the bootstrap flow is only for names that have never been published`,
    );
  }

  process.stdout.write(`${packageName} is not on npm yet; continuing with placeholder bootstrap.\n`);

  if (publish) {
    process.stdout.write("Checking npm auth with npm whoami...\n");
    ensureNpmAuth();
  }

  await stageAndPublish(packageName, { publish });
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
