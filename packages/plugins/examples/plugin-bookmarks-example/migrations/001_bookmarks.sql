CREATE TABLE plugin_bookmarks_b34a9f8617.bookmarks (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  slug text NOT NULL,
  url text NOT NULL,
  title text NOT NULL,
  notes text NOT NULL DEFAULT '',
  tags text[] NOT NULL DEFAULT '{}',
  file_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bookmarks_company_slug_uq UNIQUE (company_id, slug)
);

CREATE INDEX bookmarks_company_idx
  ON plugin_bookmarks_b34a9f8617.bookmarks (company_id, created_at DESC);
