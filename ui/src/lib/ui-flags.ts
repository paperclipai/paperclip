/**
 * Product UI feature flags.
 *
 * These are compile-time constants that gate presentation-only surfaces. They
 * deliberately do NOT touch the data model, API, validation, or filter DSL — a
 * gated feature stays fully functional at the data layer and can be revived by
 * flipping the flag back to `true`.
 */

/**
 * Controls whether task/issue **priority** indicators and controls are shown in
 * the product UI.
 *
 * Set to `false` for PAP-411 ("remove task priority level from the UI"). The
 * priority data model, API params, Zod validation (including the `"medium"`
 * default), and filter DSL are intentionally left intact so priority can be
 * revived by flipping this single boolean back to `true`.
 *
 * Typed as `boolean` (not the literal `false`) on purpose: this keeps
 * TypeScript and lint from flagging the gated branches as unreachable/dead code.
 */
export const SHOW_TASK_PRIORITY_UI: boolean = false;
