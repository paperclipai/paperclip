import { pgEnum, pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { estates } from "./estates.js";

export const collaboratorAccessLevelEnum = pgEnum("collaborator_access_level", [
  "read",
  "read_write",
]);

export const estateCollaborators = pgTable(
  "estate_collaborators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    estateId: uuid("estate_id").notNull().references(() => estates.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    advisorUserId: text("advisor_user_id"),
    invitedByUserId: text("invited_by_user_id").notNull(),
    email: text("email").notNull(),
    accessLevel: collaboratorAccessLevelEnum("access_level").notNull().default("read"),
    inviteToken: text("invite_token").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    estateIdx: index("estate_collaborators_estate_idx").on(table.estateId),
    tokenIdx: index("estate_collaborators_token_idx").on(table.inviteToken),
  }),
);
