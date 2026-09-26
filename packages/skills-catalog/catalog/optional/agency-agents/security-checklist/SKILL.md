---
name: "security-checklist"
description: "Security best practices for Micronaut/Kotlin backend including authentication, authorization, input validation, and OWASP prevention. Use when implementing auth, validating inputs, or reviewing security."
allowed_tools:
  - Read
  - Glob
  - Grep
key: "paperclipai/optional/agency-agents/security-checklist"
recommendedForRoles:
  - "engineer"
  - "product"
  - "security"
tags:
  - "agency-agents"
  - "engineer"
  - "product"
  - "security"
  - "checklist"
defaultInstall: false
---
# Security Checklist

Run a security audit against Micronaut/Kotlin backend code.

## When to Use

- Adding authentication or authorization to endpoints
- Validating user inputs on new or changed endpoints
- Reviewing code for security issues before merge
- Checking for common vulnerabilities (SQL injection, XSS, IDOR)
- Setting up secrets management

## Process

> See audit-reference.md for code examples, vulnerability table, and SAFE/DANGEROUS patterns.

1. **Check Authentication** — every controller has @Secured, current user comes from security context
2. **Check Authorization** — verify user has access to the resource before returning it
3. **Check Input Validation** — @Valid on controller params, Jakarta annotations on request DTOs
4. **Check SQL Injection Prevention** — use Exposed ORM (auto-parameterized), never raw SQL with string concat
5. **Check Common Vulnerabilities** — SQL injection, XSS, CSRF, auth bypass, IDOR, mass assignment, data exposure, rate limiting
6. **Check Secrets Management** — no hardcoded secrets, use env vars, never log tokens/passwords/PII, never commit .env
7. **Check Response Sanitization** — response DTOs control what's exposed, never return raw entities

## Interaction Style

- Always checks all categories, doesn't skip any section
- Flags the most dangerous issues first
- Shows code examples for every fix, not just descriptions
- Tells you what's wrong AND how to fix it

## Rules

- Every endpoint must have a @Secured annotation
- Admin endpoints use OAuthSecurityRule.ADMIN
- Users can only access their own resources (or admin can access all)
- Input validated with @Valid and Jakarta annotations
- No raw SQL queries with string concatenation
- Sensitive fields excluded from response DTOs
- Tokens/passwords never logged
- Error messages don't leak internal details
- Rate limiting on auth endpoints

## Output

Produces a checklist report with pass/fail for each category:

- [ ] All endpoints have @Secured annotation
- [ ] Admin endpoints use OAuthSecurityRule.ADMIN
- [ ] User can only access their own resources (or admin can access all)
- [ ] Input validated with @Valid and Jakarta annotations
- [ ] No raw SQL queries with string concatenation
- [ ] Sensitive fields excluded from response DTOs
- [ ] Tokens/passwords never logged
- [ ] Error messages don't leak internal details
- [ ] Rate limiting on auth endpoints
