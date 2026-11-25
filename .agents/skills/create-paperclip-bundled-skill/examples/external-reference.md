# Example — FIND path: tweet → existing skill → external reference

Real artifact: `packages/skills-catalog/catalog/optional/research/last30days/`.

## Input

Dotta sends a tweet praising a "last 30 days" research workflow that sweeps
Reddit/X/YouTube for what changed recently on a topic.

## Step 0 — Capture

```sh
xc get https://x.com/<author>/status/<id> --json   # post text + conversation_id
xc search 'conversation_id:<id>' --archive --json  # the rest of the thread
```

The thread links a GitHub repo: `mvanhorn/last30days-skill`, which already
contains a proper skill (`skills/last30days/SKILL.md` plus scripts and
references).

## Step 1 — FIND

- Not in the catalog, not in this repo.
- The upstream repo IS the skill — maintained, tagged releases, real SKILL.md.
- Verdict: **FIND** — add it as an external reference, keep attribution and
  updates upstream.

## Step 2A — catalog-ref.json

Placement: `optional` / `research` / `last30days`. Pin the release tag to an
exact commit:

```sh
gh api repos/mvanhorn/last30days-skill/commits/v3.3.0 --jq .sha
# → daca71f89eb71d0d56d01a43ed7627aa919dba4f
```

`catalog/optional/research/last30days/catalog-ref.json` (the only file in the
directory):

```json
{
  "source": {
    "type": "github",
    "hostname": "github.com",
    "owner": "mvanhorn",
    "repo": "last30days-skill",
    "ref": "v3.3.0",
    "commit": "daca71f89eb71d0d56d01a43ed7627aa919dba4f",
    "path": "skills/last30days"
  },
  "files": [
    "SKILL.md",
    "agents/openai.yaml",
    "references/**",
    "scripts/briefing.py",
    "scripts/compare.sh",
    "scripts/last30days.py",
    "scripts/lib/**",
    "scripts/setup-keychain.sh",
    "scripts/store.py",
    "scripts/watchlist.py"
  ],
  "defaultInstall": false,
  "recommendedForRoles": ["researcher", "marketer", "product-manager", "analyst"],
  "requires": ["node", "python3"],
  "tags": ["research", "last-30-days", "social-media", "trends", "citations", "reddit", "x", "youtube"]
}
```

Metadata (`recommendedForRoles`, `requires`, `tags`) lives in the JSON because
there is no local SKILL.md to carry it.

## Steps 4–5 — Manifest, tests, PR

- `pnpm --filter @paperclipai/skills-catalog build:manifest` fetches the
  pinned files from GitHub and inventories them (network required).
- The skill bundles `scripts/`, so trust level derives to
  `scripts_executables` → it must also be added to the `scriptBearing`
  expectation in `src/shipped-catalog.test.ts`, alongside
  `EXPECTED_OPTIONAL_KEYS`.
- PR diff: `catalog-ref.json`, regenerated `generated/catalog.json`, test
  expectations. PR body links both the tweet and the upstream repo, and calls
  out the elevated trust level so review is deliberate.
