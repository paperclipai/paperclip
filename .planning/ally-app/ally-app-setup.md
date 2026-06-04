# Migrate the bot identity `blockcast-ci-packages` → `ally`

**Decision (2026-06-04):** full new app — the fleet bot becomes `allyblockcast[bot]`.
(The global `ally` app slug was already taken, so the app is named `allyblockcast`;
its bot login is therefore `allyblockcast[bot]`. Operators still trigger reviews
with the `@ally` text alias — parsed from the comment body in
`github-webhook.ts`, independent of the bot's GitHub handle; `@allyblockcast`
works too.)

## What this bot actually is (read first)

`blockcast-ci-packages` is **not** just Ally's reviewer identity. There is one
GitHub-App credential — k8s secret `paperclip/paperclip-github-app-creds`
(`app_id`, `installation_id`, `private_key.pem`) — and paperclip mints an
**installation token from it that is injected into every agent run pod** as
`GH_TOKEN`. So this single identity authors:

- every agent's git commits, branch pushes, and opened PRs,
- every agent's PR **review** + issue comments (this is the `blockcast-ci-packages[bot]` you see on reviews),
- CI automation (e.g. the `chore(lockfile): refresh` / upstream-merge PRs called out in `pr.yml`),
- package publishing (hence the broad `packages`/`actions`/org perms).

**Swapping the credential rebrands ALL of the above to `ally[bot]` at once.**
That is the intended outcome of "rename the bot to ally." If you only wanted the
*review comments* to read `ally` (leaving other agents/CI as-is), stop — that
needs a new paperclip per-agent-app feature instead; tell the assistant.

There is **no per-agent GitHub-App override** in paperclip today.

## Step 1 — Create the app (you, in browser, as Blockcast org owner)

**Option A (one-click manifest):** open `create-ally-app.html` in a browser
logged into GitHub as a Blockcast org owner → click → review → "Create GitHub App".
GitHub redirects to `…/app-manifest-callback?code=XXXX` (the page may 404 — fine).
**Copy the `code=` value from the address bar.**

**Option B (manual):** GitHub → Org `Blockcast` → Settings → Developer settings →
GitHub Apps → New GitHub App. Set:
- **Name:** `ally`  ·  **Homepage:** `https://paperclip.blockcast.net`
- **Webhook:** *uncheck Active* (delivery is via per-repo webhooks already in place — do not add an app-level webhook).
- **Permissions:** match the existing `blockcast-ci-packages` app exactly. Current set (all the write ones):
  actions, checks, contents, deployments, environments, issues, packages, pages,
  pull_requests, repository_hooks, repository_projects, secret_scanning_alerts,
  security_events, statuses, vulnerability_alerts, workflows = **Read & write**;
  metadata = **Read**; organization administration + org self-hosted runners = **Read & write**.
  (Mirror anything else shown on the old app's Permissions page.)
- **Where can this be installed:** Only this account.

## Step 2 — Generate a private key + install

1. On the new app's page → **Generate a private key** (downloads a `.pem`).
2. **Install App** → Blockcast org → **All repositories**.
3. Note the new **App ID** (app settings page) and **Installation ID**
   (from the install URL `…/installations/<ID>` or
   `gh api /orgs/Blockcast/installations --jq '.installations[]|select(.app_slug=="ally")|.id'`).

## Step 3 — (If you used Option A) exchange the code for credentials

```bash
# within ~10 min of creating the app:
gh api -X POST /app-manifests/<CODE>/conversions \
  --jq '{app_id:.id, slug:.slug, client_id:.client_id, pem:.pem, webhook_secret:.webhook_secret}'
# → save app_id + pem. Then install (Step 2.2) and read installation_id (Step 2.3).
```

## Step 4 — Cutover (assistant can do once you provide app_id + installation_id + pem)

Replace the fleet credential in-place (instant rebrand on next agent run; existing
runs keep their ~1h token):

```bash
kubectl -n paperclip create secret generic paperclip-github-app-creds \
  --from-literal=app_id=<NEW_APP_ID> \
  --from-literal=installation_id=<NEW_INSTALLATION_ID> \
  --from-file=private_key.pem=<path-to-new.pem> \
  --dry-run=client -o yaml | kubectl -n paperclip apply -f -
kubectl -n paperclip rollout restart deploy/paperclip-api
```
Keep the OLD secret values saved for rollback (just re-apply them).

## Step 5 — Code coordination (assistant, via PR)

- `pr.yml` lockfile-guard exemption: accept **both** `blockcast-ci-packages[bot]`
  and `ally[bot]` (prepped now so it works before *and* after cutover).
- Webhook `@ally` mention: already handled (`github-webhook.ts:83`).
- **Audit other repos** for hardcoded `blockcast-ci-packages[bot]` references
  (branch-protection bypass lists, CODEOWNERS, sibling `pr.yml` lockfile guards,
  release workflows). Grep each repo's `.github/` for the literal bot login.

## Rollback

Re-apply the saved old `paperclip-github-app-creds` and `rollout restart`. The
old `blockcast-ci-packages` app stays intact until you delete it, so cutover is
fully reversible until then. Don't delete the old app until a full agent cycle +
CI automation run is verified green under `ally[bot]`.
