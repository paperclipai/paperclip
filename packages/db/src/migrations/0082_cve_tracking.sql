CREATE TABLE "tracked_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"ecosystem" text NOT NULL,
	"version" text,
	"github_repo" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"alert_on_critical" boolean DEFAULT true NOT NULL,
	"alert_on_high" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tracked_dependencies_name_idx" ON "tracked_dependencies" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "tracked_dependencies_ecosystem_idx" ON "tracked_dependencies" USING btree ("ecosystem");
--> statement-breakpoint
CREATE INDEX "tracked_dependencies_is_active_idx" ON "tracked_dependencies" USING btree ("is_active");
--> statement-breakpoint
CREATE TABLE "cve_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cve_id" text NOT NULL UNIQUE,
	"description" text NOT NULL,
	"severity" text NOT NULL,
	"cvss_score" real,
	"cvss_vector" text,
	"affected_packages" text NOT NULL,
	"published_at" timestamp with time zone,
	"last_modified_at" timestamp with time zone,
	"references" text,
	"is_critical" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cve_entries_cve_id_idx" ON "cve_entries" USING btree ("cve_id");
--> statement-breakpoint
CREATE INDEX "cve_entries_severity_idx" ON "cve_entries" USING btree ("severity");
--> statement-breakpoint
CREATE INDEX "cve_entries_published_at_idx" ON "cve_entries" USING btree ("published_at");
--> statement-breakpoint
CREATE INDEX "cve_entries_is_critical_idx" ON "cve_entries" USING btree ("is_critical");
--> statement-breakpoint
CREATE TABLE "cve_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cve_id" uuid NOT NULL,
	"dependency_id" uuid NOT NULL,
	"paperclip_issue_id" text,
	"alert_status" text DEFAULT 'pending' NOT NULL,
	"alerted_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cve_alerts" ADD CONSTRAINT "cve_alerts_cve_id_cve_entries_id_fk" FOREIGN KEY ("cve_id") REFERENCES "public"."cve_entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "cve_alerts" ADD CONSTRAINT "cve_alerts_dependency_id_tracked_dependencies_id_fk" FOREIGN KEY ("dependency_id") REFERENCES "public"."tracked_dependencies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cve_alerts_cve_id_idx" ON "cve_alerts" USING btree ("cve_id");
--> statement-breakpoint
CREATE INDEX "cve_alerts_dependency_id_idx" ON "cve_alerts" USING btree ("dependency_id");
--> statement-breakpoint
CREATE INDEX "cve_alerts_alert_status_idx" ON "cve_alerts" USING btree ("alert_status");
--> statement-breakpoint
CREATE INDEX "cve_alerts_paperclip_issue_id_idx" ON "cve_alerts" USING btree ("paperclip_issue_id");