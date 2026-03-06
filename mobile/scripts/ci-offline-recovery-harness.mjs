#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputDir = path.join(projectRoot, "dist", "offline-harness");
const outputReportPath = path.join(outputDir, "offline-recovery-report.json");
const outputJunitPath = path.join(outputDir, "offline-recovery-junit.xml");
const outputEventsPath = path.join(outputDir, "offline-recovery-events.log");
const outputDiagnosticsPath = path.join(outputDir, "offline-recovery-diagnostics.txt");
const startedAt = new Date().toISOString();

const assertions = [];
const events = [];
const diagnostics = [];

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toOneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function log(message) {
  const line = `[offline-harness] ${message}`;
  events.push(`${nowIso()} ${line}`);
  console.log(line);
}

function recordDiagnostic(label, payload) {
  diagnostics.push(`## ${label}\n${payload}\n`);
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  try {
    const result = await execFileAsync(command, args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: 0,
    };
  } catch (error) {
    const stdout = error.stdout ?? "";
    const stderr = error.stderr ?? "";
    const exitCode = Number.isInteger(error.code) ? error.code : -1;
    const rendered = `${command} ${args.join(" ")}`;
    throw new Error(
      `${rendered} failed (exit ${exitCode}): ${toOneLine(stderr || stdout || String(error.message))}`,
    );
  }
}

async function runShell(command, options = {}) {
  return runCommand("bash", ["-lc", command], options);
}

async function adb(serial, args, options = {}) {
  const scopedArgs = serial ? ["-s", serial, ...args] : args;
  return runCommand("adb", scopedArgs, options);
}

async function resolveDeviceSerial() {
  const { stdout } = await adb(null, ["devices"]);
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(1);

  const deviceLine = lines.find((line) => line.endsWith("\tdevice"));
  if (!deviceLine) {
    throw new Error("No booted Android emulator/device found in `adb devices`.");
  }

  return deviceLine.split("\t")[0];
}

async function waitForBootCompleted(serial, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { stdout } = await adb(serial, ["shell", "getprop", "sys.boot_completed"]);
    if (stdout.trim() === "1") {
      return;
    }
    await sleep(1500);
  }
  throw new Error("Timed out waiting for Android emulator boot completion.");
}

async function setAirplaneMode(serial, enabled) {
  const mode = enabled ? "enable" : "disable";
  try {
    await adb(serial, ["shell", "cmd", "connectivity", "airplane-mode", mode], {
      timeoutMs: 15000,
    });
  } catch {
    const state = enabled ? "1" : "0";
    await adb(serial, ["shell", "settings", "put", "global", "airplane_mode_on", state]);
    await adb(serial, [
      "shell",
      "am",
      "broadcast",
      "-a",
      "android.intent.action.AIRPLANE_MODE",
      "--ez",
      "state",
      enabled ? "true" : "false",
    ]);
  }
}

