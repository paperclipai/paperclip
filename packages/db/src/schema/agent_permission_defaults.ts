import { pgTable, uuid, boolean, timestamp } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";

export const agentPermissionDefaults = pgTable("agent_permission_defaults", {
  companyId: uuid("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  assignDefault: boolean("assign_default").notNull().default(false),
  commentDefault: boolean("comment_default").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
