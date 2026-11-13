import { z } from "zod";

export const DEPARTMENT_NAME_MAX_LENGTH = 80;
export const AGENT_DEPARTMENT_MAX_MEMBERSHIPS = 20;

// The roster filter value for agents with no membership rows. It is not a
// department id and is never stored.
export const UNASSIGNED_DEPARTMENT = "__unassigned__";

export interface Department {
  id: string;
  companyId: string;
  name: string;
  agentIds: string[];
}

// Collapse whitespace and reject an empty or oversized name. The database
// stores this form and uniquely indexes `lower(name)` per company.
export function normalizeDepartmentName(input: string): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim().replace(/\s+/g, " ");
  if (!name || name.length > DEPARTMENT_NAME_MAX_LENGTH) return null;
  return name;
}

export const createDepartmentSchema = z.object({
  name: z.string().min(1).max(200),
}).strict();

export const updateDepartmentSchema = z.object({
  name: z.string().min(1).max(200),
}).strict();

export const setAgentDepartmentsSchema = z.object({
  departmentIds: z.array(z.string().uuid()).max(AGENT_DEPARTMENT_MAX_MEMBERSHIPS),
  // A new label typed on the agent card. Created in this request so the card
  // does not need a separate board-only catalog call.
  names: z.array(z.string().min(1).max(200)).max(AGENT_DEPARTMENT_MAX_MEMBERSHIPS).optional(),
}).strict();

export type CreateDepartment = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartment = z.infer<typeof updateDepartmentSchema>;
export type SetAgentDepartments = z.infer<typeof setAgentDepartmentsSchema>;
