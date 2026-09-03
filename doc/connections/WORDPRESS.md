# WordPress read-only connection

The first-party WordPress connection is intentionally limited to one tool:
`wordpress_authentication_check`. It performs `GET
/wp-json/wp/v2/users/me?context=edit` and returns only `authenticated: true` and
the numeric user ID. It does not expose profile fields and has no create,
update, delete, publish, upload, or other write capability.

## Credential and audit boundary

The WordPress username and Application Password are stored as Paperclip secret
references. The Application Password uses the reviewed
`class_3_static_lease` allowlist key `wordpress.application_password` at
`credentials.application_password`. It is resolved only inside the connection
runtime for the single request. Neither credential is projected into agent or
project environment variables, adapter configuration, prompts, API responses,
activity/audit payloads, run logs, or tool errors. Provider response text and
WordPress profile fields are not copied into errors or audit records.

The connector accepts an HTTPS base URL only. Embedded credentials, query
strings, fragments, caller-supplied `wp-json` paths, redirects, arguments, and
unknown capabilities are rejected. The fixed REST path is assembled by the
connector and redirects are never followed.

## Onboarding and binding

1. Create a dedicated least-privilege WordPress user and Application Password.
2. In Apps, select WordPress and enter the HTTPS site base URL, the exact
   Paperclip project ID, an explicit comma-separated allowed-agent set, and the
   two credential values.
3. On the Access step, select exactly the same allowed agents. `All agents` is
   rejected for this connection.
4. Review that the catalog contains only `wordpress_authentication_check`, then
   finish setup. Calls fail closed unless company, project, and agent all match.
5. Revoke by removing/archiving the connection and revoking the Application
   Password in WordPress. Rotate before its operational expiry and reconnect the
   same connection so its audit identity remains stable.

Do not use a real credential in automated tests. The harness uses only a local
mock and a synthetic sentinel.

## Future write access

Write support is outside this connector. Any future WordPress write capability
requires a separate plan-bound child issue, a current backup, a named rollback
owner, and Oliver `request_confirmation`. It must add an explicit reviewed tool
inventory and cannot broaden this read-only connection in place.
