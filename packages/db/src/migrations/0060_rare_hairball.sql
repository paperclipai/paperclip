CREATE TABLE "gateway_circuit_state" (
	"route_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'closed' NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_failure_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"adapter_type" text NOT NULL,
	"model" text NOT NULL,
	"weight" integer DEFAULT 100 NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"quota_tokens_per_minute" integer,
	"quota_tokens_per_hour" integer,
	"quota_tokens_per_day" integer,
	"quota_requests_per_minute" integer,
	"quota_requests_per_hour" integer,
	"quota_requests_per_day" integer,
	"circuit_breaker_enabled" boolean DEFAULT false NOT NULL,
	"circuit_breaker_failure_threshold" integer DEFAULT 3 NOT NULL,
	"circuit_breaker_reset_sec" integer DEFAULT 300 NOT NULL,
	"timeout_sec" integer,
	"adapter_config_overrides" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"route_id" uuid NOT NULL,
	"window_type" text NOT NULL,
	"window_key" text NOT NULL,
	"token_count" bigint DEFAULT 0 NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gateway_circuit_state" ADD CONSTRAINT "gateway_circuit_state_route_id_gateway_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."gateway_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_routes" ADD CONSTRAINT "gateway_routes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_routes" ADD CONSTRAINT "gateway_routes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_usage_counters" ADD CONSTRAINT "gateway_usage_counters_route_id_gateway_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."gateway_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_routes_company_agent_idx" ON "gateway_routes" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "gateway_routes_company_enabled_idx" ON "gateway_routes" USING btree ("company_id","is_enabled","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_usage_route_window_unique_idx" ON "gateway_usage_counters" USING btree ("route_id","window_type","window_key");