async function canReachHost(serial) {
  try {
    await adb(serial, ["shell", "ping", "-c", "1", "-W", "2", "10.0.2.2"], {
      timeoutMs: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

async function waitForConnectivity(serial, expectedOnline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    const online = await canReachHost(serial);
    if (online === expectedOnline) {
      return { attempts, online };
    }
    await sleep(1200);
  }

  const online = await canReachHost(serial);
  return { attempts, online };
}

async function runPhaseHook(phase) {
  const key = `OFFLINE_RECOVERY_${phase}_HOOK`;
  const hookCommand = process.env[key];
  if (!hookCommand) {
    return;
  }
  log(`Running hook ${key}`);
  await runShell(hookCommand, { timeoutMs: 60000 });
}

async function assertStep(code, description, run) {
  const started = Date.now();
  log(`ASSERT:${code}:START ${description}`);
  try {
    const details = await run();
    const durationMs = Date.now() - started;
    assertions.push({
      code,
      description,
      passed: true,
      durationMs,
      details,
    });
    log(`ASSERT:${code}:PASS ${description}`);
  } catch (error) {
    const durationMs = Date.now() - started;
    assertions.push({
      code,
      description,
      passed: false,
      durationMs,
      details: { error: String(error.message || error) },
    });
    log(`ASSERT:${code}:FAIL ${description} :: ${toOneLine(String(error.message || error))}`);
    throw error;
  }
}

async function captureDiagnostics(serial) {
  try {
    const [airplane, routes, netInterfaces, logcat] = await Promise.all([
      adb(serial, ["shell", "settings", "get", "global", "airplane_mode_on"]).catch(
        () => ({ stdout: "unavailable\n", stderr: "", exitCode: -1 }),
      ),
      adb(serial, ["shell", "ip", "route"]).catch(() => ({
        stdout: "unavailable\n",
        stderr: "",
        exitCode: -1,
      })),
      adb(serial, ["shell", "ip", "addr"]).catch(() => ({
        stdout: "unavailable\n",
        stderr: "",
        exitCode: -1,
      })),
      adb(serial, ["logcat", "-d", "-t", "300"]).catch(() => ({
        stdout: "unavailable\n",
        stderr: "",
        exitCode: -1,
      })),
    ]);

    recordDiagnostic("airplane_mode_on", airplane.stdout);
    recordDiagnostic("ip_route", routes.stdout);
    recordDiagnostic("ip_addr", netInterfaces.stdout);
    recordDiagnostic("logcat_tail", logcat.stdout);
  } catch (error) {
    recordDiagnostic("diagnostics_error", String(error.message || error));
  }
}

async function writeArtifacts(serial, failed) {
  await mkdir(outputDir, { recursive: true });

  const failedAssertions = assertions.filter((assertion) => !assertion.passed);
  const report = {
    startedAt,
    finishedAt: nowIso(),
    serial,
    failed,
    assertionCount: assertions.length,
    failedAssertionCount: failedAssertions.length,
    assertions,
    artifacts: {
      eventsLog: path.relative(projectRoot, outputEventsPath),
      diagnostics: path.relative(projectRoot, outputDiagnosticsPath),
      reportJson: path.relative(projectRoot, outputReportPath),
      junitXml: path.relative(projectRoot, outputJunitPath),
    },
  };

  const junitCases = assertions
    .map((assertion) => {
      const name = `${assertion.code} ${assertion.description}`;
      const durationSeconds = (assertion.durationMs / 1000).toFixed(3);
      if (assertion.passed) {
        return `    <testcase classname="offline-recovery" name="${xmlEscape(name)}" time="${durationSeconds}" />`;
      }

      const failureMessage = assertion.details?.error
        ? xmlEscape(String(assertion.details.error))
        : "Assertion failed";
      return [
        `    <testcase classname="offline-recovery" name="${xmlEscape(name)}" time="${durationSeconds}">`,
        `      <failure message="${failureMessage}" />`,
        "    </testcase>",
      ].join("\n");
    })
    .join("\n");

  const junit = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="offline-recovery" tests="${assertions.length}" failures="${failedAssertions.length}">`,
    junitCases,
    "</testsuite>",
    "",
  ].join("\n");

  await Promise.all([
    writeFile(outputReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
    writeFile(outputJunitPath, junit, "utf8"),
    writeFile(outputEventsPath, `${events.join("\n")}\n`, "utf8"),
    writeFile(outputDiagnosticsPath, `${diagnostics.join("\n")}\n`, "utf8"),
  ]);
}

async function runHarness() {
  let serial = "unknown";
  let failed = false;
  try {
    log("Starting offline recovery CI harness");
    await adb(null, ["start-server"]);
    serial = await resolveDeviceSerial();
    log(`Using device: ${serial}`);
    await waitForBootCompleted(serial);
    log("Emulator boot complete");

    await assertStep("OFF-01", "baseline online connectivity before disruption", async () => {
      const result = await waitForConnectivity(serial, true, 20000);
      if (!result.online) {
        throw new Error("Device could not reach host bridge (10.0.2.2) before disruption.");
      }
      return result;
    });

    await runPhaseHook("PRE_OFFLINE");

    await assertStep("OFF-03", "deterministic network drop detected in emulator", async () => {
      await setAirplaneMode(serial, true);
      const result = await waitForConnectivity(serial, false, 15000);
      if (result.online) {
        throw new Error("Connectivity still online after airplane mode enable.");
      }
      return result;
    });

    await runPhaseHook("OFFLINE");

    await assertStep("OFF-02", "recovery reconnect succeeds after network restore", async () => {
      await setAirplaneMode(serial, false);
      const result = await waitForConnectivity(serial, true, 30000);
      if (!result.online) {
        throw new Error("Connectivity did not recover after airplane mode disable.");
      }
      return result;
    });

    await runPhaseHook("RECOVERY");
  } catch (error) {
    failed = true;
    log(`Harness failed: ${toOneLine(String(error.message || error))}`);
  } finally {
    if (serial !== "unknown") {
      await captureDiagnostics(serial);
      try {
        await setAirplaneMode(serial, false);
      } catch {
        // Ignore cleanup failures to preserve root-cause exit.
      }
    }

    await writeArtifacts(serial, failed);
    log(`Artifacts written to ${path.relative(projectRoot, outputDir)}`);
  }

  if (failed) {
    process.exitCode = 1;
  }
}

void runHarness();
