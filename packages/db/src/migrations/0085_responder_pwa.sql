-- Field Responder Mobile PWA: status machine + web push subscriptions (IUN-2959)

CREATE TYPE IF NOT EXISTS "responder_status" AS ENUM (
  'acknowledged',
  'en_route',
  'on_scene',
  'cleared'
);

CREATE TABLE IF NOT EXISTS "responder_status_updates" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "alert_id"     uuid NOT NULL REFERENCES "solaris_alerts"("id") ON DELETE CASCADE,
  "company_id"   uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "status"       "responder_status" NOT NULL,
  "responder_id" text,
  "responder_name" text,
  "note"         text,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "responder_status_alert_idx"
  ON "responder_status_updates" ("alert_id", "created_at");

CREATE TABLE IF NOT EXISTS "web_push_subscriptions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id"  uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "responder_id" text NOT NULL,
  "endpoint"    text NOT NULL,
  "p256dh"      text NOT NULL,
  "auth"        text NOT NULL,
  "created_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"  timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "web_push_subscriptions_responder_endpoint_idx"
  ON "web_push_subscriptions" ("responder_id", "endpoint");

CREATE INDEX IF NOT EXISTS "web_push_subscriptions_company_idx"
  ON "web_push_subscriptions" ("company_id");
