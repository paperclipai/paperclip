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

The approved lease response exposes immutable hashes and relay-local staged
paths only. It does not return `signatureBundleRef` as a live deploy path.
Before staging, `stagedArtifactPath` and `stagedSignatureBundlePath` are `null`.
After staging they point at token-gated relay endpoints:

```json
{
  "signatureBundleSha256": "3333...",
  "stageRelayArtifactPath": "/api/release-deploy-authorizations/{authorizationId}/stage-relay-artifact",
  "stagedArtifactPath": "/api/release-deploy-authorizations/{authorizationId}/staged-artifact",
  "stagedArtifactSha256": "4444...",
  "stagedSignatureBundlePath": "/api/release-deploy-authorizations/{authorizationId}/staged-signature-bundle",
  "stagedSignatureBundleSha256": "3333..."
}
```

Stage relay artifact:

```http
POST /api/release-deploy-authorizations/{authorizationId}/stage-relay-artifact
X-Paperclip-Deploy-Token: pcdeploy_...
Content-Type: application/json
```

The staging body must include both the release tarball and the actual Sigstore
bundle bytes. The relay validates both hashes before consuming the one-time
authorization.

```json
{
  "imageDigest": "sha256:...",
  "sbomHash": "2222...",
  "signatureVerified": true,
  "sbomVerified": true,
  "tarballSha256": "4444...",
  "tarballBase64": "...",
  "signatureBundleSha256": "3333...",
  "signatureBundleBase64": "..."
}
```

Download staged release tarball:

```http
GET /api/release-deploy-authorizations/{authorizationId}/staged-artifact
X-Paperclip-Deploy-Token: pcdeploy_...
```

Download staged Sigstore bundle:

```http
GET /api/release-deploy-authorizations/{authorizationId}/staged-signature-bundle
X-Paperclip-Deploy-Token: pcdeploy_...
```

Deploy record submission:

```http
POST /api/release-candidates/deploy-records
X-Paperclip-Deploy-Token: pcdeploy_...
Content-Type: application/json
```

The secure JSON bodies do not include a `token` field. Query-string and body
token transport are rejected.
