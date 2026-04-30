# Document Validator Skill

Validates documents received via email attachments. Extracts content from all file types, checks against a caller-supplied checklist, and produces a structured result. The calling agent defines what documents are required and what to do with the result.

---

## Step 1 — Read the email and list attachments

```
1a. outlook_read_email messageId="{messageId}"
    → note: hasAttachments, body text, sender email, sender name

1b. IF hasAttachments:
    outlook_list_attachments messageId="{messageId}"
    → collect: name, contentType, size, attachmentId for each file
```

---

## Step 2 — Extract content from each attachment

For each attachment, call `outlook_read_attachment`:

| File type | Supported | What you get |
|-----------|-----------|-------------|
| `.pdf` | ✅/⚠️ | `extractedText` — full plain text from all pages. If response contains `warning: "SCANNED_PDF_NO_TEXT"`, the PDF is a scanned image with no text layer — treat as `needs_manual_review`, notify `human_in_loop_email`, and ask candidate to re-send as a JPG/PNG image or a text-layer PDF |
| `.docx` | ✅ Yes | `extractedText` — full plain text from the document |
| `.txt / .csv / .md` | ✅ Yes | `text` — raw file content |
| `.jpg / .jpeg` | ✅ Yes | Image content block — Claude vision reads it directly |
| `.png` | ✅ Yes | Image content block — Claude vision reads it directly |
| `.gif` | ✅ Yes | Image content block — Claude vision reads it directly |
| `.webp` | ✅ Yes | Image content block — Claude vision reads it directly |
| `.heic / .tiff` | ⚠️ Uncertain | Flag for manual review — may not extract |
| `.zip / .rar` | ❌ No | Flag as received, instruct candidate to send files unzipped |
| Other binary | ❌ No | Metadata only — flag as received, note manual verification needed |

**Every response includes `contentBytes` (base64) and `contentType`.** The calling agent MUST retain both fields per attachment — they are required in Phase 9 to upload the original file to SharePoint via `sharepoint_upload_binary`. Do not discard them after validation.

**Note on image quality:** Claude vision can read scanned documents, ID cards, certificates, and photos. If an image is blurry, too dark, or resolution is very low, flag it as `unclear` and request a re-upload with specific feedback (e.g., "The image of your degree certificate is blurry — please provide a clearer scan").

Combine: email body text + all extracted attachment text → **full submission text** for matching.

For image attachments: visually inspect for document type, name visible on document, and any key fields (DOB, ID number, etc.).

---

## Step 3 — Match against the required checklist

The **calling agent** provides the checklist — a list of required items with keywords to detect.

For each required item:

- `present` — explicitly mentioned in text OR attachment name matches OR extracted text / image contains identifying keywords
- `pending` — not found anywhere in submission
- `unclear` — partial mention, ambiguous, needs follow-up

**Matching tips:**
- Normalise text: lowercase, strip punctuation before keyword search
- A single attachment may satisfy multiple checklist items (e.g., Aadhaar satisfies both Photo ID and Address Proof)
- An attachment that is clearly a different document (e.g., a company PRD, meeting notes) does NOT count for any checklist item
- For images: use visual content to identify document type even if no text label is present

---

## Step 3b — Verify document details match candidate details

The calling agent provides the candidate's known details: `employee_full_name`, `employee_email`, `date_of_birth` (if available).

For each document that contains a name, DOB, or other identity field, cross-check against the candidate's details:

| Check | How to verify | Result if mismatch |
|-------|--------------|-------------------|
| Name on document matches `employee_full_name` | Compare (allow minor spelling variations, initials) | `name_mismatch` — log and flag |
| DOB on document matches provided DOB | Compare date | `dob_mismatch` — log and flag |
| Name consistent across ALL submitted documents | Compare names on PAN, Aadhaar, certificates, payslips | `cross_doc_name_mismatch` — log and flag |

**Mismatch handling:**
- Minor variation (e.g., "Karthik R" vs "Karthik Rajan") → flag as `unclear`, note in record, escalate to human
- Clear mismatch (different name entirely) → flag as `name_mismatch`, do NOT accept document, notify human_in_loop_email immediately
- DOB mismatch → same — flag, notify human, do not accept

Add `identity_checks` to the result object (see Step 4).

---

## Step 4 — Build a structured validation result

**DATA SENSITIVITY:** Never include actual Aadhaar digits, PAN digits, or any government ID number in the `evidence` field or `notes` field. Use `[REDACTED]` as a placeholder. The result object is passed to other agents and may appear in logs or emails.

Return this object (the calling agent decides what to do with it):

```json
{
  "sender": { "name": "...", "email": "..." },
  "attachments": [
    { "name": "file.pdf", "contentType": "application/pdf", "readable": true, "extractedLength": 1200, "messageId": "AAMkAGI...", "attachmentId": "AAMkAGI...att" }
  ],
  "checklist": [
    { "item": "Aadhaar Card", "status": "present", "evidence": "Aadhaar card received — number [REDACTED]" },
    { "item": "PAN Card", "status": "pending", "evidence": null },
    { "item": "Highest Qualification Certificate", "status": "unclear", "evidence": "Certificate present but blurry — re-upload requested" }
  ],
  "summary": {
    "total": 8,
    "present": 5,
    "pending": 2,
    "unclear": 1
  },
  "identity_checks": {
    "name_on_documents": "Karthik Rajan",
    "name_matches_candidate": true,
    "dob_on_documents": "1995-06-15",
    "dob_matches_candidate": true,
    "cross_doc_name_consistent": true,
    "mismatches": []
  },
  "notes": "All identity fields consistent across submitted documents."
}
```

---

## Step 5 — Reply with HTML (always)

**Before sending:** Confirm the reply body contains no raw Aadhaar, PAN, or government ID digits. If referencing a received document, use "Aadhaar Card ✓" not the number itself.

**All replies from this skill MUST use `isHtml: true`.** Never send plain text — formatting is lost in Outlook.

The calling agent provides the reply template. This skill populates it with the actual missing/present items and sends:

```
outlook_reply
  messageId: "{messageId}"
  body: "{HTML body from calling agent's template, filled with actual results}"
  isHtml: true
  replyAll: false
```

**HTML formatting rules:**
- Paragraphs → `<p>...</p>`
- Numbered lists → `<ol><li>...</li></ol>`
- Bullet lists → `<ul><li>...</li></ul>`
- Bold emphasis → `<strong>...</strong>`
- Signature line breaks → `<br>`
- Never use markdown (`**`, `-`, `\n`) in the body — HTML only

---

## Step 6 — Return result to calling agent

Pass the validation result back. The calling agent decides:
- Whether to escalate, follow up, or proceed
- What to save to SharePoint or other storage
- Whether to notify a human reviewer
- What the next step in its own workflow is

This skill does not make those decisions.
