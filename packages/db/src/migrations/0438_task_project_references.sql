CREATE TABLE "issue_project_references" (
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	CONSTRAINT "issue_project_references_issue_id_source_kind_source_id_project_id_pk" PRIMARY KEY("issue_id","source_kind","source_id","project_id"),
	CONSTRAINT "issue_project_references_source_kind_check" CHECK ("issue_project_references"."source_kind" in ('issue', 'comment', 'document', 'annotation', 'interaction', 'case', 'accepted_plan'))
);
--> statement-breakpoint
CREATE INDEX "issue_project_references_company_project_idx" ON "issue_project_references" USING btree ("company_id","project_id");--> statement-breakpoint
-- Task project references (C1b). Triggers rewrite the candidate rows of each
-- changed source in the statement of its write, whatever performs it. They take
-- no lock beyond those rows (the writer already holds the source row), so they
-- add no lock-order edge. Candidates are a superset of the structured parser's
-- result; the context owner re-parses the sources for truth.
CREATE OR REPLACE FUNCTION paperclip_project_reference_candidates(body text) RETURNS uuid[]
LANGUAGE sql IMMUTABLE AS $$
	SELECT coalesce(array_agg(DISTINCT lower(id.m[1])::uuid), '{}')
	FROM regexp_matches(coalesce(body, ''), 'project://[^)\s]+', 'gi') AS href(m)
	CROSS JOIN LATERAL regexp_matches(href.m[1], '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'gi') AS id(m)
$$;--> statement-breakpoint
-- removed: [{issue_id, source_id}]; added: [{company_id, issue_id, source_id, body}].
CREATE OR REPLACE FUNCTION paperclip_sync_project_reference_sources(kind text, removed jsonb, added jsonb) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM issue_project_references p USING jsonb_array_elements(removed) r
	WHERE p.issue_id = (r->>'issue_id')::uuid AND p.source_kind = kind AND p.source_id = (r->>'source_id')::uuid;
	INSERT INTO issue_project_references (company_id, issue_id, source_kind, source_id, project_id)
	SELECT (a->>'company_id')::uuid, (a->>'issue_id')::uuid, kind, (a->>'source_id')::uuid, candidate
	FROM jsonb_array_elements(added) a CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(a->>'body')) candidate
	ON CONFLICT DO NOTHING;
END;
$$;--> statement-breakpoint
-- The task's own fields: primary project, title and description.
CREATE OR REPLACE FUNCTION paperclip_issue_project_references() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'UPDATE' AND (NEW.title, NEW.description, NEW.project_id) IS NOT DISTINCT FROM (OLD.title, OLD.description, OLD.project_id) THEN
		RETURN NULL;
	END IF;
	DELETE FROM issue_project_references WHERE issue_id = NEW.id AND source_kind = 'issue';
	INSERT INTO issue_project_references (company_id, issue_id, source_kind, source_id, project_id)
	SELECT NEW.company_id, NEW.id, 'issue', NEW.id, candidate FROM unnest(array_remove(
		paperclip_project_reference_candidates(NEW.title || ' ' || coalesce(NEW.description, '')) || NEW.project_id, NULL)) candidate
	ON CONFLICT DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paperclip_issue_project_references_trigger
