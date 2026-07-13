DO $$ BEGIN
 ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_update_cadence_check" CHECK ("update_cadence" IN ('weekly', 'biweekly', 'monthly'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_status_check" CHECK ("status" IN ('active', 'stale', 'deprecated'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_document_class_check" CHECK ("document_class" IN ('strategy', 'implementation', 'runbook', 'incident', 'experimentation', 'architecture', 'governance'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "seo_doc_registry_entries" ADD CONSTRAINT "seo_doc_registry_entries_criticality_check" CHECK ("criticality" IN ('normal', 'critical'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
