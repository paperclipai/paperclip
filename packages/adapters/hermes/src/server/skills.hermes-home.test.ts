import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { resolveHermesHome } from "./skills.js";

/**
 * Pure resolution tests: they assert the *path* the adapter derives, so they
 * run on every platform — including Windows hosts without Developer Mode,
 * where creating the symlinks asserted in index.test.ts raises EPERM.
 *
 * Ground truth is hermes_constants.get_hermes_home():
 *   HERMES_HOME (expandvars + expanduser) if set, else the platform default
 *   (%LOCALAPPDATA%/hermes on Windows, ~/.hermes elsewhere), with
 *   HERMES_DATA_DIR_SUFFIX appended.
 */

const TOUCHED = [
  "HERMES_HOME",
  "HERMES_DATA_DIR_SUFFIX",
  "LOCALAPPDATA",
  "HERMES_HOME_TEST_HOME",
] as const;
const original = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of TOUCHED) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("an explicitly set HERMES_HOME in adapter config wins over HOME and process env", () => {
  const configHome = path.join(os.tmpdir(), "hermes-home-from-config");
  const processHome = path.join(os.tmpdir(), "hermes-home-from-process");
  process.env.HERMES_HOME = processHome;

  expect(
    resolveHermesHome({
      env: { HOME: path.join(os.tmpdir(), "some-home"), HERMES_HOME: configHome },
    }),
  ).toBe(path.resolve(configHome));
});

test("a deliberately set HERMES_HOME in the process env is honoured when config has none", () => {
  delete process.env.HERMES_HOME;
  const hermesHome = path.join(os.tmpdir(), "hermes-home-from-process-only");
  process.env.HERMES_HOME = hermesHome;

  expect(resolveHermesHome({ env: { HOME: path.join(os.tmpdir(), "some-home") } })).toBe(
    path.resolve(hermesHome),
  );
});

test("HERMES_HOME is never silently replaced by HOME", () => {
  delete process.env.HERMES_HOME;
  const home = path.join(os.tmpdir(), "hermes-home-not-this-one");
  const hermesHome = path.join(os.tmpdir(), "hermes-home-but-this-one");
  const resolved = resolveHermesHome({ env: { HOME: home, HERMES_HOME: hermesHome } });

  expect(resolved).not.toBe(path.resolve(home));
  expect(resolved).toBe(path.resolve(hermesHome));
});

test("HERMES_HOME expands %VAR% references and ~ before resolving", () => {
  delete process.env.HERMES_HOME;
  process.env.HERMES_HOME_TEST_HOME = path.join(os.tmpdir(), "expanded-hermes-home");

  expect(resolveHermesHome({ env: { HERMES_HOME: "%HERMES_HOME_TEST_HOME%" } })).toBe(
    path.resolve(process.env.HERMES_HOME_TEST_HOME),
  );
  expect(resolveHermesHome({ env: { HERMES_HOME: "~/expanded-home" } })).toBe(
    path.join(os.homedir(), "expanded-home"),
  );
});

test("HERMES_DATA_DIR_SUFFIX keeps a parallel install under its own directory", () => {
  delete process.env.HERMES_HOME;
  const suffix = "-parallel";
  const base = resolveHermesHome({ env: { HERMES_DATA_DIR_SUFFIX: suffix } });
  const withSuffix = resolveHermesHome({ env: { HERMES_DATA_DIR_SUFFIX: suffix } });

  expect(withSuffix).toBe(base);
  expect(path.basename(base)).toBe(`hermes${suffix}`);
});

test("without HERMES_HOME the platform default matches Hermes, not $HOME/.hermes on Windows", () => {
  delete process.env.HERMES_HOME;
  delete process.env.HERMES_DATA_DIR_SUFFIX;
  const localAppData = path.join(os.tmpdir(), "fake-localappdata");
  const home = path.join(os.tmpdir(), "fake-home");
  process.env.LOCALAPPDATA = localAppData;

  const resolved = resolveHermesHome({ env: { HOME: home } });
  const expected =
    process.platform === "win32"
      ? path.join(localAppData, "hermes")
      : path.join(path.resolve(home), ".hermes");

  expect(resolved).toBe(expected);
  if (process.platform === "win32") {
    // The bug: the adapter used to derive $HOME/.hermes here, a directory
    // Hermes never reads on Windows.
    expect(resolved).not.toBe(path.join(path.resolve(home), ".hermes"));
  }
});

test("an empty or blank HERMES_HOME falls back to the platform default", () => {
  delete process.env.HERMES_HOME;
  const localAppData = path.join(os.tmpdir(), "fake-localappdata-blank");
  process.env.LOCALAPPDATA = localAppData;
  const home = path.join(os.tmpdir(), "fake-home-blank");

  for (const blank of ["", "   "]) {
    const resolved = resolveHermesHome({ env: { HOME: home, HERMES_HOME: blank } });
    expect(resolved).toBe(
      process.platform === "win32"
        ? path.join(localAppData, "hermes")
        : path.join(path.resolve(home), ".hermes"),
    );
  }
});

test("structured {type:'plain'} binding is read; secret binding falls back", () => {
  delete process.env.HERMES_HOME;
  const plainHome = path.join(os.tmpdir(), "structured-plain-hermes");
  expect(
    resolveHermesHome({ env: { HERMES_HOME: { type: "plain", value: plainHome } } }),
  ).toBe(path.resolve(plainHome));
  const secretResult = resolveHermesHome({ env: { HERMES_HOME: { type: "secret", key_ref: "x" } } });
  expect(secretResult).not.toBe(path.resolve("secret"));
});
