import { describe, expect, it } from "vitest";

import {
  RUNTIME_EXPOSURE_BIND_HOST,
  commandSelectsBindMode,
  forceLoopbackBindInCommand,
  isPaperclipDevRunnerCommand,
  rewriteUrlHostToLoopback,
} from "./loopback-bind.js";

describe("forceLoopbackBindInCommand", () => {
  it("replaces the exact command the failing managed lanes ran", () => {
    // PAP-17256 reproduction: this is verbatim what `workspace_runtime_services`
    // recorded for every lane the broker denied.
    expect(forceLoopbackBindInCommand("pnpm dev --bind lan")).toBe(
      "pnpm dev --bind custom --bind-host 127.0.0.1",
    );
  });

  it("replaces an existing loopback-adjacent bind rather than duplicating it", () => {
    expect(forceLoopbackBindInCommand("pnpm dev --bind tailnet")).toBe(
      "pnpm dev --bind custom --bind-host 127.0.0.1",
    );
    expect(forceLoopbackBindInCommand("pnpm dev --bind custom --bind-host 10.0.0.4")).toBe(
      "pnpm dev --bind custom --bind-host 127.0.0.1",
    );
  });

  it("is idempotent, so a re-start of an already-rewritten service is stable", () => {
    const once = forceLoopbackBindInCommand("pnpm dev --bind lan");
    expect(forceLoopbackBindInCommand(once)).toBe(once);
  });

  it("handles the =-separated spelling", () => {
    expect(forceLoopbackBindInCommand("pnpm dev --bind=lan --bind-host=0.0.0.0")).toBe(
      "pnpm dev --bind custom --bind-host 127.0.0.1",
    );
  });

  it("adds an explicit loopback bind when the command selects none", () => {
    // A bare `pnpm dev` lets an old guest runner infer its bind from HOST, so the
    // flags must be added rather than assumed.
    expect(forceLoopbackBindInCommand("pnpm dev")).toBe(
      "pnpm dev --bind custom --bind-host 127.0.0.1",
    );
  });

  it("keeps the legacy lan aliases so dev-service detection still matches", () => {
    // `isPaperclipDevRuntimeService` matches `--tailscale-auth` as a substring;
    // an explicit `--bind` already beats the alias in every dev-runner version.
    expect(forceLoopbackBindInCommand("pnpm dev:once --tailscale-auth")).toBe(
      "pnpm dev:once --tailscale-auth --bind custom --bind-host 127.0.0.1",
    );
  });

  it("never strips a value that is actually the next flag", () => {
    expect(forceLoopbackBindInCommand("pnpm dev --bind --verbose")).toBe(
      "pnpm dev --bind --verbose --bind custom --bind-host 127.0.0.1",
    );
  });

  it("does not touch a --bind occurrence that is not a flag boundary", () => {
    expect(forceLoopbackBindInCommand("pnpm dev --no--bind lan")).toBe(
      "pnpm dev --no--bind lan --bind custom --bind-host 127.0.0.1",
    );
  });

  it("leaves a command that does not parse these flags untouched", () => {
    // The HTTPS probe canaries: rewriting this would produce nonsense, and
    // appending flags to a command that cannot parse them makes it exit at boot.
    const canary = 'python3 -m http.server "$PORT" --bind 127.0.0.1';
    expect(forceLoopbackBindInCommand(canary)).toBe(canary);
    const fixture = `node -e 'require("http").createServer().listen(1)'`;
    expect(forceLoopbackBindInCommand(fixture)).toBe(fixture);
  });

  it("uses the loopback host constant", () => {
    expect(forceLoopbackBindInCommand("pnpm dev")).toContain(RUNTIME_EXPOSURE_BIND_HOST);
  });
});

describe("commandSelectsBindMode", () => {
  it("detects both spellings and the legacy aliases", () => {
    expect(commandSelectsBindMode("pnpm dev --bind lan")).toBe(true);
    expect(commandSelectsBindMode("pnpm dev --bind=lan")).toBe(true);
    expect(commandSelectsBindMode("pnpm dev --bind-host 10.0.0.1")).toBe(true);
    expect(commandSelectsBindMode("pnpm dev:once --tailscale-auth")).toBe(true);
    expect(commandSelectsBindMode("pnpm dev:once --authenticated-private")).toBe(true);
  });

  it("is false for a command with no bind selection", () => {
    expect(commandSelectsBindMode("pnpm dev")).toBe(false);
    expect(commandSelectsBindMode('python3 -m http.server "$PORT"')).toBe(false);
  });
});

describe("isPaperclipDevRunnerCommand", () => {
  it("matches the real managed dev commands", () => {
    expect(isPaperclipDevRunnerCommand("pnpm dev --bind lan")).toBe(true);
    expect(isPaperclipDevRunnerCommand("pnpm dev")).toBe(true);
    expect(isPaperclipDevRunnerCommand("pnpm dev:once --tailscale-auth")).toBe(true);
    expect(isPaperclipDevRunnerCommand("pnpm dev:watch")).toBe(true);
    expect(isPaperclipDevRunnerCommand("npm run dev --bind lan")).toBe(true);
    expect(isPaperclipDevRunnerCommand("yarn dev")).toBe(true);
    expect(isPaperclipDevRunnerCommand("node /tmp/x/dev-runner.mjs --bind lan")).toBe(true);
    expect(isPaperclipDevRunnerCommand("tsx ../scripts/dev-runner.ts watch")).toBe(true);
  });

  it("does not match unrelated commands that merely use --bind", () => {
    expect(isPaperclipDevRunnerCommand('python3 -m http.server "$PORT" --bind 127.0.0.1')).toBe(false);
    expect(isPaperclipDevRunnerCommand("node -e 'listen()'")).toBe(false);
    expect(isPaperclipDevRunnerCommand("pnpm build")).toBe(false);
    expect(isPaperclipDevRunnerCommand("pnpm develop")).toBe(false);
    expect(isPaperclipDevRunnerCommand("./my-dev-runnerish --bind lan")).toBe(false);
  });
});

describe("rewriteUrlHostToLoopback", () => {
  it("redirects a MagicDNS probe target to loopback, keeping port and path", () => {
    expect(rewriteUrlHostToLoopback("http://paperclip-dev:42003/api/health")).toBe(
      "http://127.0.0.1:42003/api/health",
    );
    expect(rewriteUrlHostToLoopback("http://paperclip-dev:42003")).toBe("http://127.0.0.1:42003/");
  });

  it("leaves an already-loopback target alone", () => {
    expect(rewriteUrlHostToLoopback("http://127.0.0.1:42003/api/health")).toBe(
      "http://127.0.0.1:42003/api/health",
    );
  });

  it("passes through null and unparseable values", () => {
    expect(rewriteUrlHostToLoopback(null)).toBeNull();
    expect(rewriteUrlHostToLoopback("not a url")).toBe("not a url");
  });
});
