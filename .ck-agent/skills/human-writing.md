# Skill: human-writing — make every outward text read as human-written (owner law)

Load this whenever you write ANY text a person outside the company will read: outreach
emails, follow-ups, proposals, buyer/venue replies, marketing copy. Alan's rule: if a
recipient can tell it was written by AI, it fails — even if the content is correct. A
polished-but-robotic email loses the sale. Migrated + tuned for CK B2B from the
research-backed Divino anti-detection guide (full source with Reddit/persona specifics:
`~/divino-agent/hermes-home/skills/divino-sales/divino-writing/SKILL.md`).

Our channel is mostly **German B2B email to Swiss venues** (see [[sales-style-and-templates]]
for structure and [[th-product-facts]] for what you may claim). Human voice, never casual-fake.

## The hard rules (an instant AI tell if broken — some are gate-enforced)

1. **NO em/en dashes (— –). Ever.** Use a comma, a period, or a new sentence. ENFORCED by the
   `review_draft` gate — a draft with one FAILS. (Owner: dashes make people think "AI wrote this.")
2. **NO connective/suspended hyphens** — write "Zigarrenlounge", not "Zigarren-Lounge"; "Premiumzigarren",
   not "Premium-Zigarren"; not "Fumoir- und Zigarrenlounge". Close the compound or reword. Also gate-ENFORCED.
   (Legit hyphens like "E-Mail" are fine.)
3. **NO bullet points / numbered lists / markdown / bold / headers** in an email or message. Write prose.
4. **Swiss German: "ss" never "ß"** ("Strasse", "gross", "Grüsse"). Gate-ENFORCED.
5. **NO collaborative AI-speak**: "Ich hoffe, das hilft", "Gerne stehe ich für Fragen zur Verfügung" as
   filler, "I hope this email finds you well", "Great question", "Of course/Certainly". Just say the thing.
6. **NO mic-drop closer.** AI ends on a tidy wrap-up sentence. Humans stop when they're done. If the last
   sentence neatly summarizes everything, cut it.

## The 2026 word/phrase tells (data-backed — avoid; English ones creep into German drafts too)

**Only-in-AI (instant flag):** "curious what others think", "Not because X. Because Y.", "The lesson?",
"here's what actually happened", "X taught me Y", "the privilege of", "And honestly?", "here's the kicker",
"You're not alone", "no fluff", "thrilled/excited/humbled to announce".

