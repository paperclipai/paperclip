export const providerScreens = [
  {
    id: "13", slug: "slack-setup", provider: "Slack", phase: "Setup", group: "Slack", kind: "providerSetup",
    title: "Invite Maya to Slack", subtitle: "Create or select a Slack app, then verify its workspace installation.",
    rationale: "Paperclip generates the exact provider handoff while keeping Slack-owned installation and workspace policy visible.",
    annotations: [
      "The selected Paperclip agent and derived Slack bot identity stay fixed throughout setup.",
      "Direct webhook is the default; relay and Socket Mode are advanced alternatives for private deployments.",
      "The generated manifest owns the exact scopes, events, interactivity URL, and optional command configuration.",
      "Secrets are masked references; workspace install or OAuth happens in Slack, not inside a Paperclip imitation.",
      "Verification separates identity, signature, scopes, events, and workspace membership so failures are actionable."
    ]
  },
  {
    id: "14", slug: "slack-settings", provider: "Slack", phase: "Configuration", group: "Slack", kind: "providerSettings",
    title: "Slack settings", subtitle: "Choose reach and rich behavior after the bot is connected.",
    rationale: "Slack exposes the richest optional surface, but least-privilege thread behavior remains the default.",
    annotations: [
      "Reach is the intersection of the saved allowlist and channels where Slack has actually added the bot.",
      "Root mention → Slack thread → one Paperclip issue is fixed; bound-thread replies continue without mentions.",
      "DMs, Agent Sessions, progress cadence, files, Block Kit, modals, commands, and ephemeral replies are independent controls.",
      "OAuth/Grid identity, token rotation, scope drift, and optional Socket Mode live under Security and delivery.",
      "Unsupported or ungranted features show a precise fallback and reinstall action instead of failing silently."
    ]
  },
  {
    id: "15", slug: "slack-interactions", provider: "Slack", phase: "Interactions", group: "Slack", kind: "providerInteractions",
    title: "Slack interaction model", subtitle: "A root mention moves the work into one native thread and one Paperclip issue.",
    rationale: "This makes the Hermes thread contract and Slack-specific acknowledgement/action deadlines inspectable.",
    annotations: [
      "A human mentions @maya in a channel root; an unmentioned fresh root message is ignored.",
      "Paperclip durably records and acknowledges the event before task work begins.",
      "Maya replies under the activation message; that Slack thread binds exactly one assigned Paperclip issue.",
      "Later human replies, files, and actions in the bound thread become turns after current permission checks.",
      "Safe streaming, stop/actions, final delivery, and error fallback stay in the thread; internal traces never publish."
    ]
  },
  {
    id: "16", slug: "github-setup", provider: "GitHub", phase: "Setup", group: "GitHub", kind: "providerSetup",
    title: "Connect Maya to GitHub conversations", subtitle: "Install a least-privilege GitHub App on selected repositories.",
    rationale: "GitHub chat setup deliberately excludes code/tool authority and makes repository installation scope explicit.",
    annotations: [
      "The purpose is Chat with an agent; repository code access remains a separate GitHub tool connection.",
      "GitHub App is recommended; PAT is marked testing-only and GitHub Enterprise adds an API base URL.",
      "Paperclip provides the webhook URL/secret and the minimum Issues, Pull requests, and Metadata permissions.",
      "The operator installs the App on selected repositories and stores the App ID/private key as secret references.",
      "Verification checks signature delivery, bot identity, subscribed events, installation, and selected repositories."
    ]
  },
  {
    id: "17", slug: "github-settings", provider: "GitHub", phase: "Configuration", group: "GitHub", kind: "providerSettings",
    title: "GitHub conversation settings", subtitle: "Choose repositories, activation surfaces, and comment behavior.",
    rationale: "The settings reflect GitHub's object-based threads and its narrower non-realtime interaction surface.",
    annotations: [
      "The Paperclip repository allowlist can only narrow the repositories selected in the GitHub App installation.",
      "Issues, PR conversations, and inline review-comment threads are distinct activation surfaces and bindings.",
      "Mention-only activation is the default; labels or trusted-author automation are explicit advanced policies.",
      "Output uses GFM, reactions, and coarse comment edits; files and governed actions become Paperclip links.",
      "Permission drift, installation suspension, GHES URL, rate limits, and self-message suppression are operational settings."
    ]
  },
  {
    id: "18", slug: "github-interactions", provider: "GitHub", phase: "Interactions", group: "GitHub", kind: "providerInteractions",
    title: "GitHub interaction model", subtitle: "A mention binds the existing issue, PR, or review thread to one Paperclip issue.",
    rationale: "GitHub supplies the conversation object, so Paperclip binds it rather than manufacturing a new native thread.",
    annotations: [
      "A user mentions the bot in an issue, PR conversation, or inline review comment.",
      "Webhook signature and delivery ID are verified before principal, repository, and activation checks.",
      "The existing GitHub object/thread maps once to a Paperclip issue; an inline review thread remains separate from the PR conversation.",
      "Maya reacts, posts or edits one GFM progress comment, and publishes the final answer without token streaming.",
      "Buttons, modals, ephemeral replies, DMs, and uploads fall back to text plus authenticated Paperclip URLs."
    ]
  },
  {
    id: "19", slug: "teams-setup", provider: "Microsoft Teams", phase: "Setup", group: "Teams", kind: "providerSetup",
    title: "Install Maya in Microsoft Teams", subtitle: "Register the app and bot, then install its package in the tenant.",
    rationale: "Teams setup exposes every external ownership boundary: Entra/bot registration, endpoint, package, tenant policy, and install.",
    annotations: [
      "Paperclip fixes Maya and supplies the public messaging endpoint before the operator enters Microsoft tooling.",
      "Teams Developer CLI is the recommended handoff; manual Azure/Developer Portal setup remains available.",
      "Client secret and federated identity are mutually exclusive; single-tenant, multi-tenant, and sovereign cloud are explicit.",
      "Custom-app upload or tenant approval may block installation and is reported as an external admin action.",
      "Verification covers Entra/bot identity, manifest, endpoint reachability, install scope, and tenant."
    ]
  },
  {
    id: "20", slug: "teams-settings", provider: "Microsoft Teams", phase: "Configuration", group: "Teams", kind: "providerSettings",
    title: "Microsoft Teams settings", subtitle: "Configure chat scopes and add privileged Graph access only when needed.",
    rationale: "Teams permissions are layered; basic mention/reply must work without broad directory or history grants.",
    annotations: [
      "Personal, team/channel, and group-chat reach is bounded by app installation and Paperclip allowlists.",
      "Channel post/reply threads map one issue; DMs and group chats use the stable Teams conversation.",
      "Mention-only is default. RSC all-message/history access is a per-resource, off-by-default grant.",
      "User directory lookup and DM history show their broader Entra application permission and admin-consent status.",
      "Adaptive Cards, task modules, targeted messages, files, and DM streaming expose exact group/channel fallbacks."
    ]
  },
  {
    id: "21", slug: "teams-interactions", provider: "Microsoft Teams", phase: "Interactions", group: "Teams", kind: "providerInteractions",
    title: "Microsoft Teams interaction model", subtitle: "The native conversation type determines threading, streaming, and permissions.",
    rationale: "Teams channel posts, group chats, and DMs need visibly different runtime behavior behind one endpoint.",
    annotations: [
      "A channel root mention starts work in that post's reply thread; the original post is the stable thread root.",
      "A DM or group-chat message binds the stable Teams conversation according to the configured task-boundary policy.",
      "Paperclip verifies the bot activity, resolves tenant/member identity, and applies current access before waking Maya.",
      "DMs can stream natively; group/channel output buffers or edits and uses Adaptive Cards/task modules for actions.",
      "RSC-disabled unmentioned traffic is ignored; denied or unsupported actions use targeted/DM or text-link fallback."
    ]
  },
  {
    id: "22", slug: "telegram-setup", provider: "Telegram", phase: "Setup", group: "Telegram", kind: "providerSetup",
    title: "Connect Maya to Telegram", subtitle: "Create a dedicated bot with BotFather, then choose webhook or polling delivery.",
    rationale: "Telegram has no managed installation object, so bot identity, delivery mode, privacy, and chat membership are separate checks.",
    annotations: [
      "One BotFather bot represents one Paperclip agent; name, username, avatar, and token come from Telegram.",
      "Privacy mode stays on and group joining is allowed; commands and forum-topic rights are optional provider setup.",
      "Verified webhook is production default; polling is for local long-running development and cannot run simultaneously.",
      "Paperclip supplies the HTTPS webhook URL and secret token, while the operator adds the bot to intended chats.",
      "Verification checks getMe identity, webhook/polling exclusivity, pending updates/errors, privacy guidance, and chat reach."
    ]
  },
  {
    id: "23", slug: "telegram-settings", provider: "Telegram", phase: "Configuration", group: "Telegram", kind: "providerSettings",
    title: "Telegram settings", subtitle: "Make task boundaries explicit for DMs, groups, and forum topics.",
    rationale: "Telegram's privacy mode and mostly linear chats require different continuation rules from Slack-style subscribed threads.",
    annotations: [
      "Allowed chats, topics, and users narrow the bot token's reach; privacy mode remains a visible safety assumption.",
      "DMs keep one active issue; /new or New task starts another, and /close ends the active binding.",
      "Groups activate on @maya and continue only through replies to the bot or new mentions; forum topics can map one issue each.",
      "Post-and-edit is default; native draft previews are private-chat-only and opt-in with a rate-safe cadence.",
      "Inline buttons, files, callback limits, no ephemeral/modal/select support, flood control, and bot-to-bot off are explicit."
    ]
  },
  {
    id: "24", slug: "telegram-interactions", provider: "Telegram", phase: "Interactions", group: "Telegram", kind: "providerInteractions",
    title: "Telegram interaction model", subtitle: "Privacy-safe replies and explicit New task controls replace universal native threads.",
    rationale: "The flow distinguishes private chats, ordinary groups, and forum topics rather than pretending Telegram behaves like Slack.",
    annotations: [
      "In a DM, the first message creates the active issue; /new or an inline button deliberately starts a fresh one.",
      "In a privacy-on group, @maya activates and a reply to Maya continues; unrelated group traffic is not consumed.",
      "In a forum, message_thread_id provides a stable topic-to-issue boundary when the bot is present.",
      "Paperclip deduplicates update_id, enforces actor/chat scope, then uses typing/reaction and throttled output.",
      "Inline callbacks carry opaque IDs; unsupported or governed interactions return concise text/DM plus a Paperclip link."
    ]
  }
];
