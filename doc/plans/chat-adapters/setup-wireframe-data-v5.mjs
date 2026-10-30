export const setupWizards = [
  {
    provider: "Slack",
    short: "Slack",
    slug: "slack",
    screens: [
      {
        id: "13",
        slug: "slack-add",
        title: "Add Maya to Slack",
        subtitle:
          "Approve one agent installation. Paperclip handles credentials and delivery in the background.",
        rail: ["Agent selected", "Add Maya to Slack", "Try Maya"],
        active: 1,
        mode: "default",
        groups: [
          {
            title: "Agent",
            intro:
              "This connection is permanently assigned to one Paperclip agent.",
            rows: [["Maya", "Support engineer · active", "Locked"]],
          },
          {
            title: "What Slack will ask",
            intro:
              "Slack owns workspace selection, administrator approval, and the final permission screen.",
            rows: [
              [
                "Workspace",
                "Choose the Slack workspace where Maya should appear.",
                "In Slack",
              ],
              [
                "Permissions",
                "Review mentions, thread replies, messages, reactions, files, actions, modals, commands, and DMs.",
                "Review in Slack",
              ],
              [
                "Installation",
                "Slack returns the authorized agent installation to this Paperclip company.",
                "Automatic return",
              ],
            ],
          },
          {
            title: "What Paperclip handles",
            intro:
              "No token, signing secret, webhook, relay, or Socket Mode choice appears in this path.",
            rows: [
              [
                "Credentials",
                "Store the returned Slack installation in Paperclip's secret store; never reveal it in connector settings.",
                "Automatic",
              ],
              [
                "Delivery",
                "Select and verify the correct callback path for this Paperclip deployment.",
                "Automatic",
              ],
              [
                "Capabilities",
                "Enable every safe Slack feature granted by the installation.",
                "Automatic",
              ],
            ],
          },
        ],
        primary: "Add Maya to Slack",
        secondary: "Use a custom Slack app",
        actions: [
          [
            "Add Maya to Slack",
            "Opens Slack's agent-installation authorization, then returns to Paperclip with the scoped installation stored internally.",
          ],
          [
            "Use a custom Slack app",
            "Enters the advanced self-hosted/existing-app branch; it does not expose transport choices on this screen.",
          ],
        ],
        annotations: [
          "The left rail shows the three-step happy path and preserves progress when Slack redirects away and back.",
          "Maya is shown as immutable; there is no Change agent action. Another agent requires another connection.",
          "The external Slack authorization is explained before the one primary action.",
          "Credentials and delivery are explicitly automatic, while custom-app setup is a secondary advanced branch.",
        ],
        rationale:
          "The common case is one Slack authorization button, not an infrastructure questionnaire.",
      },
      {
        id: "41",
        slug: "slack-try",
        title: "Try Maya in Slack",
        subtitle:
          "Mention Maya once. Paperclip verifies the real workspace event and creates the first task thread.",
        rail: ["Agent selected", "Add Maya to Slack", "Try Maya"],
        active: 2,
        mode: "default",
        groups: [
          {
            title: "Installation complete",
            intro: "Slack returned a verified installation for this company.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["Workspace", "Acme · @Maya installed", "Connected"],
              [
                "Permission check",
                "All required safe chat capabilities are available.",
                "Passed",
              ],
            ],
          },
          {
            title: "Start the first task",
            intro: "Use the same behavior people will use after setup.",
            rows: [
              [
                "1. Open a channel",
                "Choose a channel where you are allowed to add or mention apps.",
                "In Slack",
              ],
              [
                "2. Mention Maya",
                "Send “@Maya help me investigate this” as a new channel message.",
                "Starts thread",
              ],
              [
                "3. Continue in the thread",
                "Maya replies in a new thread; that thread is one Paperclip task.",
                "Expected",
              ],
            ],
          },
          {
            title: "Live verification",
            intro:
              "Paperclip waits for an actual signed Slack event rather than claiming setup works after a token check.",
            rows: [
              ["Workspace event", "No test mention received yet.", "Waiting"],
              [
                "If Maya is not in the channel",
                "Slack prompts you to add the agent; no Paperclip setting is required.",
                "Handled in Slack",
              ],
            ],
          },
        ],
        primary: "Open Slack",
        secondary: "Finish without testing",
        actions: [
          [
            "Open Slack",
            "Opens the installed workspace; Paperclip remains on this step and listens for the first valid event.",
          ],
          [
            "Finish without testing",
            "Activates the endpoint with verified installation health and leaves the first-message check visible on Overview.",
          ],
        ],
        annotations: [
          "Completed rail steps make the Slack redirect and successful return obvious.",
          "Agent, workspace, and capability checks are read-only results—not editable setup options.",
          "The test teaches the Hermes root-mention-to-thread behavior directly.",
          "The first real signed event completes verification; finishing early remains possible without inventing another setup form.",
        ],
        rationale:
          "The final step teaches the real interaction and proves inbound delivery with the smallest possible user action.",
      },
      {
        id: "42",
        slug: "slack-custom-create",
        title: "Create a custom Slack app",
        subtitle:
          "Advanced path for self-hosted deployments or organizations that require a customer-owned app.",
        rail: ["Agent selected", "Create Slack app", "Connect app", "Verify"],
        active: 1,
        mode: "advanced",
        groups: [
          {
            title: "Agent",
            intro: "The custom Slack app will always represent this agent.",
            rows: [
              [
                "Maya",
                "Support engineer · a new connection is required for another agent",
                "Locked",
              ],
            ],
          },
          {
            title: "Paperclip prepared the app",
            intro:
              "A versioned Slack manifest contains the bot name, callback URLs, scopes, events, actions, modals, commands, and files configuration.",
            rows: [
              [
                "App identity",
                "Maya · unique native Slack app and mention",
                "Prepared",
              ],
              [
                "Callback",
                "Chosen automatically for this Paperclip deployment.",
                "Prepared",
              ],
              [
                "Permissions",
                "Maximum safe Slack chat capability set; no tool permissions.",
                "Prepared",
              ],
            ],
          },
          {
            title: "Create it in Slack",
            intro:
              "The shared manifest URL opens Slack with the configuration prefilled; there is no copy-and-paste step.",
            rows: [
              [
                "Workspace owner",
                "Slack may require an app manager or administrator to approve creation.",
                "Provider policy",
              ],
              [
                "After creation",
                "Return here for the two values Slack cannot send back through this custom-app path.",
                "Next step",
              ],
            ],
          },
        ],
        primary: "Open prefilled Slack setup",
        secondary: "Back to Add to Slack",
        actions: [
          [
            "Open prefilled Slack setup",
            "Opens Slack's app-from-manifest URL with Paperclip's generated manifest already encoded.",
          ],
          [
            "Back to Add to Slack",
            "Returns to the managed/default installation path without losing the selected agent.",
          ],
        ],
        annotations: [
          "The rail clearly marks this as a separate custom-app branch.",
          "Agent assignment remains immutable in the advanced path.",
          "Paperclip precomputes identity, callbacks, permissions, and events; none become user choices.",
          "One external action replaces the old manifest copy, delivery selection, and provider-configuration rows.",
        ],
        rationale:
          "A custom app remains possible, but Paperclip collapses it to the provider action that only the customer can perform.",
      },
      {
        id: "43",
        slug: "slack-custom-connect",
        title: "Connect the custom Slack app",
        subtitle:
          "Provide only the two secrets Slack cannot return to Paperclip for a customer-owned app.",
        rail: ["Agent selected", "Create Slack app", "Connect app", "Verify"],
        active: 2,
        mode: "advanced",
        fields: [
          [
            "Bot token",
            "xoxb-••••••••",
            "Used to publish as Maya and call the Slack Web API.",
          ],
          [
            "Signing secret",
            "••••••••••••",
            "Used to verify that inbound HTTP events and interactions came from Slack.",
          ],
        ],
        groups: [
          {
            title: "Stored securely",
            intro:
              "Values are submitted once into Paperclip's secret store. Connector rows retain only secret references and redacted suffixes.",
            rows: [
              [
                "Who can view them",
                "No user can reveal the stored value from this connector after saving.",
                "Write only",
              ],
              [
                "Rotation",
                "Replace either secret later without changing Maya's tasks or Slack thread bindings.",
                "Supported",
              ],
            ],
          },
          {
            title: "Not requested",
            intro: "The manifest already configured these values at Slack.",
            rows: [
              [
                "Webhook URL",
                "Generated and embedded automatically.",
                "Hidden",
              ],
              [
                "Delivery mode",
                "Chosen from instance reachability; not an endpoint preference.",
                "Automatic",
              ],
              [
                "App token",
                "Not needed for the normal webhook/relay path.",
                "Not requested",
              ],
            ],
          },
        ],
        primary: "Save and verify",
        secondary: "Back",
        actions: [
          [
            "Save and verify",
            "Writes both values to the secret store, calls Slack auth.test, validates expected scopes, and advances to verification.",
          ],
          [
            "Back",
            "Returns to the manifest step without persisting partially entered secrets.",
          ],
        ],
        annotations: [
          "Only provider credentials that cannot be recovered automatically are shown.",
          "Help text explains exactly why Paperclip needs each secret.",
          "Webhook, relay, Socket Mode, and app-token choices are absent from endpoint onboarding.",
          "Saving is write-only and immediately followed by provider verification.",
        ],
        rationale:
          "Customer-owned Slack apps require credentials, but the form is limited to the irreducible two values.",
      },
      {
        id: "44",
        slug: "slack-custom-verify",
        title: "Verify the custom Slack app",
        subtitle:
          "Paperclip checks identity, callbacks, permissions, and installation before activation.",
        rail: ["Agent selected", "Create Slack app", "Connect app", "Verify"],
        active: 3,
        mode: "advanced",
        groups: [
          {
            title: "Verification results",
            intro:
              "Each check has one provider-specific remediation rather than another configuration panel.",
            rows: [
              [
                "Bot identity",
                "auth.test returned Maya in the Acme workspace.",
                "Passed",
              ],
              [
                "Request verification",
                "Signing challenge and timestamp validation succeeded.",
                "Passed",
              ],
              [
                "Scopes and features",
                "Messages, threads, reactions, files, actions, modals, commands, and DMs.",
                "Passed",
              ],
              [
                "Event subscriptions",
                "Mention, message, interaction, and command callbacks reach Paperclip.",
                "Passed",
              ],
            ],
          },
          {
            title: "Delivery selected automatically",
            intro:
              "Public instances use the verified callback directly; private instances use the configured outbound relay. Socket Mode is an instance-admin escape hatch only.",
            rows: [["This instance", "Verified public callback", "Healthy"]],
          },
        ],
        primary: "Activate Maya",
        secondary: "Back",
        actions: [
          [
            "Activate Maya",
            "Marks the endpoint active and opens the ordinary Slack connector Overview.",
          ],
          [
            "Back",
            "Returns to credential entry; existing verified secret references remain selected.",
          ],
        ],
        annotations: [
          "All prior custom-app phases remain visible in the completed rail.",
          "Checks are results with direct remediation, not setup toggles.",
          "The chosen delivery path is disclosed but cannot be changed from the endpoint wizard.",
          "Activation is the only primary action after every required check passes.",
        ],
        rationale:
          "The advanced path ends with evidence, while transport mechanics remain owned by the deployment.",
      },
    ],
  },
  {
    provider: "GitHub",
    short: "GitHub",
    slug: "github",
    screens: [
      {
        id: "16",
        slug: "github-create",
        title: "Create Maya in GitHub",
        subtitle:
          "GitHub creates a dedicated App from Paperclip's manifest and returns its credentials automatically.",
        rail: [
          "Agent selected",
          "Create GitHub App",
          "Choose repositories",
          "Try Maya",
        ],
        active: 1,
        mode: "default",
        groups: [
          {
            title: "Agent",
            intro:
              "The GitHub App is permanently assigned to this Paperclip agent.",
            rows: [
              [
                "Maya",
                "Support engineer · separate from Maya's GitHub tool connection",
                "Locked",
              ],
            ],
          },
          {
            title: "What GitHub will create",
            intro:
              "Paperclip submits an App Manifest; GitHub shows the owner and app-name confirmation.",
            rows: [
              [
                "App identity",
                "paperclip-maya[bot] · native mention and avatar",
                "Dedicated",
              ],
              [
                "Chat permissions",
                "Issues write · Pull requests write · Metadata read",
                "Least privilege",
              ],
              [
                "Events",
                "Issue comments and pull-request review comments",
                "Prepared",
              ],
            ],
          },
          {
            title: "What returns automatically",
            intro:
              "GitHub redirects with a one-time code that Paperclip exchanges within the provider deadline.",
            rows: [
              [
                "App ID and private key",
                "Stored directly in Paperclip's secret store.",
                "Automatic",
              ],
              [
                "Webhook secret",
                "Stored directly and used for signature verification.",
                "Automatic",
              ],
              [
                "Code access",
                "Contents and Actions are intentionally absent; use a separate tool connection.",
                "Not granted",
              ],
            ],
          },
        ],
        primary: "Create in GitHub",
        secondary: "Use an existing GitHub App",
        actions: [
          [
            "Create in GitHub",
            "Posts Paperclip's manifest to GitHub; GitHub confirms the App, redirects back, and Paperclip exchanges the one-time code for credentials.",
          ],
          [
            "Use an existing GitHub App",
            "Opens the advanced credential form for an App the company already owns.",
          ],
        ],
        annotations: [
          "The wizard rail follows provider handoffs and keeps the selected agent visible.",
          "Maya is immutable and chat-purpose GitHub access is explicitly separate from tool-purpose access.",
          "The manifest fixes permissions and events instead of asking the operator to configure them.",
          "Default App credentials return server-to-server; only the existing-App branch exposes fields.",
        ],
        rationale:
          "GitHub's App Manifest flow removes nearly every manual setup row while preserving a dedicated native bot.",
      },
      {
        id: "45",
        slug: "github-install",
        title: "Choose GitHub repositories",
        subtitle:
          "Install Maya on an organization or account, then choose all or selected repositories in GitHub.",
        rail: [
          "Agent selected",
          "Create GitHub App",
          "Choose repositories",
          "Try Maya",
        ],
        active: 2,
        mode: "default",
        groups: [
          {
            title: "App created",
            intro:
              "GitHub returned the dedicated App configuration successfully.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["GitHub App", "paperclip-maya[bot]", "Created"],
              ["Webhook", "Signed delivery endpoint", "Verified"],
            ],
          },
          {
            title: "Install it in GitHub",
            intro:
              "GitHub owns organization approval and repository selection.",
            rows: [
              [
                "Account or organization",
                "Choose the GitHub owner where people will mention Maya.",
                "In GitHub",
              ],
              [
                "Repository access",
                "Choose all repositories or a selected set; Paperclip can narrow this later.",
                "In GitHub",
              ],
              [
                "Permissions",
                "Review the prepared Issues, Pull requests, and Metadata grant.",
                "In GitHub",
              ],
            ],
          },
          {
            title: "What returns",
            intro:
              "The installation callback contains an installation ID, not another long-lived credential for the user to copy.",
            rows: [
              [
                "Installation",
                "Paperclip links the App installation to this endpoint.",
                "Automatic return",
              ],
              [
                "Repository inventory",
                "Paperclip reads the installed repository IDs and labels.",
                "Automatic",
              ],
            ],
          },
        ],
        primary: "Install in GitHub",
        secondary: "Back",
        actions: [
          [
            "Install in GitHub",
            "Opens the GitHub App installation page; GitHub collects owner/repository approval and returns the installation ID.",
          ],
          [
            "Back",
            "Returns to App creation without deleting the already-created GitHub App.",
          ],
        ],
        annotations: [
          "The App-creation phase is complete before repository installation begins.",
          "The agent and App identity are read-only results.",
          "All organization and repository choices happen at GitHub, where policy and approval live.",
          "Paperclip receives the installation ID and repository inventory automatically.",
        ],
        rationale:
          "Repository scope is the only meaningful default-flow choice, and GitHub already owns its UI.",
      },
      {
        id: "46",
        slug: "github-try",
        title: "Try Maya in GitHub",
        subtitle:
          "Mention Maya in an allowed issue, pull-request conversation, or review thread.",
        rail: [
          "Agent selected",
          "Create GitHub App",
          "Choose repositories",
          "Try Maya",
        ],
        active: 3,
        mode: "default",
        groups: [
          {
            title: "Installation complete",
            intro:
              "Paperclip verified the App, installation, selected repositories, events, and signatures.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["Installation", "Acme · acme/api and acme/web", "Connected"],
              [
                "Permissions",
                "Chat-only; no repository code authority",
                "Passed",
              ],
            ],
          },
          {
            title: "Start the first task",
            intro:
              "Use an existing GitHub conversation; Paperclip does not create a second native thread.",
            rows: [
              [
                "1. Open an issue or PR",
                "Use either installed repository.",
                "In GitHub",
              ],
              [
                "2. Mention the App",
                "Comment “@paperclip-maya investigate this.”",
                "Starts task",
              ],
              [
                "3. Watch the comment",
                "Maya reacts, posts progress, and edits the final GFM response.",
                "Expected",
              ],
            ],
          },
          {
            title: "Live verification",
            intro:
              "The first signed webhook proves the selected installation and native conversation boundary.",
            rows: [
              ["GitHub delivery", "No test mention received yet.", "Waiting"],
            ],
          },
        ],
        primary: "Open GitHub",
        secondary: "Finish without testing",
        actions: [
          [
            "Open GitHub",
            "Opens an installed repository while Paperclip waits for the first signed mention event.",
          ],
          [
            "Finish without testing",
            "Activates the endpoint and leaves the first-delivery check visible on Overview.",
          ],
        ],
        annotations: [
          "All setup phases remain visible and resumable.",
          "Installation scope and chat-only authority are confirmed before testing.",
          "The test covers issue, PR, and review-thread behavior without manufacturing a separate GitHub thread.",
          "A real signed webhook completes verification; the endpoint may still be finished for later testing.",
        ],
        rationale:
          "Testing teaches the native object binding while proving the provider's actual delivery path.",
      },
      {
        id: "47",
        slug: "github-existing",
        title: "Connect an existing GitHub App",
        subtitle:
          "Advanced path for organizations that already own and govern the dedicated chat App.",
        rail: [
          "Agent selected",
          "Connect existing App",
          "Choose repositories",
          "Try Maya",
        ],
        active: 1,
        mode: "advanced",
        fields: [
          [
            "GitHub App ID",
            "123456",
            "Identifies the customer-owned App registration.",
          ],
          [
            "Private key",
            "Choose PEM file",
            "Signs installation-token requests; uploaded once into the secret store.",
          ],
          [
            "Webhook secret",
            "••••••••••••",
            "Verifies inbound GitHub webhook signatures.",
          ],
          [
            "GitHub host",
            "https://github.com",
            "Change only for GitHub Enterprise Server.",
          ],
        ],
        groups: [
          {
            title: "Required App configuration",
            intro:
              "Paperclip verifies rather than asks the user to re-enter provider configuration.",
            rows: [
              [
                "Webhook and events",
                "Paperclip callback · issue comments · PR review comments",
                "Will verify",
              ],
              [
                "Permissions",
                "Issues write · Pull requests write · Metadata read",
                "Will verify",
              ],
              [
                "Code access",
                "Contents and Actions remain a separate tool connection.",
                "Not used",
              ],
            ],
          },
        ],
        primary: "Connect and verify",
        secondary: "Back to manifest flow",
        actions: [
          [
            "Connect and verify",
            "Stores the private key and webhook secret, authenticates as the App, and verifies permissions/events before repository installation.",
          ],
          [
            "Back to manifest flow",
            "Returns to the default credential-free App Manifest path.",
          ],
        ],
        annotations: [
          "The existing-App rail is a distinct advanced branch.",
          "Only App ID, private key, webhook secret, and optional GHES host are requested.",
          "Paperclip verifies events and permissions instead of adding more setup switches.",
          "The primary action stores write-only secrets and proves App authentication before continuing.",
        ],
        rationale:
          "Existing Apps cannot use the one-time manifest exchange, so these credentials are irreducible.",
      },
    ],
  },
  {
    provider: "Microsoft Teams",
    short: "Teams",
    slug: "teams",
    screens: [
      {
        id: "19",
        slug: "teams-register",
        title: "Register Maya for Microsoft Teams",
        subtitle:
          "Run one guided Microsoft command to create the customer-owned bot identity and point it at Paperclip.",
        rail: [
          "Agent selected",
          "Register Teams bot",
          "Connect identity",
          "Install app",
          "Try Maya",
        ],
        active: 1,
        mode: "default",
        groups: [
          {
            title: "Agent",
            intro:
              "The Microsoft bot and Teams app package are permanently assigned to this agent.",
            rows: [
              [
                "Maya",
                "Support engineer · a new connection is required for another agent",
                "Locked",
              ],
            ],
          },
          {
            title: "Recommended Microsoft setup",
            intro:
              "Teams Developer CLI creates the Entra App, Azure Bot resource, Teams channel, and install metadata with Microsoft-owned sign-in and policy checks.",
            rows: [
              [
                "Prerequisites",
                "Microsoft 365 account, Azure subscription, and permission to create the resources.",
                "Required",
              ],
              [
                "Messaging endpoint",
                "Paperclip generated the verified endpoint used by the command.",
                "Prepared",
              ],
              [
                "Tenant policy",
                "The CLI reports when custom-app upload or resource creation needs an administrator.",
                "Checked by Microsoft",
              ],
            ],
          },
          {
            title: "What the command does",
            intro:
              "The copied command contains Maya's name and Paperclip endpoint; it never contains a Paperclip secret.",
            rows: [
              [
                "Microsoft sign-in",
                "The CLI asks Microsoft to authenticate the operator.",
                "External",
              ],
              [
                "Resource creation",
                "Creates one single-tenant bot identity and enables the Teams channel.",
                "External",
              ],
              [
                "Credential output",
                "Writes Client ID, Tenant ID, and a generated secret for the next step.",
                "Local output",
              ],
            ],
          },
        ],
        primary: "Copy setup command",
        secondary: "Use Azure Portal instead",
        actions: [
          [
            "Copy setup command",
            "Copies the generated Teams Developer CLI command; the user runs it locally so Microsoft owns authentication and resource provisioning.",
          ],
          [
            "Use Azure Portal instead",
            "Opens detailed manual instructions for locked-down tenants; it produces the same three required identity values.",
          ],
        ],
        annotations: [
          "The five-step rail reflects the irreducible Microsoft registration and package lifecycle.",
          "Maya is shown as immutable before any Microsoft resources are created.",
          "The recommended CLI path collapses Entra, Azure Bot, channel, endpoint, and policy setup into one provider-owned command.",
          "Manual Azure Portal work is a secondary path, not a competing set of first-page options.",
        ],
        rationale:
          "Microsoft requires customer-owned bot infrastructure today, so simplification means one guided command rather than pretending credentials do not exist.",
      },
      {
        id: "48",
        slug: "teams-identity",
        title: "Connect the Microsoft bot identity",
        subtitle:
          "Paste the three values created by Microsoft so Paperclip can authenticate as Maya.",
        rail: [
          "Agent selected",
          "Register Teams bot",
          "Connect identity",
          "Install app",
          "Try Maya",
        ],
        active: 2,
        mode: "default",
        fields: [
          [
            "Application (client) ID",
            "00000000-0000-0000-0000-000000000000",
            "Identifies Maya's Entra application and Azure Bot.",
          ],
          [
            "Directory (tenant) ID",
            "00000000-0000-0000-0000-000000000000",
            "Limits the bot to the company tenant.",
          ],
          [
            "Client secret",
            "••••••••••••",
            "Lets Paperclip authenticate outbound bot messages; stored write-only.",
          ],
        ],
        groups: [
          {
            title: "Why these values are visible",
            intro:
              "Microsoft created a customer-owned identity. It does not send those credentials to Paperclip through an installation callback.",
            rows: [
              [
                "Storage",
                "Client secret enters Paperclip's secret store; configuration keeps only its reference.",
                "Write only",
              ],
              [
                "Rotation",
                "A replacement secret can be saved later without changing task bindings.",
                "Supported",
              ],
              [
                "Managed identity",
                "Available only when the Paperclip deployment already runs with a compatible Azure identity.",
                "Instance advanced",
              ],
            ],
          },
        ],
        primary: "Save and verify",
        secondary: "Back",
        actions: [
          [
            "Save and verify",
            "Stores the secret, requests a Microsoft bot token, and verifies tenant, bot identity, and messaging endpoint.",
          ],
          [
            "Back",
            "Returns to the registration instructions without persisting partial fields.",
          ],
        ],
        annotations: [
          "The completed registration step remains visible in the rail.",
          "Exactly three Microsoft values are requested, each with a reason.",
          "Secret storage and rotation are explained; managed identity is moved to instance-level advanced setup.",
          "One save action both persists and proves the identity before package generation.",
        ],
        rationale:
          "These credentials are required because Microsoft does not provide a GitHub-style manifest callback for the customer-owned bot.",
      },
      {
        id: "49",
        slug: "teams-install",
        title: "Install Maya in Microsoft Teams",
        subtitle:
          "Download the generated app package and let Microsoft apply tenant and scope policy.",
        rail: [
          "Agent selected",
          "Register Teams bot",
          "Connect identity",
          "Install app",
          "Try Maya",
        ],
        active: 3,
        mode: "default",
        groups: [
          {
            title: "Package ready",
            intro:
              "Paperclip inserted Maya's immutable identity, bot App ID, supported scopes, commands, and icons into a validated Teams package.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["Package", "maya-paperclip-teams.zip", "Validated"],
              ["Scopes", "Personal, team, and group chat", "Included"],
            ],
          },
          {
            title: "Install through Microsoft Teams",
            intro:
              "Tenant policy determines whether the operator can upload directly or must send the package to an administrator.",
            rows: [
              [
                "Self-service tenant",
                "Upload the package under Manage your apps, then add it to the intended scope.",
                "In Teams",
              ],
              [
                "Admin-managed tenant",
                "Send the same package to the Teams administrator for approval and distribution.",
                "Admin action",
              ],
              [
                "No extra credentials",
                "The package contains public IDs and presentation metadata, not the client secret.",
                "Safe to share",
              ],
            ],
          },
        ],
        primary: "Download Teams package",
        secondary: "Open Teams",
        actions: [
          [
            "Download Teams package",
            "Downloads the validated ZIP containing manifest.json and the required icons; it contains no secret.",
          ],
          [
            "Open Teams",
            "Opens Manage your apps so the operator can upload/install, subject to tenant policy.",
          ],
        ],
        annotations: [
          "Registration and identity steps are complete before a package can be generated.",
          "Agent, package name, validation, and scopes are read-only.",
          "The screen branches only on Microsoft tenant policy, not Paperclip preferences.",
          "The two actions correspond to the two external operations: obtain the package, then install it.",
        ],
        rationale:
          "Teams package installation is provider-owned and cannot be collapsed into the credential step without hiding tenant policy.",
      },
      {
        id: "50",
        slug: "teams-try",
        title: "Try Maya in Microsoft Teams",
        subtitle:
          "Mention Maya in an installed channel post or start a personal chat.",
        rail: [
          "Agent selected",
          "Register Teams bot",
          "Connect identity",
          "Install app",
          "Try Maya",
        ],
        active: 4,
        mode: "default",
        groups: [
          {
            title: "Installation checks",
            intro:
              "Paperclip verifies Microsoft identity and waits for the installed package to deliver a real activity.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["Bot authentication", "Single tenant · Acme", "Passed"],
              [
                "Messaging endpoint",
                "Authenticated Bot Framework activity",
                "Passed",
              ],
              [
                "Teams installation",
                "No message received from an installed scope yet.",
                "Waiting",
              ],
            ],
          },
          {
            title: "Start the first task",
            intro: "The test reflects the conversation type people will use.",
            rows: [
              [
                "Channel",
                "Create a new post with @Maya; its replies become one Paperclip task.",
                "Post thread",
              ],
              [
                "Personal or group chat",
                "Send a message; the conversation exposes one active Paperclip task.",
                "Active task",
              ],
              [
                "Unmentioned channel replies",
                "Paperclip detects actual manifest/RSC delivery and explains if another mention is required.",
                "Verified live",
              ],
            ],
          },
        ],
        primary: "Open Microsoft Teams",
        secondary: "Finish without testing",
        actions: [
          [
            "Open Microsoft Teams",
            "Opens Teams while Paperclip waits for the first authenticated activity from an installed scope.",
          ],
          [
            "Finish without testing",
            "Activates the endpoint and leaves package/install delivery health visible on Overview.",
          ],
        ],
        annotations: [
          "The rail shows every completed Microsoft-owned phase.",
          "Identity and endpoint checks are complete before installation delivery is claimed.",
          "Channel-thread and linear-chat boundaries are tested separately in plain language.",
          "Live delivery establishes actual mention/RSC behavior rather than assuming it from the package.",
        ],
        rationale:
          "A real Teams activity is the only reliable final proof of package installation and conversation delivery.",
      },
    ],
  },
  {
    provider: "Telegram",
    short: "Telegram",
    slug: "telegram",
    screens: [
      {
        id: "22",
        slug: "telegram-create",
        title: "Create Maya with BotFather",
        subtitle:
          "Create one Telegram bot and paste the token BotFather gives you.",
        rail: [
          "Agent selected",
          "Create Telegram bot",
          "Add to chats",
          "Try Maya",
        ],
        active: 1,
        mode: "default",
        fields: [
          [
            "Bot token",
            "123456:••••••••••••",
            "Telegram has no installation callback; this one-time token is required to connect the bot.",
          ],
        ],
        groups: [
          {
            title: "Agent",
            intro:
              "The Telegram bot is permanently assigned to this Paperclip agent.",
            rows: [
              [
                "Maya",
                "Support engineer · a new connection is required for another agent",
                "Locked",
              ],
            ],
          },
          {
            title: "Create the bot in Telegram",
            intro: "BotFather owns bot creation and username uniqueness.",
            rows: [
              [
                "1. Open BotFather",
                "Send /newbot and follow Telegram's prompts.",
                "In Telegram",
              ],
              [
                "2. Name the bot",
                "Use Maya and choose an available username such as @maya_acme_bot.",
                "In Telegram",
              ],
              [
                "3. Copy the token",
                "Treat it like a password and paste it in the field above.",
                "Required",
              ],
            ],
          },
          {
            title: "What Paperclip handles",
            intro: "The token is enough for Paperclip to configure the rest.",
            rows: [
              [
                "Identity",
                "Call getMe and store the stable numeric bot ID and username.",
                "Automatic",
              ],
              [
                "Delivery",
                "Configure a verified webhook or the deployment's relay; local developer polling is automatic.",
                "Automatic",
              ],
              [
                "Commands and capabilities",
                "Register commands and use the maximum safe Telegram feature set.",
                "Automatic",
              ],
            ],
          },
        ],
        primary: "Connect bot",
        secondary: "Open BotFather",
        actions: [
          [
            "Connect bot",
            "Stores the token write-only, calls getMe, configures the deployment-selected delivery path, and registers supported commands.",
          ],
          [
            "Open BotFather",
            "Opens Telegram's verified BotFather conversation; it cannot return the token to Paperclip automatically.",
          ],
        ],
        annotations: [
          "The rail shows Telegram's short four-step path.",
          "Maya is read-only and another agent requires another connection.",
          "The sole credential field is explained as a BotFather platform limitation.",
          "Webhook, relay, polling, commands, and capabilities are configured automatically after the token is saved.",
        ],
        rationale:
          "Telegram has no OAuth-style bot installation, so one token field is irreducible while every other setup choice disappears.",
      },
      {
        id: "51",
        slug: "telegram-add",
        title: "Add Maya to Telegram chats",
        subtitle:
          "Open Maya's Telegram profile, then add the bot wherever people should start tasks.",
        rail: [
          "Agent selected",
          "Create Telegram bot",
          "Add to chats",
          "Try Maya",
        ],
        active: 2,
        mode: "default",
        groups: [
          {
            title: "Bot connected",
            intro:
              "Paperclip verified the BotFather token and configured delivery automatically.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              [
                "Telegram identity",
                "@maya_acme_bot · numeric ID verified",
                "Connected",
              ],
              [
                "Delivery",
                "Verified webhook selected for this deployment",
                "Healthy",
              ],
            ],
          },
          {
            title: "Choose reach in Telegram",
            intro:
              "Telegram owns chat membership; Paperclip learns stable IDs when the bot receives an addressed message.",
            rows: [
              [
                "Direct messages",
                "Anyone who opens the bot can start an active task, subject to Paperclip access policy.",
                "Available",
              ],
              [
                "Groups",
                "Add Maya to a group; keep BotFather privacy mode on.",
                "In Telegram",
              ],
              [
                "Forum topics",
                "Add Maya to the forum; an addressed topic message establishes the stable topic binding.",
                "In Telegram",
              ],
            ],
          },
          {
            title: "No admin rights by default",
            intro:
              "Ordinary conversation does not need topic creation, member management, or broad group visibility.",
            rows: [
              [
                "Privacy mode",
                "Unrelated group traffic is not delivered to Maya.",
                "Keep on",
              ],
              [
                "Admin upgrade",
                "Request only later if a separately planned capability truly requires it.",
                "Not requested",
              ],
            ],
          },
        ],
        primary: "Open Maya in Telegram",
        secondary: "Continue",
        actions: [
          [
            "Open Maya in Telegram",
            "Opens the bot deep link so the operator can start a DM or add it to a group/forum.",
          ],
          [
            "Continue",
            "Advances to live verification; Paperclip does not require pre-entered numeric chat IDs during setup.",
          ],
        ],
        annotations: [
          "Bot creation is complete before provider-owned chat membership begins.",
          "Agent, Telegram identity, and delivery are read-only results.",
          "DM, group, and forum reach are described without asking for numeric IDs.",
          "Privacy remains on and admin rights are intentionally excluded from initial setup.",
        ],
        rationale:
          "People choose Telegram reach by adding the bot in Telegram, not by configuring a Paperclip allowlist before any chat IDs exist.",
      },
      {
        id: "52",
        slug: "telegram-try",
        title: "Try Maya in Telegram",
        subtitle:
          "Send one addressed message so Paperclip can verify the bot, chat, and task boundary.",
        rail: [
          "Agent selected",
          "Create Telegram bot",
          "Add to chats",
          "Try Maya",
        ],
        active: 3,
        mode: "default",
        groups: [
          {
            title: "Connection checks",
            intro:
              "Provider identity, delivery, and privacy are ready before the first task.",
            rows: [
              ["Agent", "Maya · permanently assigned", "Locked"],
              ["Bot API", "getMe and command registration", "Passed"],
              [
                "Delivery",
                "Secret-token webhook · zero pending updates",
                "Passed",
              ],
              [
                "First addressed update",
                "No test message received yet.",
                "Waiting",
              ],
            ],
          },
          {
            title: "Start the first task",
            intro: "Choose one native Telegram context.",
            rows: [
              [
                "Direct message",
                "Send any message; it creates Maya's active Paperclip task.",
                "DM",
              ],
              [
                "Ordinary group",
                "Mention @maya_acme_bot; replies to Maya continue the active task.",
                "Addressed",
              ],
              [
                "Forum topic",
                "Mention Maya inside a topic; message_thread_id becomes the issue boundary.",
                "Topic",
              ],
            ],
          },
          {
            title: "Live verification",
            intro:
              "Paperclip records the first stable chat/user IDs and verifies a safe reply, post/edit behavior, and callbacks.",
            rows: [
              [
                "Telegram update",
                "Waiting for message or callback query.",
                "Waiting",
              ],
            ],
          },
        ],
        primary: "Open Telegram",
        secondary: "Finish without testing",
        actions: [
          [
            "Open Telegram",
            "Opens Maya's bot profile while Paperclip waits for the first verified update.",
          ],
          [
            "Finish without testing",
            "Activates the endpoint and leaves first-delivery and chat-discovery health visible on Overview.",
          ],
        ],
        annotations: [
          "All prior Telegram steps remain visible in the completed rail.",
          "Bot API and delivery checks are separate from the first real conversation.",
          "DM, group, and forum tests teach their different task boundaries.",
          "A real addressed update captures stable IDs and proves the maximum safe output path.",
        ],
        rationale:
          "The final step verifies Telegram's actual context and privacy behavior without another settings form.",
      },
    ],
  },
];
