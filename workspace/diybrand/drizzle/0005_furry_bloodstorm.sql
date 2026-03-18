ALTER TABLE "brand_logos" ALTER COLUMN "image_data" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "brand_logos" ADD COLUMN "image_path" varchar(500);--> statement-breakpoint
ALTER TABLE "brand_logos" ADD COLUMN "mime_type" varchar(100);--> statement-breakpoint
CREATE INDEX "brand_logos_questionnaire_selected_idx" ON "brand_logos" USING btree ("questionnaire_id","selected");--> statement-breakpoint
CREATE INDEX "brand_palette_questionnaire_selected_idx" ON "brand_palette" USING btree ("questionnaire_id","selected");--> statement-breakpoint
CREATE INDEX "brand_typography_questionnaire_selected_idx" ON "brand_typography" USING btree ("questionnaire_id","selected");--> statement-breakpoint
CREATE INDEX "orders_questionnaire_idx" ON "orders" USING btree ("questionnaire_id");