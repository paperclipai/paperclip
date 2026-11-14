# Use Tailscale machines in SSH environments

The Tailscale connector gives Paperclip access to a tailnet. Paperclip joins a
separate device to that network, then uses the existing SSH environment driver
to run tasks on selected computers. The connector is managed from **Connectors**
and can serve multiple SSH environments in the same company. The computer is
not replaced or provisioned by Paperclip.

In **Connectors**, find **Tailscale**, open it and click **Connect Tailscale Network**.
After approving consent, click **Create SSH environment**, or create an SSH
environment and select **Tailscale** under **Network**. Choose the connection
and machine, then configure the SSH user, port, absolute workspace path, private
key, and trusted host keys. The Tailscale network option appears once a tailnet
is connected. On a Mac
with the normal Tailscale application, enable macOS Remote Login. Tailscale SSH
server support on macOS requires the open-source tailscaled variant; ordinary
OpenSSH over Tailscale works with the standard Mac application.

Device sign-in opens Tailscale in a separate tab and keeps the connector page
open. A normal sign-in link remains available if the browser blocks the tab.
Approve the Paperclip device in your own tailnet; no OAuth app, API key, Cloud
broker credential, or per-instance pilot admission is needed. If your tailnet
requires device approval, the connector shows that separate pending state.
Sign-in expires after ten minutes and can be cancelled from the connector.

SSH setup hides the Network selector when Direct connection is the only
available option. A sole connected tailnet is selected automatically and its
connection selector is hidden; multiple connected tailnets remain selectable.
Switching an existing environment to **Direct connection** clears its saved
Tailscale machine and credential references and saves the direct host you enter.

After selecting a machine, **Prepare machine pairing** creates an SSH key in
Paperclip’s vault and displays a command containing only the public key. Each
preparation generates a fresh key pair. The command uses the public key produced
during that request, never mutable metadata from a saved secret. Run it
as the target SSH user. The command preserves existing authorized keys, including
files without a final newline. Before installing the key, it checks for readable
Ed25519, ECDSA, or RSA host public keys in `/etc/ssh` and stops without changing
`authorized_keys` if none are available. It prints that user's name, home
workspace path, and known-hosts entries for every available host key for the
form. You can also select an existing SSH private key secret.

Pairing output is tied to the selected company, tailnet, machine, and SSH port.
After editing the port, prepare pairing again for matching known-hosts output.
A late response for an earlier port cannot replace the selected private key.
Switching to Direct connection or closing the form also prevents pending pairing
results from changing the selected key.

Save the environment and test it. Select it as an agent’s environment and choose
any harness supported by SSH environments. Select the agent's AI account in
Paperclip. Runs use that account's subscription or API key, with private
credential directories on the target computer, just as sandbox runs do. The
computer supplies the installed harness and workspace; its SSH user's provider
login is not used for an agent with a configured AI account. Test the chosen
harness separately: SSH access does not prove provider authentication.

SSH's **Advanced** section includes **Use authentication configured on the remote
machine**. New environments leave it off, requiring the agent's Paperclip AI
account. Turn it on to use the remote user's provider login instead. Existing
SSH environments display it as on; opening or upgrading an installation does
not rewrite their saved configuration. The same option applies to direct SSH
and Tailscale connections.

The environment keeps the `ssh` driver. Machine selection stores the connector
ID and Tailscale’s stable device ID, and runtime
resolution looks up its current address through that connection’s private
socket. Offline, removed, disconnected, and wrong-company machines fail closed.
The host’s existing Tailscale connection is never a fallback.

## Device sign-in and credential custody

It is a network connector on the Connectors surface; it does not publish agent
tools or enter MCP discovery. Management requires an instance administrator with
access to the company. Only the person who started a pending sign-in can retrieve
its sign-in link. Existing SSH environment access governs which agents execute
there. Cloud and self-hosted instances use the same Tailscale device sign-in.

The instance starts a private userspace Tailscale device and returns its generated
`https://login.tailscale.com/a/...` sign-in address. Pending device state is stored
in the configured company vault before the address is returned. The active
`tailscale up` command watches Tailscale state until consent and any required
device approval complete, or the ten-minute deadline expires. It saves the
registered device state before marking the connection connected. Pending sign-ins
can resume from the saved state after a server restart without extending their
deadline. There is no background database scan: browser progress requests exist
only during the bounded sign-in, and the CLI waits for Tailscale state events.

The previous OAuth callback remains available for already-started pilot flows;
existing enrolled devices continue to use their saved state. New connections
use device sign-in and do not call the Cloud OAuth broker.

The connection records
the exact trusted vault version and a SHA-256 digest of the server-written value.
Runtime reads that version and verifies its digest. A generic company secret
rotation cannot change the authorized network. Trusted node-state saves advance
both fields together, with a compare-and-set guard so an older save cannot
replace a newer state. Reads keep using the previous trusted version until the
new version is committed. Private node state, digests and enrollment credentials
never appear in connection or environment responses.

Enrollment tokens and node state are server-owned secrets with a durable
`system_purpose` classification. Generic company catalogs omit them. Generic
bindings, environment injection, and agent value reads reject them, including
bindings saved before the restriction. Renaming or rotating a secret cannot
remove this classification. Disconnecting or replacing a connection leaves its
old credential protected. Only the connector's server consumer can resolve its
trusted value; an SSH environment binds its private key, never the node state.
Unclassified legacy node-state values are also rejected by generic reads,
including state left behind by an earlier connection replacement.
Migration `0482_aberrant_rumiko_fujikawa` classifies existing connector-referenced secrets.
Apply it before running the updated server. If node state was copied before
this restriction, revoke that enrolled device in Tailscale; a local disconnect
cannot stop a copy outside Paperclip.

