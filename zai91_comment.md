## ZAI-91 Complete — awaiting CEO review

### What was done

**Previous run** (`c337aaf9`) localized the 5 core files. **This run** performed the full file-wide audit and fixed all remaining hardcoded strings missed in the initial pass.

#### Additional fixes (this run)

- **IssueDetail.tsx**: `tab_related_work` "Related work" tab label; `productivity_review` badge title + text
- **IssueThreadInteractionCard.tsx**: `interaction.no_reason` fallback, `aria-label` for include-task checkbox, `"Confirm"` / `"Decline"` button defaults
- **IssueChatThread.tsx** (major pass): 5 components needed `useTranslation` added; wired up ~30 translation keys for copy/interrupt/cancel/sending/feedback dialog/downvote popover/system notice buttons/toast messages/composer placeholder/attachment status labels/assignee selector

All keys were already in `en/issues.json` but never wired. New keys added for strings without keys: `interaction.{include_task,confirm,decline}`, `detail.{productivity_review,productivity_review_tooltip}`, `chat.{copy_link,copy_link_aria,copy_notice,copy_notice_aria,drop_to_upload,drop_upload_hint,attach_file,attachment_*}`.

### Parity check
- EN: 781 keys, RU: 805 keys (24 extra = valid Russian plural forms `_few`/`_many`)
- **Missing in RU: 0**

### Visual verification (server 3105)

**English — `/SDF/issues/SDF-1`:**
![issue-detail-overview-en](/api/attachments/ab79e4c9-bbf8-4047-a988-44d46b8696c6/content)

**Russian — same route:**
![issue-detail-overview-ru](/api/attachments/c6af2bbb-e306-4363-a284-838aff025cdd/content)

**Russian — Связанная работа tab:**
![issue-detail-related-work-ru](/api/attachments/5e993c4c-9903-4b15-99f5-2b80a8d79aaf/content)

**Russian — Активность tab:**
![issue-detail-activity-ru](/api/attachments/01b2f607-a88e-4322-b72c-39be073edcd5/content)

### Tabs verified RU
`Чат` · `Активность` · `Связанная работа` ✓
Properties panel all Russian ✓
Sidebar navigation all Russian ✓
Composer placeholder "Ответить" ✓

### Out of scope noted
- `PriorityIcon.tsx` hardcodes priority label strings (e.g. "Medium") — shared component outside 5-file scope; separate ticket needed
- `"New document"` button — documents component outside this cluster

### Commits
- `c337aaf9` — initial localization of 5 files
- `890a5d6c` — complete file-wide audit (this run)

`git diff master --stat` shows only `ui/src/locales/**` and `t()`-replacements. No DOM changes, no feature changes.

Ready for CEO review.
