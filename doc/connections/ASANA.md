# Asana

Paperclip uses [Asana's official remote MCP server](https://developers.asana.com/docs/integrating-with-asanas-mcp-server)
at `https://mcp.asana.com/v2/mcp`. The default connection uses Paperclip's
shared OAuth app through the Cloud connector broker. An enrolled self-hosted
instance can use that same app. **Use your own Asana OAuth app** is available
without enrolling the instance, including when the shared app is unavailable.

## Your own app

1. Open [Asana My apps](https://app.asana.com/0/my-apps) and create an
   **Asana MCP** app. An API app or personal access token will not authorize MCP.
2. Under OAuth, copy the exact callback displayed in Paperclip into Redirect URLs.
   For local development Paperclip uses `localhost`, even if opened at `127.0.0.1`.
   Public deployments should configure their canonical HTTPS URL.
3. Under Manage distribution, select the workspaces that can use the app and save.
4. Enter the client ID and client secret in Paperclip and continue to Asana.

MCP v2 still requires OAuth and a preregistered client; it does not offer dynamic
client registration. Asana MCP currently grants one fixed `default` scope.
Paperclip's action permissions govern which discovered tools an agent can use.
The client secret is encrypted in the local credential vault and sent only to
the token endpoint. Resuming setup with the same client ID preserves the secret;
changing the client ID requires the matching new secret.

## Discovery and lifecycle

Asana's live v2 resource challenge points to
`https://mcp.asana.com/.well-known/oauth-protected-resource/v2`. The root metadata
still describes the retired v1 issuer. The curated method pins the v2 discovery
URL and re-resolves it for saved connections, repairing drafts that cached v1.
Saved manual-client bindings from that exact v1 issuer/resource are repaired for
Asana v2 while preserving company and callback checks. Other binding changes
still require new credentials. Secret reuse is shown only when the requesting
user has an active grant with a saved client-secret reference.
Authorization and token exchange use `https://app.asana.com/-/oauth_authorize`
and `https://app.asana.com/-/oauth_token`, with PKCE S256.

The managed `asana.mcp` profile uses the existing signed Cloud connector protocol,
including instance-bound encrypted token delivery and refresh. Availability is
advertised only after the broker has its MCP app credentials and profile enabled.
The shared app's provider secret is held by the broker, never distributed to
instances. Rolling out the shared option requires the companion broker support,
app registration, allowed distribution, and provider configuration.

## Verify

Test both managed and custom sign-in in the browser. Confirm that callback and
workspace selection succeed, tools load, and a read-only tool such as **Get me**
works through **Test** as an installed agent. Also verify canceled/interrupted
setup can resume, and that refresh works after token expiration. Never place
provider tokens or client secrets in screenshots or test fixtures.

Also connect a second account after renaming the first connection. Both custom
and shared app connections must finish with separate permission profiles, even
when the first profile still uses the provider's original name.
