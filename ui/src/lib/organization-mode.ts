import type { Company, CompanyOrganizationMode } from "@paperclipai/shared";

export function resolveOrganizationMode(
  company: Pick<Company, "organizationMode"> | null | undefined,
): CompanyOrganizationMode {
  return company?.organizationMode === "team" ? "team" : "company";
}

export function getOrganizationTerms(
  company: Pick<Company, "organizationMode"> | null | undefined,
) {
  const mode = resolveOrganizationMode(company);
  const isTeam = mode === "team";

  return {
    mode,
    singular: isTeam ? "team" : "company",
    singularTitle: isTeam ? "Team" : "Company",
    plural: isTeam ? "teams" : "companies",
    pluralTitle: isTeam ? "Teams" : "Companies",
    goal: isTeam ? "team goal" : "company goal",
    goalTitle: isTeam ? "Team Goal" : "Company Goal",
    leadRole: isTeam ? "Team Lead" : "CEO",
    addAgent: isTeam ? "Add teammate" : "Add agent",
    addAgentLower: isTeam ? "add teammate" : "add agent",
    newAgent: isTeam ? "new teammate" : "new agent",
    newAgentTitle: isTeam ? "New Teammate" : "New Agent",
    addedAgent: isTeam ? "added teammate" : "hired agent",
    hireAgent: isTeam ? "Add Teammate" : "Hire Agent",
    hireAgentLower: isTeam ? "add teammate" : "hire agent",
    planApproval: isTeam ? "Team Plan" : "CEO Strategy",
    planApprovalLower: isTeam ? "team plan" : "CEO strategy",
    chart: isTeam ? "Team Chart" : "Org Chart",
    chartShort: isTeam ? "Team" : "Org",
    operator: "operator",
    operatorTitle: "Operator",
    approvalForNewAgents: isTeam
      ? "Require operator approval for new teammates"
      : "Require board approval for new hires",
    approvalForNewAgentsHint: isTeam
      ? "New teammates stay pending until approved by the operator."
      : "New agent hires stay pending until approved by board.",
    selectedPrompt: isTeam ? "Select a team" : "Select a company",
    noSelectionPrompt: isTeam ? "No team selected." : "No company selected.",
  };
}
