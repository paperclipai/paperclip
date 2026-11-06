import type { OracleArtifacts, OracleResult, WorkloadId } from "./types.js";

/** Deterministic bench output: sum of squares 1..240. */
export const BENCH_STEPS = 240;
export const BENCH_EXPECTED = `BENCH_RESULT=${(BENCH_STEPS * (BENCH_STEPS + 1) * (2 * BENCH_STEPS + 1)) / 6}`;

export interface WorkloadDefinition {
  id: WorkloadId;
  label: string;
  usesRepository: boolean;
  /** Fault fire offset from issue creation (seeded uniform). */
  fireWindowMs: readonly [number, number];
  followUpWindowMs?: readonly [number, number];
  /** Time budget for the task excluding outage time (R1). */
  budgetMs: number;
  title(nonce: string): string;
  description(nonce: string): string;
  followUp?(nonce: string): string;
  /** Files and commands the observer must collect for the T-oracle. */
  collect: { documents: string[]; files(nonce: string): string[]; commands: Array<{ name: string; argv: string[] }> };
  grade(nonce: string, artifacts: OracleArtifacts): OracleResult;
}

const briefMarker = (nonce: string) => `CHAOS-${nonce}`;
const followUpMarker = (nonce: string) => `FOLLOWUP-${nonce}`;
const notesFile = (nonce: string) => `NOTES-${nonce}.md`;
const benchFile = (nonce: string) => `bench-result-${nonce}.txt`;

function result(checks: OracleResult["checks"]): OracleResult {
  return { verdict: checks.every(check => check.ok) ? "pass" : "fail", checks };
}

function statusCheck(artifacts: OracleArtifacts) {
  return { name: "issue_done", ok: artifacts.issueStatus === "done", detail: `status=${artifacts.issueStatus ?? "unknown"}` };
}

function briefChecks(body: string | null | undefined, markers: string[]) {
  const text = body ?? "";
  const bullets = text.split(/\r?\n/).filter(line => /^\s*[-*] \S/.test(line)).length;
  return [
    { name: "brief_document_present", ok: body != null && text.trim().length > 0 },
    ...markers.map(marker => ({ name: `brief_contains_${marker.split("-")[0]!.toLowerCase()}_marker`, ok: text.includes(marker), detail: marker })),
    { name: "brief_has_three_bullets", ok: bullets >= 3, detail: `bullets=${bullets}` },
  ];
}

const briefDescription = (nonce: string) => [
  "Write a short brief on why idempotent retries matter for background job queues.",
  "Save it as this issue's document with key `brief` (title \"Brief\"), in markdown.",
  `The document must contain the line \`${briefMarker(nonce)}\` exactly, on its own line,`,
  "and at least three bullet points that start with \"- \".",
  "Do not create files or other tasks. When the document is saved, mark this task done.",
].join("\n");

export const workloadDefinitions: Record<WorkloadId, WorkloadDefinition> = {
  A1: {
    id: "A1",
    label: "Brief to issue document",
    usesRepository: false,
    fireWindowMs: [10_000, 45_000],
    budgetMs: 10 * 60_000,
    title: nonce => `Chaos A1 brief ${nonce}`,
    description: briefDescription,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([statusCheck(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce)])]);
    },
  },
  C1: {
    id: "C1",
    label: "Comment while running",
    usesRepository: false,
    fireWindowMs: [20_000, 60_000],
    followUpWindowMs: [8_000, 25_000],
    budgetMs: 12 * 60_000,
    title: nonce => `Chaos C1 brief with follow-up ${nonce}`,
    description: briefDescription,
    followUp: nonce => `Additional requirement for this task: also include the line \`${followUpMarker(nonce)}\` on its own line in the \`brief\` document before you mark the task done.`,
    collect: { documents: ["brief"], files: () => [], commands: [] },
    grade(nonce, artifacts) {
      return result([statusCheck(artifacts), ...briefChecks(artifacts.documents.brief, [briefMarker(nonce), followUpMarker(nonce)])]);
    },
  },
  B1: {
    id: "B1",
    label: "Python CLI with tests",
    usesRepository: true,
    fireWindowMs: [20_000, 90_000],
    budgetMs: 15 * 60_000,
    title: nonce => `Chaos B1 slugify command ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace (a small Python CLI called chaoscli).",
      "Implement the `slugify` subcommand in `chaoscli/cli.py` so that",
      "`python3 -m chaoscli slugify \"Hello Chaos World\"` prints `hello-chaos-world`",
      "(lowercase, runs of non-alphanumeric characters become a single `-`, no leading or trailing `-`).",
      "The currently failing test must pass: run `python3 -m unittest discover -s tests -v`.",
      `Also create \`${notesFile(nonce)}\` in the repository root containing exactly the line \`B1-${nonce}\`.`,
      "Use only the Python standard library. Do not run ./bench.sh. When the tests pass, mark this task done.",
    ].join("\n"),
    collect: {
      documents: [],
      files: nonce => [notesFile(nonce), "chaoscli/cli.py"],
      commands: [
        { name: "unittest", argv: ["python3", "-m", "unittest", "discover", "-s", "tests"] },
        { name: "slugify", argv: ["python3", "-m", "chaoscli", "slugify", "Hello Chaos World"] },
      ],
    },
    grade(nonce, artifacts) {
      const tests = artifacts.commands.unittest;
      const slug = artifacts.commands.slugify;
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "unittest_passes", ok: tests?.exitCode === 0, detail: `exit=${tests?.exitCode ?? "not run"}` },
        { name: "slugify_output", ok: slug?.exitCode === 0 && slug.stdout.trim() === "hello-chaos-world", detail: JSON.stringify(slug?.stdout.trim() ?? null) },
        { name: "notes_file", ok: artifacts.files[notesFile(nonce)]?.trim() === `B1-${nonce}` },
      ]);
    },
  },
  B5: {
    id: "B5",
    label: "Long bench.sh run",
    usesRepository: true,
    fireWindowMs: [60_000, 180_000],
    budgetMs: 20 * 60_000,
    title: nonce => `Chaos B5 bench ${nonce}`,
    description: nonce => [
      "Work in this task's repository workspace.",
      "Run `./bench.sh` from the repository root in the foreground and wait for it to finish.",
      "It takes about four minutes; if your shell tool has a timeout, set it to at least 10 minutes. Do not background or interrupt it.",
      "It prints one line of the form `BENCH_RESULT=<number>`.",
      `Write exactly that line into a new file \`${benchFile(nonce)}\` in the repository root.`,
      "Do not compute the result yourself and do not edit bench.sh. Then mark this task done.",
    ].join("\n"),
    collect: { documents: [], files: nonce => [benchFile(nonce)], commands: [] },
    grade(nonce, artifacts) {
      const content = artifacts.files[benchFile(nonce)]?.trim() ?? null;
      return result([
        statusCheck(artifacts),
        { name: "workspace_located", ok: artifacts.workspacePath !== null },
        { name: "bench_result_file", ok: content === BENCH_EXPECTED, detail: JSON.stringify(content) },
      ]);
    },
  },
};

