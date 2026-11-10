# Azure DevOps connection

The Azure DevOps connector can list repository metadata for an organization through
the governed REST tool gateway. Connect with a Microsoft Entra application or a
personal access token, and install the connection for the company. The account
must already have access to the Azure DevOps organization.

For Microsoft Entra, register a web application, add the Paperclip callback URL,
and grant the delegated Azure DevOps permission. An administrator may need to
approve consent. Copy the application ID and client secret into connection setup.
For personal access tokens, grant repository read access and store the token in
the connection vault.

Select Azure DevOps repositories in a project and authorize its connection to
prepare managed workspaces. Skill-source import requires a separate integration.
