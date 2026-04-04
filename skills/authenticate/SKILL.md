---
name: authenticate
description: Authentication procedures for admin, personal, and MFA platforms
---

# Authentication Skill

Use this skill whenever you need to log into any platform.

## Administrative Platforms (with company credentials)

For platforms where the organization has administrative credentials, **retrieve the password from the credentials document** (check your TOOLS.md for the credentials URL).

**Procedure:**
1. Navigate to the platform login page using Playwright MCP
2. Open the credentials document in a new tab
3. Find the relevant username/password for the platform
4. Log in to the platform
5. **Close the credentials document tab immediately after logging in**

**Security rules:**
- **NEVER save passwords locally** — not in files, variables, comments, or any other place
- **NEVER include passwords in research documents, logs, or conversation output**
- Passwords must **ONLY exist in the credentials document** — nowhere else
- Always close the credentials tab after use

## Personal / Non-Administrative Platforms

For platforms requiring the user's personal credentials (banking, email, etc.):
1. Navigate to the page first using Playwright MCP
2. **If credentials are prefilled** (e.g., saved by browser), just click "Log in" / "Submit" directly — do NOT ask the user first
3. **If credentials are NOT prefilled**, use the `wait-for-board` skill to wait for the user to log in
4. Only then continue with the work

**NEVER ask the user if they need to log in before navigating — always navigate first, then assess.**

## OTP / MFA Codes

When a platform requires a one-time code (OTP, MFA, 2FA) sent to the user's phone or email:
1. **Inform the user** which platform is requesting the code and where it was sent
2. **Use the `wait-for-board` skill** to poll for the code entry (5-minute timeout for OTP)
3. **Enter the code immediately** — OTP codes expire quickly
4. **Never store OTP codes** in files, variables, or logs

## Completion

After successful authentication:
- Verify the login was successful (check for dashboard/home page elements)
- If login fails, retry once with fresh credentials before escalating to the user
- Report which platform was authenticated and proceed with the task
