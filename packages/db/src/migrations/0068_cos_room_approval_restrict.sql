-- Phase 5.2f hardening: change `room_messages.approval_id` FK from
-- ON DELETE SET NULL to ON DELETE RESTRICT.
--
-- Reviewer P1 finding F: the original migration used SET NULL, which
-- silently un-gated an action message if anyone deleted its linked
-- approvals row. The gate in `updateActionStatus` is
--   `if (msg.approvalId) { check approval; }`
-- so a NULL approvalId = no gate → execute allowed. This is a latent
-- bypass that would fire the first time someone added an admin
-- "clean up stale approvals" worker or cascade.
--
-- There is no current code path that deletes a single `approvals` row,
-- so RESTRICT costs nothing today and future-proofs the invariant.

ALTER TABLE room_messages
  DROP CONSTRAINT IF EXISTS room_messages_approval_id_approvals_id_fk;

ALTER TABLE room_messages
  ADD CONSTRAINT room_messages_approval_id_approvals_id_fk
  FOREIGN KEY (approval_id) REFERENCES approvals(id) ON DELETE RESTRICT;
