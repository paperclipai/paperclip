# Release Candidate Deploy Relay

The deploy relay token is a one-time secret. Relay consumers must never put it in
the URL, argv, shell history, or JSON body.

## Header Contract

Send the token only in this request header:

```http
X-Paperclip-Deploy-Token: pcdeploy_...
```

The `authorizationId` may remain a path or query identifier because it is not the
secret.

## Secure Calls

Approved lease lookup:

```http
GET /api/release-candidates/approved-lease?authorizationId={authorizationId}
X-Paperclip-Deploy-Token: pcdeploy_...
```

Stage relay artifact:

```http
POST /api/release-deploy-authorizations/{authorizationId}/stage-relay-artifact
X-Paperclip-Deploy-Token: pcdeploy_...
Content-Type: application/json
```

Deploy record submission:

```http
POST /api/release-candidates/deploy-records
X-Paperclip-Deploy-Token: pcdeploy_...
Content-Type: application/json
```

The secure JSON bodies do not include a `token` field. Query-string and body
token transport are rejected.
