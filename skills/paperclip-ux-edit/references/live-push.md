# Live Push

Use this reference when a Paperclip UX task must land in the running local app, not only in the development checkout.

## Goal

Make the UX change visible in the local always-on Paperclip service with the smallest safe diff.

## 1. Identify The Checkout That Owns The Running Service

```sh
lsof -nP -iTCP:3100 -sTCP:LISTEN
lsof -a -p <pid> -d cwd
ps -p <pid> -o command=
```

Interpretation for this fork:

- `Paperclip` is the active development checkout.
- `Paperclip-live` is the stable always-on service checkout.

If the running service already comes from `Paperclip-live`, mirror only the validated change into that checkout. Do not repoint the live service at a dirty development repo just to make a UI tweak visible.

## 2. Check For Active Live Work Before Restarting

```sh
curl -sS -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/live-runs"
```

If the result shows queued or running work, note that in the issue before restarting. UX work is low risk, but you should still understand whether you are interrupting live runs.

## 3. Mirror Only The Minimal Validated Diff

- Apply the proven UI patch to the checkout that owns the service.
- Avoid unrelated cleanup or refactors while touching the live checkout.
- Keep tests in the dev checkout when the live checkout is only being updated to serve the already-validated change.

## 4. Restart The Owning Checkout

For the stable fork setup where the always-on process is `paperclipai run` from `Paperclip-live`, restart that exact checkout:

```sh
kill <pid>
cd "/Users/robertdawson/Documents/AI /Paperclip-live"
nohup pnpm paperclipai run >/tmp/paperclip-live.log 2>&1 &
```

Prefer a normal `kill` over `kill -9` unless the process refuses to exit.

## 5. Confirm The Service Came Back

```sh
curl -sS http://localhost:3100/api/health
```

Then confirm the relevant route/behavior in the live app. If browser automation is blocked by the local install, say that explicitly and rely on the service restart plus route/API confirmation.
