-- Runs through the Paperclip migration executor outside a file-wide transaction.
-- Each idempotent keyset batch commits before advancing; history is recorded last.
-- Bind historical inline draft images to their first owned task. Unbound drafts
-- remain uploader-only. Attachment deletion never makes the draft company-open.
DO $$
DECLARE cursor_id uuid := '00000000-0000-0000-0000-000000000000'; next_id uuid;
BEGIN
  LOOP
    SELECT max(id::text)::uuid INTO next_id FROM (
      SELECT id FROM assets WHERE id > cursor_id AND object_key LIKE company_id::text || '/assets/issues/drafts/%'
      ORDER BY id LIMIT 1000
    ) batch;
    EXIT WHEN next_id IS NULL;
    INSERT INTO issue_attachments (company_id, issue_id, asset_id)
    SELECT a.company_id, first_issue.id, a.id FROM assets a
    CROSS JOIN LATERAL (
      SELECT i.id FROM issues i WHERE i.company_id = a.company_id
        AND (i.created_by_user_id = a.created_by_user_id OR i.responsible_user_id = a.created_by_user_id
          OR i.created_by_agent_id = a.created_by_agent_id)
        AND strpos(coalesce(i.description, ''), '/api/assets/' || a.id::text || '/content') > 0
      ORDER BY i.created_at, i.id LIMIT 1
    ) first_issue
    WHERE a.id > cursor_id AND a.id <= next_id AND a.object_key LIKE a.company_id::text || '/assets/issues/drafts/%'
    ON CONFLICT DO NOTHING;
    cursor_id := next_id;
    COMMIT;
  END LOOP;
END $$;
