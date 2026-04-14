import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { pruneToolOutput, formatSummaryForContext } from "../src/output-pruner.js";

let tmpDir: string;

const defaultConfig = () => ({
  artifactsDir: tmpDir,
  maxOutputBytes: 1_500,
  maxOutputTokens: 300,
});

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tm-pruner-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("pruneToolOutput", () => {
  it("produces a valid ToolResultSummary", async () => {
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "ls -la" },
      "file1.txt\nfile2.txt\nfile3.txt",
      42,
      defaultConfig(),
    );
    expect(summary.tool).toBe("Bash");
    expect(summary.status).toBe("success");
    expect(summary.exit_code).toBe(0);
    expect(summary.stdout_ref).toMatch(/^artifact:\/\//);
    expect(summary.stderr_ref).toMatch(/^artifact:\/\//);
    expect(summary.original_bytes).toBeGreaterThan(0);
    expect(summary.original_lines).toBeGreaterThan(0);
  });

  it("stores stdout as artifact", async () => {
    const { stdoutRef } = await pruneToolOutput(
      "Bash",
      { command: "echo hello" },
      "hello\n",
      10,
      defaultConfig(),
    );
    expect(stdoutRef.hash).toHaveLength(64);
    const artifactPath = path.join(tmpDir, stdoutRef.hash);
    const exists = await fs.access(artifactPath).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("marks error status for non-zero exit code", async () => {
    const errorResponse = { output: "command not found", exit_code: 127 };
    const { summary } = await pruneToolOutput("Bash", { command: "nosuchcmd" }, errorResponse, 5, defaultConfig());
    expect(summary.status).toBe("error");
    expect(summary.exit_code).toBe(127);
  });

  it("applies jq-equivalent filter for kubectl output", async () => {
    const kubectlOutput = JSON.stringify({
      items: [
        {
          metadata: { name: "nginx-abc" },
          status: {
            phase: "Running",
            containerStatuses: [{ restartCount: 0 }],
          },
        },
      ],
    });
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "kubectl get pods -n production -o json" },
      kubectlOutput,
      150,
      defaultConfig(),
    );
    expect(summary.parsed).not.toBeNull();
    expect(summary.parsed?.pods).toBeDefined();
  });

  it("falls back to regex extraction for malformed JSON", async () => {
    const malformedJson = 'ERROR: connection refused\n{"incomplete": ';
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "kubectl get pods" },
      malformedJson,
      50,
      defaultConfig(),
    );
    // Should not crash, should populate parsed with error signatures
    expect(summary).toBeDefined();
    expect(summary.tool).toBe("Bash");
  });

  it("falls back to truncation when no JSON and no error signatures", async () => {
    const plainOutput = "line 1\nline 2\nline 3\n";
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "echo test" },
      plainOutput,
      10,
      defaultConfig(),
    );
    expect(summary.preview).toBeTruthy();
  });

  it("handles malformed JSON gracefully (3 malformed inputs)", async () => {
    const malformedInputs = [
      '{"key": "value", "nested": {incomplete',
      "[1, 2, 3, oops",
      "not json at all, just text",
    ];
    for (const input of malformedInputs) {
      const { summary } = await pruneToolOutput("Bash", { command: "test" }, input, 10, defaultConfig());
      expect(summary).toBeDefined();
      expect(summary.stdout_ref).toMatch(/^artifact:\/\//);
    }
  });

  it("summary does not exceed maxOutputBytes", async () => {
    // Create a very large output
    const largeOutput = "x".repeat(50_000);
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "cat large-file" },
      largeOutput,
      200,
      defaultConfig(),
    );
    const summaryBytes = Buffer.byteLength(JSON.stringify(summary), "utf8");
    expect(summaryBytes).toBeLessThanOrEqual(defaultConfig().maxOutputBytes + 200); // some tolerance for JSON wrapping
  });

  it("integration: npm command", async () => {
    const npmOutput = JSON.stringify({ name: "my-app", version: "1.0.0", dependencies: { express: "4.18.0" } });
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "npm list --json" },
      npmOutput,
      100,
      defaultConfig(),
    );
    expect(summary.tool).toBe("Bash");
  });

  it("integration: git command", async () => {
    const gitOutput = "On branch main\nnothing to commit, working tree clean";
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "git status" },
      gitOutput,
      30,
      defaultConfig(),
    );
    expect(summary.tool).toBe("Bash");
    expect(summary.stdout_ref).toMatch(/^artifact:\/\//);
  });

  it("integration: terraform output", async () => {
    const tfOutput = JSON.stringify({
      format_version: "1.0",
      terraform_version: "1.5.0",
      resource_changes: [
        { change: { actions: ["create"] }, type: "aws_instance", name: "web" },
      ],
    });
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "terraform plan -json" },
      tfOutput,
      500,
      defaultConfig(),
    );
    expect(summary.tool).toBe("Bash");
  });

  it("integration: failing shell command", async () => {
    const errorOutput = { output: "bash: nosuchcmd: command not found", exit_code: 127 };
    const { summary } = await pruneToolOutput(
      "Bash",
      { command: "nosuchcmd" },
      errorOutput,
      5,
      defaultConfig(),
    );
    expect(summary.status).toBe("error");
    expect(summary.exit_code).toBe(127);
  });
});

describe("formatSummaryForContext", () => {
  it("produces a string with [tool-middleware] prefix", async () => {
    const { summary } = await pruneToolOutput("Bash", { command: "echo hi" }, "hi", 5, defaultConfig());
    const formatted = formatSummaryForContext(summary);
    expect(formatted.startsWith("[tool-middleware]")).toBe(true);
    expect(formatted).toContain('"tool"');
  });
});
