type AssignmentWakeInput = {
  actorType: "board" | "agent" | "none";
  actorAgentId: string | null;
  actorRunId: string | null;
  assignmentAgentId: string | null;
};

export function shouldWakeAssigneeOnAssignment(input: AssignmentWakeInput): boolean {
  if (!input.assignmentAgentId) return false;
  if (input.actorType !== "agent") return true;
  if (!input.actorAgentId) return true;
  if (input.actorAgentId !== input.assignmentAgentId) return true;
  if (!input.actorRunId) return true;
  return false;
}