AFTER INSERT OR UPDATE OF "title", "description", "project_id" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_issue_project_references();--> statement-breakpoint
-- No foreign key (its check would lock the task inside source writes): task deletion removes the rows.
CREATE OR REPLACE FUNCTION paperclip_deleted_issue_project_references() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM issue_project_references p USING old_rows o WHERE p.issue_id = o.id;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paperclip_deleted_issue_project_references AFTER DELETE ON "issues"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_deleted_issue_project_references();--> statement-breakpoint
-- Issue documents of every key, by latest body. A document's source ID is its document ID.
CREATE OR REPLACE FUNCTION paperclip_issue_document_project_references() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		PERFORM paperclip_sync_project_reference_sources('document', '[]', coalesce((SELECT jsonb_agg(jsonb_build_object(
			'company_id', n.company_id, 'issue_id', n.issue_id, 'source_id', n.document_id, 'body', d.latest_body))
			FROM new_rows n JOIN documents d ON d.id = n.document_id), '[]'));
	ELSIF TG_OP = 'DELETE' THEN
		PERFORM paperclip_sync_project_reference_sources('document', coalesce((SELECT jsonb_agg(jsonb_build_object(
			'issue_id', o.issue_id, 'source_id', o.document_id)) FROM old_rows o), '[]'), '[]');
	ELSE
		PERFORM paperclip_sync_project_reference_sources('document',
			coalesce((SELECT jsonb_agg(jsonb_build_object('issue_id', o.issue_id, 'source_id', o.document_id)) FROM old_rows o JOIN new_rows n ON n.id = o.id
				WHERE (n.issue_id, n.document_id) IS DISTINCT FROM (o.issue_id, o.document_id)), '[]'),
			coalesce((SELECT jsonb_agg(jsonb_build_object('company_id', n.company_id, 'issue_id', n.issue_id, 'source_id', n.document_id, 'body', d.latest_body))
				FROM old_rows o JOIN new_rows n ON n.id = o.id JOIN documents d ON d.id = n.document_id
				WHERE (n.issue_id, n.document_id) IS DISTINCT FROM (o.issue_id, o.document_id)), '[]'));
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paperclip_issue_document_project_references_insert AFTER INSERT ON "issue_documents"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_issue_document_project_references();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_document_project_references_update AFTER UPDATE ON "issue_documents"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_issue_document_project_references();--> statement-breakpoint
CREATE TRIGGER paperclip_issue_document_project_references_delete AFTER DELETE ON "issue_documents"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_issue_document_project_references();--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_document_body_project_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE changed jsonb;
BEGIN
	SELECT jsonb_agg(jsonb_build_object('company_id', l.company_id, 'issue_id', l.issue_id, 'source_id', n.id, 'body', n.latest_body))
	INTO changed FROM old_rows o JOIN new_rows n ON n.id = o.id JOIN issue_documents l ON l.document_id = n.id
	WHERE n.latest_body IS DISTINCT FROM o.latest_body;
	IF changed IS NOT NULL THEN PERFORM paperclip_sync_project_reference_sources('document', changed, changed); END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paperclip_document_body_project_references AFTER UPDATE ON "documents"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_document_body_project_references();--> statement-breakpoint
-- Comments, plan-review annotation comments, thread interactions, workflow
-- case facts and accepted plan revisions. Arguments: source kind, task column,
-- source ID expression, content expression (JSON is searched as text), extra
-- FROM/WHERE clause. Unchanged sources are left untouched.
CREATE OR REPLACE FUNCTION paperclip_row_project_references() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE sources text := 'SELECT jsonb_build_object(''company_id'', t.company_id, ''issue_id'', t.%1$I, ''source_id'', %3$s, ''body'', %4$s) s'
		|| ' FROM %2$I t ' || coalesce(TG_ARGV[4], '') || ' AND t.%1$I IS NOT NULL';
	removed jsonb; added jsonb;
