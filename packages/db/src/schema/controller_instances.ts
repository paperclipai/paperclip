import { bigint, bigserial, index, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * One row per server process boot. A live process renews its lease on the
 * database clock; a newer boot fences an older one only after its lease has
 * expired, and a fenced or lease-less process stops. Stamps name the boot id,
 * so a record owned by a replaced container is proven gone without sharing a
 * host or PID space with it.
 */
export const controllerInstances = pgTable(
  "controller_instances",
  {
    bootId: text("boot_id").primaryKey(),
    epoch: bigserial("epoch", { mode: "number" }).notNull(),
    processSpace: text("process_space").notNull(),
    pid: integer("pid").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    renewedAt: timestamp("renewed_at", { withTimezone: true }).notNull().defaultNow(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    fencedAt: timestamp("fenced_at", { withTimezone: true }),
    fencedByEpoch: bigint("fenced_by_epoch", { mode: "number" }),
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
  },
  (table) => ({
    epochIdx: uniqueIndex("controller_instances_epoch_idx").on(table.epoch),
    liveIdx: index("controller_instances_lease_idx").on(table.leaseExpiresAt),
  }),
);
