-- Migration 0082: terminology comments
--
-- The 'issues' table is presented to users as "Missions" in the UI.
-- We keep the DB name stable to avoid a 200+ file rename. This comment
-- ensures future engineers browsing pgAdmin/psql see the mapping.
--
-- Full mapping: docs/TERMINOLOGY.md

COMMENT ON TABLE issues IS 'User-facing name in UI: "Mission". See docs/TERMINOLOGY.md.';
