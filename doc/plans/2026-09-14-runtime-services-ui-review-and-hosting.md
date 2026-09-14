# Runtime services: UI review and hosted deployment

Date: 2026-09-14


## Review in Storybook

Run `pnpm -C ui storybook` and open the Runtime Services section. The full task/properties view and company service inventory use production components, real routes and simulated API data. `pnpm -C ui build-storybook` creates a static review build. Mutations change the browser fixture. Example external URLs use `.invalid` domains. Storybook does not establish live provider acceptance.

| Changed surface | Review location |
| --- | --- |
| `RuntimeServices`, Sidebar service navigation, BreadcrumbBar, company routes | 01 Company services: inventory, empty, loading, stale/error, viewer, mobile, light |
| `CreateRuntimeServiceForm`, `SearchableSelect` task search and accessible labels | 01: Create service; Create with task and environment |
| `RuntimeServiceCompanyPolicyEditor` | 01: Company defaults and limits |
| `IssueDetail`, `IssueProperties`, `TaskRuntimeServices`, desktop/mobile properties toggle | 02 Task and properties: complete task page in every state |
| `RuntimeServiceDetail`, `RuntimeServiceControls`, logs | 03 Service details and controls: running, starting, stopping, sleeping, stopped, failure, worker, preview/retention unavailable, viewer, slow/lost responses |
| `RuntimeServicePolicyEditor` | 03: Lifetime editor; Company policy conflict |
| `RuntimeServiceEnvironmentEditor`, shared `EnvironmentVariablesEditor` and `EnvironmentVariableRow` | 03: Configure environment; Environment locked while running |
| `RuntimeServiceSharing` | 03: Share preview; Share created (copy and revoke available) |
| `RuntimeServiceTaskWorkspace`, `RuntimeServiceTaskDetach`, task picker | 03: Develop in task; Attached task |
| `RuntimeServiceStorage`, retained data expiry/protection | 03: Running; Protected data retention |
| `RuntimeServiceDataDeletion` | 03: Review data deletion; Deletion blocked by running service; Data deletion needs attention |
| `CompanyEnvironments` retained-service deletion warning | 04 Related app pages: environment edit and blocked deletion dialog |
| `AuthPage` preview return flow | 04: Preview sign-in desktop/mobile; actual authentication/redirect requires live gateway |
| Server-rendered `previewPage` | 05 Preview gateway pages: starting, sleeping, stopped, failure, unavailable, not found, access required, sign-in, expired/revoked share |

Nonvisual changes in hooks, API clients, routing/scroll utilities and environment-binding models are exercised by their consuming pages. Tests are not separate UI surfaces. Gateway HTML fixtures are generated from the actual server renderer using `ui/storybook/scripts/generate-runtime-preview-pages.mjs`; their sandboxed iframe disables scripts/navigation, so it shows the page without running its polling loop.

The initial review rendered 61 stories. Rebuild and verify them for the current PR head; the initial review is historical evidence.

## Hosted deployment belongs in both repositories

**Paperclip Cloud needs routing, proxy and provisioning changes.** The service manager and preview gateway run inside each Paperclip instance. Cloud dispatches traffic to the owning instance; that instance authenticates the preview and proxies its private Daytona endpoint.

```text
browser: <namespace>-<service>-<endpoint>.preview.paperclip.app
  → wildcard DNS and TLS
  → Paperclip Cloud preview ingress
  → owning Paperclip instance (the same stack as foo.paperclip.app)
  → private Daytona app port
```

`preview.paperclip.app` remains a proposed namespace, not a deployed setting.

### Concrete Cloud work

1. **Preview host lookup.** The Cloud router must resolve generated preview labels separately from board hosts. Add an indexed, collision-checked namespace-to-stack lookup and reject unknown namespaces. The current Paperclip namespace is the first 12 hexadecimal characters of SHA-256 over `cloud:<PAPERCLIP_CLOUD_STACK_ID>`; service and endpoint identifiers occupy the rest of the label. Keep that contract synchronized, including stack deletion, restore and migration. No per-service DNS records are needed.
2. **Dedicated HTTP and WebSocket dispatch.** Cloud must classify preview traffic separately from tenant board traffic. A preview has its own cookie and can be shared with a guest. Add a preview route for all app paths and WebSocket upgrades. Let the instance preview gateway enforce private/share access. Do not attach board-user identity to arbitrary app traffic or apply board API path routing to app paths.
3. **Trusted original host.** An ingress can replace `Host` with its internal upstream name. The new instance gateway currently matches `req.headers.host`. Simply adding a DNS record will therefore not work. Agree an authenticated edge-to-instance original-preview-host contract, or preserve `Host` through a compatible ingress. Do not trust a client-supplied forwarded header. This needs a companion change in Paperclip, with forged-host and HTTP/WebSocket tests.
4. **Stack lifecycle.** Route to the current stack upstream and handle sleeping/waking, unavailable, suspended, deleted and migrated stacks. Decide how preview requests/active services interact with whole-instance sleep, so the gateway/controller does not disappear while an app is in use. Unknown hosts must not wake or select an arbitrary stack.
5. **Provisioning/configuration.** The instance requires a stable `PAPERCLIP_CLOUD_STACK_ID`. Add `PAPERCLIP_SERVICE_PREVIEW_BASE_URL`, keep the normal public board URL correct, and retain a stable instance signing secret through deployments. Roll the config out to existing stacks as well as new ones.

### Shared infrastructure and browser boundary

- Configure wildcard DNS and a certificate for `*.preview.paperclip.app`, routed to the Cloud preview ingress. The existing board wildcard is a different hostname level.
- The chosen preview base must be in the PRIVATE Public Suffix List for the current gateway contract. Browser suffix handling prevents cross-app cookie inheritance; DNS and TLS alone do not provide that boundary. The domain owner submits the registration. See the [PSL explanation](https://publicsuffix.org/learn/) and [submission rules](https://publicsuffix.org/submit/).
- Update Paperclip's `tldts` suffix data after acceptance, and verify the boundary in supported browsers. The current configuration deliberately rejects an unrecognized hosted suffix. A submitted registration is not evidence that browsers or the shipped library already recognize it.

### Deployment acceptance

Verify an actual private Vite app through the public hostname: sign-in and return to a deep link, subsequent agent edit with React Fast Refresh, ten-minute revisit, service sleep/wake, instance restart, expired/revoked share including an existing WebSocket, sibling-app/company isolation, provider preview-token refresh, stale mappings and unknown-host rejection. Provider credentials stay server-side. Check both the instance's own lifecycle and the service/sandbox lifecycle.

No Cloud source, production configuration, DNS, certificates, PSL registration or provider allocation was changed during this review work.
