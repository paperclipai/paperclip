# Connections Glossary

Audience: engineers, designers, and agents writing integration code, plans, or
product copy on the Apps v2 substrate.

Source: the accepted vocabulary table from the [PAP-13211](/PAP/issues/PAP-13211)
plan. Treat these definitions as product law when translating old Connections
v1, plugin, skill, MCP, and gateway language onto Apps v2.

## Canonical Vocabulary

| Term | Definition | It is NOT |
| --- | --- | --- |
| App | Catalog entry for an external or first-party system: metadata, supported transports, auth modes, and action catalog. The unit of the store. | A running thing; a plugin. |
| Connection | A configured, credentialed instance of an app for this company, possibly per-user account. Carries status and health. | A plugin install; an MCP server config file. |
| Action / Tool | One invokable capability of a connection, risk-classified and quarantined when new or changed. | A free-form shell command or permission grant. |
| Profile | Curated allowlist of actions bound to a scope such as company, project, agent, routine, or issue. | A permission system of its own. |
| Rule | Allow, ask-first, or block per action. Ask-first lands in the Review queue. | A profile or catalog entry. |
| Gateway | Named inbound MCP endpoint exposing curated connections/tools to external clients under a scoped bearer token. Reuses profiles and rules. | A new permission model. |
| Plugin | Code extension package: workers, UI, migrations. May declare apps/providers and provision skills. Packaging, not governance. | An integration per se. |
| Skill | Instructions an agent follows. May use connections; must not own tokens. | A token store. |
| MCP | A wire protocol; one transport apps may support. | A product category. |
| Broker | The run-time service that turns a stored credential plus a grant into a short-lived, downscoped, attributed token. | A vault or a permission model. |

## Product Copy Defaults

Use these words in prosumer surfaces:

- app
- connect
- connection
- allowed
- ask-first
- review

Keep protocol and implementation terms behind Developer or Advanced surfaces:

- MCP
- stdio
- gateway
- plugin
- manifest
- DCR
- PKCE
- schema hash
- bearer token
- secret ref

## Apps v2 Object Mapping

| Vocabulary term | Apps v2 object or surface |
| --- | --- |
| App | `tool_applications`, provider gallery cards, app detail metadata. |
| Connection | `tool_connections`, connection detail status/health, setup/configure flows. |
| Action / Tool | Catalog entries discovered from MCP/OpenAPI/vendor wrappers. |
| Profile | Access profiles and bindings. |
| Rule | Policy rules such as allow, ask-first, block, rate limit, and trust rules. |
| Gateway | Inbound MCP gateway sessions and scoped client tokens. |
| Plugin | Extension packaging that may declare apps but does not bypass governance. |
| Skill | Agent instruction package that calls governed connections through Paperclip. |
| MCP | Transport option for apps and gateways. |
| Broker | Credential resolver/token broker path over `company_secrets`. |

## Translation Rules

- MCP is a transport, not the information architecture.
- A plugin may bundle an app, but governance always flows through the connection,
  profile, rule, broker, and audit model.
- A skill may use Slack, Google Drive, Ramp, or another vendor, but the durable
  credential belongs in `company_secrets` and is reached through a connection.
- Inbound clients use scoped Paperclip auth; outbound vendor calls use the Apps
  v2 connection governance stack.
