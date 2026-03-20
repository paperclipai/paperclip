# Stripe environment variables (VPS)

Production compose loads host env from `/opt/paperclip/.env` (`docker compose ... --env-file` in `deploy-vultr.yml`).

## Recommended (test)

```bash
STRIPE_TEST_PUBLISHABLE_KEY=pk_test_...
STRIPE_TEST_SECRET_KEY=sk_test_...
```

## Aliases (optional)

```bash
# STRIPE_PUBLISHABLE_KEY=pk_test_...
# STRIPE_SECRET_KEY=sk_test_...
```

If both prefixed and generic names are set, **`STRIPE_TEST_*` takes precedence**. The server mirrors the effective values onto `STRIPE_PUBLISHABLE_KEY` / `STRIPE_SECRET_KEY` inside the process for SDK compatibility.

## Verify after deploy

```bash
curl -sS http://<host>:3100/api/health | jq '.features.stripe'
```

Expect `publishableKey` / `secretKey` to be `true` when the corresponding credential is non-empty. This does not expose key material.

## GitHub Actions

Deploy does **not** inject Stripe from GitHub Secrets; keys live only in the VPS `.env`. Add or rotate them on the host when needed, then recreate the server container if compose already references these variables.
