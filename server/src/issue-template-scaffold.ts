/**
 * Soft-scaffold and validation helpers for the Objective/Scope/Verification
 * harness spec format enforced at issue creation time.
 *
 * Controlled by the PAPERCLIP_SPEC_ENFORCE environment variable:
 *   (unset / anything other than "strict") — scaffold mode: missing sections
 *     are appended automatically so the path of least resistance is compliance.
 *   "strict" — hard-reject mode: a POST /api/companies/:companyId/issues
 *     request whose description is missing any required section returns HTTP 400.
 */

export const REQUIRED_SECTIONS = ["## Objective", "## Scope", "## Verification"] as const;

const SECTION_SKELETONS: Record<(typeof REQUIRED_SECTIONS)[number], string> = {
  "## Objective": "## Objective\n\n<!-- Describe what this task achieves and why it matters. -->",
  "## Scope":
    "## Scope\n\n**Touch:** <!-- files, systems, or areas to modify -->\n**Do not touch:** <!-- explicit exclusions -->",
  "## Verification": "## Verification\n\n- [ ] <!-- Concrete, machine-checkable acceptance criterion -->",
};

/** Returns true when every required section header is present in the description. */
export function hasAllRequiredSections(description: string | null | undefined): boolean {
  if (!description) return false;
  return REQUIRED_SECTIONS.every((section) => description.includes(section));
}

/**
 * Soft-scaffold: append skeleton blocks for any missing sections.
 * If the description already contains all three sections it is returned unchanged.
 */
export function scaffoldDescription(description: string | null | undefined): string {
  const base = description ?? "";
  const missing = REQUIRED_SECTIONS.filter((section) => !base.includes(section));
  if (missing.length === 0) return base;

  const appended = missing.map((section) => SECTION_SKELETONS[section]).join("\n\n");
  return base ? `${base}\n\n${appended}` : appended;
}

/**
 * Returns the scaffold enforcement mode derived from the environment.
 *   "strict"  — reject requests that are missing any required section (HTTP 400)
 *   "scaffold" — (default) silently append missing sections
 */
export function getSpecEnforceMode(): "strict" | "scaffold" {
  return process.env.PAPERCLIP_SPEC_ENFORCE === "strict" ? "strict" : "scaffold";
}