**Heavily overrepresented (×5–×39 vs humans):** **"genuinely" (×39 — the #1 tell)**, "in practice" (×18),
"worth noting/mentioning" (×13), "what actually matters" (×9.7), "one of those" (×7.7), "feels like" (×7.5),
"not just X" (×4.5), "That said" (×4.4), "rather than" (×4.1), "it's not X, it's Y" (×3.9), "especially" (×2.2),
hedge pileups ("arguably, perhaps, generally, typically" stacked).

**Classic AI vocab (still kills you):** delve, crucial, pivotal, testament, showcasing, underscoring,
fostering, landscape/tapestry/realm (abstract), vibrant, intricate, profound, enhance, garner, furthermore,
moreover, notably, undoubtedly, in conclusion, in order to, in terms of. German equivalents to avoid:
"nahtlos", "massgeschneidert" (as filler), "im Herzen von", "Genuss auf höchstem Niveau", "Erlebnis der Extraklasse".

## Cadence + voice (the structural tells, harder to fake, more important than any word)

- **Vary sentence length naturally, never theatrically.** Do not manufacture a
  two-word fragment or a long meandering sentence merely to look human. For a
  first contact, clarity matters more than visible cadence tricks.
- **Be specific, not balanced.** AI hedges ("eine hochwertige Ergänzung für Ihr
  Sortiment"). Humans give a concrete purpose for writing. On a first contact,
  specificity should usually live in the proposal or question, not in a product
  catalogue or a recital of the recipient's website.
- **If an observation is used, connect it to the reason for writing.** A sourced
  venue fact followed by a new paragraph beginning `Tres Hermanos ist ...` is
  still a template: it reads as two pasted facts. The better option is often to
  omit the observation and let dossier knowledge shape the proposal. If the
  fact truly belongs in the mail, connect it plainly to the reason for writing;
  do not flatter, assume what guests want, or declare a perfect fit.
- **Put a person and a purpose in the room; do not narrate CRM fields.** On a
  cold first contact to a general mailbox, opening with `Sie führen ...`, `Ihr
  Hotel bietet ...`, or a list of the recipient's own facilities sounds like
  an audit. The recipient already knows what business they run. Use a normal
  introduction, preferably `Mein Name ist Alan Christopherson und ich vertrete
  Tres Hermanos.` Then state the relevant idea or question. A venue fact is
  optional, not a quota: include it only when a person would naturally mention
  it in the same sentence as the reason for writing.
- **Vary vocabulary.** AI repeats its favorite words. Don't let a distinctive word appear twice in one message.
- **Natural does not mean incorrect.** A slightly informal turn or an intentional
  two-word sentence can help, but grammar, articles, salutations, punctuation,
  product names, and the sender signature must still be correct. Never manufacture
  “human” mistakes such as a missing relative-clause comma, `der Gasthaus`, or
  `in Ihrer The Council Lounge`. Put branded venue names into a grammatically
  sound construction such as `in der Lounge The Council`.
- **No catalogue fragments.** Never insert a fragment such as `Handgerollte
  Premiumzigarren, von mild bis kräftig.` A product-range phrase is not a
  substitute for a sentence and usually does not belong in first contact at all.
- **Swiss markers, used naturally** (not mechanically): "Grüezi" opening, "Merci", "Freundliche Grüsse" close;
  helvetisms where they fit ("Apéro", "Anlass"). Never "I hope this finds you well".

## Pre-send checklist (run before every outward text)

1. Search "—" and "–" → 0. Search connective hyphens ("wort-wort", "wort- und") → 0.
2. Search "genuinely"/"genau genommen"/"eigentlich" as filler, and any only-in-AI phrase → 0.
3. Read it aloud → person talking, or a document? If document, loosen it.
4. Any bullet/bold/header? → rewrite as prose.
5. Collaborative filler ("ich hoffe", "gerne für Fragen", "worth noting") → delete.
6. Sentence lengths varied? (a 2-word one near a 30-word one) → if uniform, break/combine some.
7. Is the purpose tied to THIS recipient's context? → if purely generic, make
   the proposal or question more relevant. Do not add a venue description just
   to prove that research happened. If a venue fact is used, connect it naturally
   to the reason for writing.
8. Mic-drop last sentence? → cut it.
9. "ss" not "ß"; no leaf/wrapper/origin claims ([[th-messaging-no-leaf-claims]]); no prices in first contact.
10. Read every claim as the recipient: remove assumptions (`selbstverständlich
    passend`), absolute-fit claims (`ideal`, `perfekt`, `für jeden Gast`), and
    administrative openers (`Ich wende mich heute an Sie`, `Ich möchte Ihnen ...
    vorstellen`). Start with the normal sender introduction. Ask one
    low-pressure question shaped by the dossier.
11. First contact may ask whether a presentation or degustation is interesting.
    It must not offer or promise a sample package, goods, delivery, a visit,
    commercial conditions, minimum order value, discount, or margin before the
    prospect engages.
12. If Alan chose Hold or wrote revision feedback, treat every concrete point in
    his latest feedback as an acceptance criterion. Re-read it immediately before
    `review_draft`. Do not replace a requested sourced fact with an easier generic
    CRM description, and do not queue the replacement until every point is visibly
    satisfied.

## First-contact shape for REV-06

Aim for 70–110 words before the signature. This is a personal introduction, not
a miniature catalogue or a hotel review.

Use four short blocks:

1. Neutral greeting, then one normal sender sentence:
   `Mein Name ist Alan Christopherson und ich vertrete Tres Hermanos.`
2. Continue with the company truth in first-person language: `Wir sind ein
   Schweizer Unternehmen ...`. A short verified-reference sentence may follow
   when it provides useful trust.
3. State the purpose naturally. For a hotel with event facilities:
   `Ich wollte Sie fragen, ob eine Zigarrendegustation im Rahmen eines Banketts
   oder Hotelanlasses für Sie interessant sein könnte.` For an existing lounge,
   ask whether they would like to get to know Tres Hermanos through a short
   degustation. This is where dossier knowledge should shape the idea without
   being recited back to the recipient.
4. Stop. Use one question. Do not list multiple products, recommend formats
   unasked, describe pairings, repeat obvious facts about the venue, or offer
   several competing calls to action.

Avoid sales-copy bridges such as “Da liegt eine gute Zigarre nah”, “das Passende
für jeden Gast”, “eine echte Ergänzung”, “Neugier wecken”, “Gespräche
einleiten”, “verdient”, and “passt ausgezeichnet”. They are polished prose, not
Alan speaking.

Alan's real replies can be warm, direct, and imperfect. Learn their directness,
not their typos or grammar errors.

Rules 1, 2, 4 (dashes, hyphens, ß) are also enforced by the `review_draft` gate, but do not rely on the
gate to catch style — write it human the first time. The gate is the floor, not the standard.
