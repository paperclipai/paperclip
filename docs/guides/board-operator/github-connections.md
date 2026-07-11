---
title: GitHub connections
summary: Add multiple GitHub credentials and select one for each project
---

# GitHub connections

Paperclip can keep several GitHub identities for one company and bind the appropriate identity to each project.

1. Create or import the personal access token in **Company Settings > Secrets**.
2. Open **Company Settings > GitHub** and add a named connection that references that secret.
3. Test the connection. Paperclip records the GitHub login returned by the server, but never returns the token.
4. Open a project workspace and select the connection under **Project GitHub identity**.

The project selection is used when Paperclip prepares a private managed checkout and while agents run in that project. Both `gh` and normal HTTPS Git operations such as `git fetch` and `git push` receive the credential automatically.

Connections are company-scoped. A connection cannot reference another company's secret, and a project cannot bind a connection from another company. Removing a connection safely clears its project bindings.

Tokens stay in the existing encrypted secret provider. Paperclip does not place tokens in clone URLs, command arguments, repository remotes, or persisted Git configuration.
