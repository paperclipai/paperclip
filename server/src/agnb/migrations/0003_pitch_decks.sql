-- AGNB migration 0003 — pitch_decks (Finn pitch-deck generator, ported from
-- the standalone finn-pitch repo into the Assets area).
--
-- Generation is dev-only (shells out to the local `claude` CLI); the rendered,
-- self-contained reveal.js HTML is stored here and served read-only everywhere
-- (prod just lists + serves; it never re-renders). Idempotent, schema `agnb`.

CREATE SCHEMA IF NOT EXISTS agnb;

CREATE TABLE IF NOT EXISTS agnb.pitch_decks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name text NOT NULL,
  vertical    text,
  deck_title  text NOT NULL,
  slides      jsonb NOT NULL DEFAULT '[]'::jsonb,
  html        text NOT NULL,
  answers     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pitch_decks_updated ON agnb.pitch_decks (updated_at DESC);
