# Plugins supplied by an application distribution

A downstream image can add prebuilt plugins without changing Paperclip's
built-in catalog. The operator owns the image and trusts its plugin code.
This is packaging and activation policy, not a sandbox or entitlement system.
Ordinary self-hosted images need no catalog and keep their existing behavior.

## Image layout

Use `distribution/catalog.json` beneath `PAPERCLIP_BUNDLED_PLUGIN_ROOT`
(default `/app/packages/plugins`). Each plugin has a stable directory below
`distribution/`, containing its `package.json`, compiled manifest, worker and
optional UI. Bundle runtime dependencies; startup never installs them.

```json
{
  "schemaVersion": 1,
  "plugins": [{
    "key": "example-extension",
    "pluginKey": "example.extension",
    "version": "1.0.0",
    "directory": "example-extension",
    "digest": "sha256:<64 lowercase hex characters>"
  }]
}
```

The digest covers a sorted depth-first file inventory. Each entry is
`[relativePosixPath, "sha256:" + sha256(fileBytes), permissionBits & 0777]`.
Hash the UTF-8 JSON serialization of the inventory and prefix it with
`sha256:`. The server's `distributionBundleDigest` implements this contract.
There are no symbolic links or special files. A bundle is limited to 10,000
files, 256 MiB and 32 directory levels. Catalog keys, plugin IDs and directory
names must be unique; a distribution cannot replace a built-in key or ID.

On startup, the host validates the catalog, hashes the bundle before importing
its executable manifest, and validates package version and confined prebuilt
entrypoints. Malformed catalogs and integrity failures stop startup. Deploy
the catalog and bundles atomically as part of the image; keep them read-only
in operation. This detects packaging errors but does not authenticate an
untrusted image builder. Image provenance and signatures remain deployment
responsibilities.

## Selection, upgrades and rollback

Managed instances select a distribution key through the existing
`plugins.autoInstall` list. Existing install, capability validation, API
compatibility, worker and health mechanisms apply. A worker or install failure
is recorded as a plugin error without taking down the application.

The catalog alone does not auto-enable plugins on self-hosted instances.
Operators can explicitly install catalog entries through the normal plugin
CLI. The package's manifest ID and version must match the catalog.
The manifest's worker and optional UI entrypoints must match the verified
`package.json` declarations and stay inside the bundle.

At boot, selected distribution entries adopt the current image's package path
even when a previous npm or local install has the same version. Reconciliation
keeps the registry ID, configuration and stored state. With unchanged permissions,
operator-disabled status is retained. A replacement that adds capabilities is
saved atomically in `upgrade_pending`, even for same-version bundles. It cannot
activate until an operator reviews the manifest and enables it through the normal
plugin lifecycle. Invalid capability declarations are rejected before persistence.
Runtime refreshes also reject unapproved capability additions before starting code.
Rolling back an unapproved replacement refreshes the displayed manifest but
retains `upgrade_pending`. Review the rollback manifest and explicitly enable it
to resume. A smaller capability set alone cannot prove prior approval: it may
retain an unapproved permission, and the plugin may originally have been disabled.
Ordinary upgrades/downgrades of an approved, ready plugin continue automatically.

Keep each key's directory stable across releases. The activation guard also
covers persisted installs: a plugin removed from the image catalog, or no
longer selected in managed configuration, cannot activate on restart. Its
stored image path remains the source marker if the directory disappears; package
resolution cannot substitute an npm copy. Keep the catalog root stable as well.
An explicit operator reinstall changes a package's source; editing database rows
or replacing the catalog root is outside this image-selection contract. Plugin
database records remain for rollback. Plugin data migrations must themselves
support the intended rollback window; removing a bundle does not undo them.

A deployment controller must generate `plugins.autoInstall` from the **target
image's** catalog. A union of catalogs from different releases is insufficient:
an older image rejects a key it does not know. Before reverting to a host
version that predates this catalog contract, disable the distribution plugins
and remove their keys from configuration. Such older hosts do not have the
new activation guard.

## Persistent application UI

The `appShellOverlay` slot requires `ui.action.register`. It receives the usual
`PluginWidgetProps` context. It mounts once in both application shells and
survives route navigation. It is disposed when the account or selected company
changes, during onboarding, and on sign-out. It is not mounted on login pages.
Local-trusted mode has no login requirement: its sessionless board may mount
overlays, but transitions to or from an account still dispose the prior state.

The host positions contributions above the mobile navigation and stacks them
at the bottom right. Each plugin owns its launcher, panel, keyboard handling,
focus restoration, accessible labels and request cancellation. Use a bounded,
responsive panel. This slot is not a launcher placement zone and does not
replace modal/launcher APIs. Errors remain inside the existing plugin mount
error boundary.

UI code is trusted browser code. Host context is display context, never proof
of server authorization. A distribution backend must independently validate
the signed-in session and enforce company, tenant and user access rules for
every read and mutation. Keep provider secrets out of plugin UI and manifests.
The service worker's offline cache accepts only same-origin, hashed build assets
under `/assets/`. It does not store or replay application HTML, extension routes
or API data. This policy remains in effect after worker restarts and does not read
the arbitrary-response caches created by older workers.
