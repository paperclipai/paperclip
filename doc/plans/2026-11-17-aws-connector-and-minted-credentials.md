# AWS connector, and connectors that mint short-lived credentials

Status: proposal, 2026-11-17 (revised the same day). Supersedes the earlier
draft that ran an AWS proxy process on the control plane.

## The message

AWS should be a **remote MCP connector with credentials minted on the control
plane**. Nothing needs to run on our side:

1. The customer gives the AWS connection its own AWS identity. That is either
   a role that trusts only this connection, using signed tokens from the
   instance with no stored keys, or a dedicated access key. Nothing is shared
   across the instance.
2. At call time, the control plane uses that connection's identity to get a
   one-hour AWS bearer token, and calls AWS's hosted
   **AWS MCP Server** through the existing remote MCP gateway.
3. IAM decides what is allowed, CloudTrail records it, and Paperclip's
   gateway applies agent policy and logs every call.

Every piece is AWS-owned and documented for automated agents. We add no
process, no Python runtime, and no third-party code.

The product-wide feature this motivates is **minted credentials**: a
connection type can turn saved setup (a role, a service account, an app key)
into a short-lived token when it's needed, instead of storing a long-lived
key. AWS is the first provider.

Running connector MCP servers on the control plane is still a real future
need, but AWS no longer requires it. It is moved to its own plan (see
"Deferred" below).

## Where things run

- Agents run in sandboxes or VMs and call back to the control plane's MCP
  endpoints (for example `/mcp/native-runs/:runId`).
- The control plane's tool gateway executes connector calls
  ([tool-gateway.ts:9653](../../server/src/services/tool-gateway.ts)).
- Credentials are resolved inside the gateway at call time
  ([`resolveCredentialHeaders`, tool-gateway.ts:4392](../../server/src/services/tool-gateway.ts)).
  Vercel Connect already uses this seam to resolve short-lived tokens at
  invocation time (tool-gateway.ts:4460).

So minting, caching and use of the AWS token all happen on the control
plane. The agent's sandbox never sees AWS credentials.

## AWS options compared (checked 2026-11-17)

| Option | Owner | Status | Runs on our side | Verdict |
|---|---|---|---|---|
| **A. Hosted AWS MCP Server + bearer token from IAM** (`signin:CreateOAuth2TokenWithIAM`, client-credentials grant) | AWS | AWS-recommended server. Token flow documented for "AI agents running automated workflows". Official JS SDK: `@aws-sdk/client-signin`, `CreateOAuth2TokenWithIAMCommand`. | Nothing: two AWS API calls, then our existing remote MCP path | **Recommended** |
| B. Hosted AWS MCP Server via `mcp-proxy-for-aws` (SigV4 proxy) | AWS (`github.com/aws/mcp-proxy-for-aws`, Apache-2.0, v1.8.0 on 2026-11-03) | Official, maintained. AWS positions it for terminal and IDE clients. | A Python process per run on the control plane | Works, but adds a runtime and processes for no gain over A |
| C. `awslabs.aws-api-mcp-server` (local `call_aws`) | AWS Labs | **Superseded** by the hosted server (notice in its README and a migration guide) | Python process | Don't build on it |
| D. Role credentials in the agent's sandbox + `aws` CLI | AWS CLI | Stable | Nothing (sandbox) | Later, opt-in, for Terraform/CDK-style work. Ungoverned per call. |

What option A gives up compared with the proxy, and how we cover it:

- **Proxy `--read-only`** (hides tools that write): our gateway already
  classifies tools by reviewed risk. We can also mint read-only tokens through
  an IAM session policy (below), which is stronger because AWS enforces it.
- **Switching between accounts in one session**: one Paperclip connection is
  one AWS account and role. Companies with several accounts add several
  connections.
- **Default region metadata**: the proxy injects `AWS_REGION` into requests.
  The spike checks whether we can send the same metadata directly. Otherwise
  the region goes in the connection's agent instructions, and agents pass it
  per call.

## Design

### 1. Minted credentials (product-wide)

A new credential source for remote MCP methods, next to `paperclip_vault` and
`vercel_connect`:

```ts
interface CredentialMinter {
  // Saved setup + grant + effective agent policy -> short-lived headers.
  mint(input: {
    setup: ConnectionSetup;
    grant: Grant;
    scope: "read" | "write";
  }): Promise<{ headers: Record<string, string>; expiresAt: Date }>;
}
```

- **Cache** in memory per company, connection, grant and scope until five
  minutes before expiry. Tokens are never persisted or logged.
- **401 from the provider**: drop the cached token, mint once, and retry that
  call once. An authentication failure means the provider didn't execute the
  call, so the retry is safe.
