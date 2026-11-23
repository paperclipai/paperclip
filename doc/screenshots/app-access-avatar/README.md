# App access user avatars

Storybook: **Connections / Chat management / 2 · People and access**
(`connections-chat-management--access`).

These screenshots show the production access component with synthetic fixture
accounts: a linked account with an image, a linked account without an image,
and an account waiting for confirmation. The image fixture is an existing
Cliptoon asset used as a deterministic profile image; it is not a real person's
photo.

The avatar is centered beside both the Paperclip name and the Slack name, at
the same vertical center as Disconnect. Missing or failed images retain initials.
Truncated Paperclip names retain their full text in the native hover tooltip.

- [Desktop, 1280 × 900](desktop.png)
- [Mobile, 390 × 844](mobile.png)

The Access story checks image loading, initials, hover text, and vertical alignment.
