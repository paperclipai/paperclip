export const fixedBehavior = [
  [
    "Channel activation",
    "A root mention creates a provider-native thread and one Paperclip task on Slack and Teams. Replies in that thread continue the same task without another mention."
  ],
  [
    "Existing provider thread",
    "The first mention inside an unbound Slack or Teams thread binds that existing thread to one new Paperclip task. Earlier messages are not imported automatically."
  ],
  [
    "Direct messages",
    "One open task is active in a DM. A completed task stays closed; the next message starts a new task. New task or /new starts another task explicitly."
  ],
  [
    "GitHub conversations",
    "A mention binds the addressed issue, pull-request conversation, or inline review thread to one Paperclip task."
  ],
  [
    "Telegram conversations",
    "DMs and ordinary groups use one active task. A forum topic has one stable topic-to-task binding."
  ],
  [
    "Delivery",
    "Paperclip chooses direct verified webhooks when reachable and the instance relay when private. This is deployment configuration, not an endpoint preference."
  ],
  [
    "Credentials and drift",
    "Invalid credentials, revoked installs, missing membership, or permission drift appear in Activity with a reconnect or repair action. They are not ordinary settings."
  ]
];

export const providerSettings = {
  Slack: {
    id: "14",
    slug: "slack-settings",
    short: "Slack",
    title: "Slack settings",
    subtitle: "Choose where people can start conversations with Maya.",
    sections: [
      {
        kind: "resources",
        title: "Allowed channels",
        intro: "Maya responds only in the selected channels.",
        items: [
          ["#customer-support · Acme", "Maya is already a member"],
          ["#incidents · Acme", "Maya is already a member"]
        ],
        action: "Edit allowed channels"
      },
      {
        kind: "toggles",
        title: "Direct messages",
        intro: "Control whether people can start work privately.",
        items: [
          ["Allow direct messages", "A person can start a task by messaging Maya directly.", true]
        ]
      }
    ],
    annotations: [
      "The connector starts on Settings; the read-only Overview tab is removed.",
      "Workspace appears only as context on each allowed channel; allowed channels are the only Slack resource choice.",
      "Direct messages are one explicit on/off choice.",
      "Save persists only reach changes; thread boundaries, delivery, credentials, drift, and capabilities are absent."
    ]
  },
  GitHub: {
    id: "17",
    slug: "github-settings",
    short: "GitHub",
    title: "GitHub settings",
    subtitle: "Choose the repositories where people can mention Maya.",
    sections: [
      {
        kind: "resources",
        title: "Allowed repositories",
        intro: "Paperclip can narrow, but not exceed, the GitHub App installation.",
        items: [
          ["acme/api · GitHub", "Installed and allowed"],
          ["acme/web · GitHub", "Installed and allowed"]
        ],
        action: "Edit allowed repositories"
      }
    ],
    annotations: [
      "The connector starts on Settings; the read-only Overview tab is removed.",
      "The account and App installation are fixed; repository reach is the only normal GitHub chat setting.",
      "Save persists the repository allowlist; private-key or installation repair begins from Activity only when needed."
    ]
  },
  "Microsoft Teams": {
    id: "20",
    slug: "teams-settings",
    short: "Teams",
    title: "Microsoft Teams settings",
    subtitle: "Choose where people can start conversations with Maya.",
    sections: [
      {
        kind: "resources",
        title: "Allowed channels",
        intro: "Maya responds only in the selected Teams channels.",
        items: [
          ["Support / General · Acme", "Maya is installed in this team"]
        ],
        action: "Edit allowed channels"
      },
      {
        kind: "toggles",
        title: "Private conversations",
        intro: "Choose which non-channel conversations may start work.",
        items: [
          ["Allow direct messages", "A person can start a task in a personal chat with Maya.", true],
          ["Allow group chats", "People can add Maya to a group chat and start a task there.", false]
        ]
      }
    ],
    annotations: [
      "The connector starts on Settings; the read-only Overview tab is removed.",
      "Tenant and bot identity are fixed; the tenant appears only as context on allowed Teams channels.",
      "Personal and group chats are independent reach toggles.",
      "Save persists only reach changes; post boundaries, consent, delivery, credentials, and drift are absent."
    ]
  },
  Telegram: {
    id: "23",
    slug: "telegram-settings",
    short: "Telegram",
    title: "Telegram settings",
    subtitle: "Choose where people can start conversations with Maya.",
    sections: [
      {
        kind: "resources",
        title: "Allowed chats and topics",
        intro: "Maya responds only in the selected Telegram destinations.",
        items: [
          ["Operations group · Telegram", "Group chat"],
          ["Support forum / Refunds · Telegram", "Forum topic"]
        ],
        action: "Edit allowed chats"
      },
      {
        kind: "toggles",
        title: "Direct messages",
        intro: "Control whether people can start work privately.",
        items: [
          ["Allow direct messages", "A person can start a task in a private chat with Maya.", true]
        ]
      }
    ],
    annotations: [
      "The connector starts on Settings; the read-only Overview tab is removed.",
      "Allowed groups and forum topics are the Telegram resource choice.",
      "Direct messages are one explicit on/off choice.",
      "Save persists only reach changes; task boundaries, privacy, delivery, token rotation, and health are absent."
    ]
  }
};
