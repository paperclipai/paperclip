import { describe, expect, it } from "vitest";
import {
  classifyProcessLossCause,
  makeApiHealthCache,
  STACK_TRACE_PATTERN,
} from "../services/process-loss-recovery.js";

const base = {
  companyId: "company-1",
  stderrExcerpt: null,
  exitCode: null,
};

describe("classifyProcessLossCause", () => {
  it("returns agent-cause when no signals fire", () => {
    const result = classifyProcessLossCause(base);
    expect(result.causeClass).toBe("agent");
    expect(result.classifyConfidence).toBe("primary");
    expect(result.reason).toBe("agent_cause(no_infra_signals)");
  });

  describe("signal #4 — apiHealthy", () => {
    // GNO-216: inverted from apiHealthy===true. A concurrent API disruption weakly
    // corroborates shared infra failure. apiHealthy===true adds no discriminating power.
    it("(a) returns infrastructure when apiHealthy=false and no other signals fire", () => {
      const result = classifyProcessLossCause(base, { apiHealthy: false });
      expect(result.causeClass).toBe("infrastructure");
      expect(result.classifyConfidence).toBe("weak");
      expect(result.reason).toContain("signal_4_api_unhealthy");
    });

    it("(b) absence of apiHealthy (undefined) maintains agent-cause behaviour", () => {
      const result = classifyProcessLossCause(base, { apiHealthy: undefined });
      expect(result.causeClass).toBe("agent");
    });

    it("(b) apiHealthy=true maintains agent-cause behaviour (healthy API does not imply infra cause)", () => {
      const result = classifyProcessLossCause(base, { apiHealthy: true });
      expect(result.causeClass).toBe("agent");
    });
  });

  describe("signal #1 — inter-agent correlation (primary signal)", () => {
    it("returns infrastructure with primary confidence when peers exist", () => {
      const result = classifyProcessLossCause(base, {
        coReapedSameCompanyRunIds: ["run-2"],
      });
      expect(result.causeClass).toBe("infrastructure");
      expect(result.classifyConfidence).toBe("primary");
      expect(result.reason).toContain("signal_1_correlation");
    });

    it("returns agent-cause when coReapedSameCompanyRunIds is empty", () => {
      const result = classifyProcessLossCause(base, {
        coReapedSameCompanyRunIds: [],
      });
      expect(result.causeClass).toBe("agent");
    });
  });

  describe("signal #2 — clean stderr", () => {
    it("returns infrastructure when stderr has content without a stack trace", () => {
      const result = classifyProcessLossCause({
        ...base,
        stderrExcerpt: "Out of memory: kill process 12345",
      });
      expect(result.causeClass).toBe("infrastructure");
      expect(result.classifyConfidence).toBe("weak");
      expect(result.reason).toContain("signal_2_clean_stderr");
    });

    it("returns agent-cause when stderr contains a V8 stack trace", () => {
      const result = classifyProcessLossCause({
        ...base,
        stderrExcerpt:
          "Error: something\n    at Object.<anonymous> (/app/index.js:10:5)\n    at Module._compile (node:internal/modules/cjs/loader:1376:14)",
      });
      expect(result.causeClass).toBe("agent");
    });

    it("returns agent-cause when stderr is null", () => {
      const result = classifyProcessLossCause({ ...base, stderrExcerpt: null });
      expect(result.causeClass).toBe("agent");
    });

    it("returns agent-cause when stderr is empty string", () => {
      const result = classifyProcessLossCause({ ...base, stderrExcerpt: "" });
      expect(result.causeClass).toBe("agent");
    });
  });

  describe("signal #3 — OOM kill (exit 137)", () => {
    it("returns infrastructure when exitCode is 137", () => {
      const result = classifyProcessLossCause({ ...base, exitCode: 137 });
      expect(result.causeClass).toBe("infrastructure");
      expect(result.classifyConfidence).toBe("weak");
      expect(result.reason).toContain("signal_3_oom_kill");
    });

    it("returns agent-cause for other exit codes", () => {
      for (const code of [0, 1, 2, 127, 136, 138]) {
        const result = classifyProcessLossCause({ ...base, exitCode: code });
        expect(result.causeClass).toBe("agent");
      }
    });
  });

  it("signal #1 short-circuits other signals and returns primary confidence", () => {
    // Even with weak signals present, signal #1 dominates with primary confidence
    const result = classifyProcessLossCause(
      { ...base, exitCode: 137, stderrExcerpt: "OOM kill log" },
      { apiHealthy: false, coReapedSameCompanyRunIds: ["peer-run"] },
    );
    expect(result.causeClass).toBe("infrastructure");
    expect(result.classifyConfidence).toBe("primary");
    expect(result.reason).toContain("signal_1_correlation");
  });

  it("combines multiple weak signals in the reason string", () => {
    const result = classifyProcessLossCause(
      { ...base, exitCode: 137, stderrExcerpt: "OOM kill log" },
      { apiHealthy: false },
    );
    expect(result.causeClass).toBe("infrastructure");
    expect(result.classifyConfidence).toBe("weak");
    expect(result.reason).toContain("signal_2_clean_stderr");
    expect(result.reason).toContain("signal_3_oom_kill");
    expect(result.reason).toContain("signal_4_api_unhealthy");
  });

  // GNO-183 regression: agent spoofing via process.stderr.write + process.exit
  // An agent that writes benign stderr and exits normally must NOT be classified as
  // infrastructure with primary confidence — it must be marked weak (option 2).
  it("PoC GNO-183: agent writing benign stderr and calling process.exit(1) is classified weak, not primary infrastructure", () => {
    // Simulates: process.stderr.write("benign\n"); process.exit(1)
    const result = classifyProcessLossCause({
      ...base,
      stderrExcerpt: "benign\n",
      exitCode: 1,
    });
    // Must still classify as infrastructure (signal #2 fires — clean stderr)
    expect(result.causeClass).toBe("infrastructure");
    // But confidence MUST be weak, not primary — the signal is agent-writable
    expect(result.classifyConfidence).toBe("weak");
    expect(result.reason).toContain("signal_2_clean_stderr");
    // signal_3 must NOT fire for exit code 1
    expect(result.reason).not.toContain("signal_3_oom_kill");
  });

  // GNO-183 regression: agent spoofing via process.exit(137) alone
  it("PoC GNO-183: agent calling process.exit(137) alone is classified weak, not primary infrastructure", () => {
    const result = classifyProcessLossCause({ ...base, exitCode: 137 });
    expect(result.causeClass).toBe("infrastructure");
    expect(result.classifyConfidence).toBe("weak");
    expect(result.reason).toContain("signal_3_oom_kill");
    expect(result.reason).not.toContain("signal_1_correlation");
  });
});

