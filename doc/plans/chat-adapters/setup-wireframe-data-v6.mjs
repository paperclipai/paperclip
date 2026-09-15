export const setupFlows = [
  {
    provider: "Slack",
    short: "Slack",
    screens: [
      {
        id: "13",
        slug: "slack-add",
        title: "Connect a Slack app",
        subtitle: "Bring your own Slack app using Paperclip's prepared manifest.",
        rail: ["Agent selected", "Connect Slack app", "Try Maya"],
        active: 1,
        mode: "default",
        instructions: [
          ["Copy the manifest", "Create a Slack app From an app manifest in the target workspace."],
          ["Install the app", "Open OAuth & Permissions, install it to the workspace, and copy the Bot User OAuth Token."],
          ["Copy the signing secret", "Open Basic Information and copy the App's Signing Secret."]
        ],
        fields: [
          ["Bot User OAuth Token", "xoxb-••••••••••••"],
          ["Signing Secret", "••••••••••••"]
        ],
        primary: "Connect Slack app",
        secondary: "Open Slack app settings",
        actions: [
          ["Connect Slack app", "Stores the two write-only credentials and verifies the Slack bot identity and required scopes."],
          ["Open Slack app settings", "Opens Slack's app-management page where the operator creates and installs the customer-owned App."]
        ],
        annotations: [
          "The prepared manifest and exact provider locations make the customer-owned App the complete required path.",
          "Only the Bot User OAuth Token and Signing Secret are entered, and both remain write-only.",
          "Managed Add to Slack is an optional later convenience and cannot gate this path or release."
        ],
        rationale: "Bring-your-own credentials are sufficient to ship; managed installation remains optional."
      },
      {
        id: "41",
        slug: "slack-try",
        title: "Try Maya in Slack",
        subtitle: "Start one task and reply to it once.",
        rail: ["Agent selected", "Connect Slack app", "Try Maya"],
        active: 2,
        mode: "default",
        instructions: [
          ["Open a channel", "If Slack asks, add Maya with /invite @Maya."],
          ["Start a task", "Post “@Maya help me test this” as a new channel message."],
          ["Continue the task", "Reply once in the thread Maya creates; no second mention is needed."]
        ],
        primary: "Open Slack",
        actions: [
          ["Open Slack", "Opens the installed workspace while Paperclip waits for the root mention and thread reply to complete setup."]
        ],
        annotations: [
          "The body is only the three actions needed to test the real Slack interaction.",
          "The instructions teach the root-mention-to-thread Paperclip task boundary.",
          "There is one action: open Slack and perform the test."
        ],
        rationale: "Installation health and automatic verification do not belong on an instruction screen."
      }
    ]
  },
  {
    provider: "GitHub",
    short: "GitHub",
    screens: [
      {
        id: "16",
        slug: "github-create",
        title: "Create Maya in GitHub",
        subtitle: "Create a dedicated GitHub App from Paperclip's prepared manifest.",
        rail: ["Agent selected", "Create GitHub App", "Choose repositories", "Try Maya"],
        active: 1,
        mode: "default",
        instructions: [
          ["Choose the owner", "Select your personal account or the organization that should own the App."],
          ["Create the App", "Keep the suggested unique name, then click Create GitHub App."]
        ],
        primary: "Create in GitHub",
        secondary: "Use an existing GitHub App",
        actions: [
          ["Create in GitHub", "Posts Paperclip's App Manifest to GitHub. GitHub returns to Paperclip after creation, and Paperclip stores the returned App credentials."],
          ["Use an existing GitHub App", "Opens the advanced path for an App the organization already owns."]
        ],
        annotations: [
          "Only the two choices GitHub presents during App creation are described.",
          "The normal action uses the GitHub App Manifest handoff; credentials never pass through the operator.",
          "The existing-App branch remains available without cluttering the default path."
        ],
        rationale: "The manifest already fixes permissions, events, and webhook configuration."
      },
      {
        id: "45",
        slug: "github-install",
        title: "Choose GitHub repositories",
        subtitle: "Install Maya where people should be able to mention it.",
        rail: ["Agent selected", "Create GitHub App", "Choose repositories", "Try Maya"],
        active: 2,
        mode: "default",
        instructions: [
          ["Choose the account or organization", "GitHub may ask an organization owner to approve the installation."],
          ["Choose repository access", "Select all repositories or only the repositories where Maya should respond."],
          ["Install", "Review the requested chat permissions, then click Install."]
        ],
        primary: "Install in GitHub",
        actions: [
          ["Install in GitHub", "Opens GitHub's App installation page and returns the installation and selected repository IDs to Paperclip."]
        ],
        annotations: [
          "The screen contains only GitHub's installation decisions.",
          "Repository scope stays in GitHub's native approval UI.",
          "One button begins the complete provider-owned installation step."
        ],
        rationale: "There is no Paperclip form to duplicate GitHub's repository picker."
      },
      {
        id: "46",
        slug: "github-try",
        title: "Try Maya in GitHub",
        subtitle: "Start one task in an installed repository.",
        rail: ["Agent selected", "Create GitHub App", "Choose repositories", "Try Maya"],
        active: 3,
        mode: "default",
        instructions: [
          ["Open an issue or pull request", "Use one of the repositories selected during installation."],
          ["Mention Maya", "Add a comment: “@paperclip-maya help me test this.”"],
          ["Continue", "Add another comment in the same issue or pull request to continue the same Paperclip task."]
        ],
        primary: "Open GitHub",
        actions: [
          ["Open GitHub", "Opens an installed repository while Paperclip waits for the first signed mention to complete setup."]
        ],
        annotations: [
          "The body is only the native GitHub test sequence.",
          "The instructions explain that GitHub's existing issue or pull request is the task boundary.",
          "There is one action: open GitHub and perform the test."
        ],
        rationale: "A real mention proves the App installation without a separate verification screen."
      },
      {
        id: "47",
        slug: "github-existing",
        title: "Connect an existing GitHub App",
        subtitle: "Update the App in GitHub, then provide its identity credentials.",
        rail: ["Agent selected", "Configure existing App", "Choose repositories", "Try Maya"],
        active: 1,
        mode: "advanced",
        copyValue: ["Webhook URL and secret", "Copy Paperclip webhook settings"],
        instructions: [
          ["Update the webhook", "In the GitHub App settings, paste Paperclip's URL and generated secret, then make the webhook active."],
          ["Set permissions and events", "Grant Issues: write, Pull requests: write, Metadata: read; subscribe to Issue comment and Pull request review comment."],
          ["Create a private key", "In the App settings, click Generate a private key and download the PEM file."]
        ],
        fields: [
          ["GitHub App ID", "123456"],
          ["Private key", "Choose PEM file"]
        ],
        primary: "Connect and verify",
        secondary: "Back",
        actions: [
          ["Copy Paperclip webhook settings", "Copies the endpoint URL and generated webhook secret needed in the existing GitHub App settings."],
          ["Connect and verify", "Stores the PEM file write-only, authenticates as the App, and verifies webhook, events, and least-privilege permissions."],
          ["Back", "Returns to the credential-free App Manifest path."]
        ],
        annotations: [
          "The copy control provides the exact values the operator must paste into GitHub.",
          "The instructions list every provider change required for an existing App.",
          "Only App ID and private key return to Paperclip; the generated webhook secret is already stored.",
          "Verification happens as part of Connect rather than on another screen."
        ],
        rationale: "Existing Apps lack the manifest callback, so this advanced page contains the complete minimum manual configuration."
      }
    ]
  },
  {
    provider: "Microsoft Teams",
    short: "Teams",
    screens: [
      {
        id: "19",
        slug: "teams-register",
        title: "Create Maya for Microsoft Teams",
        subtitle: "Run one command to register Maya with Microsoft.",
        rail: ["Agent selected", "Create Teams app", "Install Maya", "Try Maya"],
        active: 1,
        mode: "default",
        code: "npx @paperclipai/teams-connect --setup PC-7K4M",
        instructions: [
          ["Copy and run the command", "Run it in a terminal on a computer where you can sign in to Microsoft 365."],
          ["Sign in to Microsoft", "Approve the Microsoft login when the browser opens. The command creates the bot and returns here when it is ready."]
        ],
        primary: "Copy setup command",
        secondary: "Set up Microsoft manually",
        actions: [
          ["Copy setup command", "Copies a one-time Paperclip command that invokes Microsoft's Teams Developer CLI, signs the operator in, creates the Teams App and bot registration, and sends the resulting identity to this setup draft."],
          ["Set up Microsoft manually", "Opens the Azure/Teams manual fallback for tenants that cannot run the guided command."]
        ],
        annotations: [
          "The generated command is the only normal-path configuration artifact.",
          "Both instructions are actions the operator performs locally or in Microsoft's login.",
          "The manual path is available without exposing Azure choices on the default screen."
        ],
        rationale: "The helper collapses Microsoft registration into one attended command while Microsoft remains the authority for sign-in and tenant policy."
      },
      {
        id: "49",
        slug: "teams-install",
        title: "Install Maya in Microsoft Teams",
        subtitle: "Open the Microsoft install page and add the app.",
        rail: ["Agent selected", "Create Teams app", "Install Maya", "Try Maya"],
        active: 2,
        mode: "default",
        instructions: [
          ["Open the install page", "Sign in to the same Microsoft 365 tenant if prompted."],
          ["Add Maya", "Review the app, click Add, and choose the team or channel if Microsoft asks."]
        ],
        primary: "Install Maya in Teams",
        actions: [
          ["Install Maya in Teams", "Opens the install link returned by Microsoft. Tenant policy may route the same request to an administrator for approval."]
        ],
        annotations: [
          "The install link replaces package download and upload on the normal path.",
          "The body contains only the two actions performed in Microsoft Teams.",
          "Tenant approval is handled by Microsoft's install experience, not another Paperclip choice."
        ],
        rationale: "Microsoft's CLI returns an install link, so normal setup should use it directly."
      },
      {
        id: "50",
        slug: "teams-try",
        title: "Try Maya in Microsoft Teams",
        subtitle: "Start one task in a channel post.",
        rail: ["Agent selected", "Create Teams app", "Install Maya", "Try Maya"],
        active: 3,
        mode: "default",
        instructions: [
          ["Open an installed channel", "Start a new post rather than replying to an unrelated post."],
          ["Mention Maya", "Post “@Maya help me test this.”"],
          ["Continue in replies", "Reply once beneath that post; the post and its replies are one Paperclip task."]
        ],
        primary: "Open Microsoft Teams",
        actions: [
          ["Open Microsoft Teams", "Opens Teams while Paperclip waits for the first authenticated mention and reply to complete setup."]
        ],
        annotations: [
          "The body is only the Teams channel test sequence.",
          "The instructions teach the channel-post-and-replies task boundary.",
          "There is one action: open Teams and perform the test."
        ],
        rationale: "The final provider event is the verification; no installation report is shown first."
      },
      {
        id: "48",
        slug: "teams-manual",
        title: "Set up Microsoft manually",
        subtitle: "Create the bot in Microsoft, then paste the three identity values.",
        rail: ["Agent selected", "Configure Microsoft", "Install Maya", "Try Maya"],
        active: 1,
        mode: "advanced",
        copyValue: ["Messaging endpoint", "Copy Paperclip endpoint"],
        instructions: [
          ["Create the Microsoft identity", "Create a single-tenant Entra App registration and a client secret."],
          ["Create the bot", "Create an Azure Bot with that App ID, enable the Microsoft Teams channel, and paste Paperclip's messaging endpoint."],
          ["Enter the identity below", "Copy Application ID and Directory ID from Entra; paste the client secret value before leaving Microsoft."]
        ],
        fields: [
          ["Application (client) ID", "00000000-0000-0000-0000-000000000000"],
          ["Directory (tenant) ID", "00000000-0000-0000-0000-000000000000"],
          ["Client secret", "••••••••••••"]
        ],
        primary: "Connect and create Teams app",
        secondary: "Back",
        actions: [
          ["Copy Paperclip endpoint", "Copies the public messaging endpoint that must be entered on the Azure Bot resource."],
          ["Connect and create Teams app", "Stores the client secret write-only, verifies Microsoft bot authentication, and creates the installable Teams app and install link."],
          ["Back", "Returns to the guided one-command setup."]
        ],
        annotations: [
          "The copy control provides the one Paperclip value required by Microsoft.",
          "Every instruction is a portal operation the tenant administrator must perform.",
          "The three fields are the minimum identity values Paperclip needs to send as the bot.",
          "Connect verifies the identity and produces the same install step as the default flow."
        ],
        rationale: "The manual fallback is longer because Microsoft has no manifest callback equivalent; no optional Azure choices are exposed."
      }
    ]
  },
  {
    provider: "Telegram",
    short: "Telegram",
    screens: [
      {
        id: "22",
        slug: "telegram-create",
        title: "Create Maya in Telegram",
        subtitle: "Create the bot with BotFather and paste its token.",
        rail: ["Agent selected", "Create Telegram bot", "Try Maya"],
        active: 1,
        mode: "default",
        instructions: [
          ["Open BotFather", "Send /newbot."],
          ["Name the bot", "Enter Maya, then choose an available username ending in bot."],
          ["Copy the token", "BotFather sends a token after creating the bot. Paste it below."]
        ],
        fields: [
          ["Bot token", "123456:••••••••••••"]
        ],
        primary: "Connect bot",
        secondary: "Open BotFather",
        actions: [
          ["Open BotFather", "Opens Telegram's verified BotFather conversation so the operator can run /newbot."],
          ["Connect bot", "Stores the token write-only, verifies the bot with getMe, and continues to the test step."]
        ],
        annotations: [
          "The page contains the exact three BotFather actions.",
          "The bot token is Telegram's only unavoidable setup input.",
          "The two buttons let the operator leave for BotFather and connect after returning."
        ],
        rationale: "Webhook, polling, commands, and identity checks are automatic and therefore absent."
      },
      {
        id: "51",
        slug: "telegram-try",
        title: "Try Maya in Telegram",
        subtitle: "Send the bot its first message.",
        rail: ["Agent selected", "Create Telegram bot", "Try Maya"],
        active: 2,
        mode: "default",
        instructions: [
          ["Open Maya", "Telegram opens the new bot's private chat."],
          ["Start the chat", "Tap Start, then send “Help me test this.”"]
        ],
        primary: "Open Maya in Telegram",
        actions: [
          ["Open Maya in Telegram", "Opens the bot's t.me link while Paperclip waits for the first verified private message to complete setup."]
        ],
        annotations: [
          "The minimum proof is one private message; group and forum reach can be added after connection.",
          "The body contains only the two Telegram actions required for the test.",
          "There is one action: open the bot and send the message."
        ],
        rationale: "A private chat is Telegram's shortest path from BotFather token to a working Paperclip conversation."
      }
    ]
  }
];
