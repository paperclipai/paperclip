ALTER TABLE "agents" ADD COLUMN "is_router" boolean DEFAULT false NOT NULL;
UPDATE "agents" SET "is_router" = true WHERE "id" = '369da996-0a84-426f-ace4-d2d8250dd677';
