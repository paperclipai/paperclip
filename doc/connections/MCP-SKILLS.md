# MCP Skills: skills that connected apps publish

Some MCP servers publish **skills** next to their tools: a `SKILL.md` with
instructions and, often, supporting files. When a connected app does, its skills
appear on the Skills page under **Skills from connected apps**. The board
reviews each one. Approved skills reach the agents that can use that app.

The first public server Paperclip was checked against is Hugging Face
(`https://huggingface.co/mcp`, no sign-in needed). It publishes 25 skills.

## The standard

These skills follow the **MCP Skills extension**:

- Specification: [SEP-2640, beta](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/beta/skills.mdx)
  ([overview](https://modelcontextprotocol.io/extensions/skills/overview)).
- Extension id: `io.modelcontextprotocol/skills`. It is defined for stateless MCP
  (2026-07-28), so Paperclip only uses it with servers on that version. See
  [MCP-PROTOCOL-VERSIONS.md](./MCP-PROTOCOL-VERSIONS.md).
- Skill format: [Agent Skills](https://agentskills.io/specification).

The protocol works like this:

1. **The server declares the extension** in `server/discover`:
   `capabilities.extensions["io.modelcontextprotocol/skills"]`.
2. **The client declares it too**, in each request's
   `_meta["io.modelcontextprotocol/clientCapabilities"].extensions`.
3. **`skills/list`** returns one entry per skill: the URI of its `SKILL.md`, its
   frontmatter verbatim, and a complete manifest of its files
   (`{uri, digest: "sha256:…", size}`), or `"dynamic"` for generated content.
   The result carries `ttlMs` and `cacheScope`.
4. **`skills/get {uri}`** returns one entry in the same shape.
5. **Files are read with `resources/read`.** `resources/directory/read` is
   optional; Paperclip does not use it, because the manifest already lists every
   file.

## How Paperclip implements it

| Layer | What happens | Code |
| --- | --- | --- |
| Client capability | Every stateless request declares `io.modelcontextprotocol/skills`. Handshake (legacy) sessions do not. | `mcpClientCapabilities` in `server/src/services/mcp-http.ts` |
| Server capability | What `server/discover` advertised is remembered beside the connection's protocol version, so a refresh knows whether the server serves skills without asking again. | `rememberMcpServerCapabilities` in `mcp-http.ts` |
| Discovery | A catalog refresh lists skills (`skills/list`, paged) after the tool catalog, only when the server declared the extension. A listing within its `ttlMs` is reused and changes nothing. A skills failure never fails the tool refresh. Nothing runs while an agent run starts. | `discoverSkills` in `server/src/services/tool-access/catalog/discovery.ts`, `refreshSkills` in `catalog/publication.ts` |
| Record | One `tool_mcp_skills` row per skill, keyed by company, connection and skill URI. The name is a label only. The row keeps the verbatim frontmatter, the manifest sorted by URI, and the manifest digest. | `packages/db/src/schema/tool_access.ts`, `server/src/services/mcp-skills.ts` |
| Review | New skills wait for review. Approving binds to the manifest digest the board saw; a request with any other digest is refused (409). A changed manifest or frontmatter moves an approved skill back to review. Reordering the manifest is not a change. | `mcpSkillsService.applyEntry` and `approve` |
| Run time | When a run starts, approved skills of the connections the agent can use (tools allowed or Ask first, and a grant that resolves) are loaded. `SKILL.md` is read with the agent's own grant, checked, and cached. Each becomes a per-run skill bundle on the connector skill path. | `resolveConnectionSkillsForRun` in `server/src/services/tool-gateway.ts`, `server/src/services/mcp-skill-runtime.ts`, `heartbeat/execution-configuration.ts` |
| Supporting files | Bundles contain only `SKILL.md`. Agents read other files with `GET /api/agents/me/mcp-skills/:skillId/files?path=…`, which needs an active run, access to the app, and a path in the approved manifest. The sandbox bridge allows this route. | `server/src/routes/mcp-skills.ts`, `readConnectionSkillFile` |
| API (board) | `GET /api/companies/:companyId/mcp-skills`, `GET …/:skillId/content` (read `SKILL.md` before deciding, with the viewer's own access), `POST …/:skillId/approve` with `{manifestDigest, allowTools}`, `POST …/:skillId/decline`. | `server/src/routes/mcp-skills.ts` |
| UI | The Skills page lists connected-app skills with their app, state, size, requested tools and a plain-language note. It renders nothing when there are none. | `ui/src/components/skills/ConnectedAppSkills.tsx` |

## Security requirements and how each is met

The spec's host requirements were treated as day-one requirements.

- **Identity is (server, URI).** Rows, approvals, the file cache, the agent file
  route and bundle paths are keyed by connection and URI (or by the skill row,
  which is). Two apps can serve `skill://refunds/SKILL.md`; they are two skills.
- **No silent shadowing.** A connected app's skill runs under a name in that
  app's namespace (`<app>-<skill>`). A remaining clash gets a suffix derived from
  the connection and URI. Nothing replaces a company skill or another app's
  skill. The board sees a note when names collide.
- **Verification before use.** Every file read checks the byte size, then the
  SHA-256, against the approved manifest. `SKILL.md` frontmatter is parsed with
  the skills system's own parser and compared field by field with the listed
  frontmatter. A YAML form that parser cannot read faithfully fails closed.
  Content that fails is never used. Paperclip calls `skills/get`; if the
  manifest changed the skill goes back to review, and if the same manifest
  served different bytes the skill is taken out of use (`verification_failed`).
  An unknown skill (`-32602`) is marked as removed.
- **Reads stay in the manifest and in the origin.** Only listed files are read,
  and only through the skill's own connection. A path outside the skill root or
  not in the manifest is refused.
- **Lazy retrieval.** Listing, approving and reviewing fetch no files. `SKILL.md`
  is fetched when a run loads the skill (or when the board opens it to read);
  a supporting file when an agent reads it.
- **Content-bound approval.** Approval binds to every `{uri, digest, size}` in the
  manifest. Any other manifest revokes it and is logged
  (`tool_mcp_skill.approval_revoked`).
- **Untrusted content, tagged origin.** Each bundle starts with a note naming the
  app and the skill URI and saying the instructions come from that app. The
  description ends with "(Skill from the <app> app.)".
- **No implicit permission grants.** Paperclip writes the bundle's frontmatter
  itself: `name`, `description`, and `allowed-tools` only when the board ticked
  "Also let it use" when approving. Other frontmatter fields from the app (hooks,
  metadata and so on) never reach the agent's skill loader. A nested `SKILL.md`
  is listed as a reference file, not a skill.
- **No implicit execution.** Approval is explicit and per skill. The approval
  note says agents may follow the skill's instructions, including commands.
- **Cache integrity.** Verified bytes live in `tool_mcp_skill_files`, written only
  by the server, keyed by connection, URI and digest, never changed in place, and
  re-hashed on every read. Nothing scans it for skills. Deleting a connection
  deletes its skills and cached files.
- **Dynamic skills are declined.** A `"dynamic"` skill has no digests, so it is
  shown as not available with a note and cannot be approved. Skills over the
  spec limits (512 files or 16 MiB) or with an invalid entry are shown the same
  way with their reason.

## Governance

Approving or declining is a skill install decision. It needs board access, the
`skill_config:update` permission, and the company skill policy's
`skills.install` for source type `external_package` with source locator
`mcp-connection:<connectionId>`. A policy rule can therefore block skills from
one app or from all connected apps.

## Performance

A run in a company without an approved connected-app skill pays one indexed
read. With approved skills, loading runs in parallel with the other skill
preparation. Against Hugging Face, loading three approved skills took 135 ms
cold and 13 ms from the cache. A run waits at most 3 seconds for connected-app
skills. A skill that cannot load in that time, or at all, is left out with a run
warning (`skills.mcp_unavailable`); it never fails the run. A read still in
flight at the deadline finishes in the background and fills the cache, so the
next run has the skill.

## Not yet supported

- Opting in to dynamic skills per connection.
- Serving Paperclip's own company skills from its MCP endpoint
  (`server/src/routes/public-mcp.ts`).
- `resources/directory/read`, and loading a skill by URI from server
  instructions without a listing.
- Showing connected-app skills on an agent's skills tab.
