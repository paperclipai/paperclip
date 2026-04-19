import { pgTable, uuid, timestamp, index, primaryKey } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { labels } from "./labels.js";
import { projects } from "./projects.js";

export const projectLabels = pgTable(
  "project_labels",
  {
    projectId: uuid("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    labelId: uuid("label_id").notNull().references(() => labels.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.labelId], name: "project_labels_pk" }),
    projectIdx: index("project_labels_project_idx").on(table.projectId),
    labelIdx: index("project_labels_label_idx").on(table.labelId),
    companyIdx: index("project_labels_company_idx").on(table.companyId),
  }),
);
