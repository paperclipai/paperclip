---
name: deal-with-security-advisory
description: >
  Handle a GitHub Security Advisory response for Paperclip, including
  confidential fix development in a temporary private fork, human coordination
  on advisory-thread comments, CVE request, synchronized advisory publication,
  and immediate security release steps.
---

# Security Vulnerability Response Instructions

## ⚠️ CRITICAL: This is a security vulnerability. Everything about this process is confidential until the advisory is published. Do not mention the vulnerability details in any public commit message, PR title, branch name, or comment. Do not push anything to a public branch. Do not discuss specifics in any public channel. Assume anything on the public repo is visible to attackers who will exploit the window between disclosure and user upgrades.

***

## Context

A security vulnerability has been reported via GitHub Security Advisory:

* **Advisory:** {{ghsaId}} (e.g. GHSA-x8hx-rhr2-9rf7)
* **Reporter:** {{reporterHandle}}
* **Severity:** {{severity}}
* **Notes:** {{notes}}

***

## Step 0: Fetch the Advisory Details

Pull the full advisory so you understand the vulnerability before doing anything else:

```
gh api repos/paperclipai/paperclip/security-advisories/{{ghsaId}}

```

Read the `description`, `severity`, `cvss`, and `vulnerabilities` fields. Understand the attack vector before writing code.

## Step 1: Acknowledge the Report

⚠️ **This step requires a human.** The advisory thread does not have a comment API. Ask the human operator to post a comment on the private advisory thread acknowledging the report. Provide them this template:

> Thanks for the report, @{{reporterHandle}}. We've confirmed the issue and are working on a fix. We're targeting a patch release within {{timeframe}}. We'll keep you updated here.

Give your human this template, but still continue

Below we use `gh` tools - you do have access and credentials outside of your sandbox, so use them.

## Step 2: Create the Temporary Private Fork

This is where all fix development happens. Never push to the public repo.

```
gh api --method POST \
  repos/paperclipai/paperclip/security-advisories/{{ghsaId}}/forks

```

This returns a repository object for the private fork. Save the `full_name` and `clone_url`.

Clone it and set up your workspace:

```
# Clone the private fork somewhere outside ~/paperclip
git clone <clone_url_from_response> ~/security-patch-{{ghsaId}}
cd ~/security-patch-{{ghsaId}}
git checkout -b security-fix

```

**Do not edit `~/paperclip`** — the dev server is running off the `~/paperclip` master branch and we don't want to touch it. All work happens in the private fork clone.

**TIPS:**

* Do not commit `pnpm-lock.yaml` — the repo has actions to manage this
* Do not use descriptive branch names that leak the vulnerability (e.g., no `fix-dns-rebinding-rce`). Use something generic like `security-fix`
* All work stays in the private fork until publication
* CI/GitHub Actions will NOT run on the temporary private fork — this is a GitHub limitation by design. You must run tests locally

## Step 3: Develop and Validate the Fix

Write the patch. Same content standards as any PR:

* It must functionally work — **run tests locally** since CI won't run on the private fork
* Consider the whole codebase, not just the narrow vulnerability path. A patch that fixes one vector but opens another is worse than no patch
* Ensure backwards compatibility for the database, or be explicit about what breaks
* Make sure any UI components still look correct if the fix touches them
* The fix should be minimal and focused — don't bundle unrelated changes into a security patch. Reviewers (and the reporter) should be able to read the diff and understand exactly what changed and why

**Specific to security fixes:**

* Verify the fix actually closes the attack vector described in the advisory. Reproduce the vulnerability first (using the reporter's description), then confirm the patch prevents it
* Consider adjacent attack vectors — if DNS rebinding is the issue, are there other endpoints or modes with the same class of problem?
* Do not introduce new dependencies unless absolutely necessary — new deps in a security patch raise eyebrows

Push your fix to the private fork:

```
git add -A
git commit -m "Fix security vulnerability"
git push origin security-fix

```

## Step 4: Coordinate with the Reporter

⚠️ **This step requires a human.** Ask the human operator to post on the advisory thread letting the reporter know the fix is ready and giving them a chance to review. Provide them this template:

> @{{reporterHandle}} — fix is ready in the private fork if you'd like to review before we publish. Planning to release within {{timeframe}}.

Proceed

## Step 5: Request a CVE

This makes vulnerability scanners (npm audit, Snyk, Dependabot) warn users to upgrade. Without it, nobody gets automated notification.

```
gh api --method POST \
  repos/paperclipai/paperclip/security-advisories/{{ghsaId}}/cve

```

GitHub is a CVE Numbering Authority and will assign one automatically. The CVE may take a few hours to propagate after the advisory is published.

## Step 6: Publish Everything Simultaneously

This all happens at once — do not stagger these steps. The goal is **zero window** between the vulnerability becoming public knowledge and the fix being available.

### 6a. Verify reporter credit before publishing

```
gh api repos/paperclipai/paperclip/security-advisories/{{ghsaId}} --jq '.credits'

```

If the reporter is not credited, add them:

```
gh api --method PATCH \
  repos/paperclipai/paperclip/security-advisories/{{ghsaId}} \
  --input - << 'EOF'
{
  "credits": [
    {
      "login": "{{reporterHandle}}",
      "type": "reporter"
    }
  ]
}
EOF

```

### 6b. Update the advisory with the patched version and publish

```
gh api --method PATCH \
  repos/paperclipai/paperclip/security-advisories/{{ghsaId}} \
  --input - << 'EOF'
{
  "state": "published",
  "vulnerabilities": [
    {
      "package": {
        "ecosystem": "npm",
        "name": "paperclip"
      },
      "vulnerable_version_range": "< {{patchedVersion}}",
      "patched_versions": "{{patchedVersion}}"
    }
  ]
}
EOF

```

Publishing the advisory simultaneously:

* Makes the GHSA public
* Merges the temporary private fork into your repo
* Triggers the CVE assignment (if requested in step 5)

### 6c. Cut a release immediately after merge

```
cd ~/paperclip
git pull origin master

gh release create v{{patchedVersion}} \
  --repo paperclipai/paperclip \
  --title "v{{patchedVersion}} — Security Release" \
  --notes "## Security Release

This release fixes a critical security vulnerability.

### What was fixed
{{briefDescription}} (e.g., Remote code execution via DNS rebinding in \`local_trusted\` mode)

### Advisory
https://github.com/paperclipai/paperclip/security/advisories/{{ghsaId}}

### Credit
Thanks to @{{reporterHandle}} for responsibly disclosing this vulnerability.

### Action required
All users running versions prior to {{patchedVersion}} should upgrade immediately."

```

## Step 7: Post-Publication Verification

```
# Verify the advisory is published and CVE is assigned
gh api repos/paperclipai/paperclip/security-advisories/{{ghsaId}} \
  --jq '{state: .state, cve_id: .cve_id, published_at: .published_at}'

# Verify the release exists
gh release view v{{patchedVersion}} --repo paperclipai/paperclip

```

If the CVE hasn't been assigned yet, that's normal — it can take a few hours.

⚠️ **Human step:** Ask the human operator to post a final comment on the advisory thread confirming publication and thanking the reporter.

Tell the human operator what you did by posting a comment to this task, including:

* The published advisory URL: `https://github.com/paperclipai/paperclip/security/advisories/{{ghsaId}}`
* The release URL
* Whether the CVE has been assigned yet
* All URLs to any pull requests or branches
