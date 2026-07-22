ALTER TABLE "cost_events"
  ALTER COLUMN "cost_cents" TYPE numeric(20, 6)
  USING "cost_cents"::numeric(20, 6);
