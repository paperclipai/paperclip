-- Phase 5.2f: link room action messages to approval records
--
-- When a room action message is created with `requires_approval = true`,
-- the service-layer creates a companion `approvals` row (type =
-- "action_execution") and stores the FK here. The UI uses this to
-- gate the "Mark executed" button until the approval reaches
-- `approved` state.
--
-- `ON DELETE SET NULL` — deleting an approval (which we don't expose
-- today but reserve for cascade logic) should NOT delete the message;
-- leave it with approvalId=NULL and let the UI render "(approval gone)".

ALTER TABLE room_messages
  ADD COLUMN approval_id UUID REFERENCES approvals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS room_messages_approval_idx
  ON room_messages (approval_id);
