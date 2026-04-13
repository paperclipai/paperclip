import { runSshCommand, type SshRunInput, type SshRunResult } from "../ssh-runner.js";
import { waitForSha } from "../build-manifest.js";

export interface RunPlaywrightInput {
  issueId: string;
  specPath: string; // relative to paperclip repo root, e.g. "skills/acceptance-viracue/tests/DLD-2793.url.spec.ts"
  context: "anonymous" | "authenticated";
  targetSha: string;
  targetUrl: string; // e.g. "https://viracue.ai"
  /** SSH host override for tests */
  ssh?: (input: SshRunInput) => Promise<SshRunResult>;
  /** Build manifest SHA-match override for tests */
  waitForShaFn?: typeof waitForSha;
  /** Max SSH timeout in ms. Default 180s. */
  timeoutMs?: number;
}

export type RunPlaywrightResult =
  | {
      status: "passed";
      traceDir: string;
      durationMs: number;
      deployedSha: string;
    }
  | {
      status: "failed";
      traceDir: string;
      failureSummary: string;
      durationMs: number;
      deployedSha: string;
      rawStdout: string;
    }
  | {
      status: "unavailable";
      unavailableReason: string;
    };

interface PlaywrightJsonStats {
  expected?: number;
  unexpected?: number;
  skipped?: number;
  flaky?: number;
  duration?: number;
}

interface PlaywrightJsonSpecTestResult {
  status?: string;
  error?: { message?: string };
}

interface PlaywrightJsonSpecTest {
  results?: PlaywrightJsonSpecTestResult[];
}

interface PlaywrightJsonSpec {
  title?: string;
  tests?: PlaywrightJsonSpecTest[];
}

interface PlaywrightJsonSuite {
  specs?: PlaywrightJsonSpec[];
  suites?: PlaywrightJsonSuite[];
}

interface PlaywrightJsonReport {
  stats?: PlaywrightJsonStats;
  suites?: PlaywrightJsonSuite[];
}

function extractFirstFailure(report: PlaywrightJsonReport): string {
  const walk = (suites: PlaywrightJsonSuite[] | undefined): string | null => {
    if (!suites) return null;
    for (const suite of suites) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? []) {
            if (result.status && result.status !== "passed" && result.error?.message) {
              return `${spec.title ?? "unknown spec"}: ${result.error.message}`;
            }
          }
        }
      }
      const nested = walk(suite.suites);
      if (nested) return nested;
    }
    return null;
  };
  return walk(report.suites) ?? "unknown failure (no error message in report)";
}

/**
 * Runs a Playwright acceptance spec on the remote browser-test VPS after confirming the target
 * is serving the expected git SHA. Returns passed/failed/unavailable.
 */
