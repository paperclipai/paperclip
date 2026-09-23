I’d make this **built-in first, then an explicit choice of external provider**. The provider question belongs between connection search and the existing setup card.

One detail: Jira already exists in Paperclip’s catalog, so it should take the built-in path. We’ll use a fixture service absent from Paperclip’s catalog to test fallback reliably.

1. **Define the routing rules**

   | Search outcome | Agent behavior |
   |---|---|
   | Matching Paperclip connection is ready | Use it. |
   | Paperclip supports the service but needs setup | Show the existing connection card directly. |
   | No matching Paperclip connector | Find supported aggregator routes and ask which provider to use. |
   | Nothing supports it | Explain that no supported connection was found. |
   | An administrator denied access | Explain the restriction; don’t route around it through an aggregator. |

   Rank eligible aggregator routes **Composio → Arcade → Executor → Zapier**. Match the actual service, including aliases; an unrelated fuzzy-search result must not suppress fallback.

   An explicit request such as “connect through Arcade” takes precedence over the default ranking.

2. **Use the existing question UI for provider selection**

   Example, assuming two providers have verified support:

   > Paperclip doesn’t have a built-in connection for Example CRM. You can connect through Composio or Arcade. These are external services that will handle the connection and requests to Example CRM. Which would you like to use?

   Options:

   - **Composio — Recommended**
   - **Arcade**
   - **None for now**

   Show only providers with evidence of support, ordered by the requested priority. With four providers, show all four plus None; with one, still disclose the external service and offer it alongside None.

   Selecting a provider leads to **“Connect Example CRM through Composio”**, using the existing compact inline setup. If Composio is already connected and accessible, reuse it and move to the underlying app authorization.

   “None” stops this attempt without creating a connection, opening consent, or asking again on the next continuation. Explicitly choosing a provider in the original request skips the redundant selection question, but the card still identifies the external service.

