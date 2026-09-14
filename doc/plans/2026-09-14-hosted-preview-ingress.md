# Hosted preview ingress contract

Paperclip Cloud can route hosted preview origins to this instance through a
provider hostname without trusting browser-supplied forwarded headers. Configure
`PAPERCLIP_SERVICE_PREVIEW_BASE_URL` to an exact HTTPS PRIVATE public suffix and
`PAPERCLIP_SERVICE_PREVIEW_INGRESS_PUBLIC_KEYS` to a JSON array of one or two
Ed25519 SPKI PEM public keys. `PAPERCLIP_CLOUD_STACK_ID` must identify this stack.
The Cloud private signing key stays in Cloud; instances receive public keys only.

The Cloud edge signs the UTF-8 JSON array `["paperclip-preview-ingress-v1",
stackId, method, rawPathAndQuery, previewHost, timestampMilliseconds]` and sends
`x-paperclip-preview-host`, `x-paperclip-preview-ingress-time`, and
`x-paperclip-preview-ingress-signature` (unpadded base64url). The gateway checks
all bindings, the local namespace/endpoint host and a 30-second skew window.
Ordinary `X-Forwarded-Host` is never authority. Partial, invalid, duplicated or
stale proof headers are consumed and rejected before board routing, for HTTP and
WebSockets. Once configured, direct preview-host requests also require proof.

This establishes only the route. Private user and guest share authorization,
one-time handoff, host-only `__Host-Http-paperclip-preview` cookies, and live
revocation remain unchanged. The proxy strips its preview cookie, exact instance-scoped Better Auth cookie
names (including cache chunks), and ingress headers before reaching the sandbox
application. App cookies such as `better-auth.session_token` and `paperclip-theme`
remain available. WebSocket proof freshness is
checked only at admission, so existing authorized Fast Refresh sockets outlive
the short proof window while continuing service/share authorization checks.

Roll keys by first delivering both old and new public keys, then changing the
Cloud signer, then removing the old key after signer convergence and the proof
window. Preserve the instance's existing preview cookie signing secret through
this rotation. Board public URLs stay on the normal tenant host.

The proposed `preview.paperclip.app` suffix is not present in the official PSL
checked on 2026-09-14. This change adds no PSL bypass. Domain-owner submission,
DNS/TLS verification, library suffix-data update after acceptance and supported
browser propagation checks remain prerequisites. Host-only cookies alone do
not create a registrable-domain boundary. Cloud's companion rollout document
covers the wildcard ingress, owner registration and existing-stack campaigns.

Whole-instance sleep remains separate from service/sandbox sleep. A sleeping
Cloud instance currently requires its owner to wake it through the normal
Paperclip flow; anonymous preview traffic does not trigger Cloud compute.
Live public Vite/Fast Refresh, private login/deep links, share revocation and
cross-instance isolation must be verified after infrastructure rollout.

## Active service admission during Cloud idle sleep

The existing Cloud-authorized task-drain API now advertises
`runtimeServicesIdleProtocol: 1` without querying runtime tables. Cloud first
reads that capability, then starts a bounded drain with `purpose: "idle"` and
`ttlMs`. The response includes a unique owner ID. Reads while that hold is
active include service controller requirements and only report quiescence when
agent work, pending wakes, admitted service mutations and controller obligations
are all absent. A release with `?ownerId=` cannot cancel a different hold.

Service operations that admit process/controller work register synchronously
before their first mutation await; a drain
blocks new mutations and pauses background admission while existing mutations
finish. Existing previews still serve while a hold is checked: wake is a read
when the service is already running, and activity updates remain available.
Only a real sleeping-to-running transition needs new admission. Running/uncertain processes, lifecycle transitions, live controllers,
pending deletion/retries and incomplete allocations require the controller.
Stopped files with indefinite retention do not prevent instance sleep. A finite
retention policy keeps the controller alive until retained allocations are
released or deleted, so data-expiration jobs can meet their deadlines.

Cloud retains the same hold through its atomic idle claim and final pre-provider
validation. Rejected/failed sleeps release the hold; successful sleep clears it
on restart or expiry. The hold is process-local like existing task drain: an
unexpected restart or explicit operator override after final validation remains
a narrow race until the provider stop. Multiple tenant replicas would require
shared admission fencing. No new public preview probe grants instance-control
authority. Deploy this companion before enabling the Cloud preview feature;
older instances refuse automatic idle sleep under the new gate.
