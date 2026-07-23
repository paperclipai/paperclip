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
   Legit hyphens such as "E-Mail" and the owner-approved "Boutique-Fabrik" in
   the first-contact Muster are fine.
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
11. The owner-approved first-contact Muster asks for the opportunity to present
    the cigars and Rum Don Isidro and give a few samples to taste. This is an
    in-person presentation offer, not permission to send a sample package,
    promise delivery, or commit a date before the prospect answers. Commercial
    conditions, minimum order values, discounts, and margins remain out of first
    contact.
12. If Alan chose Hold or wrote revision feedback, treat every concrete point in
    his latest feedback as an acceptance criterion. Re-read it immediately before
    `review_draft`. Do not replace a requested sourced fact with an easier generic
    CRM description, and do not queue the replacement until every point is visibly
    satisfied.

## Owner-approved first-contact Muster (2026-07-23)

This is now the canonical model for every new first-contact mail. Preserve its
order, voice, meaning, and fixed paragraphs. Adapt only:

- the subject's natural preposition and venue name;
- the greeting, using a name only when the exact address is verified for that
  person;
- `{venue}` and `{one verified reason}` from the dossier;
- grammar required by the venue's name.

Do not shorten this into the old minimal four-block formula, replace Alan's
candid payment sentence, remove the passion paragraph, or add new sales copy.

```text
Betreff: Tres Hermanos Cigars {natural venue phrase}

{verified greeting}

Ich bin Alan Christopherson von Tres Hermanos Cigars. Wir sind eine qualitätsorientierte Zigarrenmarke mit eigener Fabrik in der Dominikanischen Republik. Das ermöglicht uns, ein sehr zuverlässiger Schweizer Partner zu sein und Zigarren zu produzieren, die für uns echte Meisterwerke sind.

Ich bin auf {venue} aufmerksam geworden, weil {one verified reason}. Ich möchte Sie freundlich um die Gelegenheit bitten, Ihnen unsere Zigarren und den Rum Don Isidro vorzustellen und Ihnen einige Muster zum Probieren zu geben.

Wir konzentrieren uns mehr darauf, unsere Leidenschaft für die Herstellung und den Genuss grossartiger Zigarren zu teilen, als einfach nur zu verkaufen. Bezahlt zu werden ist vor allem eine Bestätigung, die uns motiviert, weiterzumachen.

Auch wenn wir nur eine kleine Boutique-Fabrik sind, hat uns unsere Qualität bereits die Türen zu renommierten Häusern wie dem Bürgenstock Resort Lake Lucerne, dem Suvretta House, dem Hotel Schweizerhof Bern und vielen anderen geöffnet.

Ich würde sehr gerne eine Zigarrendegustation bei Ihnen machen. Könnte das für Sie interessant sein?

Freundliche Grüsse
Alan Christopherson
Tres Hermanos
```

The three named houses are owner-approved social proof, not accidental
cross-venue mixing. Do not substitute or add another reference without Alan's
approval. `Rum Don Isidro` must stay distinct from the cigar factory: the mail
may present it, but must never imply that Tres Hermanos produces the rum.

Avoid extra sales-copy bridges such as “Da liegt eine gute Zigarre nah”, “das
Passende für jeden Gast”, “eine echte Ergänzung”, “Neugier wecken”, “Gespräche
einleiten”, “verdient”, and “passt ausgezeichnet”. They are polished prose, not
Alan speaking.

Alan's real replies can be warm, direct, and imperfect. Learn their directness,
not their typos or grammar errors.

Rules 1, 2, 4 (dashes, hyphens, ß) are also enforced by the `review_draft` gate, but do not rely on the
gate to catch style — write it human the first time. The gate is the floor, not the standard.
