import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
import { expect, it } from "vitest";

// /api/ready means "this server can serve requests and take over". Each step
// that holds it must be named, bounded by this boot, and listed here with why
// it must finish first. Work that grows with saved backlog (a queue's first
// pass, a sweep, a dump) or waits on an outside service runs through
// startupTimeline.background instead. On 2026-11-13, backlog first passes
// awaited here kept two replacement servers on paperclip.staging from ever
// reporting ready.
const READINESS_PRECONDITIONS: Record<string, string> = {
  listen: "the HTTP/PRP listener must be bound before anything can be served",
  runtime_control_operations: "releases control operations the previous process left running, bounded by its in-flight work",
  execution_policy: "a bad forced execution policy must fail startup, before any run starts",
  managed_environments: "declared environments must exist before queued runs resume (fails closed)",
  worktree_run_execution: "one settings read that decides whether run execution is armed",
  scheduling_suppression: "one read that decides whether this runtime schedules heartbeats at all",
  native_recovery: "adoption of old runs and the gates that can refuse a start finish before taking over",
  external_adapters: "adapter type validation rejects valid external adapters until they are loaded",
  cloud_configuration: "an image whose saved configuration is not eligible must not take over",
};

type Node = { type: string; start: number; end: number; [key: string]: unknown };

function children(node: Node): Node[] {
  return Object.values(node).flatMap(value => Array.isArray(value) ? value : [value])
    .filter((value): value is Node => Boolean(value) && typeof (value as Node).type === "string");
}

function walk(node: Node, functions: Node[], visit: (node: Node, owner: Node | undefined) => void) {
  const scope = /Function|ArrowFunctionExpression/.test(node.type) ? [...functions, node] : functions;
  visit(node, scope.at(-1));
  for (const child of children(node)) walk(child, scope, visit);
}

it("holds readiness only on named, listed preconditions", () => {
  const file = fileURLToPath(new URL("../index.ts", import.meta.url));
  const source = readFileSync(file, "utf8");
  // Vite's parser (already a server dependency) reads TypeScript as ESTree.
  const program = parseAst(source, { lang: "ts" });

  // The boot path is the function that moves the phase from "recovering" to
  // "ready". Awaits inside nested closures run in the background.
  let boot: Node | undefined;
  let from = -1;
  let to = -1;
  walk(program as unknown as Node, [], (node, owner) => {
    if (node.type !== "CallExpression") return;
    const callee = node.callee as Node & { name?: string };
    const phase = ((node.arguments as Node[])[0] as Node & { value?: unknown } | undefined)?.value;
    if (callee.name !== "setStartupRecoveryPhase") return;
    if (phase === "recovering") { boot = owner; from = node.start; }
    if (phase === "ready" && owner === boot) to = node.start;
  });
  expect(boot).toBeDefined();
  expect(to).toBeGreaterThan(from);

  const unnamed: string[] = [];
  const named: string[] = [];
  walk(program as unknown as Node, [], (node, owner) => {
    if (node.type !== "AwaitExpression" || owner !== boot || node.start < from || node.start > to) return;
    const argument = node.argument as Node;
    const callee = argument.type === "CallExpression" ? argument.callee as Node : undefined;
    const isPrecondition = callee?.type === "MemberExpression"
      && source.slice(callee.start, callee.end) === "startupTimeline.precondition";
    const step = isPrecondition ? ((argument.arguments as Node[])[0] as Node & { value?: unknown }).value : undefined;
    if (typeof step === "string") named.push(step);
    else unnamed.push(`line ${source.slice(0, node.start).split("\n").length}: ${source.slice(node.start, node.start + 80)}`);
  });

  expect(unnamed, "await on the boot path outside startupTimeline.precondition").toEqual([]);
  expect([...new Set(named)].sort()).toEqual(Object.keys(READINESS_PRECONDITIONS).sort());
});
