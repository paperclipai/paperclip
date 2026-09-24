ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "appearance" jsonb;
--> statement-breakpoint
WITH RECURSIVE appearance_hash AS (
  SELECT id, id::text AS identity_text, 0 AS position, 0 AS hash FROM agents WHERE appearance IS NULL
  UNION ALL
  SELECT id, identity_text, position + 1, (hash * 31 + ascii(substr(identity_text, position + 1, 1))) % 17
  FROM appearance_hash WHERE position < length(identity_text)
)
UPDATE agents SET appearance = jsonb_build_object('schemaVersion', 1, 'characterVersion', 'cap-v1',
  'paletteId', (ARRAY['bubblegum-sky','pink-lemonade','orchid-peach','coral-mint','lime-lagoon','arctic-blue','solar-flare','violet-ember','deep-tide','coral-current','golden-hour','tangerine-cobalt','electric-grove','flamingo-jade','cherry-pop','turquoise-cherry','ultraviolet-tide'])[appearance_hash.hash + 1])
FROM appearance_hash WHERE agents.id = appearance_hash.id AND appearance_hash.position = length(appearance_hash.identity_text) AND agents.appearance IS NULL;
