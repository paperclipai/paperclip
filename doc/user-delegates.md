# User delegates

A person can name one agent as their delegate in a company. The delegate may
then perform a fixed list of person-only actions as that person. It exists so a
chief-of-staff style agent can clear routine board work, such as answering a
card, waking another agent or retrying a stalled task, without a human board key.

## Turning it on and off

- Only the signed-in person manages their own delegate, from **Profile → My
  delegate**, or with `PUT` / `DELETE /api/companies/{companyId}/users/me/delegate`.
- A person has at most one active delegate per company. Naming another agent
  replaces the earlier one.
- Turning it off takes effect on the next request. A delegate can never change
  who the delegate is.
- `GET /api/companies/{companyId}/user-delegations/mine` tells an agent which
  people named it.

## Acting as the person

The delegate opts in on each request:

```
X-Paperclip-Delegate-For: <userId>
X-Paperclip-Delegate-Reason: <why, 1 to 500 characters>
```

Clients that cannot set headers, such as the runner's `call_api` tool, may send
the `delegateFor` and `delegateReason` query parameters instead.

`server/src/middleware/user-delegate.ts` then checks, in order:

1. The caller is an agent with a standard credential. Task-bridge keys,
   skill-test keys and Muse native tool tokens are refused.
2. The person has an active delegation that names this agent.
3. The method and route are on the allowlist in
   `server/src/services/user-delegates.ts` (`USER_DELEGATE_ACTIONS`).
4. The person still has an active company membership. Viewers may only read.

It writes a `user_delegate.acted` activity row before the action runs. The row
names the delegate agent, its run, the person (`responsibleUserId` and
`details.onBehalfOfUserId`), the reason and the action key. If the row cannot be
written, the action does not run. The request then continues as a board actor
for that person, limited to this company, with the person's own membership and
never with instance-admin rights. Activity rows that the route writes itself
are attributed to the person.

## What a delegate can do

The allowlist covers the board-only steps that block agent-run companies most
often:

- Answer, accept, reject, defer or withdraw task cards, and decide items on the
  decisions page
- Create, change and run any agent's routine and its triggers (not secret rotation)
- Wake, invoke, pause and resume another agent (not terminate or delete)
- Review new catalog tools and manage tool rules
- Start adding a Composio account (the provider sign-in stays with the person)
- Decide stalled-task reviews and recovery items, retry tasks and workspace recovery
- Decide stuck-run watchdog items
- Read the person's inbox (attention feed and Mine)

Everything else stays person-only, on purpose: approvals, budgets, agent
permissions, agent keys, hires, secrets, sign-ins, board API keys, invites,
instance administration and destructive workspace repair.
