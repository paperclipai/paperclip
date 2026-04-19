-- Health & Longevity module: Phase 1 schema
-- Tables: user_locations, environmental_readings, health_scores

CREATE TABLE IF NOT EXISTS "user_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "lat" real NOT NULL,
  "lng" real NOT NULL,
  "label" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "geohash" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_locations_user_company_idx"
  ON "user_locations" ("user_id", "company_id");

CREATE INDEX IF NOT EXISTS "user_locations_geohash_idx"
  ON "user_locations" ("geohash");

CREATE UNIQUE INDEX IF NOT EXISTS "user_locations_user_default_uq"
  ON "user_locations" ("user_id", "company_id", "is_default")
  WHERE "is_default" = true;

CREATE TABLE IF NOT EXISTS "environmental_readings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "location_id" uuid NOT NULL REFERENCES "user_locations"("id"),
  "reading_at" timestamp with time zone NOT NULL,
  "aqi" real,
  "pm25" real,
  "pm10" real,
  "no2" real,
  "uv_index" real,
  "land_surface_temp" real,
  "ndvi" real,
  "data_source" text NOT NULL DEFAULT 'planet_labs',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "environmental_readings_location_reading_at_idx"
  ON "environmental_readings" ("location_id", "reading_at");

CREATE TABLE IF NOT EXISTS "health_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "scored_at" timestamp with time zone NOT NULL,
  "overall_score" integer NOT NULL,
  "color_tier" text NOT NULL DEFAULT 'green',
  "aqi_component" real,
  "uv_component" real,
  "heat_stress_component" real,
  "greenspace_component" real,
  "confidence_flag" boolean NOT NULL DEFAULT true,
  "partial_signals" text[],
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "health_scores_user_scored_at_idx"
  ON "health_scores" ("user_id", "scored_at");

CREATE INDEX IF NOT EXISTS "health_scores_company_scored_at_idx"
  ON "health_scores" ("company_id", "scored_at");

-- Convert health_scores to TimescaleDB hypertable (scored_at as time dimension).
-- Runs only when the timescaledb extension is available; safe to skip otherwise.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  ) THEN
    PERFORM create_hypertable(
      'health_scores',
      'scored_at',
      if_not_exists => TRUE,
      migrate_data   => TRUE
    );
  END IF;
END $$;
