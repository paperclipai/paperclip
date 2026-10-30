# GitHub private attachment authority

This records the bounded implementation and qualification boundary, not a claim
that arbitrary private GitHub files are downloadable by an installation App.

## Supported authority

GitHub documents installation access tokens for the exact
[issue-comment GET](https://docs.github.com/en/rest/issues/comments#get-an-issue-comment)
with existing Issues or Pull requests read permission. Its
`application/vnd.github.full+json` representation includes both the original
body and rendered HTML. The corresponding
[review-comment GET](https://docs.github.com/en/rest/pulls/comments#get-a-review-comment-for-a-pull-request)
requires Pull requests read and uses
`application/vnd.github-commitcomment.full+json`.

Those are legitimate fixed-repository comment reads. They do not document a
general private-attachment download API. GitHub's
[attachment documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files)
distinguishes anonymous public uploads from repository-gated private uploads;
its [private attachment change](https://github.blog/changelog/2023-05-08-more-secure-private-attachments/)
explains why knowing the original private URL is insufficient.

## Narrow implementation

1. Only attachment references from an admitted, exact provider comment receive
   a version-2 locator with the original body SHA-256. Existing four-field
   locators remain anonymous-only; replay does not invent missing provenance.
2. An anonymous 401/403/404 may trigger one exact-comment GET using the existing
   installation App, fixed `api.github.com`, no query, and no redirects. PAT,
   cookie, user-token, unbound-installation, and custom-host fallbacks are absent.
3. The authenticated response must match comment ID, repository, issue/PR,
   review-root when applicable, and the original body hash. Exactly one anchor
   must contain one image targeting the same asset UUID on
   `private-user-images.githubusercontent.com`, with a sole JWT query absent
   from the original body. Its link must be either the original asset URL or
   exactly its image URL. Both forms share one candidate count; duplicate,
   mixed, or conflicting same-asset renderings fail closed. HTML parsing is
   inert and bounded.
4. The signed image target is ephemeral. Download requests never receive App
   credentials or cookies. Existing HTTPS/public-address pinning, redirect
   allowlisting, byte/MIME validation, 20-second file and 60-second download-batch
   budgets remain. The batch budget is not a hard total admission deadline.
5. Current principal, runtime credential generation, destination, conversation,
   issue, and original input authority are checked before network access, after
   download, and under locks with attachment registration. Storage I/O is outside
   governance transactions; explicit revocation after storage removes the new,
   unregistered blob. No provider response HTML or signed query enters the
   delivery ledger, model context, or logs.

## Remaining gap and truthful UX

The real private text fixture under `/user-attachments/files/31948982/` remained
unavailable to anonymous intake; its provider browser anchor remained the
original file URL. The image-specific canonical mapping above does not invent
a signed generic-file endpoint. Such files remain a current-input
`download_unavailable` omission: no imported bytes, no claim of inspection, and
no substitution of an older task file. Activity currently shows that closed
omission rather than asserting that every 404 specifically means “private.”

Outbound is separate: the official
[GitHub CLI uploader](https://github.com/cli/cli/blob/trunk/internal/attachments/client.go)
allows OAuth, personal-access, and fine-grained personal-access tokens, not App
installation tokens. Paperclip keeps the private-task output-file fallback and
does not acquire extra repository permissions or impersonate the browser user.

## Qualification gate

Contract tests prove the real SDK's installation-token exchange and fixed
guarded comment GET, exact body/source binding, old-locator compatibility,
restart reconstruction, credential-free bytes, malformed/ambiguous rendering
denial, and revocation during download/storage. They are not live provider proof.

On the signed-in provider browser, upload a new private image to the existing
authorized test issue/PR comment, ask Maya to inspect that exact image, and
compare the stored hash/bytes with the fixture. Verify that no signed URL or
HTML is persisted. Repeat with a private text file; unless GitHub actually
provides a separately reviewed supported representation, it must still report
unavailable without substituting another attachment. Then test a review-comment
image and a changed/deleted source. Do not make the repository public to obtain
a passing result.

### Closed diagnostics for provider qualification

A first live private review-comment image was not imported; a signed anchor in
the browser is not evidence of the App REST response. The product now emits
only a closed `attachmentDiagnosticCode` beside the endpoint, issue, and
delivery IDs in the existing rejection log. Codes distinguish App authority or
request failure, exact source/body mismatch, missing rendering, unsupported
generic files, ambiguous/denied mapping, and a valid same-UUID signed-image
shape without the required original source anchor. In particular,
`github_attachment_canonical_signed_anchor_only` detected and denied an exact
signed anchor/image pair in the diagnostic-only deployment.

No response HTML, URL, JWT query, token, or provider error details enter these
diagnostics. SDK-wrapped errors retain only exact whitelisted codes with bounded
cause traversal; unknown errors collapse to a closed request-failed code.
Durable current-input omissions and agent prompts still use only
`download_unavailable`.

At 09:57:09 UTC on September 8, the actual App path emitted that signed-anchor
diagnostic for the newly admitted private review-comment image. This proved the
shape behind the unchanged source/body/repository/review-thread fences. The
bounded follow-up accepts exactly one such pair, with identical link/image
URLs and the same private-host/path/UUID/JWT checks. No additional host or
credential authority was added. Contract and PostgreSQL restart tests cover
both accepted forms, credential-free bytes, mixed/duplicate rejection, and
unchanged current-access/revocation checks. Successful live byte intake and
agent inspection were still unqualified at that diagnostic checkpoint.

### Live main-conversation image and generic-file check

At **17:12:44.815 UTC**, root used the signed-in GitHub browser to upload a
new image into the existing authorized test PR's main conversation. The
repository was visually confirmed **Private** and its visibility and App
permissions were not changed. `PRIVATE-IMAGE-LANDING-0908` asked the agent to
inspect only that newly attached image, without suggesting its visual content.

The current-input attachment imported as PNG, **2,111,878 bytes**, SHA-256
`7693966f6c2b4aaebf9e46359f715fdaede021346bcd926078bb331b1dddc3c1`.
An independent read-only audit rehashed the stored blob and verified the exact
comment/body/asset locator and wake-comment binding. The source-body hash
matches GitHub's CRLF normalization, not a rendered-page reconstruction.
The native `gpt-5.6-luna` run took **20.846 seconds** and recorded two artifact
view events. The final response accurately described the orange tabby, pale
green eyes, and indoor background; root inspected the rendered reply and image.
The final arrived **26.303 seconds** after submission. Working and final
operations each used one attempt and updated the same provider comment.

At **17:14:02.540 UTC**, `PRIVATE-FILE-LANDING-0908` uploaded a fresh synthetic
private text file. The prompt did not reveal its shape, color, or count.
The current-input action recorded exactly one `download_unavailable` omission,
zero imported or generated attachments, and no image-view event. Luna
truthfully reported that this exact new file was unavailable and did not
invent or reuse values. Its final arrived in **21.116 seconds**.

Scoped delivery, action, wake, run, event, result, comment and publication
checks found no persisted signed URL/JWT query or provider-rendered HTML.
Original query-free author `<img>` syntax is not provider-rendered HTML.
This is a scoped persistence audit, not a whole-database or browser-log claim.

These checks used server 48 and qualify the private **main-conversation**
image path and honest generic-file omission. Generic private files and native
outbound uploads remain unsupported.

### Live review-comment image after restart

On server 49, root replied to the existing authorized inline review thread,
uploaded the fixture again as a **new provider asset**, and submitted
`PRIVATE-REVIEW-IMAGE-LANDING-0908` at **17:25:14.894 UTC**. The final reply
arrived in that same review thread at **17:25:45.922 UTC**, **31.028 seconds**
later. The native Luna run used **23.822 seconds** and correctly described
the cat, pale green eyes, pink chair and plant. The rendered response persisted
after a normal browser refresh; the task and conversation remained open.

Independent diagnostics verified the exact new review comment, original review
root, current Paperclip comment, source-body digest, and new asset UUID. The
stored attachment again rehashed to the **2,111,878-byte** fixture SHA above.
The supplied source matches the locator digest after GitHub CRLF normalization.
There was one wake-associated run, no omission, two artifact-view events, and
one attempt per working/final publication, both targeting the same provider
review comment. Scoped persistence checks again found no signed-target/JWT or
provider-rendered response HTML, and no internal identifier in the final text.

This extends live proof to new private images in **both** main conversations
and review threads on the deployed authority implementation. It is not a
changed/deleted-source test or an interrupted-download/revocation stress test.

### Live changed-source rejection

Root uploaded a fresh private image in the authorized PR conversation and
submitted `PRIVATE-SOURCE-CHANGE-0908` at **17:38:59.379 UTC**. Paperclip was
deliberately offline after a zero-active-run shutdown, so the original created
delivery failed without entering the local delivery ledger. Root edited only
that synthetic source comment at **17:39:33.981 UTC**, preserving its new image
URL and appending a revision marker. The edit delivery also failed while the
server was offline. Neither delivery had been admitted before restart.

After server 50 became ready, root used the existing App identity and GitHub's
supported [App webhook redelivery API](https://docs.github.com/en/rest/apps/webhooks#redeliver-a-delivery-for-an-app-webhook)
to redeliver **only the original created event**, once. The new signed
delivery reached Paperclip and retained the original source digest
`1ac24a2833edef198dd4d6dfa6155414f93dff5d6e01902f9ef65b6e7902244b`.
The current canonical comment instead hashed to
`6c47240d26bf98e6561479a9c01ac6c5e111766a46ba01182397aea4845c5514`.
The unchanged new asset did not override this mismatch.

The closed diagnostic was `github_attachment_canonical_body_mismatch`, before
signed-target selection. The original ingress action was processed and its
retained body was redacted. No edited ingress action existed. The exact
current input had one `download_unavailable` omission, zero imported or
generated files, and no artifact-view event. One native Luna run took
**14.881 seconds**. Its final publication used one attempt and arrived
**17.755 seconds after ingress**: “The exact new image is unavailable because
it could not be imported.” Root verified that visible answer in the provider
conversation; the task remained open. The deliberate outage is not counted as
ordinary response latency.

An independent scoped audit of 52 run events and the associated delivery,
action, source, wake, run, result and publication found no signed-target/JWT
or provider-rendered-HTML markers, and no internal UUID in the final output.
This proves rejection of a **changed body** for a real redelivered event. It
does not prove deleted-source or in-flight download revocation behavior.

Separately, the bot-created reply callback received a 502 before reaching the
instrumented local proxy or Paperclip. GitHub reported the exact configured
destination, a 0.1-second duration, no response headers and an empty body.
Adjacent original-redelivery and bot-edit callbacks used that same destination
and received 202. The bot-edit was correctly filtered as outbound/self; the
missing created callback was not. The pre-proxy transport cause is unconfirmed
and must not be described as harmless self-event filtering or a repaired bug.
