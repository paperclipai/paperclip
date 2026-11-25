-- paperclip:migration-compat requires_staging: pause old A&R writers while assigning owners and replacing the company-wide title index.
ALTER TABLE responsibility_areas ADD COLUMN owner_user_id text;
--> statement-breakpoint
DROP INDEX responsibility_areas_company_title_uq;
--> statement-breakpoint
-- Keep the original ID for one owner and fork it for each additional owner.
-- Empty areas without attributable activity or history stay hidden under a NULL owner.
CREATE TEMP TABLE dashboard_area_owners ON COMMIT DROP AS
WITH evidence AS (
  SELECT company_id, area_id AS old_id, owner_user_id FROM responsibilities WHERE area_id IS NOT NULL
  UNION
  SELECT a.company_id, a.id, CASE WHEN l.actor_type = 'user' THEN l.actor_id
    ELSE l.details->>'onBehalfOfUserId' END
  FROM responsibility_areas a JOIN activity_log l ON l.company_id = a.company_id
    AND l.entity_type = 'responsibility_area' AND l.entity_id = a.id::text AND l.action = 'responsibility_area.created'
  UNION
  SELECT a.company_id, a.id, v.owner_user_id FROM responsibility_dashboard_versions v
  CROSS JOIN LATERAL jsonb_array_elements(v.snapshot->'areas') e
  JOIN responsibility_areas a ON a.id::text = e->>'id' AND a.company_id = v.company_id
), ranked AS (
  SELECT *, row_number() OVER (PARTITION BY company_id, old_id ORDER BY owner_user_id) AS position
  FROM evidence WHERE owner_user_id IS NOT NULL
)
SELECT company_id, old_id, owner_user_id, CASE WHEN position = 1 THEN old_id ELSE gen_random_uuid() END AS new_id FROM ranked;
--> statement-breakpoint
CREATE UNIQUE INDEX ON dashboard_area_owners(company_id, owner_user_id, old_id);
--> statement-breakpoint
UPDATE responsibility_areas a SET owner_user_id = m.owner_user_id FROM dashboard_area_owners m
WHERE a.id = m.old_id AND m.old_id = m.new_id;
--> statement-breakpoint
INSERT INTO responsibility_areas (id, company_id, owner_user_id, title, description, status, source, proposed_by_agent_id, sort_order, created_at, updated_at)
SELECT m.new_id, a.company_id, m.owner_user_id, a.title, a.description, a.status, a.source, a.proposed_by_agent_id, a.sort_order, a.created_at, a.updated_at
FROM dashboard_area_owners m JOIN responsibility_areas a ON a.id = m.old_id WHERE m.old_id <> m.new_id;
--> statement-breakpoint
UPDATE responsibilities r SET area_id = m.new_id FROM dashboard_area_owners m
WHERE r.company_id = m.company_id AND r.owner_user_id = m.owner_user_id AND r.area_id = m.old_id AND m.new_id <> m.old_id;
--> statement-breakpoint
-- Only rewrite typed ID fields. Titles, evidence and other free text remain verbatim.
WITH mappings AS (
  SELECT company_id, owner_user_id, jsonb_object_agg(old_id::text, new_id::text) AS ids
  FROM dashboard_area_owners WHERE new_id <> old_id GROUP BY company_id, owner_user_id
)
UPDATE responsibility_dashboard_versions v SET snapshot = v.snapshot || jsonb_build_object(
  'areas', COALESCE((SELECT jsonb_agg(CASE WHEN m.ids ? (e->>'id') THEN jsonb_set(e, '{id}', m.ids->(e->>'id')) ELSE e END ORDER BY n)
    FROM jsonb_array_elements(v.snapshot->'areas') WITH ORDINALITY AS a(e,n)), '[]'::jsonb),
  'responsibilities', COALESCE((SELECT jsonb_agg(CASE WHEN m.ids ? (e->>'areaId') THEN jsonb_set(e,'{areaId}',m.ids->(e->>'areaId')) ELSE e END ORDER BY n)
    FROM jsonb_array_elements(v.snapshot->'responsibilities') WITH ORDINALITY AS r(e,n)), '[]'::jsonb),
  'createdAreaIds', COALESCE((SELECT jsonb_agg(COALESCE(m.ids->e,to_jsonb(e)) ORDER BY n)
    FROM jsonb_array_elements_text(v.snapshot->'createdAreaIds') WITH ORDINALITY AS c(e,n)), '[]'::jsonb)
), snapshot_hash = 'remapped'
FROM mappings m WHERE v.company_id = m.company_id AND v.owner_user_id = m.owner_user_id;
--> statement-breakpoint
-- Keep outstanding change cards usable when their owner's existing area was split.
WITH mappings AS (
  SELECT company_id, owner_user_id, jsonb_object_agg(old_id::text, new_id::text) AS ids
  FROM dashboard_area_owners WHERE new_id <> old_id GROUP BY company_id, owner_user_id
)
UPDATE issue_thread_interactions t SET payload = jsonb_set(t.payload, '{changes}', (
  SELECT jsonb_agg(e || CASE WHEN m.ids ? (e->>'groupAreaId') THEN jsonb_build_object('groupAreaId',m.ids->(e->>'groupAreaId')) ELSE '{}'::jsonb END
    || CASE WHEN m.ids ? (e->>'fromAreaId') THEN jsonb_build_object('fromAreaId',m.ids->(e->>'fromAreaId')) ELSE '{}'::jsonb END ORDER BY n)
  FROM jsonb_array_elements(t.payload->'changes') WITH ORDINALITY AS c(e,n)
))
FROM mappings m WHERE t.company_id = m.company_id AND t.payload->>'ownerUserId' = m.owner_user_id
  AND t.kind = 'propose_dashboard_changes' AND t.status = 'pending' AND jsonb_array_length(t.payload->'changes') > 0;
--> statement-breakpoint
CREATE UNIQUE INDEX responsibility_areas_identity_uq ON responsibility_areas(company_id,owner_user_id,id);
--> statement-breakpoint
CREATE UNIQUE INDEX responsibility_areas_owner_title_uq ON responsibility_areas(company_id,owner_user_id,lower(title)) WHERE status <> 'archived';
--> statement-breakpoint
ALTER TABLE responsibilities ADD CONSTRAINT responsibilities_owned_area_fk FOREIGN KEY (company_id,owner_user_id,area_id)
REFERENCES responsibility_areas(company_id,owner_user_id,id);
--> statement-breakpoint
UPDATE issues SET visibility = 'private', privacy_root_issue_id = id, responsible_user_id = origin_id
WHERE origin_kind = 'responsibility_dashboard' AND origin_id IS NOT NULL;
--> statement-breakpoint
UPDATE issues i SET visibility = 'private', privacy_root_issue_id = i.id, responsible_user_id = r.owner_user_id
FROM responsibilities r WHERE i.company_id = r.company_id AND i.origin_id = r.id::text AND i.origin_kind IN ('responsibility_bar','responsibility_status_update');
--> statement-breakpoint
UPDATE issues SET visibility = 'private', privacy_root_issue_id = id, responsible_user_id = created_by_user_id
WHERE origin_kind = 'automation_conversation' AND created_by_user_id IS NOT NULL;
