import { describe, expect, it } from "vitest";

import {
  formatQBankItemCard,
  formatQBankMediaBrief,
  getQBankSourceRef,
  summarizeQBankItem,
  type QBankPartnerItem,
} from "./qbank-item-card.js";

const item50067: QBankPartnerItem = {
  id: 50067,
  type: "MultipleChoice",
  question_type: "Multiple Choice",
  question:
    "<p>A client diagnosed with ovarian cancer has been informed that the cancer has spread. The client has an elevated bilirubin and jaundice. Which organ likely has metastatic disease?</p>",
  rationale:
    '<p>The liver processes bilirubin.</p><p><img class="image" src="https://cdn-1.hltcorp.com/attachments/contents/000/026/921/large/Liver_and_Bile_Duct_Anatomy.jpg?1675957897" /></p>',
  key_takeaway:
    "<p>When you see jaundice, think about where the problem is:</p><ul><li>Before the liver</li><li>In the liver</li><li>After the liver</li></ul>",
  draft_rationale:
    "<p><strong>Ovarian Cancer Metastasis</strong></p><ul><li><strong>Liver:</strong> Highly vascular.</li><li><strong>Lungs:</strong> Common due to blood supply.</li></ul>",
  draft_key_takeaway: "Ovarian cancer metastasis often involves the liver, lungs, peritoneum, intestines, and lymph nodes.",
  difficulty: "Easy",
  state: "published",
  updated_at: 1755347587,
  first_published_at: 1427754310,
  revised_at: 1678147200,
  v2_flashcard_id: 759,
  answers: [
    {
      id: 169069,
      text: "Bone",
      correct: false,
      rationale: "Cancers such as breast and prostate have a predilection for bone metastases.",
    },
    {
      id: 169072,
      text: "Liver&nbsp;",
      correct: true,
      rationale: "The liver's extensive blood supply and role in filtering blood make it a common site for metastasis.",
    },
  ],
  product_associations: [
    { app_id: 3, category_id: 1068753933, visibility: true, deleted: false },
    { app_id: 4, category_id: 1068753932, visibility: true, deleted: false },
  ],
  categories: [
    { id: 1068753933, app_id: 3, name: "Anatomy and Physiology", published: true, deleted: false },
  ],
};

describe("QBank item card formatting", () => {
  it("builds a stable source ref from app and question id", () => {
    expect(getQBankSourceRef({ appId: 3, questionId: 50067 })).toBe("qbank:app-3/question-50067");
  });

  it("summarizes a raw Partner API item without exposing HTML or auth data", () => {
    const summary = summarizeQBankItem({ appId: 3, item: item50067 });

    expect(summary.sourceRef).toBe("qbank:app-3/question-50067");
    expect(summary.questionText).toContain("A client diagnosed with ovarian cancer");
    expect(summary.questionText).not.toContain("<p>");
    expect(summary.correctAnswers).toEqual(["Liver"]);
    expect(summary.appIds).toEqual([3, 4]);
    expect(summary.categoryNames).toEqual(["Anatomy and Physiology"]);
    expect(summary.hasDraftRevision).toBe(true);
    expect(summary.mediaCandidates).toEqual([
      "https://cdn-1.hltcorp.com/attachments/contents/000/026/921/large/Liver_and_Bile_Duct_Anatomy.jpg?1675957897",
    ]);
  });

  it("renders a Paperclip-readable markdown document with review and media next actions", () => {
    const card = formatQBankItemCard({ appId: 3, item: item50067 });

    expect(card.documentKey).toBe("qbank-item");
    expect(card.title).toBe("QBank item 50067: ovarian cancer has spread");
    expect(card.markdown).toContain("# QBank item 50067");
    expect(card.markdown).toContain("Source ref: `qbank:app-3/question-50067`");
    expect(card.markdown).toContain("Correct answer: Liver");
    expect(card.markdown).toContain("Draft revision: present");
    expect(card.markdown).toContain("Media candidate");
    expect(card.markdown).toContain("Create MMM2 visual rationale plan");
    expect(card.markdown).not.toContain("<p>");
    expect(card.markdown).not.toMatch(/x-mcp-token|PARTNER_API_KEY|cffefcae/i);
  });

  it("formats a review-only MMM2 visual brief grounded in the QBank item", () => {
    const brief = formatQBankMediaBrief({ appId: 3, item: item50067 });

    expect(brief.documentKey).toBe("qbank-media-brief");
    expect(brief.title).toBe("Visual brief for QBank item 50067");
    expect(brief.markdown).toContain("# QBank visual brief");
    expect(brief.markdown).toContain("Source ref: `qbank:app-3/question-50067`");
    expect(brief.markdown).toContain("Review mode: plan only — no image generation or publishing approved.");
    expect(brief.markdown).toContain("Teaching objective: Explain why the correct answer is Liver");
    expect(brief.markdown).toContain("Preserve answer grounding: Bone, Liver");
    expect(brief.markdown).toContain("Visual direction: liver/bilirubin pathway or organ-metastasis map");
    expect(brief.markdown).toContain("https://cdn-1.hltcorp.com/attachments/contents/000/026/921/large/Liver_and_Bile_Duct_Anatomy.jpg?1675957897");
    expect(brief.markdown).not.toContain("<p>");
    expect(brief.markdown).not.toMatch(/x-mcp-token|PARTNER_API_KEY|cffefcae/i);
  });

  it("strips entity-encoded HTML before rendering markdown", () => {
    const card = formatQBankItemCard({
      appId: 3,
      item: {
        id: 9001,
        question: "&lt;img src=x onerror=alert(1)&gt;Which finding matters?",
        rationale: "&lt;script&gt;alert(1)&lt;/script&gt;Treat airway first.",
        key_takeaway: "Use &lt;strong&gt;clinical&lt;/strong&gt; priorities.",
        answers: [{ text: "&lt;em&gt;Airway&lt;/em&gt;", correct: true }],
      },
    });

    expect(card.markdown).toContain("Which finding matters?");
    expect(card.markdown).toContain("Treat airway first.");
    expect(card.markdown).toContain("Use clinical priorities.");
    expect(card.markdown).toContain("Correct answer: Airway");
    expect(card.markdown).not.toMatch(/<\/?(?:img|script|strong|em)\b/i);
    expect(card.markdown).not.toContain("onerror");
  });
});
