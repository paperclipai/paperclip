# Roadmap

This document expands the roadmap preview in `README.md`.

Paperclip is still moving quickly. The list below is directional, not promised, and priorities may shift as we learn from users and from operating real AI companies with the product.

Status tracks the default branch: ✅ available, 🟡 partial or experimental, ⚪ planned. Check [release notes](https://github.com/paperclipai/paperclip/releases) for packaged versions. Some capabilities require instance settings, plugins, or provider setup.

We value community involvement and want to make sure contributor energy goes toward areas where it can land.

We may accept contributions in the areas below, but if you want to work on roadmap-level core features, please coordinate with us first in Discord (`#dev`) before writing code. Bugs, docs, polish, and tightly scoped improvements are still the easiest contributions to merge.

If you want to extend Paperclip today, the best path is often the [plugin system](doc/plugins/PLUGIN_SPEC.md). Community reference implementations are also useful feedback even when they are not merged directly into core.

## Milestones

### ✅ Plugin system

Paperclip should keep a thin core and rich edges. Plugins are the path for optional capabilities like knowledge bases, custom tracing, queues, doc editors, and other product-specific surfaces that do not need to live in the control plane itself.

### ✅ Get OpenClaw / claw-style agent employees

Paperclip should be able to hire and manage real claw-style agent workers, not just a narrow built-in runtime. This is part of the larger "bring your own agent" story and keeps the control plane useful across different agent ecosystems.

### ✅ companies.sh - import and export entire organizations

Reusable companies matter. Import/export is the foundation for moving org structures, agent definitions, and reusable company setups between environments and eventually for broader company-template distribution.

### ✅ Easy AGENTS.md configurations

Agent setup should feel repo-native and legible. Simple `AGENTS.md`-style configuration lowers the barrier to getting an agent team running and makes it easier for contributors to understand how a company is wired together.

### ✅ Skills Manager, Skill Studio & Skills Store

Agents need a practical way to discover, install, create, test, and share skills without every setup becoming bespoke. Skills Manager, Skill Studio, and the Skills Store make the skills layer reusable across an organization and easier to operate.

### ✅ Scheduled Routines

Recurring work should be native. Routine tasks like reports, reviews, and other periodic work need first-class scheduling so the company keeps operating even when no human is manually kicking work off.

### ✅ Better Budgeting

Budgets are a core control-plane feature, not an afterthought. Better budgeting means clearer spend visibility, safer hard stops, and better operator control over how autonomy turns into real cost.

### ✅ Agent Reviews and Approvals

Paperclip should support explicit review and approval stages as first-class workflow steps, not just ad hoc comments. That means reviewer routing, approval gates, change requests, and durable audit trails that fit the same task model as the rest of the control plane.

### ✅ Multiple Human Users

Paperclip needs a clearer path from solo operator to real human teams. That means shared board access, safer collaboration, and a better model for several humans supervising the same autonomous company.

### ✅ Cloud / Sandbox agent support

Sandbox provider plugins support remote execution while preserving the Paperclip control-plane model. Providers include E2B, Cloudflare, Daytona, Modal, Novita, and Kubernetes. Execution requires a configured provider and a compatible adapter; environment and isolated-workspace surfaces depend on instance settings.

### ✅ Artifacts & Work Products

Paperclip should make outputs first-class. That means generated artifacts, previews, deployable outputs, and the handoff from "agent did work" to "here is the result" should become more visible and easier to operate.

### ✅ Deep Planning (planning mode, revisioned plans, plan approvals)

Some work needs more than a task description before execution starts. Deeper planning means a dedicated planning mode, revisioned plans, and explicit plan approvals for strategy-heavy work before agents begin execution.

### ✅ Enforced Outcomes (watchdogs, recovery actions, review gates)

Paperclip should get stricter about what counts as finished work. Watchdogs, recovery actions, and review gates keep execution moving toward clear outcomes like merged code, published artifacts, shipped docs, or explicit decisions instead of vague status updates.

### ✅ MCP Tool Gateway & Apps (governed tool access)

MCP tools and apps should be available through a governed gateway instead of unmanaged direct access. Paperclip can apply company boundaries, approval gates, and activity attribution while giving agents the tools they need.

### ✅ Secrets Manager with per-agent access

Secrets need to be centrally managed without giving every agent every credential. Per-agent access, scoped bindings, and audited resolution keep sensitive integrations usable while preserving least privilege.

### ✅ Activity log & action attribution

Operators need a durable record of what changed and who initiated it. Activity history and clear action attribution make human, agent, and system actions inspectable across the control plane.

### ✅ Bounded run recovery

Recovery policies handle supported transient failures and interrupted runs, retain task ownership, and surface recovery actions when work needs human intervention. Retries are bounded and remain subject to budgets, approvals, and pause gates.

### ✅ Agent evals & feedback

Skill Studio provides saved test inputs, test runs, results, and version history. Task and document feedback helps people improve procedures. Automatic organizational learning remains a separate roadmap item below.

### 🟡 Memory / Knowledge

Experimental memory connections support Mem0, Zep, Supermemory, Cognee, and Honcho. The optional LLM Wiki plugin provides another knowledge workflow. A broader memory and knowledge surface for companies, agents, and projects remains a direction for future work. See [memory connections](doc/connections/MEMORY.md) for setup and availability.

### ⚪ MAXIMIZER MODE

This is the direction for higher-autonomy execution: more aggressive delegation, deeper follow-through, and stronger operating loops with clear budgets, visibility, and governance. The point is not hidden autonomy; the point is more output per human supervisor.

### ⚪ Work Queues

Paperclip should support queue-style work streams for repeatable inputs like support, triage, review, and backlog intake. That would make it easier to route work continuously without turning every system into a one-off workflow. Existing decision queues group items awaiting input; this milestone concerns continuous work intake and routing.

### ⚪ Self-Organization

As companies grow, agents should be able to propose useful structural changes such as role adjustments, delegation changes, and new recurring routines. The goal is adaptive organizations that still stay within governance and approval boundaries.

### ⚪ Automatic Organizational Learning

Paperclip should get better at turning completed work into reusable organizational knowledge. That includes capturing playbooks, recurring fixes, and decision patterns so future work starts from what the company has already learned.

### 🟡 Agent Chat (including CEO Chat)

Experimental Agent Chat provides persistent conversations with any agent, including leadership. Conversations keep their history and plans, then hand execution off to linked tasks. Agent Chat is off by default. Experimental chat and email connectors provide additional entry points through configured external services; they have separate setup and access controls.

### 🟡 Cloud deployments (multi-tenant isolation & company Import/Export shipped)

Local-first remains important, but Paperclip also needs a cleaner shared deployment story. Teams should be able to run the same product in hosted or semi-hosted environments without changing the mental model.

Shipped so far: multi-tenant isolation with per-company JWT keys and company-scoped cloud tenants, portable company Import/Export (zip bundles that move a company between instances, local or cloud), and cloud-managed instance bootstrap. Next: a blob-store relay so large instances can move without a hand-carried bundle.

### ⚪ Desktop App

A desktop app can make Paperclip feel more accessible and persistent for day-to-day operators. The goal is easier access, better local ergonomics, and a smoother default experience for users who want the control plane always close at hand.

### ⚪ Bring-your-own-ticket-system (Asana / Linear / Jira as on-ramps)

Existing ticket systems should be able to feed work into Paperclip without becoming the agent control plane themselves. Asana, Linear, and Jira can act as familiar on-ramps while Paperclip owns execution, governance, and outcomes.

### ✅ Connected Apps & governed actions

Apps and Connections provide a service catalog, custom MCP connections, personal and shared accounts, agent access controls, and per-action Allowed / Ask first / Off policies. Supported AI accounts also use Connections. Setup varies by provider and deployment; not every integration is one-click. Broader provider coverage and simpler setup remain ongoing work.
