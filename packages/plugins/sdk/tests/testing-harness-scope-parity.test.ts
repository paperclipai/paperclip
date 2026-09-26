/**
 * Category safeguard: a company-scoped `ctx` method must not exist in the test
 * harness without the invocation-scope gate the host applies to it.
 *
 * The instance bug was that `createTestHarness` modelled no invocation scope at
 * all. The *class* of bug is that the fake `ctx` (`testing.ts`) and the real
 * `ctx` (`worker-rpc-host.ts`) are two hand-written implementations of one
 * interface, so a method added to both — or a gate added to only one — drifts
 * silently, and the drift is invisible precisely because the fake is what the
 * tests run against.
 *
 * This test derives the company-scoped method set from the REAL client and
 * asserts the fake gates every one of them. Add a company-scoped `ctx` method
 * without a gate and this fails, naming the method.
 *
 * It is a source scan, so it strips comments first — otherwise a method named
 * only in a doc comment would satisfy it and the gate would be vacuous.
 *
 * Known blind spot: `events.subscribe` carries its company in `filter.companyId`,
 * but the harness's `ctx.events.on` registers the handler locally and never makes
 * a host call at all, so there is no fake-side call site to gate. The scan does
 * not flag it because the client builds those params from a variable.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workerClientSource = readFileSync(
  fileURLToPath(new URL("../src/worker-rpc-host.ts", import.meta.url)),
  "utf8",
);
const harnessSource = readFileSync(
  fileURLToPath(new URL("../src/testing.ts", import.meta.url)),
  "utf8",
);

/**
 * Methods the harness deliberately does not gate, each with the reason. Every
 * entry here is a hole in the safeguard, so it stays short and justified.
 */
const UNGATED: Record<string, string> = {
  // Fire-and-forget notifications. The host does not throw on these — it drops
  // the notification and logs (plugin-worker-manager.ts handleWorkerNotification).
  // The harness's `ctx.streams.*` fakes record nothing observable, so modelling
  // the drop would have no test-visible effect. Gate them when the fakes grow a
  // recorder.
  "streams.open": "notification; host drops rather than throws, and the fake records nothing",
  "streams.emit": "notification; host drops rather than throws, and the fake records nothing",
  "streams.close": "notification; host drops rather than throws, and the fake records nothing",
};

/** Strip line and block comments so a method named in prose cannot satisfy the scan. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      out += ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { out += source.slice(i, i + 2); i += 2; continue; }
        out += source[i];
        const closed = source[i] === ch;
        i += 1;
        if (closed) break;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Text of the argument list of `fn(` starting at `openParenIndex`, paren-matched. */
function argumentText(source: string, openParenIndex: number): string {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return source.slice(openParenIndex + 1);
}

/**
 * Every worker→host method the production client sends a company for — either a
 * `companyId` field or a `scopeKind`/`scopeId` pair.
 *
 * A call that forwards a whole object (`callHost("x", input)`) counts too: the
 * company is inside `input`, invisible to a text scan, and every such call in
 * the client today is company-scoped. Counting it errs toward demanding a gate,
 * which is the safe direction for a safeguard — a new one must be gated or
 * appear in `UNGATED` with a reason.
 */
function companyScopedMethods(source: string): string[] {
  const stripped = stripComments(source);
  const found = new Set<string>();
  const call = /\b(?:callHost|notifyHost)\s*\(\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(stripped)) !== null) {
    const method = match[1];
    const openParen = stripped.indexOf("(", match.index);
    const args = argumentText(stripped, openParen);
    const params = args.slice(args.indexOf(",") + 1).trim();
    const forwardsWholeObject = args.includes(",") && /^[A-Za-z_$][\w$]*$/.test(params);
    if (/\bcompanyId\b/.test(args) || /\bscopeKind\b/.test(args) || forwardsWholeObject) {
      found.add(method);
    }
  }
  return [...found].sort();
}

/** Methods the harness passes to one of its invocation-scope gates. */
function gatedMethods(source: string): Set<string> {
  const stripped = stripComments(source);
  const gates = /\b(?:requireCompanyScope|requireCompanyId|requireResolvedCompanyId)\s*\(\s*"([^"]+)"/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = gates.exec(stripped)) !== null) found.add(match[1]);
  return found;
}

describe("test harness / production client company-scope parity", () => {
  const scoped = companyScopedMethods(workerClientSource);
  const gated = gatedMethods(harnessSource);

  it("finds the company-scoped methods in the production client", () => {
    // Negative control: if the scan silently matches nothing, every assertion
    // below passes vacuously.
    expect(scoped.length).toBeGreaterThan(30);
    expect(scoped).toContain("config.get");
    expect(scoped).toContain("issues.createComment");
    expect(scoped).toContain("state.get");
  });

  it("finds the harness's gates", () => {
    expect(gated.size).toBeGreaterThan(30);
  });

  it("gates every company-scoped method the production client can send", () => {
    const missing = scoped.filter((method) => !gated.has(method) && !(method in UNGATED));
    expect(missing).toEqual([]);
  });

  it("keeps the ungated allowlist honest", () => {
    // An allowlist entry for a method that is no longer company-scoped is dead
    // weight that hides the next real hole.
    const stale = Object.keys(UNGATED).filter((method) => !scoped.includes(method));
    expect(stale).toEqual([]);
  });
});
