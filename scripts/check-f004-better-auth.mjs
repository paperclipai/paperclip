#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FLOOR = "1.6.11";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? "");
  return match ? match.slice(1).map(Number) : null;
}

function atLeast(value, floor) {
  const left = parseVersion(value);
  const right = parseVersion(floor);
  if (!left || !right) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function inspect(root) {
  const manifest = readJson(path.join(root, "server", "package.json"));
  const installed = readJson(
    path.join(root, "server", "node_modules", "better-auth", "package.json"),
  );
  const manifestVersion = manifest?.dependencies?.["better-auth"];
  const installedVersion = installed?.version;
  const failures = [];

  if (!parseVersion(manifestVersion)) failures.push("F004_MANIFEST_NOT_EXACT");
  else if (!atLeast(manifestVersion, FLOOR)) failures.push("F004_MANIFEST_BELOW_FLOOR");
  if (!installedVersion) failures.push("F004_INSTALLED_UNRESOLVED");
  else if (!parseVersion(installedVersion)) failures.push("F004_INSTALLED_INVALID");
  else if (!atLeast(installedVersion, FLOOR)) failures.push("F004_INSTALLED_BELOW_FLOOR");
  if (manifestVersion && installedVersion && manifestVersion !== installedVersion) {
    failures.push("F004_MANIFEST_INSTALLED_MISMATCH");
  }

  return {
    failures,
    floorMet: atLeast(manifestVersion, FLOOR) && atLeast(installedVersion, FLOOR),
    manifestVersion: manifestVersion ?? "unresolved",
    installedVersion: installedVersion ?? "unresolved",
  };
}

function fixture(root, manifestVersion, installedVersion) {
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "server", "package.json"),
    JSON.stringify({ dependencies: { "better-auth": manifestVersion } }),
  );
  if (installedVersion) {
    const installed = path.join(root, "server", "node_modules", "better-auth");
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, "package.json"), JSON.stringify({ version: installedVersion }));
  }
}

function selfTest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "f004-version-gate-"));
  const results = [];
  try {
    const vulnerable = path.join(base, "vulnerable");
    fixture(vulnerable, "1.4.18", "1.4.18");
    results.push(inspect(vulnerable));
    assert.deepEqual(results.at(-1), {
      failures: ["F004_MANIFEST_BELOW_FLOOR", "F004_INSTALLED_BELOW_FLOOR"],
      floorMet: false,
      manifestVersion: "1.4.18",
      installedVersion: "1.4.18",
    });

    const target = path.join(base, "target");
    fixture(target, "1.6.20", "1.6.20");
    results.push(inspect(target));
    assert.deepEqual(results.at(-1), {
      failures: [],
      floorMet: true,
      manifestVersion: "1.6.20",
      installedVersion: "1.6.20",
    });

    const safeLater = path.join(base, "safe-later");
    fixture(safeLater, "1.6.21", "1.6.21");
    results.push(inspect(safeLater));
    assert.deepEqual(results.at(-1), {
      failures: [],
      floorMet: true,
      manifestVersion: "1.6.21",
      installedVersion: "1.6.21",
    });

    const mismatch = path.join(base, "mismatch");
    fixture(mismatch, "1.6.20", FLOOR);
    results.push(inspect(mismatch));
    assert.deepEqual(results.at(-1), {
      failures: ["F004_MANIFEST_INSTALLED_MISMATCH"],
      floorMet: true,
      manifestVersion: "1.6.20",
      installedVersion: FLOOR,
    });

    const unresolved = path.join(base, "unresolved");
    fixture(unresolved, "1.6.20", null);
    results.push(inspect(unresolved));
    assert.deepEqual(results.at(-1), {
      failures: ["F004_INSTALLED_UNRESOLVED"],
      floorMet: false,
      manifestVersion: "1.6.20",
      installedVersion: "unresolved",
    });

    const ranged = path.join(base, "ranged");
    fixture(ranged, "^1.6.20", "1.6.20");
    results.push(inspect(ranged));
    assert.deepEqual(results.at(-1), {
      failures: ["F004_MANIFEST_NOT_EXACT", "F004_MANIFEST_INSTALLED_MISMATCH"],
      floorMet: false,
      manifestVersion: "^1.6.20",
      installedVersion: "1.6.20",
    });

    const red = results.filter((result) => result.failures.length > 0).length;
    const green = results.length - red;
    console.log(`F004_VERSION_SELF_TEST_OK red=${red} green=${green}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const result = inspect(root);
  console.log(result.floorMet ? "F004_ADVISORY_FLOOR_GREEN" : "F004_ADVISORY_FLOOR_RED");
  for (const failure of result.failures) console.log(failure);
  console.log(
    `${result.failures.length ? "F004_VERSION_GATE_RED" : "F004_VERSION_GATE_GREEN"} manifest=${result.manifestVersion} installed=${result.installedVersion} floor=${FLOOR}`,
  );
  if (result.failures.length) process.exitCode = 1;
}
