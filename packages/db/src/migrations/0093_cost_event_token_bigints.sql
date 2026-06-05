ALTER TABLE "cost_events"
  ALTER COLUMN "input_tokens" TYPE bigint,
  ALTER COLUMN "cached_input_tokens" TYPE bigint,
  ALTER COLUMN "output_tokens" TYPE bigint;
