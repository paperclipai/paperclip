# Skill: call-scripts — phone call preparation for Alan
Alan closes by phone. When a task involves calling a venue, produce a call
prep in the calendar entry / task description with EXACTLY this shape:

1. CONTEXT LINE: who they are, relationship state (new / cold client / warm),
   the one thing we know that matters (from the CRM dossier).
2. OPENER: one natural sentence. New contact: "Grüezi, Alan Christopherson von
   Divino Cigars. Wir vertreiben Tres Hermanos Zigarren an Schweizer
   Gastronomie und Fachhandel." Cold existing client: reference the last real
   touchpoint (an event, an order) and ask how it went.
3. GOAL: ONE concrete outcome per call type —
   emailless venue: get the decision-maker's name + email to send info.
   warm-up call: reorder or a short visit appointment.
   post-draft follow-up: confirm the mail arrived, propose the meeting slot.
4. OBJECTION LINES (max 3): "kein Bedarf" → ask what their guests ask for
   after dinner; "haben schon einen Lieferanten" → we complement, small fine
   assortment, no exclusivity; "keine Zeit" → offer to send one page by mail,
   ask for the address.
5. HARD RULES: NO prices on a first call (say: kommt in den Unterlagen).
   Never mention producers by name as our source. Never promise delivery
   terms — Alan decides. Respect do-not-contact.
After Alan reports the call: log it with espo_log_call (status Held, outcome
in notes) and create the follow-up (espo_create_crm_task or schedule_followup).
