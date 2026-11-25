---
title: Company skills
summary: Optional recipient access for company skill content
---

## Recipient access

`POST /api/companies/{companyId}/skills` and
`PATCH /api/companies/{companyId}/skills/{skillId}` accept an optional
`recipientAgentId` UUID or `null`. Responses include this field.

Board operators can set or remove this restriction. The recipient must be a
non-terminated agent in the same company. Invalid recipients return `422`.
An agent cannot change a recipient, including clearing it (`403`). Existing
skill policy and company authorization still apply. A board update saves the
recipient and its activity record in one transaction.

A non-null recipient limits agent discovery, references, details, versions,
file reads and execution delivery to that agent. Project-source access is an
additional requirement. Board operators retain company administration access.
Background reads without an actor cannot load recipient-restricted content.
`null` retains the previous company/project behavior.

Skill assignments control whether an accessible skill is enabled. They do not
change its recipient. A wrong-recipient assignment or a stale version pin does
not grant access. Each new runtime selection checks current access. Native
assigned-skill reads also check current authorization before reading their
saved bundle. Bytes already delivered to a running process cannot be recalled.

The database uses a composite company/recipient foreign key with `ON DELETE
RESTRICT`. Deleting a referenced agent fails; it cannot set the restriction to
`null`. Terminating the agent denies its restricted reads. Forks retain the
recipient and cannot become public links. Portable export rejects restricted
content until that format can preserve its audience.

## Safe preparation and later activation

This API does not approve a deployment, migration or third-party skill content.
Obtain those approvals separately. Migration `0509_nasty_mantis.sql` adds a
nullable field, composite foreign key and index. Existing rows remain
unrestricted. The migration is marked `requires_staging` because its constraint
and index can lock the skills table. Do not run it on an active production
instance as an unapproved preparation step.

Do not create restricted rows while any older server that lacks this access
check can still serve the company.

After the reviewed code and schema are available in the authorized environment:

1. Complete the source safety and license review for each selected skill.
2. As a board operator, create each skill with its reviewed `markdown` and
   `recipientAgentId` in the initial POST. Do not first import it company-wide
   and apply the restriction afterward.
3. Add its reviewed supporting files through the existing files API. Use the
   current `expectedVersionId` on each save. Keep the skill unassigned until
   all files, including required license notices, are present.
4. Compare the recipient's catalog and known-ID content reads with other agents.
   Check both legacy adapters and native execution with safe fixtures first.
5. Add only the selected keys with `POST /api/agents/{agentId}/skills/sync`,
   `mode: "add"` and `desiredSkills: [key, ...]`. Leave all other selections and
   permissions unchanged. Validate the delivered content in a fresh run.

For rollback, remove only those keys with `mode: "remove"`. Wait for admitted
runs and protected version pins to settle before deleting the new skill
records through the existing delete API. Keep the recipient restriction during
rollback. Do not clear it to make deletion easier. Retain the additive schema
until a separate reviewed schema rollback is authorized.
