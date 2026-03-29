CREATE TABLE "memory_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"provider_type" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"content" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"binding_id" uuid NOT NULL,
	"operation_type" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_bindings" ADD CONSTRAINT "memory_bindings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_operations" ADD CONSTRAINT "memory_operations_binding_id_memory_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."memory_bindings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_bindings_company_key_idx" ON "memory_bindings" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX "memory_entries_company_binding_idx" ON "memory_entries" USING btree ("company_id","binding_id");--> statement-breakpoint
CREATE INDEX "memory_entries_company_created_idx" ON "memory_entries" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_operations_company_created_idx" ON "memory_operations" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "memory_operations_company_binding_idx" ON "memory_operations" USING btree ("company_id","binding_id");
