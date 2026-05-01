import {
  pgTable,
  uuid,
  text,
  timestamp,
  real,
  boolean,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "./companies.js";

export const userLocations = pgTable(
  "user_locations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    userId: text("user_id").notNull(),
    lat: real("lat").notNull(),
    lng: real("lng").notNull(),
    label: text("label"),
    isDefault: boolean("is_default").notNull().default(false),
    geohash: text("geohash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompanyIdx: index("user_locations_user_company_idx").on(table.userId, table.companyId),
    geohashIdx: index("user_locations_geohash_idx").on(table.geohash),
    userDefaultIdx: uniqueIndex("user_locations_user_default_uq")
      .on(table.userId, table.companyId, table.isDefault)
      .where(sql`${table.isDefault} = true`),
  }),
);
