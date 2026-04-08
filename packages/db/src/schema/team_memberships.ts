import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { teams } from "./teams.js";

export const teamMemberships = pgTable(
  "team_memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    teamId: uuid("team_id").notNull().references(() => teams.id),
    principalType: text("principal_type").notNull(),
    principalId: text("principal_id").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamPrincipalUq: uniqueIndex("team_memberships_team_principal_uq").on(
      table.teamId,
      table.principalType,
      table.principalId,
    ),
    companyTeamIdx: index("team_memberships_company_team_idx").on(table.companyId, table.teamId),
  }),
);
