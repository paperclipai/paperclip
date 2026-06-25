# Roadmap

This document expands the roadmap preview in `README.md`.

Bizbox is still moving quickly. The list below is directional, not promised, and priorities may shift as we learn from users and from operating real AI companies with the product.

As a fork focused on enterprise usability, Bizbox prioritizes governance, compliance, and deployment flexibility ahead of consumer features.

We value community involvement and want to make sure contributor energy goes toward areas where it can land.

We may accept contributions in the areas below, but if you want to work on roadmap-level core features, please coordinate with us first before writing code. Bugs, docs, polish, and tightly scoped improvements are still the easiest contributions to merge.

If you want to extend Bizbox today, the best path is often the [plugin system](doc/plugins/PLUGIN_SPEC.md). Community reference implementations are also useful feedback even when they are not merged directly into core.

## Milestones

### ✅ Plugin system

Bizbox should keep a thin core and rich edges. Plugins are the path for optional capabilities like knowledge bases, custom tracing, queues, doc editors, and other product-specific surfaces that do not need to live in the control plane itself.

### ✅ Get OpenClaw / claw-style agent employees

Bizbox should be able to hire and manage real claw-style agent workers, not just a narrow built-in runtime. This is part of the larger "bring your own agent" story and keeps the control plane useful across different agent ecosystems.

### ✅ companies.sh - import and export entire organizations

Reusable companies matter. Import/export is the foundation for moving org structures, agent definitions, and reusable company setups between environments and eventually for broader company-template distribution.

### ✅ Easy AGENTS.md configurations

Agent setup should feel repo-native and legible. Simple `AGENTS.md`-style configuration lowers the barrier to getting an agent team running and makes it easier for contributors to understand how a company is wired together.

### ✅ Skills Manager

Agents need a practical way to discover, install, and use skills without every setup becoming bespoke. The skills layer is part of making Bizbox companies more reusable and easier to operate.

### ✅ Scheduled Routines

Recurring work should be native. Routine tasks like reports, reviews, and other periodic work need first-class scheduling so the company keeps operating even when no human is manually kicking work off.

### ✅ Better Budgeting

Budgets are a core control-plane feature, not an afterthought. Better budgeting means clearer spend visibility, safer hard stops, and better operator control over how autonomy turns into real cost.

### ✅ Agent Reviews and Approvals

Bizbox should support explicit review and approval stages as first-class workflow steps, not just ad hoc comments. That means reviewer routing, approval gates, change requests, and durable audit trails that fit the same task model as the rest of the control plane.

### ✅ Multiple Human Users

Bizbox needs a clearer path from solo operator to real human teams. That means shared board access, safer collaboration, and a better model for several humans supervising the same autonomous company.

### ✅ Deliverables & Work Products

Bizbox makes outputs first-class. Generated deliverables, previews, deployable outputs, and the handoff from "agent did work" to "here is the result" are now part of the product surface.

### ✅ AI Workflows

Bizbox now supports first-class multi-step workflow orchestration alongside the existing task model. You can define sequential or branching ADK workflow steps, add human-checkpoint steps that hand off to ClickUp for approval and continue automatically when approved, import workflow definitions from version-controlled directories, and use saved prompt templates as pre-filled run starters. The workflow detail page surfaces selectable run history for inspection. Google ADK workflows and join-node patterns are supported.

**Where to contribute:** Workflow graph visualization and layout improvements are actively in flight — see [open PRs](https://github.com/zesthq/bizbox/pulls) for the current shape. Feedback on the prompt-template API and ClickUp handoff ergonomics is welcome in Discussions.

### ⚪ Memory / Knowledge

We want a stronger memory and knowledge surface for companies, agents, and projects. That includes durable memory, better recall of prior decisions and context, and a clearer path for knowledge-style capabilities without turning Bizbox into a generic chat app.

### ⚪ Cloud / Sandbox agents (e.g. Cursor / e2b agents)

We want agents to run in more remote and sandboxed environments while preserving the same Bizbox control-plane model. This makes the system safer, more flexible, and more useful outside a single trusted local machine.

### ⚪ Enterprise SSO / SAML Integration

Enterprise teams need to authenticate through their existing identity providers. Bizbox should support SAML/SSO so teams can onboard through their corporate IdP without separate credential management.

### ⚪ Role-Based Access Control (RBAC)

Fine-grained permissions for board operators — so different human team members have different levels of access (read-only observer, approver, full operator) within a company or across companies in the same deployment.

### ⚪ Kubernetes / Helm Deployment

First-class Helm charts and Kubernetes deployment guides for enterprise teams running Bizbox on their own clusters.
