// Exact state-label vocabulary defined by LET-167
// `visual-system-component-direction` rev 1 §4. Do not rename or paraphrase
// these copies; surfaces depend on the exact string. See LET-164
// `command-center-shell-ia` rev 1 §3/§7 for placement rules.

export type EaosStateLabel =
  | "REAL"
  | "BACKEND-BACKED"
  | "PREVIEW"
  | "DEMO"
  | "DESIGN-ONLY"
  | "DRY-RUN"
  | "APPROVAL REQUIRED"
  | "LIVE"
  | "APPLIED"
  | "FAILED"
  | "ROLLBACK NEEDED";

export const EAOS_STATE_LABELS = [
  "REAL",
  "BACKEND-BACKED",
  "PREVIEW",
  "DEMO",
  "DESIGN-ONLY",
  "DRY-RUN",
  "APPROVAL REQUIRED",
  "LIVE",
  "APPLIED",
  "FAILED",
  "ROLLBACK NEEDED",
] as const satisfies readonly EaosStateLabel[];

// Kernel/admin escape hatch chip copy, per LET-164 §4 and the LET-181
// validation contract. Must appear on every `/k/*` surface. The kernel
// chip describes a real legacy admin surface that IS backend-backed
// (links route to the existing Paperclip kernel pages), so this stays
// BACKEND-BACKED post-LET-187.
export const KERNEL_POSTURE_LABEL = "Kernel/Admin · BACKEND-BACKED" as const;

// LET-187 semantic-posture vocabulary. Two independent layers:
//   - "Shell · BACKEND-BACKED" — the React app and route shell IS served
//     by our backend. Always true for any `/eaos` route render.
//   - "Data · PREVIEW · Not connected" — the data displayed on the surface
//     is NOT yet wired to the LET-182 read-model contract. Until wired,
//     not-connected surfaces MUST NOT claim BACKEND-BACKED for the data
//     layer. Dual-label is the LET-187 fix to the LET-183 Product Designer
//     REQUEST_CHANGES finding.
export const SHELL_POSTURE_PREFIX = "Shell" as const;
export const SHELL_POSTURE_LABEL: EaosStateLabel = "BACKEND-BACKED";
export const NOT_CONNECTED_DATA_PREFIX = "Data" as const;
export const NOT_CONNECTED_DATA_LABEL: EaosStateLabel = "PREVIEW";
export const NOT_CONNECTED_DATA_NOTE = "Not connected" as const;

// Top-bar scope placeholder copy. Replaces the previous "Company · Project"
// fake-looking value with a visibly non-real string per LET-187 §2 until
// the company/project read model is wired.
export const SCOPE_PREVIEW_LABEL = "Scope preview · Not connected" as const;

// Aria/title text used by stub indicator and nav-zone count badges while
// counts are not wired to a read model. Visible badge content is explicitly
// "Stub" so screen readers and sighted users both see that the badge is a
// preview placeholder rather than a real "0" count.
export const STUB_COUNT_PLACEHOLDER = "Stub" as const;
export const STUB_COUNT_NOTE = "preview count · not connected" as const;

// Top-bar environment chip default — describes the shell layer only.
// Retained for downstream imports (EaosTopBar) while LET-187 also renders
// a paired Data · PREVIEW chip alongside it.
export const DEFAULT_TOPBAR_POSTURE_LABEL: EaosStateLabel = SHELL_POSTURE_LABEL;

// Bottom posture strip shell-layer default. The strip pairs this with a
// Data · PREVIEW chip until LET-182 wires the read model.
export const DEFAULT_BOTTOM_STRIP_LABEL: EaosStateLabel = SHELL_POSTURE_LABEL;
