export const permissionModel = [
  [
    "Provider availability",
    "Slack, Teams, and Telegram decide where the bot is installed or invited. GitHub decides which repositories belong to the App installation."
  ],
  [
    "Paperclip enablement",
    "Paperclip responds only in provider resources that a Paperclip administrator has enabled for this connection. Invitation or installation alone is not permission to create a task."
  ],
  [
    "Effective reach",
    "A message is eligible only when the provider delivers it, its resource is enabled in Paperclip, the connection is active, and the sender has authority for the requested action."
  ],
  [
    "Safe default",
    "The destination used for the successful setup test becomes the first enabled resource. Resources discovered later start disabled."
  ]
];

export const providerManagement = {
  Slack: {
    id: "14",
    slug: "slack-settings",
    short: "Slack",
    providerAction: "Add Maya to another Slack channel  ↗",
    providerActionHelp: "Opens Slack instructions. After Maya is invited, the channel appears here disabled.",
    settingsTitle: "Slack settings",
    settingsSubtitle: "Enable the Slack channels where Maya may create and continue tasks.",
    resourcesTitle: "Channels",
    resourcesIntro: "Only channels where Maya is already a member can be enabled.",
    resources: [
      ["#customer-support · Acme", "Invited in Slack · Enabled", true],
      ["#incidents · Acme", "Invited in Slack · Enabled", true],
      ["#product · Acme", "Invited in Slack · Not enabled", false]
    ],
    conversationToggles: [
      ["Allow direct messages", "People may start private tasks by messaging Maya.", true]
    ],
    accessTitle: "Slack access",
    accessSubtitle: "Decide how people are identified when they message Maya.",
    unlinkedLabel: "Allow unlinked people",
    unlinkedDetail: "In enabled channels, unlinked Slack members can start and continue tasks with restricted access.",
    identityHint: "Slack workspace ID + user ID",
    linked: [
      ["Ari Chen · U0184", "ari@acme.com · Member", "Revoke"],
      ["Sam Rivera · U0191", "sam@acme.com · Viewer", "Revoke"]
    ],
    conversationsTitle: "Slack conversations",
    conversationsSubtitle: "Conversations created through this connection.",
    openProvider: "Open Slack",
    conversations: [
      ["#customer-support · Refund timeout", "PAP-1842 · Refund workflow is failing", "Working · 18s"],
      ["#incidents · Queue delay", "PAP-1838 · Investigate queue delay", "Waiting · 12m"],
      ["Direct message · Ari Chen", "PAP-1831 · Customer export", "Completed · 2h"]
    ]
  },
  GitHub: {
    id: "17",
    slug: "github-settings",
    short: "GitHub",
    providerAction: "Manage GitHub installation  ↗",
    providerActionHelp: "Opens GitHub. Repositories added to the App installation appear here disabled.",
    settingsTitle: "GitHub settings",
    settingsSubtitle: "Enable the repositories where Maya may respond to mentions.",
    resourcesTitle: "Repositories",
    resourcesIntro: "Only repositories selected in the GitHub App installation can be enabled.",
    resources: [
      ["acme/api", "Available in GitHub installation · Enabled", true],
      ["acme/web", "Available in GitHub installation · Enabled", true],
      ["acme/docs", "Available in GitHub installation · Not enabled", false]
    ],
    conversationToggles: [],
    accessTitle: "GitHub access",
    accessSubtitle: "Decide how people are identified when they mention Maya.",
    unlinkedLabel: "Allow unlinked people",
    unlinkedDetail: "In enabled repositories, unlinked GitHub users can start and continue tasks with restricted access.",
    identityHint: "GitHub host + numeric user ID",
    linked: [
      ["arichen · 481902", "ari@acme.com · Member", "Revoke"],
      ["sam-rivera · 592113", "sam@acme.com · Viewer", "Revoke"]
    ],
    conversationsTitle: "GitHub conversations",
    conversationsSubtitle: "Conversations created through this connection.",
    openProvider: "Open GitHub",
    conversations: [
      ["acme/api · Issue #482", "PAP-1850 · Retry API timeouts", "Working · 3m"],
      ["acme/web · Pull request #912", "PAP-1846 · Review checkout change", "Waiting · 22m"],
      ["acme/api · Review thread", "PAP-1829 · Fix response typing", "Completed · 1d"]
    ]
  },
  "Microsoft Teams": {
    id: "20",
    slug: "teams-settings",
    short: "Teams",
    providerAction: "Add Maya to another team  ↗",
    providerActionHelp: "Opens Teams instructions. Channels in the newly installed team appear here disabled.",
    settingsTitle: "Microsoft Teams settings",
    settingsSubtitle: "Enable the Teams channels where Maya may create and continue tasks.",
    resourcesTitle: "Channels",
    resourcesIntro: "Only channels in teams where Maya is installed can be enabled.",
    resources: [
      ["Support / General · Acme", "Installed in Teams · Enabled", true],
      ["Engineering / Incidents · Acme", "Installed in Teams · Enabled", true],
      ["Product / General · Acme", "Installed in Teams · Not enabled", false]
    ],
    conversationToggles: [
      ["Allow direct messages", "People may start tasks in personal chats with Maya.", true],
      ["Allow group chats", "People may add Maya to a group chat and start tasks there.", false]
    ],
    accessTitle: "Microsoft Teams access",
    accessSubtitle: "Decide how people are identified when they message Maya.",
    unlinkedLabel: "Allow unlinked people",
    unlinkedDetail: "In enabled Teams conversations, unlinked members can start and continue tasks with restricted access.",
    identityHint: "Microsoft tenant ID + Entra object ID",
    linked: [
      ["Ari Chen · 62af…91c", "ari@acme.com · Member", "Revoke"],
      ["Sam Rivera · 74bd…10a", "sam@acme.com · Viewer", "Revoke"]
    ],
    conversationsTitle: "Microsoft Teams conversations",
    conversationsSubtitle: "Conversations created through this connection.",
    openProvider: "Open Teams",
    conversations: [
      ["Support / General · Refund timeout", "PAP-1861 · Fix refund timeout", "Working · 42s"],
      ["Engineering / Incidents · Queue delay", "PAP-1857 · Diagnose queue delay", "Waiting · 8m"],
      ["Personal chat · Ari Chen", "PAP-1841 · Export account history", "Completed · 4h"]
    ]
  },
  Telegram: {
    id: "23",
    slug: "telegram-settings",
    short: "Telegram",
    providerAction: "Add Maya to another Telegram chat  ↗",
    providerActionHelp: "Opens instructions. After Maya receives a message there, the chat appears here disabled.",
    settingsTitle: "Telegram settings",
    settingsSubtitle: "Enable the Telegram chats and topics where Maya may create and continue tasks.",
    resourcesTitle: "Chats and topics",
    resourcesIntro: "Only chats where the bot is present and discovered can be enabled.",
    resources: [
      ["Operations group", "Bot is present · Enabled", true],
      ["Support forum / Refunds", "Bot is present · Enabled", true],
      ["Product group", "Bot is present · Not enabled", false]
    ],
    conversationToggles: [
      ["Allow direct messages", "People may start private tasks by messaging Maya.", true]
    ],
    accessTitle: "Telegram access",
    accessSubtitle: "Decide how people are identified when they message Maya.",
    unlinkedLabel: "Allow unlinked people",
    unlinkedDetail: "In enabled chats, unlinked Telegram users can start and continue tasks with restricted access.",
    identityHint: "Telegram bot ID + numeric user ID",
    linked: [
      ["Ari Chen · 18409211", "ari@acme.com · Member", "Revoke"],
      ["Sam Rivera · 18410482", "sam@acme.com · Viewer", "Revoke"]
    ],
    conversationsTitle: "Telegram conversations",
    conversationsSubtitle: "Conversations created through this connection.",
    openProvider: "Open Telegram",
    conversations: [
      ["Operations group · Deployment alert", "PAP-1870 · Check deployment alert", "Working · 25s"],
      ["Support forum / Refunds", "PAP-1866 · Trace missing refund", "Waiting · 6m"],
      ["Private chat · Ari Chen", "PAP-1852 · Prepare customer export", "Completed · 3h"]
    ]
  }
};
