#!/usr/bin/env node
/**
 * CLI entry point for the tool-middleware hook runner.
 *
 * Called by Claude Code PreToolUse/PostToolUse hooks.
 * Reads hook event JSON from stdin, processes it, writes pruned summary to stdout.
 *
 * Exit codes:
 *   0 — pass-through (PostToolUse always, PreToolUse when input is valid)
 *   2 — block (PreToolUse when input exceeds byte ceiling or cache-hit served)
 */

import { runHook } from "./hook-runner.js";

runHook().catch((err: unknown) => {
  process.stderr.write(`[tool-middleware/bin] Fatal: ${String(err)}\n`);
  process.exit(0); // never crash Claude
});
