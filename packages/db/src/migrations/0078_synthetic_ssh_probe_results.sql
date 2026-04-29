CREATE TABLE IF NOT EXISTS "synthetic_ssh_probe_results" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "target_host" text NOT NULL,
  "target_user" text NOT NULL,
  "ok" boolean NOT NULL,
  "total_ms" integer NOT NULL,
  "ssh_handshake_ms" integer,
  "curl_ms" integer,
  "error_class" text,
  "attempts_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "host_load_avg_1m" double precision,
  "sshd_auth_attempts" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthetic_ssh_probe_results_target_started_idx"
  ON "synthetic_ssh_probe_results" USING btree ("target_host","started_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "synthetic_ssh_probe_results_started_idx"
  ON "synthetic_ssh_probe_results" USING btree ("started_at" DESC);
