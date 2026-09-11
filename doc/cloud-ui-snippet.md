# Cloud UI snippet

Cloud operators can set `PAPERCLIP_CLOUD_UI_SNIPPET` to an HTML snippet.
The server inserts it before `</body>` in static and Vite-served UI pages.
It requires the existing Cloud-managed instance signal. Self-hosted instances
ignore this setting. No snippet is enabled by default.

This is trusted deployment configuration, not user input. It executes in the
application origin and is visible to every browser that receives the UI shell.
Do not include secrets or customer data. Restart the app after changing it.
Operators must review scripts and any required CSP changes before deployment.

## Plain closed beta

Set the value to this standard embed, replacing `YOUR_CHAT_APP_ID` with the
public chat app ID for the target environment:

```html
<script>
(function(d) {
  var script = d.createElement('script');
  script.src = 'https://chat.cdn-plain.com/index.js';
  script.onload = function() { Plain.init({ appId: 'YOUR_CHAT_APP_ID' }); };
  d.head.appendChild(script);
})(document);
</script>
```

No signing secret or Plain API key is required. No Paperclip customer identity
or organization data is passed. Plain manages the anonymous browser session;
there is no Paperclip account-switch integration. Ask users for identifying
information when needed. The existing feedback flag remains unchanged.

Docs: [Plain chat](https://www.plain.com/docs/product/channels/chat).

## Verification and rollback

On staging, open `/`, `/index.html`, and an organization dashboard directly.
Confirm the bubble appears and a test message reaches Plain. Verify the support
reply returns. On a self-hosted instance, confirm no snippet or widget is loaded.
Unset the snippet and restart to remove it on the next page load. Existing open
tabs retain the widget until refreshed. No production deployment is implied.