export async function runPlaywrightSpec(input: RunPlaywrightInput): Promise<RunPlaywrightResult> {
  const {
    issueId,
    specPath,
    context,
    targetSha,
    targetUrl,
    ssh = runSshCommand,
    waitForShaFn = waitForSha,
    timeoutMs = 180_000,
  } = input;

  // 1. Verify the deployed SHA matches expectation before running a spec.
  let shaResult;
  try {
    shaResult = await waitForShaFn({ baseUrl: targetUrl, expectedSha: targetSha });
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `build manifest unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!shaResult.matched) {
    return {
      status: "unavailable",
      unavailableReason: `deploy_not_ready: expected ${targetSha}, got ${shaResult.deployedSha}`,
    };
  }

  // 2. Validate spec_path strictly: no shell metacharacters, must live under skills/acceptance-*/tests/.
  // This is a defense-in-depth check on top of the route's validation — specPath flows into an ssh
  // command string so we cannot tolerate any characters that could alter argv structure.
  if (!/^skills\/acceptance-[a-z0-9-]+\/tests\/[A-Za-z0-9_.-]+\.(spec|test)\.(ts|js)$/.test(specPath)) {
    return {
      status: "unavailable",
      unavailableReason: `invalid spec_path format: must match skills/acceptance-<product>/tests/<name>.<spec|test>.<ts|js>, got: ${specPath}`,
    };
  }
  const skillSplit = specPath.split("/tests/");
  const skillDir = skillSplit[0];
  const testFile = `tests/${skillSplit[1]}`;

  // Sanitize issue id (UUIDs are already safe, but defend against accidents).
  const safeIssueId = issueId.replace(/[^a-zA-Z0-9-]/g, "_");
  const ts = Date.now();
  const traceDir = `/tmp/trace-${safeIssueId}-${ts}`;
  const reportPath = `${traceDir}/report.json`;

  // We write the Playwright JSON report to a known file path (via PLAYWRIGHT_JSON_OUTPUT_NAME)
  // and then cat ONLY that file. This avoids trying to parse a JSON object out of a stream that
  // may contain stderr noise, install warnings, or git pull output.
  const command = [
    `mkdir -p ${traceDir}`,
    "cd /tmp/paperclip-specs",
    "git pull --quiet",
    `cd ${skillDir}`,
    "test -d node_modules || npm install --silent",
    `PLAYWRIGHT_JSON_OUTPUT_NAME=${reportPath} npx playwright test ${testFile} --project=${context} --reporter=json --output=${traceDir} > /dev/null 2>&1`,
    `EC=$?`,
    `echo "---PW-REPORT-START---"`,
    `cat ${reportPath} 2>/dev/null || echo '{}'`,
    `echo "---PW-REPORT-END---"`,
    `exit $EC`,
  ].join("; ");

  const host = process.env.BROWSER_TEST_HOST;
  const user = process.env.BROWSER_TEST_USER ?? "root";
  const keyPath = process.env.BROWSER_TEST_SSH_KEY;
  if (!host || !keyPath) {
    return {
      status: "unavailable",
      unavailableReason: "BROWSER_TEST_HOST or BROWSER_TEST_SSH_KEY not configured",
    };
  }

  // 3. Execute.
  const started = Date.now();
  let sshResult: SshRunResult;
  try {
    sshResult = await ssh({
      host,
      user,
      keyPath,
      command,
      timeoutMs,
    });
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: err instanceof Error ? err.message : String(err),
    };
  }
  const durationMs = Date.now() - started;

  // 4. Parse JSON report. We bracket the report file contents with ---PW-REPORT-START/END---
  // markers so we never confuse test/install stdout for the report itself.
  const stdout = sshResult.stdout;
  const startMarker = "---PW-REPORT-START---";
  const endMarker = "---PW-REPORT-END---";
  const startIdx = stdout.indexOf(startMarker);
  const endIdx = stdout.indexOf(endMarker, startIdx + startMarker.length);
  if (startIdx === -1 || endIdx === -1) {
    return {
      status: "unavailable",
      unavailableReason: `no report markers in stdout (exit ${sshResult.exitCode}): ${stdout.slice(-500)}`,
    };
  }
  const reportBlock = stdout.slice(startIdx + startMarker.length, endIdx).trim();
  if (reportBlock === "" || reportBlock === "{}") {
    return {
      status: "unavailable",
      unavailableReason: `playwright report file was empty (exit ${sshResult.exitCode}). Tail of stdout: ${stdout.slice(-500)}`,
    };
  }
  let report: PlaywrightJsonReport;
  try {
    report = JSON.parse(reportBlock) as PlaywrightJsonReport;
  } catch (err) {
    return {
      status: "unavailable",
      unavailableReason: `failed to parse playwright json: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const stats = report.stats ?? {};
  const expected = stats.expected ?? 0;
  const unexpected = stats.unexpected ?? 0;

  if (unexpected === 0 && expected > 0) {
    return {
      status: "passed",
      traceDir,
      durationMs: stats.duration ?? durationMs,
      deployedSha: shaResult.deployedSha,
    };
  }

  if (expected === 0 && unexpected === 0) {
    return {
      status: "unavailable",
      unavailableReason: "playwright reported zero tests executed (spec may have no tests or test filter matched nothing)",
    };
  }

  return {
    status: "failed",
    traceDir,
    failureSummary: extractFirstFailure(report),
    durationMs: stats.duration ?? durationMs,
    deployedSha: shaResult.deployedSha,
    rawStdout: stdout.slice(0, 4000),
  };
}
