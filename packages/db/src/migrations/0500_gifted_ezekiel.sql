CREATE TABLE "agent_departments" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"department_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_departments_pk" PRIMARY KEY("agent_id","department_id")
);
--> statement-breakpoint
CREATE TABLE "departments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "departments_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
ALTER TABLE "agent_departments" ADD CONSTRAINT "agent_departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_departments" ADD CONSTRAINT "agent_departments_agent_company_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."agents"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_departments" ADD CONSTRAINT "agent_departments_department_company_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "departments" ADD CONSTRAINT "departments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_departments_company_idx" ON "agent_departments" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "agent_departments_agent_idx" ON "agent_departments" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_departments_department_idx" ON "agent_departments" USING btree ("department_id");--> statement-breakpoint
CREATE INDEX "departments_company_idx" ON "departments" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_company_name_key_uq" ON "departments" USING btree ("company_id",lower("name"));