---
name: typesafe
description: Ask TypeSafe's Jev model yes/no, multiple-choice and scoring questions about text or data and get calibrated answers with a confidence. Provided automatically by your TypeSafe connection.
---

# TypeSafe

Jev is an evaluator. It reads a `state` and answers the typed questions you
define. It does not write text, call tools or edit files. Use it when a decision
must be consistent and come with a probability, not a paragraph.

Good uses:

- Gate a step. "Is this pull request description complete?" Continue only above
  a threshold you choose.
- Route between named options. "Which team owns this issue?"
- Rate against a rubric. "How severe is this incident?"

The `state` and your questions are sent to TypeSafe. Do not submit content that
must not leave this instance. Do not look for provider credentials; Paperclip
holds the key.

## How to call it

Native runners use the `typesafe_ask` tool with the request below as its
arguments.

Other runtimes use `paperclipai typesafe ask --file <request.json>`. If the
installed CLI does not include `typesafe`, use the authenticated HTTP API
instead; do not install or upgrade tools for this. Send
`POST /api/companies/$PAPERCLIP_COMPANY_ID/typesafe/ask` with the same JSON, the
injected Paperclip API URL and bearer key, and the `X-Paperclip-Run-Id` header.

## Request

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this convey urgency?",
      "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": null
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

- `state`: a string, object or array. Structured data is fine.
- `questions`: a map. You choose each key; the answer returns under the same key.
- `instructions`: a string, or an object that holds the question in one field
  and data it refers to in others. Refer to a data field by name in backticks.
- `noul`: a yes/no question. `criteria` is optional.
- `choice`: `criteria` maps each option to a description, or `null`. 1 to 255
  options.
- `score`: `criteria` is an ordered array of 2 to 10 level descriptions, lowest
  first.
- `model`: optional. It overrides the connection's model, for example
  `jev-preview`.
- `connectionId`: required only when more than one TypeSafe connection is listed
  under "Assigned resources" below.

Ask several questions about one state in one call. A request may hold 64k tokens
in total, and 32k for the state plus the longest question.

## Reading answers

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent": { "type": "noul", "noul": 0.95 },
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.88, "technical": 0.12, "sales": 0.0 },
      "confidence": 0.81
    },
    "frustration": {
      "type": "score",
      "score": 1.05,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.0, "1": 0.95, "2": 0.05 },
      "confidence": 0.92
    }
  },
  "usage": { "input_tokens": 318, "output_tokens": 34 }
}
```

- `noul` is the probability of yes, from 0 to 1. Pick your threshold before you
  ask, and state it when you report the decision.
- `choice` is the most likely option. `confidence` tells you how far ahead it
  is. Treat a low confidence as "unclear", not as an answer.
- `score` is probability-weighted and can land between levels. Use `legend` to
  name the levels.

## Errors

| Status | Meaning | What to do |
| --- | --- | --- |
| 400 | The request shape is wrong. | Fix the request. The response names the field. |
| 403 | No TypeSafe connection is assigned to you, a policy blocks the call, or the request carries no active run of yours. | Send `X-Paperclip-Run-Id` from your run environment. Otherwise stop and report it; access is managed on the connection in Paperclip. |
| 422 | TypeSafe rejected the request or the model name, or you must pick a `connectionId`. | Fix the request. |
| 429, 503 | TypeSafe is rate limiting or overloaded. | Wait, then retry once. |
| 502 | TypeSafe rejected the stored key or failed. | Stop. Report that the connection needs attention. |
