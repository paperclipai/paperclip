# Linear Webhook Fixtures

Paperclip keeps sanitized Linear webhook fixtures under `server/src/__fixtures__/linear-webhooks/` and replays them in `server/src/__tests__/linear-webhook-fixture-replay.test.ts`.

## Recording

Capture the raw Linear webhook request body and, when useful, its headers into a local file that is not committed. Then run:

```sh
pnpm --filter @paperclipai/server exec tsx src/scripts/record-linear-webhook-fixture.ts issue-update-with-paperclip-link server/src/__fixtures__/linear-webhooks/issue-update-with-paperclip-link.json < /tmp/linear-webhook.json
```

The input may be either the raw JSON body or an object with `{ "headers": {}, "body": {} }`.

## Redaction

The recorder redacts common secrets and PII-like fields before writing a fixture:

- Signature and auth headers such as `linear-signature`, `x-linear-signature`, `authorization`, and `cookie`.
- Fields ending in `token`, `secret`, `signature`, `authorization`, `cookie`, `email`, `avatar`, `url`, `name`, `displayName`, `description`, `body`, `content`, or `text`.

Review every generated fixture before committing it. Replace any remaining customer-specific IDs or free-form text with stable sanitized placeholders.

## Replaying

Run the focused harness with:

```sh
pnpm exec vitest run server/src/__tests__/linear-webhook-fixture-replay.test.ts
```

CI runs this through the normal grouped Vitest jobs. The test prints the replayed fixture count and asserts both the webhook delivery path and expected Paperclip-side effect descriptions for issue, comment, and link-sync flows.
