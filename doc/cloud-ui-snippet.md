# Retired Cloud UI snippet settings

`PAPERCLIP_CLOUD_UI_SNIPPET` and `PAPERCLIP_CLOUD_UI_SNIPPET_B64` are no longer
read by the server. They do not inject HTML or JavaScript into static or dev
pages. This removes an operator-controlled executable HTML path from the app.
Existing ordinary branding and plugin UI contributions are unchanged.

Before upgrading an installation that uses either setting, move the integration
to a trusted plugin using the supported [plugin UI slots](plugins/PLUGIN_AUTHORING_GUIDE.md).
Plugin UI runs as trusted same-origin code; a plugin is not a sandbox for
untrusted JavaScript. Remove the retired settings from the operator's desired
configuration and verify any provision/restart/wake mechanism cannot restore them.
Refresh existing browser tabs to unload previously injected code.

For rollback, retain the prior image and configuration outside source control.
An older image can still use these settings. Do not activate the old integration
and its replacement together.
