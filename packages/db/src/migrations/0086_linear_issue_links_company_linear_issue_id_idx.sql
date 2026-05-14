-- Adds the third unique index on linear_issue_links to back the inbound
-- Linear-webhook hot path. issueService.getByLinearIssueId(companyId,
-- linearIssueId) was added in PR #60 to dedupe webhook-driven mirror
-- imports against host-allocator-tx mirrors, and is queried for every
-- create webhook the Linear plugin receives for cutover companies.
--
-- Without this index that query is a Seq Scan over linear_issue_links;
-- invisible at the current scale but the schema is sized for tens of
-- thousands of rows per company. Equally important: the index serializes
-- concurrent inserts at the DB layer, closing the multi-replica race
-- that the per-process inFlightCreates Set in worker.ts cannot. Today
-- paperclip is a single-replica StatefulSet so the race is theoretical,
-- but this is one of the cheaper invariants to enforce while it is.
--
-- Linear's opaque issue id (UUID) is the natural webhook dedup key;
-- linear_identifier ("BLO-12345") can in principle be reissued, the
-- opaque id cannot.
CREATE UNIQUE INDEX "linear_issue_links_company_linear_issue_id_idx"
  ON "linear_issue_links" ("company_id", "linear_issue_id");
