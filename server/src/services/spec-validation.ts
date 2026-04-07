/**
 * REQ-01: Spec Enforcement on Issue Creation
 *
 * Validates that a spec template for an issue assigned to an agent
 * has all required fields based on the agent's role.
 */

export interface SpecValidationResult {
  valid: boolean;
  missingFields: string[];
  agentRole: string;
}

/** Base required fields for all roles. */
const DEFAULT_REQUIRED_FIELDS = ["goal", "acceptance_criteria", "output_format"];

/** Additional required fields per role (merged with defaults). */
const ROLE_EXTRA_FIELDS: Record<string, string[]> = {
  cmo: ["audience", "tone_voice"],
  content_marketer: ["audience", "tone_voice"],
  senior_engineer: ["scope_boundary"],
  engineer: ["scope_boundary"],
  devops_engineer: ["scope_boundary"],
  security_engineer: ["scope_boundary"],
  cto: ["scope_boundary"],
};

/**
 * Returns the set of required spec fields for a given agent role.
 */
function getRequiredFields(agentRole: string): string[] {
  const normalizedRole = agentRole.toLowerCase().replace(/\s+/g, "_");
  const extra = ROLE_EXTRA_FIELDS[normalizedRole] ?? [];
  return [...DEFAULT_REQUIRED_FIELDS, ...extra];
}

/**
 * Validates a spec template against the required fields for the given agent role.
 *
 * @param _companyId - Company context (reserved for future per-company overrides).
 * @param agentRole  - The role string of the assigned agent.
 * @param specTemplate - The JSONB spec template from the issue.
 * @returns Missing fields array and validation result.
 */
export function validateSpec(
  _companyId: string,
  agentRole: string,
  specTemplate: Record<string, unknown>,
): SpecValidationResult {
  const requiredFields = getRequiredFields(agentRole);
  const missingFields: string[] = [];

  for (const field of requiredFields) {
    const value = specTemplate[field];
    if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }

  return {
    valid: missingFields.length === 0,
    missingFields,
    agentRole,
  };
}
