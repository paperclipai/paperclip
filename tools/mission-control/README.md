# Mission Control

Mission Control is a local, read-only operational view of one Paperclip company. It runs as a loopback sidecar and reads company state without exposing mutation controls.

Requires Node.js 24.11.0 or newer, matching the repository runtime policy.

## Runtime-only startup

From this directory, provide the control-plane values at runtime and start the sidecar:

```sh
export PAPERCLIP_API_URL=http://127.0.0.1:3100
export PAPERCLIP_API_KEY='(enter at runtime; do not commit)'
export PAPERCLIP_COMPANY_ID='39f0b0b8-1f7a-4aab-b9c9-bbcadc2eb0cc'
npm start
```

The default listener is `127.0.0.1:61962`. Open `http://127.0.0.1:61962/?companyId=$PAPERCLIP_COMPANY_ID` in a browser. The sidecar must not be exposed publicly or bound to a non-loopback interface.

The browser is read-only: it can display current state and source links, but it cannot approve, reject, run, or mutate work. Paperclip routines remain the autonomy source of truth; this view does not create schedules or replace routine governance. Credentials are runtime-only. Do not commit API keys, cookies, generated headers, or copied control-plane responses.

## Focused proof

```sh
npm test
npm run smoke:browser
```

`npm test` runs the deterministic sidecar tests. `npm run smoke:browser` starts a local non-secret fixture server and proves the browser shell renders its four zones, masthead, read-only label, healthy lane, approval card, and source link. Broad suites, deployment, publishing, and Paperclip schedule changes are not part of this proof.
