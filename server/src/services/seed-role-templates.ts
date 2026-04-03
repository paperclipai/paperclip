import type { Db } from "@ironworksai/db";
import { agentRoleTemplates } from "@ironworksai/db";
import { ROLE_TEMPLATES } from "../onboarding-assets/role-templates.js";

/**
 * Seeds system role templates for a newly created company.
 * Inserts one agent_role_template row per ROLE_TEMPLATE with is_system = true.
 */
export async function seedSystemRoleTemplates(db: Db, companyId: string): Promise<void> {
  if (ROLE_TEMPLATES.length === 0) return;

  await db.insert(agentRoleTemplates).values(
    ROLE_TEMPLATES.map((tmpl) => ({
      companyId,
      name: tmpl.key,
      role: tmpl.role,
      department: tmpl.department,
      title: tmpl.title,
      capabilities: tmpl.tagline,
      systemPromptTemplate: tmpl.soul,
      isSystem: true,
    })),
  );
}
