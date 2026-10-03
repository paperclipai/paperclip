import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULT_SERVER_OOM_SCORE_ADJ,
  DEFAULT_WORKER_OOM_SCORE_ADJ,
  OOM_PROTECTION_ENV,
  OOM_SCORE_ADJ_MAX,
  OOM_SCORE_ADJ_MIN,
  OOM_SERVER_SCORE_ADJ_ENV,
  OOM_WORKER_SCORE_ADJ_ENV,
  applyOomScoreAdjToChild,
  bootstrapOomScoreAdjProtection,
  parseOomScoreAdj,
  readOomScoreAdj,
  resolveOomScoreAdjPolicy,
} from "./oom-score-adj.js";

const isLinux = process.platform === "linux";
const MISSING_PROC_ROOT = "/definitely/not/proc";

function makeFakeProcRoot(initialServerAdj: number): {
  procRoot: string;
  writePid: (pid: number, adj: number) => void;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "paperclip-oom-adj-"));
  const writePid = (pid: number, adj: number) => {
    mkdirSync(join(root, String(pid)), { recursive: true });
    writeFileSync(join(root, String(pid), "oom_score_adj"), `${adj}\n`, "utf8");
  };
  writePid(process.pid, initialServerAdj);
  return { procRoot: root, writePid, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("parseOomScoreAdj", () => {
  it("falls back when the value is missing, empty, or not a number", () => {
    expect(parseOomScoreAdj(undefined, 42)).toBe(42);
    expect(parseOomScoreAdj("   ", 42)).toBe(42);
    expect(parseOomScoreAdj("nope", 42)).toBe(42);
  });

  it("clamps to the kernel range and truncates", () => {
    expect(parseOomScoreAdj("500", 0)).toBe(500);
    expect(parseOomScoreAdj("-500", 0)).toBe(-500);
    expect(parseOomScoreAdj("99999", 0)).toBe(OOM_SCORE_ADJ_MAX);
    expect(parseOomScoreAdj("-99999", 0)).toBe(OOM_SCORE_ADJ_MIN);
    expect(parseOomScoreAdj("12.9", 0)).toBe(12);
  });
});

describe("resolveOomScoreAdjPolicy", () => {
  it("defaults to a server value below the worker maximum", () => {
    const policy = resolveOomScoreAdjPolicy({});
    expect(policy.enabled).toBe(true);
    expect(policy.serverAdj).toBe(DEFAULT_SERVER_OOM_SCORE_ADJ);
    expect(policy.workerAdj).toBe(DEFAULT_WORKER_OOM_SCORE_ADJ);
    expect(policy.serverAdj).toBeLessThan(policy.workerAdj);
    expect(policy.ordered).toBe(true);
  });

  it("reads operator overrides", () => {
    const policy = resolveOomScoreAdjPolicy({
      [OOM_SERVER_SCORE_ADJ_ENV]: "-500",
      [OOM_WORKER_SCORE_ADJ_ENV]: "800",
    });
    expect(policy.serverAdj).toBe(-500);
    expect(policy.workerAdj).toBe(800);
    expect(policy.ordered).toBe(true);
  });

  it("reports a policy that does not order the processes", () => {
    const policy = resolveOomScoreAdjPolicy({
      [OOM_SERVER_SCORE_ADJ_ENV]: "900",
      [OOM_WORKER_SCORE_ADJ_ENV]: "100",
    });
    expect(policy.ordered).toBe(false);
  });

  it("disables the mitigation for the documented off values", () => {
    for (const value of ["off", "false", "0", "no", "OFF"]) {
      expect(resolveOomScoreAdjPolicy({ [OOM_PROTECTION_ENV]: value }).enabled).toBe(false);
    }
    expect(resolveOomScoreAdjPolicy({ [OOM_PROTECTION_ENV]: "on" }).enabled).toBe(true);
  });
});

describe("applyOomScoreAdjToChild", () => {
  it("writes the worker value and reads it back", () => {
    const fake = makeFakeProcRoot(937);
    try {
      fake.writePid(4242, 937);
      const outcome = applyOomScoreAdjToChild(4242, resolveOomScoreAdjPolicy({}), fake.procRoot);
      expect(outcome.ok).toBe(true);
      expect(outcome.reason).toBe("applied");
      expect(outcome.pid).toBe(4242);
      expect(outcome.previous).toBe(937);
      expect(outcome.applied).toBe(DEFAULT_WORKER_OOM_SCORE_ADJ);
    } finally {
      fake.cleanup();
    }
  });

  it("reports a failed write instead of throwing when the pid has no proc entry", () => {
    const fake = makeFakeProcRoot(937);
    try {
      const outcome = applyOomScoreAdjToChild(999999, resolveOomScoreAdjPolicy({}), fake.procRoot);
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toBe("write-failed");
    } finally {
      fake.cleanup();
    }
  });

  it("rejects a non-positive pid without touching procfs", () => {
    const outcome = applyOomScoreAdjToChild(0, resolveOomScoreAdjPolicy({}), MISSING_PROC_ROOT);
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("proc-unavailable");
  });

  it("is a no-op when the mitigation is disabled", () => {
    const policy = resolveOomScoreAdjPolicy({ [OOM_PROTECTION_ENV]: "off" });
    const outcome = applyOomScoreAdjToChild(1, policy, MISSING_PROC_ROOT);
    expect(outcome.reason).toBe("disabled");
  });
});

describe("bootstrapOomScoreAdjProtection", () => {
  it("lowers the server adjustment when the platform allows it", () => {
    const fake = makeFakeProcRoot(937);
    try {
      const summary = bootstrapOomScoreAdjProtection({}, fake.procRoot);
      expect(summary.self.ok).toBe(true);
      expect(summary.serverAdj).toBe(DEFAULT_SERVER_OOM_SCORE_ADJ);
      expect(summary.protected).toBe(true);
      expect(summary.serverAdj!).toBeLessThan(summary.policy.workerAdj);
    } finally {
      fake.cleanup();
    }
  });

  it("does not throw when the write is refused", () => {
    // A missing procfs stands in for a container without CAP_SYS_RESOURCE: the
    // write fails, and the server still starts.
    const summary = bootstrapOomScoreAdjProtection({}, MISSING_PROC_ROOT);
    expect(summary.self.ok).toBe(false);
    expect(summary.serverAdj).toBeNull();
    expect(summary.protected).toBe(false);
  });

  it("reports the protected state when the mitigation is disabled", () => {
    const summary = bootstrapOomScoreAdjProtection({ [OOM_PROTECTION_ENV]: "off" }, MISSING_PROC_ROOT);
    expect(summary.policy.enabled).toBe(false);
    expect(summary.self.reason).toBe("disabled");
    expect(summary.protected).toBe(false);
  });
});

describe.runIf(isLinux)("live kernel ordering", () => {
  it("reports a higher adjustment for a spawned worker than for the server", async () => {
    const serverAdj = readOomScoreAdj();
    if (serverAdj === null) return;

    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });
    try {
      const outcome = applyOomScoreAdjToChild(child.pid!, resolveOomScoreAdjPolicy({}));
      expect(outcome.ok).toBe(true);
      const workerAdj = readOomScoreAdj(child.pid!);
      expect(workerAdj).toBe(DEFAULT_WORKER_OOM_SCORE_ADJ);
      expect(workerAdj!).toBeGreaterThan(readOomScoreAdj()!);
    } finally {
      child.kill("SIGKILL");
    }
  }, 20000);

  it("leaves the server's own adjustment untouched when the platform forbids lowering it", () => {
    const before = readOomScoreAdj();
    if (before === null) return;
    const summary = bootstrapOomScoreAdjProtection({ [OOM_SERVER_SCORE_ADJ_ENV]: String(OOM_SCORE_ADJ_MIN) });
    // A privileged environment lowers it; an unprivileged container cannot, and
    // the important half — the per-spawn worker raise — is unaffected.
    if (summary.self.ok) {
      expect(summary.serverAdj).toBe(OOM_SCORE_ADJ_MIN);
    } else {
      expect(summary.self.reason).toBe("lowering-requires-capability");
      expect(summary.serverAdj).toBe(before);
    }
  });
});

describe.runIf(!isLinux)("non-Linux platforms", () => {
  it("reports unsupported rather than throwing", () => {
    const outcome = applyOomScoreAdjToChild(1, resolveOomScoreAdjPolicy({}));
    expect(outcome.reason).toBe("unsupported-platform");
  });
});