/** Files committed into the `chaos-sandbox` fixture repository. */
export function fixtureRepositoryFiles(benchSeconds = 240): Record<string, { content: string; mode?: number }> {
  return {
    "README.md": { content: "# chaos-sandbox\n\nFixture repository for the Paperclip restart chaos harness.\n" },
    "chaoscli/__init__.py": { content: "" },
    "chaoscli/__main__.py": { content: "from chaoscli.cli import main\n\nraise SystemExit(main())\n" },
    "chaoscli/cli.py": { content: [
      "import argparse",
      "import sys",
      "",
      "",
      "def greet(name: str) -> str:",
      "    return f\"hello, {name}\"",
      "",
      "",
      "def slugify(text: str) -> str:",
      "    raise NotImplementedError(\"slugify is not implemented yet\")",
      "",
      "",
      "def main(argv=None) -> int:",
      "    parser = argparse.ArgumentParser(prog=\"chaoscli\")",
      "    commands = parser.add_subparsers(dest=\"command\", required=True)",
      "    greet_parser = commands.add_parser(\"greet\")",
      "    greet_parser.add_argument(\"name\")",
      "    args = parser.parse_args(argv)",
      "    if args.command == \"greet\":",
      "        print(greet(args.name))",
      "        return 0",
      "    return 2",
      "",
    ].join("\n") },
    "tests/__init__.py": { content: "" },
    "tests/test_cli.py": { content: [
      "import unittest",
      "",
      "from chaoscli.cli import greet, slugify",
      "",
      "",
      "class CliTest(unittest.TestCase):",
      "    def test_greet(self):",
      "        self.assertEqual(greet(\"chaos\"), \"hello, chaos\")",
      "",
      "    def test_slugify(self):",
      "        self.assertEqual(slugify(\"Hello Chaos World\"), \"hello-chaos-world\")",
      "        self.assertEqual(slugify(\"  A--b__C!! \"), \"a-b-c\")",
      "",
      "",
      "if __name__ == \"__main__\":",
      "    unittest.main()",
      "",
    ].join("\n") },
    "bench.sh": { mode: 0o755, content: [
      "#!/bin/sh",
      "# Deterministic long-running benchmark for restart chaos boundary B6.",
      "set -eu",
      `steps=${BENCH_STEPS}`,
      `seconds="\${BENCH_SECONDS:-${benchSeconds}}"`,
      "mkdir -p .bench",
      "date -u +%Y-%m-%dT%H:%M:%SZ > .bench/started",
      "total=0",
      "i=1",
      "while [ \"$i\" -le \"$steps\" ]; do",
      "  total=$((total + i * i))",
      "  if [ $((i % 24)) -eq 0 ]; then echo \"bench progress $i/$steps\"; echo \"$i\" > .bench/progress; fi",
      "  sleep \"$(awk -v s=\"$seconds\" -v n=\"$steps\" 'BEGIN { printf \"%.3f\", s / n }')\"",
      "  i=$((i + 1))",
      "done",
      "echo \"BENCH_RESULT=$total\"",
      "",
    ].join("\n") },
    ".gitignore": { content: ".bench/\n__pycache__/\n" },
  };
}