- **Mint failure** (role deleted, trust changed) marks the connection's health
  with a plain-language reason ("Paperclip can no longer use the AWS role. Check
  that it still trusts Paperclip.") and never shows raw AWS errors to end
  users.
- **Restarts and deploys**: the cache is memory-only, so the next call after a
  restart simply mints again. There is nothing to recover and no Retry.

### 2. AWS minter

**Each connection carries its own AWS identity. Nothing is instance-wide.**
A connection is one AWS identity the customer created for it. Two connections
in the same company, even to the same AWS account, have separate credentials,
and deleting a connection revokes only its own.

A connection proves who it is in one of two ways. The customer picks one at
setup.

**Method 1 (recommended): AWS role, with no stored keys.** This uses OIDC
federation, the same mechanism GitHub Actions, GitLab and Vercel use to reach
AWS.

- *Once per company:* Paperclip publishes the company's issuer
  `https://<instance>/oidc/companies/<companyId>`. Its discovery document is
  at `<issuer>/.well-known/openid-configuration` and its public key set at
  `<issuer>/jwks.json` (see
  [the issuer design](./2026-11-17-workload-identity-issuer.md)). The private
  signing key stays in the instance's database, encrypted with the vault
  master key. It is separate from sign-in keys and is used only for these
  tokens.
- *Once per connection (customer, via CloudFormation):*
  - Register the company's issuer URL as an IAM OIDC identity provider.
    This is skipped if the account already has it.
  - Create a role whose trust policy allows
    `sts:AssumeRoleWithWebIdentity` only when the token's `sub` equals this
    connection (for example `connection:<id>`) and `aud` equals
    `sts.amazonaws.com`.
- *At call time:*
  1. Paperclip signs a 5-minute JWT: issuer is the company's issuer URL,
     `sub` is the connection, `aud` is `sts.amazonaws.com`.
  2. Paperclip calls `AssumeRoleWithWebIdentity`. That call needs no AWS
     credentials at all; the signed JWT is the proof.
  3. AWS checks the signature against the public keys at the company's
     issuer, then returns one-hour role credentials.
- *Requirements:*
  - The instance does not have to run on AWS. It only has to serve those two
    URLs over HTTPS with a publicly trusted certificate, reachable from the
    internet.
  - Paperclip Cloud instances qualify. Local, private-network or Tailscale-only
    instances don't, and use method 2.
  - The issuer URL must stay stable. Changing an instance's domain breaks
    existing trusts until the customer updates the identity provider.
- *What a compromise means:* an attacker holding a company's signing key
  could act as any of that company's connections, but only toward roles that
  already trust that company's issuer and that connection. Keys rotate by publishing
  the new key next to the old one.

**Method 2: access key.** The customer creates a dedicated IAM user for this
connection, optionally with a role to assume, and pastes the key pair. It is
stored as this connection's secret, like any API-key connector, and never
leaves the control plane. This works on any instance, including local ones.

Either way, identity belongs to the connection. Nothing is shared across the
instance.

Minting then works as follows:

1. Get role credentials:
   - Method 1 calls `AssumeRoleWithWebIdentity` with the signed JWT.
   - Method 2 with a role ARN calls `AssumeRole` with the stored key.

   Either call sets:
   - Session name: `paperclip-<connection name>`, so CloudTrail shows which
     connection acted.
   - Duration: one hour.
   - Read-scope tokens add the AWS managed `ReadOnlyAccess` policy as a
     session policy (`PolicyArns`). The session can then do at most what the
     role allows and what read-only allows.
   - With no role ARN, the dedicated IAM user's key is used directly. A
     read-only scope still applies, via a `GetFederationToken` session policy.
2. Sign-in `CreateOAuth2TokenWithIAM`:
   - Grant type is `client_credentials`.
   - Resource is `aws-mcp.amazonaws.com`.
   - The region is the endpoint region chosen at setup.
   - It returns a bearer token valid for about one hour, with no refresh token.
3. The token is used as `Authorization: Bearer …` to
   `https://aws-mcp.<region>.api.aws/mcp`.

### How agents call AWS (no AWS CLI anywhere)

Agents never receive the token. They see AWS tools the way they see any
connector's tools, through the control-plane MCP endpoint they're already
connected to:

1. The agent calls the `aws___call_aws` tool with the operation it wants
   (an AWS CLI-style command and its parameters), or calls `aws___run_script`
   with a short Python script that chains several calls.
2. The gateway on the control plane checks policy, attaches the connection's
   bearer token, and forwards the call to AWS's hosted MCP server.
3. **AWS runs the operation on its side.** That includes `run_script`, which
   runs in AWS's own sandbox. The result returns through the gateway to the
   agent.

So the AWS CLI isn't installed on the instance or in any sandbox. All the
control plane needs is the two token calls from the AWS JavaScript SDK
(`@aws-sdk/client-sts`, `@aws-sdk/client-signin`). The only path that would
need the CLI is option D, which is a later opt-in.

### 3. Governance

- Tools are discovered with a minted token and published to the catalog as
  for any remote MCP connector.
- Reviewed risk:
  - `aws___call_aws` and `aws___run_script` are writes.
  - Documentation, skill, region and task tools are reads.
  - `aws___get_presigned_url` is a write, because it can grant upload access.
- **Read-only agents keep `aws___call_aws`, called with a read-scope token.**
  AWS then refuses anything that isn't read-only, which beats hiding the
  main tool. Writes need an agent granted write scope, plus the normal approval
  policy.
- Every call goes through the gateway: activity log, timeouts, redaction.
  CloudTrail on the customer side shows the session name, so customers can see
  which Paperclip connection acted.

### 4. Setup experience

1. **Connect AWS** asks for one choice: **Role** (recommended, offered only
   when AWS can reach the instance over public HTTPS) or **Access key**.
   - The **Role** choice opens a one-click CloudFormation link, filled in
     with this company's issuer URL and this connection. It creates the identity
     provider (if missing) and a role trusted only by this connection, with
     `AWSMCPSignInOAuthAccessPolicy` (which allows the token exchange) and
     the permissions the customer picks (read-only to start, or their own
     policy).
   - The **Access key** choice's template creates a dedicated IAM user with
     the same policies.
2. The customer pastes the role ARN (or the key pair) and picks an endpoint
   region from the 8
   AWS publishes (us-east-1, us-west-2, eu-west-1, eu-west-2, eu-central-1,
   ap-southeast-1, ap-southeast-2, ap-northeast-1) and a default region for
   operations.
3. **Test** mints a token and lists tools, then reports the AWS account and role
   in plain words.
4. Agents get AWS tools through the normal agent or company install. Read
   scope is the default.

An optional second method, "Sign in with AWS as yourself" (a personal grant),
may need no code: the hosted server supports standard MCP OAuth with dynamic
client registration. Verify it in the spike.

## Phases (one PR each)

| # | Deliverable | Proof |
|---|---|---|
| 0 | Spike with a test AWS account (`~/.secrets`): assume a role, exchange for a token, list and call tools from Node. Check that a `ReadOnlyAccess` session policy carries into the token (through `AssumeRoleWithWebIdentity`, `AssumeRole` and `GetFederationToken`); that AWS accepts a JWT issued by a tunnelled local issuer URL, what the call inputs of `aws___call_aws` look like, whether region metadata can be sent, latency of the mint and the first call, and that the DCR OAuth method works. | Findings recorded in this doc |
| 1 | Minted-credential source in the gateway: minter interface, cache, single retry on 401, health reasons. | Red/green tests: cache hit and expiry, a 401 leads to one re-mint, mint failure sets health, nothing persisted or logged |
| 1b | Per-company workload-identity issuer (`/oidc/companies/<companyId>`): signing key stored in the database, encrypted with the vault master key; discovery and JWKS routes, key rotation, JWT signing for a connection. Built in [the issuer PR](./2026-11-17-workload-identity-issuer.md). Built generically, because GCP and Azure accept the same kind of federation. | Red/green tests; AWS accepts a token from a staging instance |
| 2 | AWS minter (role via OIDC, and access key), app definition, setup screen, CloudFormation template, reviewed tools, and `doc/connections/AWS.md` following the connector playbook. | Real-provider proof: a read-only agent's write is refused by AWS; a write agent's write succeeds after approval |
| 3 | Paperclip Cloud staging verification. | An AWS task completed on a staging stack |
| Later | Option D (sandbox credentials for Terraform/CDK). Further minters as connectors need them, such as GCP service-account impersonation or Azure client credentials. Each needs its own check of what the provider supports. | Separate plans |

## Success criteria

- An agent completes real AWS work end to end, locally and on staging. Its
  permissions come only from the customer's role, narrowed to read-only by
  default.
- No AWS credential or token reaches the agent's sandbox, the database or the
  logs.
- No process is added and no Python is added to the image.
- After a deploy, the next AWS call works with no Retry.
- The mint adds a measured, cached cost: at most once an hour per connection
  and scope.

## Open decisions for Dotta

1. **Decided: identity is per connection.** Role via OIDC is the default on
   public HTTPS instances, and an access key is the fallback everywhere.
   **Decided: one issuer per company**
   (`https://<instance>/oidc/companies/<companyId>`), so a customer's identity
   provider trusts only their own company, even on a shared instance.
2. **Read-only by AWS session policy** (recommended), rather than hiding the
   write tools. It needs `PolicyArns` support carried into the token, which the
   spike verifies.
3. **Offer option D later** (credentials in the sandbox for infrastructure
   agents), or never.

## Deferred: running connector MCP servers on the control plane

AWS no longer needs this. Other connectors will, whenever a provider ships
only a local server (Google Sheets is the current user). Findings to carry into
that plan:

- Today the gateway starts a new process **for each tool call** and kills it
  afterwards
  ([tool-gateway.ts:5517](../../server/src/services/tool-gateway.ts)).
- Runtime "slots" are bookkeeping only (`process.simulated: true`); they never
  own a process.
- Local processes are refused on public authenticated deployments unless
  `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` is set.
- The shape we sketched:
  - A lease per run (start on first call, stop at run end, idle or max age).
  - Pinned packages prefetched at connect time.
  - Minted credentials passed as environment variables, using the same minter
    interface as above.
  - A temporary home directory per lease.
  - Real process ownership in the supervisor.
  - Reviewed-only packages on Cloud.
- The trigger to start that plan is the first catalog connector whose provider
  has no hosted endpoint we can reach.