Connections created before migration `0481_round_pet_avengers` have no trusted version
and digest. They fail closed and require a fresh **Connect Tailscale Network**
consent. The migration leaves these fields empty; it does not trust or backfill a
generic secret's latest value.

Each connection has a separate userspace daemon and private socket. A stale
credential read reloads the trusted value before replacing a ready daemon and
rechecks which daemon is active after the reload. It preserves a healthy newer
socket and cannot cross a manager shutdown. Failed connection requests leave
cleanup to the network manager's exact client; they cannot disconnect a newer
retry using the same connector identity. The daemon accepts no subnet routes or
DNS changes and blocks incoming connections. Normal shutdown saves
node state and removes temporary files. A restart restores the enrolled device;
it does not reuse the OAuth token or require consent for every task. Disconnect
invalidates pending consent and stops the connection’s local daemon. A callback
already exchanging or saving credentials cannot reconnect after disconnect or
replace a newer authorization. Completion retains the consumed state's digest
as a private attempt marker, with no expiry; disconnect replaces that marker.

Database writes and credential reloads verify ownership without holding a database
lock across broker or daemon startup. Cancelled attempts close their daemon and
remove their newly created secret without touching a newer connection's state.
Disconnect does not remove the target computer from Tailscale.

Company deletion removes connector records before vault secrets in the company
transaction. After commit, it stops every daemon owned by those records. A
rolled-back deletion leaves the connector and its daemon intact. Deleting a
connector's vault secret invalidates pending consent, disconnects its network,
and clears the trusted credential reference before removing the secret. If
shutdown fails, the disconnected reference remains available for a deletion
retry. Late daemon state writes cannot restore a retired connector.

Task runtime resolution obtains its socket from this same guarded connection
service after loading the SSH key. It requires the connection to remain connected
with the environment's saved credential identity during credential reload,
daemon startup, and device discovery. A disconnect or replacement rejects the
run before returning a socket; runtime resolution cannot restart the connection
from a stale saved secret.
Saved network credentials without a connector and machine selection are rejected;
all Tailscale environments use the connector's lifecycle.

This implementation currently supports one serving process per instance.
Concurrent replicas need a durable connection ownership lease before rollout.

Tailscale identity belongs to the persisted machine key in the saved node state,
not the container ID or hostname. A redeploy must retain both the database's
encrypted node state and the same vault master key. Cloud already materializes
the stable per-stack `PAPERCLIP_SECRETS_MASTER_KEY` across release rolls. Do not
make the connector ephemeral or replace its node state at each start. Losing
that state, device removal, or a tailnet reauthentication policy can require
fresh consent. The app-owned device has the consenting user's tailnet rights.

## Local development

Run the Paperclip instance at `http://localhost:3100`. No local Cloud broker or
Tailscale OAuth app is required. The instance needs `tailscale` and `tailscaled`.
For a separate local userspace client, install the pinned programs outside the
checkout:

```sh
GOBIN="$HOME/.local/share/paperclip-tailscale/bin" go install tailscale.com/cmd/tailscale@v1.104.5
GOBIN="$HOME/.local/share/paperclip-tailscale/bin" go install tailscale.com/cmd/tailscaled@v1.104.5
```

Set `PAPERCLIP_TAILSCALE_CLI` and `PAPERCLIP_TAILSCALED` to their absolute paths.
These settings can be set in the supported `.env` files. Each new client reads
them at startup, after environment loading.

## Verification and rollout gates

Offline tests cover device sign-in without an auth key, saved state and restart,
separate company identities, initiator binding, cancellation and expiry, stale
completion, trusted credential versions, device approval, popup fallback, and
route authorization/CSRF. Existing tests retain legacy broker callback, SSH,
pairing, and network lifecycle coverage. These do not prove live consent or
remote execution.

Before rollout, qualify two unrelated customer tailnets through ordinary device
sign-in, machine discovery, and an agent task using its selected AI account that
writes a file on the selected computer, result streaming, cancellation, server
restart, machine sleep/reboot, and revocation. A local instance whose public URL
is localhost also needs an API path reachable by the remote agent for tasks that
call back to Paperclip unless the adapter uses the existing remote callback
bridge. Production Cloud uses its public HTTPS stack URL.

The connector's bundled artwork comes from the vendor's
`https://tailscale.com/favicon.png`, copied without modification (SHA-256
`680570c9090b604450792f68ceed10beeb33a69c9bccc2a92e398564c7075a5c`).

The old managed OAuth profile remains disabled unless explicitly configured for
its existing pilot. Its same-tailnet registration restriction does not apply to
the new device sign-in path. Do not configure a customer-specific OAuth app or
admit a pilot instance to make device sign-in work.

Provider references:

- [Device authentication](https://tailscale.com/docs/features/tsnet#device-creation-and-authentication)
- [Tailscale CLI](https://tailscale.com/docs/reference/tailscale-cli/up)
- [OAuth apps](https://tailscale.com/docs/features/oauth-apps)
- [Device provisioning](https://tailscale.com/docs/features/oauth-apps/device-provisioning)
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)
