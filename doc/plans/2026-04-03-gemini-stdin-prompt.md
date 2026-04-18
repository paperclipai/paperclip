# Gemini Adapter: Pipe prompt via stdin on Windows

**Date:** 2026-04-03
**Status:** Resolved
**Affects:** `packages/adapters/gemini-local`

## Problem

Agent runs using the `gemini_local` adapter fail on Windows with:

```
Cannot use both a positional prompt and the --prompt (-p) flag together
```

The Gemini CLI (v0.36.0+) rejects the invocation even though the adapter
only passes `--prompt <value>` and never supplies a positional argument.

## Root cause

On Windows the globally-installed Gemini CLI resolves to `gemini.CMD`, a
batch-file wrapper.  The shared `resolveSpawnTarget()` helper in
`packages/adapter-utils` detects `.cmd` extensions and re-routes the spawn
through `cmd.exe /d /s /c "<commandLine>"`, quoting each argument with
`quoteForCmd()`.

`quoteForCmd()` doubles internal double-quotes (`"` → `""`) and wraps the
argument in outer quotes when it contains whitespace or shell meta-characters.
For short, simple arguments this works fine.  For the agent prompt — typically
1 000–3 000+ characters containing `"`, `&`, `|`, `()`, and other
cmd.exe-special characters — the escaping breaks down:

1. cmd.exe splits the prompt argument at unescaped meta-characters.
2. The fragment after the split is no longer inside the `--prompt` option.
3. The Gemini CLI's yargs parser interprets that fragment as a **positional
   `query` argument**.
4. Because both a positional prompt *and* `--prompt` are now present, the CLI
   rejects the invocation.

A secondary issue (fixed in the same change): the adapter passed
`--sandbox=none`.  In Gemini CLI v0.36.0 `--sandbox` became a boolean flag,
so `=none` was parsed as the string `"none"` — another accidental positional
argument.

## Fix

### 1. Pipe the prompt via stdin (`execute.ts`)

Instead of passing the prompt as a CLI argument:

```diff
-    args.push("--prompt", prompt);
+    // Trigger headless mode with a short non-empty placeholder.
+    // The full prompt is piped via stdin, avoiding all shell escaping.
+    args.push("--prompt", ".");
```

```diff
     const proc = await runChildProcess(runId, command, args, {
       cwd,
       env,
+      stdin: prompt,
       timeoutSec,
```

The Gemini CLI concatenates stdin content with the `--prompt` value
(`stdin + "\n\n\n" + promptValue`), so the full prompt arrives intact
regardless of length or special characters.

This mirrors the pattern the Codex adapter already uses (`codex exec … -`
with prompt on stdin).

### 2. Boolean sandbox flag (`execute.ts`, `test.ts`)

```diff
-      args.push("--sandbox=none");
+      args.push("--no-sandbox");
```

`--no-sandbox` is the standard yargs boolean negation for `--sandbox`.

### 3. Test probe consistency (`test.ts`)

The "hello" probe in `testEnvironment()` was updated to match: prompt piped
via stdin, `--prompt "."` as the headless trigger.

## Files changed

| File | Change |
|------|--------|
| `packages/adapters/gemini-local/src/server/execute.ts` | stdin prompt, `--no-sandbox`, updated command notes |
| `packages/adapters/gemini-local/src/server/test.ts` | stdin prompt in hello probe, `--no-sandbox` |

## Verification

- `pnpm --filter @paperclipai/adapter-gemini-local typecheck` passes.
- Manual test: `echo "Respond with hello." | gemini --output-format stream-json --no-sandbox --prompt "."` produces valid stream-json output with the stdin content as the user message.
- Agent runs complete successfully after the fix.
