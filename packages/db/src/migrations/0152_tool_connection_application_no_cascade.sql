-- Harden DELETE /tool-applications/:applicationId against concurrent connection creation.
-- The tool_connections.application_id FK was ON DELETE CASCADE, so a connection created in
-- the gap between the endpoint's "any connections?" pre-check and its DELETE could be silently
-- removed by the cascade instead of forcing the promised 409. Switch the FK to ON DELETE
-- NO ACTION so the database fails closed: an application with connections can never be deleted,
-- and a concurrently-inserted connection (which holds a FOR KEY SHARE lock on the parent row)
-- forces the delete to raise a foreign_key_violation rather than cascade.
--
-- NO ACTION (end-of-statement check) rather than RESTRICT (immediate check) is deliberate so a
-- company delete still cascades cleanly: companies -> tool_applications and companies ->
-- tool_connections both fire within the one DELETE statement, and the connections are already
-- gone by the time this constraint is verified.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_application_id_tool_applications_id_fk";
  END IF;
  ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE no action ON UPDATE no action;
END $$;
