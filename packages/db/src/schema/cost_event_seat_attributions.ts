import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { costEvents } from "./cost_events.js";
import { seats } from "./seats.js";

export const costEventSeatAttributions = pgTable(
  "cost_event_seat_attributions",
  {
    costEventId: uuid("cost_event_id").primaryKey().references(() => costEvents.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    seatId: uuid("seat_id").notNull().references(() => seats.id),
    attributionSource: text("attribution_source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companySeatIdx: index("cost_event_seat_attributions_company_seat_idx").on(table.companyId, table.seatId),
    companySourceIdx: index("cost_event_seat_attributions_company_source_idx").on(
      table.companyId,
      table.attributionSource,
    ),
  }),
);