BEGIN
	EXECUTE 'WITH o AS (' || CASE WHEN TG_OP = 'INSERT' THEN 'SELECT NULL::jsonb s WHERE false' ELSE format(sources, TG_ARGV[1], 'old_rows', TG_ARGV[2], TG_ARGV[3]) END || '),'
		|| ' n AS (' || CASE WHEN TG_OP = 'DELETE' THEN 'SELECT NULL::jsonb s WHERE false' ELSE format(sources, TG_ARGV[1], 'new_rows', TG_ARGV[2], TG_ARGV[3]) END || ')'
		|| ' SELECT (SELECT coalesce(jsonb_agg(s), ''[]'') FROM (SELECT s FROM o EXCEPT SELECT s FROM n) r),'
		|| ' (SELECT coalesce(jsonb_agg(s), ''[]'') FROM (SELECT s FROM n EXCEPT SELECT s FROM o) a)' INTO removed, added;
	IF removed <> '[]' OR added <> '[]' THEN PERFORM paperclip_sync_project_reference_sources(TG_ARGV[0], removed, added); END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER paperclip_comment_project_references_insert AFTER INSERT ON "issue_comments"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('comment', 'issue_id', 't.id', 'CASE WHEN t.deleted_at IS NULL THEN t.body END', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_comment_project_references_update AFTER UPDATE ON "issue_comments"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('comment', 'issue_id', 't.id', 'CASE WHEN t.deleted_at IS NULL THEN t.body END', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_comment_project_references_delete AFTER DELETE ON "issue_comments"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('comment', 'issue_id', 't.id', 'CASE WHEN t.deleted_at IS NULL THEN t.body END', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_annotation_project_references_insert AFTER INSERT ON "document_annotation_comments"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('annotation', 'issue_id', 't.id', 't.body', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_annotation_project_references_update AFTER UPDATE ON "document_annotation_comments"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('annotation', 'issue_id', 't.id', 't.body', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_annotation_project_references_delete AFTER DELETE ON "document_annotation_comments"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('annotation', 'issue_id', 't.id', 't.body', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_interaction_project_references_insert AFTER INSERT ON "issue_thread_interactions"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('interaction', 'issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.payload::text, t.result::text)', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_interaction_project_references_update AFTER UPDATE ON "issue_thread_interactions"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('interaction', 'issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.payload::text, t.result::text)', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_interaction_project_references_delete AFTER DELETE ON "issue_thread_interactions"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('interaction', 'issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.payload::text, t.result::text)', 'WHERE true');--> statement-breakpoint
-- Every accepted plan confirmation's immutable target revision, for reverse lookup of queued historical plans.
CREATE TRIGGER paperclip_accepted_plan_project_references_insert AFTER INSERT ON "issue_thread_interactions"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('accepted_plan', 'issue_id', 't.id', 'r.body', 'JOIN document_revisions r ON r.id = CASE WHEN t.payload #>> ''{target,revisionId}'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' THEN (t.payload #>> ''{target,revisionId}'')::uuid END WHERE t.kind = ''request_confirmation'' AND t.status = ''accepted'' AND t.payload #>> ''{target,key}'' = ''plan''');--> statement-breakpoint
CREATE TRIGGER paperclip_accepted_plan_project_references_update AFTER UPDATE ON "issue_thread_interactions"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('accepted_plan', 'issue_id', 't.id', 'r.body', 'JOIN document_revisions r ON r.id = CASE WHEN t.payload #>> ''{target,revisionId}'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' THEN (t.payload #>> ''{target,revisionId}'')::uuid END WHERE t.kind = ''request_confirmation'' AND t.status = ''accepted'' AND t.payload #>> ''{target,key}'' = ''plan''');--> statement-breakpoint
CREATE TRIGGER paperclip_accepted_plan_project_references_delete AFTER DELETE ON "issue_thread_interactions"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('accepted_plan', 'issue_id', 't.id', 'r.body', 'JOIN document_revisions r ON r.id = CASE WHEN t.payload #>> ''{target,revisionId}'' ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' THEN (t.payload #>> ''{target,revisionId}'')::uuid END WHERE t.kind = ''request_confirmation'' AND t.status = ''accepted'' AND t.payload #>> ''{target,key}'' = ''plan''');--> statement-breakpoint
CREATE TRIGGER paperclip_case_project_references_insert AFTER INSERT ON "cases"
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('case', 'work_issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.fields::text)', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_case_project_references_update AFTER UPDATE ON "cases"
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('case', 'work_issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.fields::text)', 'WHERE true');--> statement-breakpoint
CREATE TRIGGER paperclip_case_project_references_delete AFTER DELETE ON "cases"
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION paperclip_row_project_references('case', 'work_issue_id', 't.id', 'concat_ws('' '', t.title, t.summary, t.fields::text)', 'WHERE true');
--> statement-breakpoint
-- Backfill: the projection is complete on upgrade. Only text containing a project link is scanned.
INSERT INTO issue_project_references (company_id, issue_id, source_kind, source_id, project_id)
SELECT company_id, id, 'issue', id, candidate FROM issues CROSS JOIN LATERAL unnest(array_remove(
	paperclip_project_reference_candidates(CASE WHEN title || coalesce(description, '') ILIKE '%project://%' THEN title || ' ' || coalesce(description, '') END)
	|| project_id, NULL)) candidate
UNION SELECT company_id, issue_id, 'comment', id, candidate FROM issue_comments
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(body)) candidate WHERE deleted_at IS NULL AND body ILIKE '%project://%'
UNION SELECT l.company_id, l.issue_id, 'document', d.id, candidate FROM issue_documents l JOIN documents d ON d.id = l.document_id
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(d.latest_body)) candidate WHERE d.latest_body ILIKE '%project://%'
UNION SELECT company_id, issue_id, 'annotation', id, candidate FROM document_annotation_comments
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(body)) candidate WHERE issue_id IS NOT NULL AND body ILIKE '%project://%'
UNION SELECT company_id, issue_id, 'interaction', id, candidate FROM issue_thread_interactions
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(concat_ws(' ', title, summary, payload::text, result::text))) candidate
UNION SELECT t.company_id, t.issue_id, 'accepted_plan', t.id, candidate FROM issue_thread_interactions t
	JOIN document_revisions r ON r.id = CASE WHEN t.payload #>> '{target,revisionId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (t.payload #>> '{target,revisionId}')::uuid END
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(r.body)) candidate
	WHERE t.kind = 'request_confirmation' AND t.status = 'accepted' AND t.payload #>> '{target,key}' = 'plan'
UNION SELECT company_id, work_issue_id, 'case', id, candidate FROM cases
	CROSS JOIN LATERAL unnest(paperclip_project_reference_candidates(concat_ws(' ', title, summary, fields::text))) candidate WHERE work_issue_id IS NOT NULL;
