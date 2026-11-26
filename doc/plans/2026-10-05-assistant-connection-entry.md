# Assistant connection entry and Butter walkthrough

Start inside the user’s Paperclip organization. Connections must explain how to
connect an outside assistant to this instance as the current person, with no
agent selection.

1. Add Assistant Connection (MCP) to the existing Connectors catalog.
2. Keep setup inside the app shell. Show the organization, experimental enable
   path, canonical server URL, and exact client setup/authentication instructions.
3. Explain that the assistant’s sign-in action opens browser consent. Show only
   real authorized connections, scoped to the current person and organization.
4. Cover disabled, enabled, failure, connection refresh, and revocation states
   with focused tests and production-page stories. Preserve OAuth enforcement.
5. Deploy the revised preview only to Butter staging. Walk from its dashboard
   through Connections, OpenCode configuration, browser consent, and useful work.
6. Capture the actual screens and rebuild the portable grid/keyboard gallery.
   Clearly label any incomplete step; never substitute a mock result for live proof.

Acceptance: a user can discover the feature, understand which identity connects,
reach consent using the displayed instructions, and return to inspect/revoke the
connection. Enabling the experiment or opening setup alone grants no access.
