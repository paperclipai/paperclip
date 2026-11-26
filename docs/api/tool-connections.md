---
title: Tool Connections
summary: Remove a connection or one of its grants, cancel a first sign-in, read what happened at the provider, and read what to set up in AWS for an AWS role connection
---

Removing a connection or a grant always completes in Paperclip. The response says what happened at the provider when Paperclip can ask the provider to end access.

## Remove a Connection

```
DELETE /api/tool-connections/{connectionId}
DELETE /api/tool-connections/{connectionId}?deleteStoredContent=true
```

The caller needs `connections:configure` for the connection. Only a board user can set `deleteStoredContent=true`.

The `200` response is the archived connection with a `removal` object. `removal` holds counts of what was torn down, for example `secretsRevoked` and `grantsRevoked`. With `deleteStoredContent=true`, the response also has `contentDeletion`.

## Cancel a First Sign-In

```
POST /api/tool-connections/{connectionId}/sign-in/cancel
```

Use this when a user cancels the provider sign-in for a new connection. The caller needs `connections:configure` for the connection.

Paperclip removes the connection only if it is an OAuth draft that never held a credential. The removal is the same teardown as `DELETE`, and the activity log gets `tool_connection.sign_in_cancelled`. The `200` response is `{ "abandoned": true, "connection": ... }` with the archived connection.

For any other connection, Paperclip changes nothing. This includes an active connection and a connection that needs a new sign-in after it worked before. The `200` response is `{ "abandoned": false, "connection": ... }` with the unchanged connection.

`GET /api/companies/{companyId}/tools/connections` sets `firstSignInPending: true` on an OAuth draft that never held a credential. The Apps page does not show these drafts, and the next setup for the same app reuses them.

## Remove a Grant

```
DELETE /api/tool-connections/{connectionId}/grants/{grantId}
```

The caller needs `connections:configure` for the connection, or must be the grant's own user. The `200` response is the revoked grant.

## Google Access (`providerAccess`)

For a Google connection that Paperclip Cloud manages, the connection response has `removal.providerAccess` and the grant response has `providerAccess`. Other connections do not have this field.

```json
{
  "provider": "google",
  "result": "ended",
  "outcomes": ["revoked"]
}
```

`result` is one of:

| `result` | Meaning |
| --- | --- |
| `ended` | Google ended Paperclip's access for every removed grant. |
| `ended_unconfirmed` | Google ended access for at least one removed grant, and the others reported other connections. Paperclip cannot tell whether they were the same Google account. |
| `other_connections_remain` | Other Paperclip connections still use this Google account, so Google keeps the access. |
| `retrying` | Google did not confirm yet for at least one removed grant (Paperclip Cloud or Google could not be reached, or Google failed). Paperclip keeps that token in a pending record and retries in the background; the user does not need to act. |
| `not_ended` | Paperclip Cloud gave a final answer that it cannot end the access at Google for at least one removed grant, or the token could not be kept for a retry. The user can remove it at https://myaccount.google.com/connections. |

`outcomes` has one code for each refresh token Paperclip sent, in order. The codes are for diagnosis, not for display.

A failure to end access at Google does not undo the local removal. On both routes the local removal completes first, then Paperclip asks Paperclip Cloud to end access at Google once in the request. When that is not confirmed and can be retried, the result is `retrying`: a background worker retries with backoff from 1 minute up to 6 hours, for at most 30 days. When the retry ends, the connection's audit history gets a `connection.google_access_retry` event, and the activity log gets `tool_connection.google_access_ended` or `tool_connection.google_access_not_ended`. Revoking an organization grant whose token the connection itself still uses does not end access at Google and has no `providerAccess`; removing the connection does. The activity entry for the removal records the same `providerAccess`, and the connection's audit history gets a `connection.google_access_removal` event with it.

## AWS Role Setup

```
GET /api/tool-connections/{connectionId}/aws-setup
GET /api/tool-connections/{connectionId}/aws-setup?accessLevel=full
```

Returns what to create in AWS for an AWS role connection (`connectionMethodKey` `aws-role`): an IAM OpenID Connect identity provider for the company's issuer and a role that trusts only this connection. The setup screen reads it after saving the connection as a draft, and again on reconnect. It never contains a secret.

The caller needs `connections:configure` for the connection.

`accessLevel` is optional (`read_only` or `full`). It sets up for an access level that is not saved yet, such as one changed while reconnecting. Without it, the saved access level is used. For `read_only` the template's `AccessPolicyArn` defaults to `ReadOnlyAccess`; for `full` it has no default.

When this instance can serve the role method, the `200` response is:

```json
{
  "available": true,
  "issuer": "https://paperclip.example.com/oidc/companies/<companyId>",
  "audience": "sts.amazonaws.com",
  "subject": "connection:<connectionId>",
  "providerHost": "paperclip.example.com/oidc/companies/<companyId>",
  "roleName": "paperclip-<connectionId>",
  "savedRoleArn": null,
  "accessLevel": "read_only",
  "trustPolicy": { "Version": "2012-10-17", "Statement": ["..."] },
  "cloudFormationTemplate": "{ ... }",
  "cloudFormationConsoleUrl": "https://console.aws.amazon.com/cloudformation/home#/stacks/create",
  "issuerPublished": true
}
```

- `roleName` is the role the template and the agent prompt create. It is named after the connection, and CloudFormation fills in the account, so the template needs no edits.
- `savedRoleArn` is the role ARN saved on a finished connection when it is this connection's own role (`roleName`), or `null`. Drafts never keep a role ARN, and a role with any other name is not offered, because the setup steps tell an AWS administrator to update this role.
- `trustPolicy` is for setting up by hand. `ACCOUNT_ID` in it stands for the customer's AWS account ID.
- `issuerPublished` is `true` when the company's signing key is published, so AWS can validate the issuer.

Otherwise the `200` response is `{ "available": false, "reason": "<reason>" }`:

| `reason` | Meaning |
| --- | --- |
| `no_public_url` | The instance has no public address, so AWS cannot reach its issuer. |
| `not_https` | The instance is not served over HTTPS, which AWS requires. |
| `has_port` | The instance address includes a port, which AWS does not allow. |
| `loopback` | The instance runs on this computer only. |
| `address_changed` | The instance address changed after this draft was saved. Saving the draft again uses the current address. A finished connection is set up for the current address instead, since reconnecting records it. |

Errors: `404` when the connection does not exist or is not accessible, and `422` with code `aws_role_setup_unavailable` when the connection does not use an AWS role.
