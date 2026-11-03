// Negative fixture for scripts/check-tracked-imports.mjs. Both files here are
// tracked; the test supplies a tracked set that omits `module.ts` to stand in
// for a source file that only exists in a contributor's worktree.
export * from "./module.js";
export * from "./absent.js";