3. **Separate provider support from account readiness**

   We cannot discover every provider’s capabilities by simply calling MCP `tools/list`.

   | Provider | Discovery and setup implications |
   |---|---|
   | **Composio** | Its meta-tools search app capabilities and initiate underlying app authorization. Connecting Composio alone does not connect the requested app. [Documentation](https://docs.composio.dev/docs/composio-connect) |
   | **Arcade** | A gateway exposes its selected tools. Arcade supporting an app does not mean the user’s gateway includes it; setup may require adding those tools. [Documentation](https://docs.arcade.dev/en/operate/governance/mcp-gateways) |
   | **Executor** | Availability depends on the workspace’s integrations. Being able to register an arbitrary upstream server is not evidence that an app is already supported. [Documentation](https://executor.sh/docs/mcp-proxy) |
   | **Zapier** | Agentic mode can discover and enable actions; Managed mode exposes the chosen actions. Discovery must account for the server’s mode. [Documentation](https://docs.zapier.com/mcp/overview/how-tools-work) |

   For users without aggregator accounts connected, use a maintained support index derived from official catalogs or verified integration recipes. Each entry carries its source, verification date, supported capabilities, and setup requirements. Validate available catalog feeds first; don’t assume these services share an anonymous discovery API.

   After selection, verify against the actual account or gateway. Distinguish **supported**, **requires gateway configuration**, **requires app authorization**, and **ready**. A lookup failure means “couldn’t verify,” not “unsupported.”

   Initial search remains read-only: no OAuth starts, integration registration, action enabling, or task-data requests merely to populate choices.

4. **Extend the current flow rather than introduce another connection system**

   The implementation would touch:

   - **`connections_search`:** return direct matches or structured aggregator alternatives, including the requested service, provider, support evidence, readiness, and next action.
   - **Agent guidance:** add the fallback-selection branch. Today it says to stop on unavailable results and discourages generic questions; clarify that choosing an external provider is the legitimate exception.
   - **Question interaction:** reuse `ask_user_questions`, with typed routing context so the submitted choice binds the service, provider, responsible user, requesting agent, and task.
   - **`connection_request`:** validate that choice before creating the aggregator setup card. Preserve it across retries, reloads, and continuation runs.
   - **Inline card:** retain “Example CRM through Composio” throughout setup. After aggregator setup, explicitly say if Example CRM still requires authorization.

   Keep the four independent connections, current credential vault and grants, and the experimental MCP aggregators flag. **Do not recreate the legacy Composio broker or create child connections for underlying apps.**

   Setup stays **Access → Connect**. Permissions and testing remain on the regular Permissions screen. Provider selection also does not narrow the permissions of an already allowed broad execution tool; those boundaries remain as documented.

5. **Add evals that test agent decisions and actual outcomes**

   Use the existing **Product E2E eval harness**, with real agents, browser interactions, server, and database. Deterministic aggregator fixtures make the routing scenarios reproducible.

   | Eval | Required proof |
   |---|---|
   | Built-in and aggregator both support the service | Built-in card; no provider-choice question. |
   | Only aggregators support it | Correct ordering and explicit external-service disclosure. |
   | User chooses the second provider | Only that provider’s setup opens and receives subsequent calls. |
   | User chooses None | No setup, authorization, execution, or repeated question. |
   | Aggregator already connected | Reuse eligible account; authorize the underlying app if needed. |
   | Gateway lacks the requested tools | Accurate configuration guidance; no false “ready” claim. |
   | Provider search fails or support is stale | Honest recovery; no invented support or silent provider switch. |
   | Reload/restart during selection or OAuth | Durable choice, one setup intent, correct continuation. |
   | Denied access, wrong identity, or experiment disabled | No fallback bypass or cross-account disclosure. |
   | Successful completion | Requested read returns a fixture marker verified independently. |

   Grade persisted choices, cards, grants, gateway calls, and results—not just the agent saying it worked. Include deliberately wrong traces to verify graders reject premature execution and undisclosed routing.

   Separately run live browser acceptance against each real provider. Fixture passes establish product behavior; they do not establish current provider compatibility.

6. **Deliver in reviewable stages**

   First confirm provider discovery sources and implement routing fixtures. Then build Storybooks for provider choice, disclosure, existing-account reuse, underlying authorization, decline, and recovery. After UX review, wire the production flow, run focused tests and narrowly selected agent evals, and finish with live provider walkthroughs.

   Completion requires both **correct routing decisions** and **successful use of the requested underlying app**—an aggregator connection showing “Connected” is insufficient.

---

## Addendum: search-result guidance

`connection_request` already returns an `instruction`; add the same pattern to `connections_search`.

For aggregator results, return a Paperclip-authored instruction such as:

> No built-in connection matches this service. Ask the user to choose Composio or Arcade using `ask_user_questions`. Explain that these are external services, list Composio first, and include “None for now.” Wait for their answer before requesting the selected connection. Do not claim the underlying app is connected yet.

Include structured provider options alongside that instruction so names, ordering, and service identifiers come from the search result.

Core agent guidance can then stay short:

> When service access is uncertain, call `connections_search` and follow its returned instruction. Use the connection tools for setup and respect recorded user choices.

The server still validates selection, access, and consent. The instruction guides the model; it does not replace enforcement. Evals should verify this works with the shorter core guidance.

---

## Implementation notes — 2026-09-23

The text above preserves the proposed plan and search-result guidance addendum.
Implementation is on `codex/connection-aggregator-fallback`, based on
`origin/master` at `b41ccf097`, in a fresh worktree.

- Shared routing definitions contain provider priority, a reviewed support index,
  disclosure/question construction, route parsing, and provider-specific next steps.
- `connections_search` now returns `instruction`, structured alternatives and
  `providerQuestion`. Core guidance remains provider-neutral. Search reads public
  support metadata and authorized cached tool catalogs without contacting providers.
- The existing question ID and option IDs carry the service/provider routing context.
  The server validates the persisted answer against the company, task, requesting
  agent, responsible human, disclosure, and current route eligibility. This replaces
  the proposed additional typed question-context field; no new interaction kind or
  database table is needed.
- `connection_request` accepts `selectionInteractionId` for `via:*` routes. Inline
  setup retains the requested app name, and continuation explicitly separates
  provider readiness from underlying app authorization. REST, MCP, native runtime,
  and CLI contracts are synchronized.
- None and pending choices survive continuation; explicit reconsideration uses
  `retryProviderChoice`. Native administrative restrictions and the experimental
  aggregator flag remain enforced.
- Storybooks reuse the production question and setup components. Three new Product
  E2E cases cover native preference, decline, and choosing/reusing Arcade; focused
  database tests cover the other routing and identity boundaries.

Initial discovery deliberately has finite coverage: a reviewed public index for
Composio, Arcade, and Zapier, plus app-specific evidence from authorized cached
workspace tools (including Executor). Broad execution tools alone are not evidence
of app support. No universal anonymous live provider search API is assumed.

Direct requests naming a provider continue through its existing direct setup path
without a redundant provider-choice question. App-specific card labeling is currently
carried by the structured `via:*` selection path; automatically extracting and
preserving the app from an explicit natural-language provider request remains a
follow-up.

Validation results and acceptance limits are recorded in
[the implementation report](../connections/2026-09-23-aggregator-routing-verification.md).
