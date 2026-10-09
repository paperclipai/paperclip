CREATE TABLE IF NOT EXISTS "announcement_dismissals" (
	"user_id" text NOT NULL,
	"announcement_id" text NOT NULL,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_dismissals_user_id_announcement_id_pk" PRIMARY KEY("user_id","announcement_id")
);
