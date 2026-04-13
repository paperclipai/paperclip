CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"cnpj" text,
	"phone" text,
	"contact_name" text,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_name_override" text,
	"project_type" text,
	"status" text DEFAULT 'active' NOT NULL,
	"description" text,
	"billing_type" text,
	"amount_cents" integer,
	"last_payment_at" timestamp with time zone,
	"start_date" date,
	"end_date" date,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_projects" ADD CONSTRAINT "client_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clients_company_idx" ON "clients" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "client_projects_company_idx" ON "client_projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "client_projects_client_idx" ON "client_projects" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "client_projects_project_idx" ON "client_projects" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "client_projects_client_project_idx" ON "client_projects" USING btree ("client_id","project_id");
