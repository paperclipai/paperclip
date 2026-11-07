# Cancelled dependency handoffs

A cancelled prerequisite does not supply its required result. The dependent issue keeps that blocker until its owner changes the plan.

When a prerequisite is cancelled, Paperclip saves a system comment on each eligible assigned dependent. It sends that comment through the existing interaction wake path. The owner can use an existing result, replace or remove an obsolete dependency, or cancel work that is no longer needed. Other blockers and human approvals remain in place.

The comment identifies the current owner, the set of cancelled blockers, and the dependent's blocked cycle. Concurrent deliveries use a row lock and reuse the same comment. A new cancellation or blocked cycle can produce a new handoff. A completed or in-flight handoff wake prevents a duplicate.

The existing dependency recovery pass restores a missed handoff. It respects active execution paths, pending interactions, and pause holds. It does not move a human review into execution.

