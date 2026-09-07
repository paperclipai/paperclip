import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(scriptsDir, "..");
const configPath = path.join(repoRoot, ".cargo", "config.toml");

// A cargo build with the default network settings can fail on a short
// stall: cargo aborts a download after 30 seconds below 10 bytes per
// second, then retries only 3 times. These minimums keep the repository
// config wide enough to survive that kind of stall.
const MIN_NET_RETRY = 5;
const MIN_HTTP_TIMEOUT = 60;

function readIntUnderSection(text, sectionName, key) {
  const sectionPattern = new RegExp(`\\[${sectionName}\\]([\\s\\S]*?)(?:\\n\\[|$)`);
  const sectionMatch = text.match(sectionPattern);
  assert.ok(sectionMatch, `expected a [${sectionName}] section in ${configPath}`);
  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m");
  const keyMatch = sectionMatch[1].match(keyPattern);
  assert.ok(keyMatch, `expected ${sectionName}.${key} in ${configPath}`);
  return Number(keyMatch[1]);
}

test("the repository cargo config file exists at the repository root", () => {
  assert.doesNotThrow(() => readFileSync(configPath, "utf8"));
});

test("the repository cargo config raises the network retry count", () => {
  const text = readFileSync(configPath, "utf8");
  const retry = readIntUnderSection(text, "net", "retry");
  assert.ok(
    retry >= MIN_NET_RETRY,
    `net.retry is ${retry}; it must stay at ${MIN_NET_RETRY} or higher so a transient network stall does not fail the build`,
  );
});

test("the repository cargo config raises the http transfer timeout", () => {
  const text = readFileSync(configPath, "utf8");
  const timeout = readIntUnderSection(text, "http", "timeout");
  assert.ok(
    timeout >= MIN_HTTP_TIMEOUT,
    `http.timeout is ${timeout}; it must stay at ${MIN_HTTP_TIMEOUT} or higher so a transient network stall does not fail the build`,
  );
});
