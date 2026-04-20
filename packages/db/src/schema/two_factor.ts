import { pgTable, text, index } from "drizzle-orm/pg-core";
import { authUsers } from "./auth.js";

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("two_factor_user_id_idx").on(table.userId),
  ],
);
