---
title: Tool Connections
summary: Remove a connection or one of its grants, and read what happened at the provider
---

Removing a connection or a grant always completes in Paperclip. The response says what happened at the provider when Paperclip can ask the provider to end access.

## Remove a Connection

```
DELETE /api/tool-connections/{connectionId}
DELETE /api/tool-connections/{connectionId}?deleteStoredContent=true
```

The caller needs `connections:configure` for the connection. Only a board user can set `deleteStoredContent=true`.

The `200` response is the archived connection with a `removal` object. `removal` holds counts of what was torn down, for example `secretsRevoked` and `grantsRevoked`. With `deleteStoredContent=true`, the response also has `contentDeletion`.

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
| `not_ended` | Paperclip could not end the access at Google for at least one removed grant. The user can remove it at https://myaccount.google.com/connections. |

`outcomes` has one code for each refresh token Paperclip sent, in order. The codes are for diagnosis, not for display.

A failure to end access at Google does not undo the local removal. On both routes the local removal completes first, then Paperclip asks Paperclip Cloud to end access at Google, and it never retries in the request. Revoking an organization grant whose token the connection itself still uses does not end access at Google and has no `providerAccess`; removing the connection does. The activity entry for the removal records the same `providerAccess`, and the connection's audit history gets a `connection.google_access_removal` event with it.
