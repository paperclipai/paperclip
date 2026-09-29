export const baseSha = "d593463ab6394cd356bf27448ea28bad8cccf4ec";

const sharedAnnotations = {
  overview: [
    "The endpoint keeps one Paperclip agent and one provider-native bot identity together.",
    "Installation and delivery health are summarized before any configuration detail.",
    "Every safe capability available to this provider is included automatically; this is status, not a set of switches.",
    "Test, pause, reconnect, and remove remain ordinary connector lifecycle actions."
  ],
  access: [
    "The endpoint sponsor supplies the maximum authority available to unlinked external people.",
    "Linked provider identities act as their current Paperclip users and retain ordinary permission checks.",
    "Unlinked people use the restricted sponsored-guest profile and cannot perform governance actions.",
    "Provider identity and scope details make effective authority explainable and auditable."
  ],
  conversations: [
    "Each row names the provider-native conversation boundary and its single Paperclip issue.",
    "Participants, assigned agent, state, and last activity make live bindings scannable.",
    "Open in provider and Open task take an operator to either side of the binding.",
    "Detach preserves history and publication records; a later activation creates or claims a new binding."
  ],
  activity: [
    "Provider, credential, callback, and deployment-selected delivery health are summarized in one operational section.",
    "Inbound deliveries, callbacks, and outbound publications share a durable chronological ledger.",
    "Operators can inspect redacted errors and replay only safe, authorized failed deliveries.",
    "Rate limits, permission drift, uninstall or revocation, and provider-specific diagnostics stay visible."
  ]
};

