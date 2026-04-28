CREATE OR REPLACE FUNCTION "public"."rt2_v33_validate_contribution_ratio"("contributor_ids" text[], "contribution_ratio" jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  contributor_count integer;
  distinct_contributor_count integer;
  ratio_key_count integer;
  ratio_sum numeric := 0;
  ratio_entry record;
BEGIN
  IF contributor_ids IS NULL THEN
    RETURN false;
  END IF;

  contributor_count := cardinality(contributor_ids);
  IF contributor_count < 2 OR contributor_count > 12 THEN
    RETURN false;
  END IF;

  SELECT count(DISTINCT contributor_id)
  INTO distinct_contributor_count
  FROM unnest(contributor_ids) AS contributor_id;
  IF distinct_contributor_count <> contributor_count THEN
    RETURN false;
  END IF;

  IF contribution_ratio IS NULL OR jsonb_typeof(contribution_ratio) <> 'object' THEN
    RETURN false;
  END IF;

  SELECT count(*)
  INTO ratio_key_count
  FROM jsonb_object_keys(contribution_ratio);
  IF ratio_key_count <> contributor_count THEN
    RETURN false;
  END IF;

  IF NOT (contribution_ratio ?& contributor_ids) THEN
    RETURN false;
  END IF;

  FOR ratio_entry IN SELECT key, value FROM jsonb_each_text(contribution_ratio)
  LOOP
    IF ratio_entry.value !~ '^[0-9]+(\.[0-9]+)?$' THEN
      RETURN false;
    END IF;

    IF ratio_entry.value::numeric <= 0 THEN
      RETURN false;
    END IF;

    ratio_sum := ratio_sum + ratio_entry.value::numeric;
  END LOOP;

  RETURN abs(ratio_sum - 1) <= 0.01 OR abs(ratio_sum - 100) <= 0.5;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."rt2_v33_validate_manager_adjustment"("contributor_ids" text[], "manager_adjustment" jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  adjustment_entry record;
BEGIN
  IF contributor_ids IS NULL OR cardinality(contributor_ids) < 2 THEN
    RETURN false;
  END IF;

  IF manager_adjustment IS NULL THEN
    RETURN true;
  END IF;

  IF jsonb_typeof(manager_adjustment) <> 'object' THEN
    RETURN false;
  END IF;

  FOR adjustment_entry IN SELECT key, value FROM jsonb_each_text(manager_adjustment)
  LOOP
    IF NOT (adjustment_entry.key = ANY(contributor_ids)) THEN
      RETURN false;
    END IF;

    IF adjustment_entry.value !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
      RETURN false;
    END IF;

    IF adjustment_entry.value::numeric < -20 OR adjustment_entry.value::numeric > 20 THEN
      RETURN false;
    END IF;
  END LOOP;

  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE "rt2_v33_collaboration_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"work_product_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"contributor_ids" text[] NOT NULL,
	"contribution_ratio" jsonb NOT NULL,
	"manager_adjustment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"multiplier" numeric(4, 2) NOT NULL,
	"audit_flag" boolean DEFAULT false NOT NULL,
	"evidence_tag" text DEFAULT 'EXTRACTED' NOT NULL,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_collab_alloc_idempotency_key_len_check" CHECK (char_length("rt2_v33_collaboration_allocations"."idempotency_key") between 8 and 120),
	CONSTRAINT "rt2_v33_collab_alloc_contributor_count_check" CHECK (cardinality("rt2_v33_collaboration_allocations"."contributor_ids") between 2 and 12),
	CONSTRAINT "rt2_v33_collab_alloc_multiplier_check" CHECK ("rt2_v33_collaboration_allocations"."multiplier" >= 1 and "rt2_v33_collaboration_allocations"."multiplier" <= 5),
	CONSTRAINT "rt2_v33_collab_alloc_evidence_tag_check" CHECK ("rt2_v33_collaboration_allocations"."evidence_tag" in ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
	CONSTRAINT "rt2_v33_collab_alloc_ratio_shape_check" CHECK (rt2_v33_validate_contribution_ratio("contributor_ids", "contribution_ratio")),
	CONSTRAINT "rt2_v33_collab_alloc_manager_adjustment_shape_check" CHECK (rt2_v33_validate_manager_adjustment("contributor_ids", "manager_adjustment"))
);
--> statement-breakpoint
CREATE TABLE "rt2_v33_reputation_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"activity_type" text NOT NULL,
	"reputation_delta" integer NOT NULL,
	"source_ref" uuid,
	"ai_confidence" numeric(4, 3),
	"audit_flag" boolean DEFAULT false NOT NULL,
	"verified_by" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_reputation_ledger_activity_type_check" CHECK ("rt2_v33_reputation_ledger"."activity_type" in (
    'mentoring',
    'citation',
    'qa_answer',
    'direction',
    'god_author',
    'surprising_discovery',
    'lint_contribution',
    'reciprocal_exchange_detected'
  )),
	CONSTRAINT "rt2_v33_reputation_ledger_ai_confidence_check" CHECK ("rt2_v33_reputation_ledger"."ai_confidence" is null or ("rt2_v33_reputation_ledger"."ai_confidence" >= 0 and "rt2_v33_reputation_ledger"."ai_confidence" <= 1))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_collaboration_allocations" ADD CONSTRAINT "rt2_v33_collaboration_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_collaboration_allocations" ADD CONSTRAINT "rt2_v33_collaboration_allocations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_collaboration_allocations" ADD CONSTRAINT "rt2_v33_collaboration_allocations_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_collaboration_allocations" ADD CONSTRAINT "rt2_v33_collaboration_allocations_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_reputation_ledger" ADD CONSTRAINT "rt2_v33_reputation_ledger_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_reputation_ledger" ADD CONSTRAINT "rt2_v33_reputation_ledger_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rt2_v33_reputation_ledger" ADD CONSTRAINT "rt2_v33_reputation_ledger_verified_by_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "rt2_v33_collab_alloc_company_task_wp_idempotency_uq" ON "rt2_v33_collaboration_allocations" USING btree ("company_id","task_issue_id","work_product_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX "rt2_v33_collab_alloc_company_project_task_created_idx" ON "rt2_v33_collaboration_allocations" USING btree ("company_id","project_id","task_issue_id","created_at");
--> statement-breakpoint
CREATE INDEX "rt2_v33_reputation_ledger_company_user_created_idx" ON "rt2_v33_reputation_ledger" USING btree ("company_id","user_id","created_at");
--> statement-breakpoint
CREATE INDEX "rt2_v33_reputation_ledger_company_activity_created_idx" ON "rt2_v33_reputation_ledger" USING btree ("company_id","activity_type","created_at");
