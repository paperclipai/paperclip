CREATE TABLE "execution_workspace_restore_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"source_issue_id" uuid,
	"generation" integer NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"activated_at" timestamp with time zone,
	"tree_closed_at" timestamp with time zone,
	"delete_after" timestamp with time zone,
	"review_generation" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "execution_workspace_restore_points_object_key_uniq" ON "execution_workspace_restore_points" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_workspace_restore_points_live_generation_uniq" ON "execution_workspace_restore_points" USING btree ("execution_workspace_id","generation") WHERE "execution_workspace_restore_points"."status" <> 'deleted';--> statement-breakpoint
CREATE INDEX "execution_workspace_restore_points_status_delete_after_idx" ON "execution_workspace_restore_points" USING btree ("status","delete_after");--> statement-breakpoint
CREATE INDEX "execution_workspace_restore_points_company_idx" ON "execution_workspace_restore_points" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "execution_workspace_restore_points_source_issue_idx" ON "execution_workspace_restore_points" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "execution_workspace_restore_points_active_source_idx" ON "execution_workspace_restore_points" USING btree ("source_issue_id") WHERE "execution_workspace_restore_points"."status" = 'active';--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_restore_point_tree_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE starts uuid[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    starts := ARRAY[OLD.parent_id];
  ELSE
    starts := ARRAY[NEW.id, OLD.parent_id, NEW.parent_id];
  END IF;
  UPDATE execution_workspace_restore_points
  SET delete_after = CASE WHEN delete_after IS NULL OR delete_after > now() THEN now() ELSE delete_after END,
    review_generation = review_generation + 1,
    updated_at = now()
  WHERE status = 'active'
    AND source_issue_id IN (
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT i.id, i.parent_id, 0 FROM issues i WHERE i.id = ANY(starts)
        UNION
        SELECT parent.id, parent.parent_id, ancestors.depth + 1 FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id WHERE ancestors.depth < 64
      )
      SELECT id FROM ancestors
    );
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paperclip_restore_point_tree_update AFTER UPDATE OF status, parent_id ON issues
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status OR OLD.parent_id IS DISTINCT FROM NEW.parent_id)
EXECUTE FUNCTION paperclip_restore_point_tree_changed();
--> statement-breakpoint
CREATE TRIGGER paperclip_restore_point_tree_delete AFTER DELETE ON issues
FOR EACH ROW EXECUTE FUNCTION paperclip_restore_point_tree_changed();