export const providers = [
  {
    name: "Slack", short: "Slack", slug: "slack", ids: { setup: "13", settings: "14", walkthrough: "15", overview: "25", access: "26", conversations: "27", activity: "28" },
    setupTitle: "Invite Maya to Slack",
    setupSubtitle: "Create or select one Slack app, install it, and verify the workspace connection.",
    setupSections: [
      { title: "Agent and Slack identity", intro: "This endpoint represents exactly one Paperclip agent.", rows: [
        ["Paperclip agent", "Maya · Support engineer", "Change agent"],
        ["Slack bot", "Maya · @maya · avatar preview", "Preview"]
      ]},
      { title: "Choose delivery", intro: "Paperclip generates the callback address before the Slack app is created.", rows: [
        ["Recommended", "Direct signed webhook for cloud or public self-hosted Paperclip.", "Direct webhook"],
        ["Private Paperclip", "Use the outbound authenticated relay when this instance is not publicly reachable.", "Use relay"],
        ["Slack alternative", "Socket Mode uses an app token and one persistent listener.", "Advanced"]
      ]},
      { title: "Create and install the Slack app", intro: "The generated manifest contains the exact URLs, events, scopes, interactivity, and command declarations.", rows: [
        ["1. Copy app manifest", "Create a new Slack app from this versioned manifest.", "Copy manifest"],
        ["2. Install to workspace", "Slack owns workspace approval, OAuth, and Enterprise Grid policy.", "Open Slack"],
        ["3. Invite Maya", "Add @maya to each channel where people should be able to start work.", "Instructions"]
      ]},
      { title: "Connect credentials", intro: "Paperclip stores secret references, never raw values in endpoint configuration.", rows: [
        ["Bot or OAuth token", "Secret ref · slack/maya-bot ·•••• 8F2A", "Replace"],
        ["Signing secret", "Secret ref · slack/maya-signing ·•••• 0C91", "Replace"],
        ["App token", "Required only when Socket Mode is selected.", "Not set"]
      ]},
      { title: "Verify and activate", intro: "Each check fails independently so the operator knows where to fix the Slack app.", rows: [
        ["Identity and install", "Bot @maya · Acme workspace · membership detected", "Passed"],
        ["Security and events", "Signature challenge · scopes · subscriptions · interactivity", "Passed"],
        ["Test message", "Send a private setup check before activation.", "Send test"]
      ]}
    ],
    setupAnnotations: [
      "Agent and native bot identity are the first and only Paperclip binding decision.",
      "Direct webhook is the default; relay and Socket Mode are explicit deployment alternatives.",
      "Paperclip provides a manifest, while Slack owns app creation, approval, installation, and channel invitation.",
      "Tokens and signing secrets are masked secret references with independent rotation.",
      "Activation follows specific identity, signature, scope, event, interactivity, and membership checks."
    ],
    overviewSections: [
      { title: "Connection", intro: "One bot identity represents Maya in one Slack installation.", rows: [
        ["Status", "Active · last event 18 seconds ago", "Healthy"],
        ["Agent", "Maya · Support engineer", "Open agent"],
        ["Slack identity", "@maya · Acme workspace", "Open Slack"]
      ]},
      { title: "Installation and delivery", intro: "Operational details remain visible without reopening setup.", rows: [
        ["Installation", "OAuth workspace · 2 invited channels", "Connected"],
        ["Ingress", "Verified direct webhook · p95 acknowledgement 420 ms", "Healthy"],
        ["Credentials", "Bot token and signing secret", "No drift"]
      ]},
      { title: "Available automatically", intro: "Paperclip always uses the richest safe Slack behavior permitted by this installation.", rows: [
        ["Conversation", "Root mention creates a native thread; subscribed replies continue the same issue.", "Included"],
        ["Output", "Reaction receipt, native streaming or post/edit, safe milestones, final reply.", "Included"],
        ["Rich interaction", "Block Kit, buttons, selects, modals, slash commands, emoji, and stop.", "Included"],
        ["Files and privacy", "Bounded files, DMs, ephemeral response with DM/text fallback.", "Included"]
      ]},
      { title: "Lifecycle", intro: "Connection actions preserve the endpoint and its audit history.", rows: [
        ["Connection test", "Verify identity, permissions, events, and a private response.", "Test"],
        ["Maintenance", "Pause delivery, reconnect OAuth, rotate secrets, or remove endpoint.", "Manage"]
      ]}
    ],
    settingsSections: [
      { title: "Conversation reach", intro: "Paperclip can narrow reach but cannot exceed Slack installation and channel membership.", rows: [
        ["Workspace", "Acme · T02ACME", "Change install"],
        ["Allowed channels", "#customer-support, #incidents", "2 channels"],
        ["Direct messages", "People in this workspace may start a task in DM.", "Allowed"]
      ]},
      { title: "Task boundaries", intro: "Slack's native thread is the task boundary for channel work.", rows: [
        ["New channel work", "A root @maya mention creates the Slack thread and one Paperclip issue.", "Fixed"],
        ["Bound-thread replies", "Human replies continue without another mention.", "Subscribed"],
        ["Existing thread", "The first @maya mention may claim an unbound thread once.", "Allow"],
        ["Direct messages", "One active issue; New task starts another.", "Active task"]
      ]},
      { title: "Security and delivery", intro: "Paperclip reports the deployment-selected path; it is not an endpoint setting.", rows: [
        ["Delivery path", "Selected from instance reachability and verified continuously.", "Automatic"],
        ["Credential rotation", "Replace token or signing-secret references without changing bindings.", "Manage secrets"],
        ["Installation drift", "Pause affected resources when membership, scopes, or OAuth are revoked.", "Automatic"]
      ]}
    ],
    settingsAnnotations: [
      "Reach is an operator choice and is always bounded by the Slack installation and actual bot membership.",
      "Root mention, native thread creation, subscribed replies, and DM task boundaries are explicit.",
      "Delivery is read-only status; only credential rotation and installation repair require operator action here. Slack capabilities are reported on Overview and demonstrated in the walkthrough, never configured here."
    ],
    accessSections: [
      { title: "Endpoint sponsor", intro: "The sponsor supplies the upper bound for restricted guests.", rows: [
        ["Sponsor", "Dana · Company admin", "Change sponsor"],
        ["Endpoint scope", "Support project · #customer-support and #incidents", "View scope"]
      ]},
      { title: "Linked Slack people", intro: "Linked identities act as their mapped Paperclip users.", rows: [
        ["Ari Chen · U0184", "ari@acme.com · Member · confirmed Sep 3", "Revoke"],
        ["Sam Rivera · U0191", "sam@acme.com · Viewer · confirmed Sep 4", "Revoke"],
        ["Link another person", "Send an expiring sign-in and company-confirmation link.", "Create link"]
      ]},
      { title: "Unlinked people", intro: "Unlinked Slack users are sponsored external principals, not anonymous admins.", rows: [
        ["Restricted guest profile", "Comment, attach files, and receive safe output inside allowed tasks.", "Default"],
        ["Governance", "No approvals, budget changes, hiring, permissions, connection changes, or reassignment.", "Denied"]
      ]},
      { title: "Slack identity rules", intro: "Workspace ID plus Slack user ID is authoritative; display names and email hints are not.", rows: [
        ["Bots and apps", "Ignored unless an explicit audited endpoint-to-endpoint route permits them.", "Guarded"],
        ["Identity audit", "Every message records external ID, link state, sponsor, and effective authority.", "Enabled"]
      ]}
    ],
    conversationRows: [
      ["#customer-support · thread 172546.002", "PAP-1842 · Refund timeout", "Ari + 2 · Working · 18s", "Open Slack"],
      ["#incidents · thread 172511.119", "PAP-1838 · Queue delay", "Sam + 4 · Waiting · 12m", "Open Slack"],
      ["DM · D081MAYA", "PAP-1831 · Customer export", "Ari · Done · 2h", "Open Slack"]
    ],
    conversationBoundary: "Channel root and replies share thread_ts. A stable DM conversation uses the active-task lifecycle.",
    activityRows: [
      ["Inbound event", "Ev04K2 · message.channels · #customer-support", "Delivered · 18s"],
      ["Outbound publication", "Pub91A · native stream → final thread reply", "Delivered · 16s"],
      ["Interactive callback", "Act73C · Block Kit button · Ari", "Authorized · 4m"],
      ["Inbound event", "Ev04J8 · duplicate Slack retry", "Deduplicated · 9m"]
    ],
    activityHealth: ["Slack API · healthy", "Signed webhook · healthy", "OAuth scopes · current", "Rate limit · 84% remaining"]
  },
  {
    name: "GitHub", short: "GitHub", slug: "github", ids: { setup: "16", settings: "17", walkthrough: "18", overview: "29", access: "30", conversations: "31", activity: "32" },
    setupTitle: "Connect Maya to GitHub conversations",
    setupSubtitle: "Install a least-privilege GitHub App on the repositories where people will talk to Maya.",
    setupSections: [
      { title: "Agent and GitHub identity", intro: "This chat endpoint is separate from any GitHub code/tool connection.", rows: [
        ["Paperclip agent", "Maya · Support engineer", "Change agent"],
        ["Purpose", "People mention Maya in issues and pull requests.", "Chat only"],
        ["GitHub App identity", "paperclip-maya[bot] · avatar preview", "Preview"]
      ]},
      { title: "Choose GitHub host and app type", intro: "A GitHub App is the production path; PAT is only for a local test.", rows: [
        ["Host", "GitHub.com", "Change"],
        ["Authentication", "GitHub App with installation-scoped credentials.", "Recommended"],
        ["Enterprise Server", "Add a verified API and web base URL when selected.", "Not used"]
      ]},
      { title: "Create the GitHub App", intro: "Paperclip supplies exact webhook and least-privilege permission values.", rows: [
        ["Webhook URL and secret", "Public endpoint plus generated high-entropy secret reference.", "Copy values"],
        ["Repository permissions", "Issues write · Pull requests write · Metadata read.", "Copy list"],
        ["Events", "Issue comments and pull-request review comments.", "Copy list"]
      ]},
      { title: "Install on repositories", intro: "GitHub owns organization approval and repository selection.", rows: [
        ["1. Register app", "Create the app using the values above.", "Open GitHub"],
        ["2. Install app", "Choose Acme and only the repositories where chat is allowed.", "Open install"],
        ["3. Add credentials", "App ID and private key are stored as Paperclip secret references.", "Add secrets"]
      ]},
      { title: "Verify and activate", intro: "Code access is intentionally absent from this connection.", rows: [
        ["Webhook", "Signature, delivery ID, and subscribed event verified.", "Passed"],
        ["Installation", "Acme org · acme/api and acme/web", "Passed"],
        ["Permissions", "No Contents, Actions, or Administration grant.", "Least privilege"],
        ["Test mention", "Create a private test issue or use an existing allowed issue.", "Send test"]
      ]}
    ],
    setupAnnotations: [
      "The endpoint is explicitly chat-only; repository code/tool credentials stay separate.",
      "GitHub App is the production default, with host and Enterprise Server handled before registration.",
      "Paperclip gives the operator exact webhook, permission, and event values in one vertical sequence.",
      "GitHub owns organization approval and repository selection; Paperclip stores only secret references.",
      "Verification proves delivery and installation while confirming that broad code permissions were not granted."
    ],
    overviewSections: [
      { title: "Connection", intro: "One GitHub App bot represents Maya in the selected installation.", rows: [
        ["Status", "Active · last delivery 3 minutes ago", "Healthy"],
        ["Agent", "Maya · Support engineer", "Open agent"],
        ["GitHub identity", "paperclip-maya[bot] · Acme installation", "Open GitHub"]
      ]},
      { title: "Installation and delivery", intro: "Repository reach and webhook health stay explicit.", rows: [
        ["Repositories", "acme/api, acme/web", "2 selected"],
        ["Webhook", "Signature verified · delivery IDs deduplicated", "Healthy"],
        ["Permissions", "Issues and Pull requests write · Metadata read", "Current"]
      ]},
      { title: "Available automatically", intro: "Paperclip uses every safe interaction GitHub exposes for this chat connection.", rows: [
        ["Conversation", "Issue, PR conversation, and inline review-thread mentions.", "Included"],
        ["Output", "Reaction receipt, GFM response, coarse edit-in-place progress, final comment.", "Included"],
        ["Files and actions", "Ingest safe linked attachments; publish artifacts and governed actions as Paperclip links.", "Included"],
        ["Fallback", "Unsupported stream, DM, ephemeral, modal, or button behavior becomes text plus a link.", "Automatic"]
      ]},
      { title: "Lifecycle", intro: "Operate the App installation without conflating it with tool access.", rows: [
        ["Connection test", "Verify signature, bot identity, selected repositories, and comment response.", "Test"],
        ["Maintenance", "Pause, rotate private key, repair installation, or remove endpoint.", "Manage"]
      ]}
    ],
    settingsSections: [
      { title: "Repository reach", intro: "Paperclip can only narrow repositories selected in the GitHub App installation.", rows: [
        ["Installation", "Acme organization · installation 48219", "Change install"],
        ["Allowed repositories", "acme/api, acme/web", "2 repositories"],
        ["Conversation surfaces", "Issues, PR conversations, and inline review threads.", "All supported"]
      ]},
      { title: "Task boundaries", intro: "GitHub's existing object or review thread is the durable conversation boundary.", rows: [
        ["Activation", "A direct @paperclip-maya mention binds the addressed conversation.", "Mention"],
        ["Pull requests", "The PR conversation and each inline review thread remain distinct.", "Separate"],
        ["Trusted automation", "Optional label or trusted-author activation creates work without a mention.", "Off"]
      ]},
      { title: "Delivery and security", intro: "These settings control the App and webhook—not individual response capabilities.", rows: [
        ["GitHub host", "github.com", "Change host"],
        ["Private key", "Secret ref · github/maya-app ·•••• A19C", "Rotate"],
        ["Installation drift", "Pause affected repositories after suspension or permission change.", "Automatic"]
      ]}
    ],
    settingsAnnotations: [
      "Repository and conversation-surface reach are the only content-scope choices.",
      "Existing GitHub objects supply the issue boundary; optional non-mention activation remains an explicit workflow choice.",
      "Host, private-key rotation, and installation drift are operational settings. GitHub response capabilities are reported on Overview and demonstrated in the walkthrough, never configured here."
    ],
    accessSections: [
      { title: "Endpoint sponsor", intro: "Sponsored authority is restricted to this installation and repository allowlist.", rows: [
        ["Sponsor", "Dana · Company admin", "Change sponsor"],
        ["Endpoint scope", "Support project · acme/api and acme/web", "View scope"]
      ]},
      { title: "Linked GitHub people", intro: "The durable GitHub numeric user ID is linked after Paperclip authentication.", rows: [
        ["arichen · 184201", "ari@acme.com · Member · confirmed Sep 3", "Revoke"],
        ["sam-r · 194118", "sam@acme.com · Viewer · confirmed Sep 4", "Revoke"],
        ["Link another person", "Create an expiring company-confirmation link.", "Create link"]
      ]},
      { title: "Unlinked contributors", intro: "Public or outside contributors never inherit repository or company governance authority.", rows: [
        ["Restricted guest profile", "Comment and receive safe output only inside an allowed bound issue.", "Default"],
        ["Governance", "No approvals, budgets, hiring, permissions, connection management, or reassignment.", "Denied"]
      ]},
      { title: "GitHub identity rules", intro: "Login names may change; installation ID and numeric actor ID remain authoritative.", rows: [
        ["Bot comments", "Self-authored comments and duplicate webhook deliveries are suppressed.", "Ignored"],
        ["Code access", "This chat identity does not grant Maya repository Contents or Actions access.", "Separate"]
      ]}
    ],
    conversationRows: [
      ["acme/api · Issue #418", "PAP-1848 · Retry regression", "Ari + 3 · Working · 3m", "Open GitHub"],
      ["acme/web · PR #992 conversation", "PAP-1844 · Login redirect", "Sam + 2 · Waiting · 28m", "Open GitHub"],
      ["acme/web · PR #992 review R881", "PAP-1843 · Cookie comment", "Ari · Done · 1h", "Open GitHub"]
    ],
    conversationBoundary: "Issue and PR conversation objects bind once. Each inline review-comment thread has its own external key.",
    activityRows: [
      ["Inbound delivery", "3b12a · issue_comment · acme/api#418", "Delivered · 3m"],
      ["Outbound publication", "Pub91B · GFM comment edit", "Delivered · 2m"],
      ["Inbound delivery", "3b129 · paperclip-maya[bot] self comment", "Suppressed · 8m"],
      ["Provider health", "Installation permission comparison", "No drift · 14m"]
    ],
    activityHealth: ["GitHub API · healthy", "Webhook signature · healthy", "Installation · active", "Rate limit · 4,284 remaining"]
  },
  {
    name: "Microsoft Teams", short: "Teams", slug: "teams", ids: { setup: "19", settings: "20", walkthrough: "21", overview: "33", access: "34", conversations: "35", activity: "36" },
    setupTitle: "Invite Maya to Microsoft Teams",
    setupSubtitle: "Register the bot, package the Teams app, install it to the intended scopes, and verify delivery.",
    setupSections: [
      { title: "Agent and Teams identity", intro: "One Teams bot application represents exactly one Paperclip agent.", rows: [
        ["Paperclip agent", "Maya · Support engineer", "Change agent"],
        ["Teams bot", "Maya · app and avatar preview", "Preview"],
        ["Messaging endpoint", "https://chat.paperclip.app/in/••••/teams", "Copy"]
      ]},
      { title: "Choose Microsoft environment", intro: "Tenant and identity model must be known before app registration.", rows: [
        ["Cloud", "Microsoft commercial cloud", "Change"],
        ["Tenant mode", "Single tenant · Acme", "Change"],
        ["Bot authentication", "Federated workload identity", "Recommended"]
      ]},
      { title: "Register and package the Teams app", intro: "Teams Developer CLI is the shortest supported handoff; manual registration remains available.", rows: [
        ["1. Verify tenant policy", "Custom app upload or tenant-admin distribution must be allowed.", "Open policy"],
        ["2. Create app and bot", "Use the copied endpoint and generated manifest values.", "Copy command"],
        ["3. Download app package", "Paperclip validates scopes, IDs, endpoint, and package consistency.", "Download"]
      ]},
      { title: "Install in Teams", intro: "Microsoft owns tenant approval and the personal, team, channel, or group-chat installation.", rows: [
        ["Install link", "Open the Teams client installation flow.", "Open Teams"],
        ["Admin-managed tenant", "Export the package for the Teams administrator when sideloading is blocked.", "Export package"],
        ["Credentials", "Client/app ID and federated identity metadata; secret ref only if client secret is used.", "Review"]
      ]},
      { title: "Verify and activate", intro: "Basic mention-based chat does not require broad Graph directory or history consent.", rows: [
        ["Registration", "Entra app, bot ID, tenant, and messaging endpoint", "Passed"],
        ["Manifest and install", "Personal/team/group scopes and installed package version", "Passed"],
        ["Teams doctor", "Package and endpoint checks", "Passed"],
        ["Test message", "Send a private installation check before activation.", "Send test"]
      ]}
    ],
    setupAnnotations: [
      "The selected agent, Teams identity, and copyable public endpoint lead the setup.",
      "Cloud, tenant mode, and exactly one bot-authentication strategy are chosen before registration.",
      "Paperclip provides CLI, manifest, and package values in a conventional top-to-bottom handoff.",
      "Tenant approval and installation happen in Microsoft Teams; Paperclip keeps the draft if admin action is required.",
      "Verification separates registration, manifest, endpoint, installation, and doctor checks without requesting broad Graph consent."
    ],
    overviewSections: [
      { title: "Connection", intro: "One Microsoft bot app represents Maya in the Acme tenant.", rows: [
        ["Status", "Active · last activity 6 minutes ago", "Healthy"],
        ["Agent", "Maya · Support engineer", "Open agent"],
        ["Teams identity", "Maya · Acme tenant", "Open Teams"]
      ]},
      { title: "Installation and delivery", intro: "App package, tenant, and bot endpoint are monitored independently.", rows: [
        ["Installation", "Personal and Support / General", "2 scopes"],
        ["Bot endpoint", "Authenticated activity delivery", "Healthy"],
        ["Identity", "Federated workload identity · single tenant", "Healthy"]
      ]},
      { title: "Available automatically", intro: "Paperclip uses the richest safe Teams behavior available in the current conversation scope.", rows: [
        ["Conversation", "Channel post threads plus explicit active-task behavior in DMs and group chats.", "Included"],
        ["Output", "DM-native streaming; buffered or edited channel/group responses and safe milestones.", "Included"],
        ["Rich interaction", "Adaptive Cards, buttons, task modules, files, reactions, and typing.", "Included"],
        ["Private fallback", "Targeted response when available, otherwise DM or ordinary text plus link.", "Automatic"]
      ]},
      { title: "Lifecycle", intro: "Package, registration, and consent health are connector operations.", rows: [
        ["Connection test", "Verify bot activity, package version, tenant, scopes, and response.", "Test"],
        ["Maintenance", "Pause, update package, repair consent, rotate identity, or remove.", "Manage"]
      ]}
    ],
    settingsSections: [
      { title: "Tenant and conversation reach", intro: "Paperclip narrows the scopes where the Teams app is installed.", rows: [
        ["Tenant", "Acme · 0f3c••••", "Change install"],
        ["Teams and channels", "Support / General", "1 channel"],
        ["Personal scope", "Allow installed users to start work in a DM.", "Allowed"],
        ["Group chats", "Allow installed group chats to start work.", "Allowed"]
      ]},
      { title: "Task boundaries", intro: "The Teams conversation type determines the durable issue boundary.", rows: [
        ["Channel posts", "A root mention and the replies beneath that post map to one issue.", "Post thread"],
        ["DM and group chat", "One active issue until a participant chooses New task.", "Active task"],
        ["Unmentioned replies", "Consume when the installed manifest permits; otherwise ask for another mention.", "Detect"]
      ]},
      { title: "Delivery and Microsoft consent", intro: "Consent changes what Microsoft delivers; it does not switch rendering features on and off.", rows: [
        ["Bot identity", "Federated workload identity · single tenant", "Manage"],
        ["Resource-specific consent", "Optional all-message delivery for one installed team or chat.", "Not granted"],
        ["Graph directory/history", "Privileged admin consent remains separate from basic live chat.", "Not granted"],
        ["Installation drift", "Pause an affected scope after package removal or consent revocation.", "Automatic"]
      ]}
    ],
    settingsAnnotations: [
      "Tenant, installed team/channel, personal, and group-chat reach are explicit scope choices.",
      "Channel threads and linear-conversation active tasks are different, visible issue boundaries.",
      "Bot identity, RSC, Graph consent, and installation drift are the only provider-level operations. Teams capabilities are reported on Overview and demonstrated in the walkthrough, never configured here."
    ],
    accessSections: [
      { title: "Endpoint sponsor", intro: "Sponsor authority is intersected with tenant and installed-resource scope.", rows: [
        ["Sponsor", "Dana · Company admin", "Change sponsor"],
        ["Endpoint scope", "Support project · Support / General", "View scope"]
      ]},
      { title: "Linked Microsoft people", intro: "Tenant ID and Entra object ID form the stable identity key.", rows: [
        ["Ari Chen · 31a0••••", "ari@acme.com · Member · confirmed Sep 3", "Revoke"],
        ["Sam Rivera · 8d11••••", "sam@acme.com · Viewer · confirmed Sep 4", "Revoke"],
        ["Link another person", "Create an expiring company-confirmation link.", "Create link"]
      ]},
      { title: "Unlinked participants", intro: "Guests, federated users, and tenant members all begin with restricted sponsored authority until linked.", rows: [
        ["Restricted guest profile", "Comment, attach files, and receive safe output inside an allowed issue.", "Default"],
        ["Governance", "No approvals, budgets, hiring, permissions, connection management, or reassignment.", "Denied"]
      ]},
      { title: "Microsoft identity and consent", intro: "Directory lookup may improve display metadata but never replaces the verified Teams actor key.", rows: [
        ["External and guest users", "Tenant context remains part of identity resolution and audit attribution.", "Guarded"],
        ["Bot-to-bot activity", "Ignored unless an explicit audited endpoint route permits it.", "Ignored"]
      ]}
    ],
    conversationRows: [
      ["Support / General · post 172998", "PAP-1851 · Refund timeout", "Ari + 4 · Working · 6m", "Open Teams"],
      ["Group chat · 19:chat_82d", "PAP-1847 · Launch brief", "Sam + 2 · Waiting · 31m", "Open Teams"],
      ["Personal · Ari / Maya", "PAP-1840 · Account export", "Ari · Done · 3h", "Open Teams"]
    ],
    conversationBoundary: "A channel root post and its replies are one issue. DM and group-chat conversations use an explicit active task.",
    activityRows: [
      ["Inbound activity", "Act44M · message · Support / General", "Delivered · 6m"],
      ["Outbound publication", "Pub92T · buffered reply + Adaptive Card", "Delivered · 5m"],
      ["Interactive callback", "Act43Z · card action · Ari", "Authorized · 18m"],
      ["Permission health", "Support / General RSC comparison", "Mention-only · 1h"]
    ],
    activityHealth: ["Bot endpoint · healthy", "App package · current", "Tenant install · active", "Graph/RSC · basic scope only"]
  },
  {
    name: "Telegram", short: "Telegram", slug: "telegram", ids: { setup: "22", settings: "23", walkthrough: "24", overview: "37", access: "38", conversations: "39", activity: "40" },
    setupTitle: "Invite Maya to Telegram",
    setupSubtitle: "Create one BotFather bot, choose a delivery mode, add it to chats, and verify privacy behavior.",
    setupSections: [
      { title: "Agent and Telegram identity", intro: "One Telegram username represents exactly one Paperclip agent.", rows: [
        ["Paperclip agent", "Maya · Support engineer", "Change agent"],
        ["Telegram bot", "Maya · @maya_acme_bot · avatar/about preview", "Preview"]
      ]},
      { title: "Create the bot with BotFather", intro: "Telegram owns username uniqueness, profile, group eligibility, and token issuance.", rows: [
        ["1. Create bot", "Use /newbot, then set display name and unique username.", "Open Telegram"],
        ["2. Configure profile", "Set avatar, about text, and group-joining policy.", "Copy values"],
        ["3. Keep privacy mode on", "The bot sees addressed group messages without consuming ambient traffic.", "Required"]
      ]},
      { title: "Choose delivery", intro: "Webhook and polling are mutually exclusive.", rows: [
        ["Production", "HTTPS webhook with Telegram secret-token verification.", "Webhook"],
        ["Private Paperclip", "Use the outbound relay to reach the same verified webhook handler.", "Use relay"],
        ["Local development", "One long-running poller; Paperclip removes any webhook first.", "Advanced"]
      ]},
      { title: "Connect token and chats", intro: "The bot token is a Paperclip secret reference and can be rotated independently.", rows: [
        ["Bot token", "Secret ref · telegram/maya-bot ·•••• 471A", "Replace"],
        ["Webhook URL and secret", "Generated endpoint and secret-token header value.", "Copy"],
        ["Add Maya to chats", "Invite the bot to groups or forums; topic administration is optional.", "Instructions"]
      ]},
      { title: "Verify and activate", intro: "Verification checks both provider state and the expected addressed-message behavior.", rows: [
        ["Bot identity", "getMe → @maya_acme_bot", "Passed"],
        ["Delivery", "getWebhookInfo · URL · secret · zero pending updates", "Passed"],
        ["Privacy and membership", "Privacy on · 2 allowed chats · forum topic access", "Passed"],
        ["Test message", "Send a DM or addressed group message before activation.", "Send test"]
      ]}
    ],
    setupAnnotations: [
      "Agent and unique Telegram bot username are the first binding decision.",
      "BotFather owns creation and profile controls; privacy mode stays on by default.",
      "Webhook, relay, and local polling are shown as mutually exclusive delivery paths.",
      "The token is a masked secret reference, while Telegram chat membership remains an external step.",
      "Activation verifies getMe, webhook or polling state, privacy, membership, pending updates, and a test message."
    ],
    overviewSections: [
      { title: "Connection", intro: "One BotFather identity represents Maya in the allowed chats.", rows: [
        ["Status", "Active · last update 1 minute ago", "Healthy"],
        ["Agent", "Maya · Support engineer", "Open agent"],
        ["Telegram identity", "@maya_acme_bot", "Open Telegram"]
      ]},
      { title: "Bot and delivery", intro: "Webhook state and BotFather policy are monitored separately.", rows: [
        ["Reach", "Operations group, Support forum / topic 381, DMs", "3 scopes"],
        ["Ingress", "Verified webhook · zero pending updates", "Healthy"],
        ["Bot policy", "Privacy on · may join groups", "Current"]
      ]},
      { title: "Available automatically", intro: "Paperclip uses every safe Telegram capability valid for the current chat type.", rows: [
        ["Conversation", "DM/group active task plus stable forum-topic binding.", "Included"],
        ["Output", "Typing or reaction receipt, throttled post/edit, private-chat draft previews when available.", "Included"],
        ["Rich interaction", "Inline callback and URL buttons, Markdown rendering, documents and media groups.", "Included"],
        ["Fallback", "Unsupported ephemeral, modal, or select interaction becomes reply or DM plus link.", "Automatic"]
      ]},
      { title: "Lifecycle", intro: "Operate the BotFather token and connector without changing task bindings.", rows: [
        ["Connection test", "Verify bot, delivery mode, privacy, membership, and response.", "Test"],
        ["Maintenance", "Pause, rotate the token, repair membership, or remove the endpoint.", "Manage"]
      ]}
    ],
    settingsSections: [
      { title: "Chat and participant reach", intro: "Allowed IDs narrow Telegram membership and BotFather group policy.", rows: [
        ["Allowed chats", "Operations group and Support forum", "2 chats"],
        ["Allowed topics", "Support forum · topic 381", "1 topic"],
        ["Direct messages", "People may start active tasks in private chat.", "Allowed"],
        ["Allowed users", "No additional principal allowlist inside the saved chat scope.", "All scoped"]
      ]},
      { title: "Task boundaries", intro: "Linear chats use an explicit active issue instead of pretending Telegram has Slack-style threads.", rows: [
        ["Direct message", "First message starts the active issue; New task or /new starts another.", "Active task"],
        ["Ordinary group", "@maya activates; replies to Maya or new mentions continue.", "Addressed"],
        ["Forum topic", "Stable message_thread_id maps one topic to one issue.", "Topic"]
      ]},
      { title: "BotFather policy and delivery", intro: "Paperclip reports the deployment-selected path; it is not an endpoint preference.", rows: [
        ["Delivery path", "Selected from instance reachability and verified continuously.", "Automatic"],
        ["Privacy mode", "Remain on so unrelated group traffic is not consumed.", "Required"],
        ["Token rotation", "Replace the secret reference after rotating with BotFather.", "Manage secret"],
        ["Delivery changes", "Paperclip drains pending updates if instance delivery changes.", "Automatic"]
      ]}
    ],
    settingsAnnotations: [
      "Chat, topic, DM, and optional user reach are real scope choices.",
      "DM/group active tasks and forum-topic bindings make Telegram's non-Slack boundaries explicit.",
      "Delivery is read-only status; privacy mode and token rotation are the only provider operations exposed here. Telegram capabilities are reported on Overview and demonstrated in the walkthrough, never configured here."
    ],
    accessSections: [
      { title: "Endpoint sponsor", intro: "Sponsor authority is bounded by saved chat, topic, and participant reach.", rows: [
        ["Sponsor", "Dana · Company admin", "Change sponsor"],
        ["Endpoint scope", "Support project · 2 chats and 1 topic", "View scope"]
      ]},
      { title: "Linked Telegram people", intro: "Telegram numeric user ID is authoritative; username is display metadata.", rows: [
        ["Ari · 58104412", "ari@acme.com · Member · confirmed Sep 3", "Revoke"],
        ["Sam · 59110284", "sam@acme.com · Viewer · confirmed Sep 4", "Revoke"],
        ["Link another person", "Send an expiring sign-in link in a private response.", "Create link"]
      ]},
      { title: "Unlinked people", intro: "Unlinked group and DM participants remain sponsored external principals.", rows: [
        ["Restricted guest profile", "Comment, attach bounded media, and receive safe output inside an allowed issue.", "Default"],
        ["Governance", "No approvals, budgets, hiring, permissions, connection management, or reassignment.", "Denied"]
      ]},
      { title: "Telegram identity rules", intro: "Forwarded messages, anonymous admins, and bots require explicit handling.", rows: [
        ["Anonymous/forwarded actor", "Do not infer a Paperclip user when a stable sender identity is absent.", "Restricted"],
        ["Other bots", "Ignore unless an explicit endpoint route and loop guards permit the message.", "Ignored"]
      ]}
    ],
    conversationRows: [
      ["DM · Ari / @maya_acme_bot", "PAP-1854 · Customer export", "Ari · Working · 1m", "Open Telegram"],
      ["Operations group · active task", "PAP-1850 · Alert routing", "Sam + 3 · Waiting · 22m", "Open Telegram"],
      ["Support forum · topic 381", "PAP-1846 · Refund queue", "Ari + 5 · Done · 2h", "Open Telegram"]
    ],
    conversationBoundary: "DM and ordinary group chats expose the active issue. Forum message_thread_id supplies a stable one-topic/one-issue key.",
    activityRows: [
      ["Inbound update", "Upd88422 · message · Ari DM", "Delivered · 1m"],
      ["Outbound publication", "Pub92G · post → 3 edits → final", "Delivered · 48s"],
      ["Callback query", "Cb814 · inline New task · Ari", "Authorized · 12m"],
      ["Inbound update", "Upd88411 · unrelated privacy-on group message", "Not delivered · expected"]
    ],
    activityHealth: ["Bot API · healthy", "Webhook · healthy", "Pending updates · 0", "Flood control · normal"]
  }
];

for (const provider of providers) {
  provider.overviewAnnotations = sharedAnnotations.overview;
  provider.accessAnnotations = sharedAnnotations.access;
  provider.conversationAnnotations = sharedAnnotations.conversations;
  provider.activityAnnotations = sharedAnnotations.activity;
}