describe("STACK_TRACE_PATTERN", () => {
  it("matches V8 at-style frames", () => {
    expect(STACK_TRACE_PATTERN.test("    at Object.<anonymous> (/app/index.js:10:5)")).toBe(true);
  });

  it("matches JVM frames", () => {
    expect(STACK_TRACE_PATTERN.test("    at com.example.Main.run(Main.java:42)")).toBe(true);
  });

  it("matches Python frames", () => {
    expect(STACK_TRACE_PATTERN.test('  File "/app/main.py", line 10')).toBe(true);
  });

  it("does not match plain log lines", () => {
    expect(STACK_TRACE_PATTERN.test("Killed")).toBe(false);
    expect(STACK_TRACE_PATTERN.test("Out of memory")).toBe(false);
  });
});

describe("makeApiHealthCache", () => {
  it("returns false when no tick has been recorded", () => {
    const cache = makeApiHealthCache(5_000);
    expect(cache.isHealthy()).toBe(false);
  });

  it("returns true immediately after markTick()", () => {
    const cache = makeApiHealthCache(5_000);
    cache.markTick();
    expect(cache.isHealthy()).toBe(true);
  });

  it("returns false after TTL expires", async () => {
    const cache = makeApiHealthCache(10);
    cache.markTick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(cache.isHealthy()).toBe(false);
  });
});
