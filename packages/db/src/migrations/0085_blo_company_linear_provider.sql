-- Phase 3 Task 3.2 of the Linear ↔ Paperclip ID Unification plan.
-- See onprem-k8s commit 9979d0d / .planning/linear-id-unification.md.
--
-- Activates the Linear-issued identifier path for the BLO company. After
-- 0084's backfill renamed BLO's 2377 paperclip-only "BLO-N" rows to
-- "PCL-N", this flip routes new BLO issue creates through allocateFromLinear
-- (added in #49 + OAuth fallback in #53) so the BLO-N namespace becomes
-- Linear-owned end to end.
--
-- BLO production company id is hardcoded. The plan suggested matching by
-- `companies.slug`, but that column doesn't exist — `companies` has
-- (id, name, issue_prefix, …). The id below is the BLO row in the
-- paperclip-pg cluster on the user's k8s instance; on every other paperclip
-- deployment this UPDATE is a no-op (no row matches), which is the
-- intended cross-environment safety. Other companies that want to opt in
-- should land their own follow-up migration with their own id, OR (better
-- once the admin UI ships) flip via a settings toggle.
--
-- The `<> 'linear'` predicate makes this idempotent — re-runs on the BLO
-- instance leave the row alone after the first apply.
UPDATE "companies"
   SET "identifier_provider" = 'linear',
       "updated_at" = now()
 WHERE "id" = 'aaced805-3491-4ee5-9b14-cdf70cb81d47'
   AND "identifier_provider" <> 'linear';
