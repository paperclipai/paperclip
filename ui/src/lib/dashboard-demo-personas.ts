import type { Company } from "@paperclipai/shared";

/**
 * Design exploration only, not a product feature: the Dashboard can compare
 * the dashboards of a few demo people, each seeded as their own organization
 * by `scripts/seed-persona-dashboards.mjs`. Such an organization's description
 * starts with `[dashboard-demo] Name — Role`. Remove this with the comparison.
 */
export const DASHBOARD_DEMO_MARKER = "[dashboard-demo]";

export interface DashboardDemoPersona {
  companyId: string;
  issuePrefix: string;
  /** "Scott". */
  name: string;
  /** "Chief Product Officer"; null when the marker names nobody's role. */
  role: string | null;
}

/** The person and role in a description that starts with the marker, or null. */
export function parseDashboardDemoPersona(description: string | null | undefined): Pick<DashboardDemoPersona, "name" | "role"> | null {
  const text = description?.trimStart();
  if (!text?.startsWith(DASHBOARD_DEMO_MARKER)) return null;
  const line = text.slice(DASHBOARD_DEMO_MARKER.length).split("\n")[0]!.trim();
  if (!line) return null;
  const separator = line.indexOf(" — ");
  if (separator < 0) return { name: line, role: null };
  const name = line.slice(0, separator).trim();
  const role = line.slice(separator + 3).trim();
  return name ? { name, role: role || null } : null;
}

/** The demo people among the organizations the viewer can open, oldest organization first. */
export function dashboardDemoPersonas(
  companies: readonly Pick<Company, "id" | "issuePrefix" | "description" | "createdAt" | "status">[],
): DashboardDemoPersona[] {
  return companies
    .filter((company) => company.status !== "archived")
    .map((company) => ({ company, persona: parseDashboardDemoPersona(company.description) }))
    .filter((entry): entry is { company: (typeof companies)[number]; persona: NonNullable<ReturnType<typeof parseDashboardDemoPersona>> } => entry.persona !== null)
    .sort((a, b) =>
      new Date(a.company.createdAt).getTime() - new Date(b.company.createdAt).getTime() || a.company.id.localeCompare(b.company.id))
    .map(({ company, persona }) => ({ companyId: company.id, issuePrefix: company.issuePrefix, ...persona }));
}
