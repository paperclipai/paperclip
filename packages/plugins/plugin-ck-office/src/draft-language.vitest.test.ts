import assert from "node:assert/strict";
import { test } from "vitest";
import { reviewDraft, reviewOutreachMessage } from "./tools.js";

test("German outreach rejects an English strength term", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nDie Bandbreite reicht von mild bis full.\n\nFreundliche Grüsse\nAlan Christopherson",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /English strength term 'full'/);
});

test("German outreach rejects the English medium strength term", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nDer Cañonazo ist medium stark.\n\nFreundliche Grüsse\nAlan Christopherson",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /mittelkräftig/);
});

test("German outreach rejects the English adjective prime", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nIhre Karte führt prime kubanische Zigarren.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /English adjective 'prime'/);
});

test("German strength wording remains valid", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nDie Bandbreite reicht von mild bis vollmundig.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, true);
});

test("German outreach rejects the French product-line label", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nUnsere Ligne classique umfasst verschiedene Zigarren.\n\nFreundliche Grüsse\nAlan Christopherson",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /klassische Linie/);
});

test.each([
  "Tres Hermanos ist ein dominikanisches Unternehmen mit eigener Produktion.",
  "Tres Hermanos est une maison dominicaine qui produit ses propres cigares.",
  "Tres Hermanos is a Dominican company with its own production.",
])("outreach rejects Dominican company positioning: %s", (text) => {
  const result = reviewDraft(
    `Guten Tag\n\n${text}\n\nFreundliche Grüsse\nAlan Christopherson`,
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /Swiss company/);
});

test("outreach accepts the canonical Swiss-company and Dominican-factory fact", () => {
  const result = reviewDraft(
    "Guten Tag\n\nTres Hermanos ist ein Schweizer Unternehmen mit eigener Zigarrenproduktion in der Dominikanischen Republik.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, true);
});

test("the outreach gate checks the subject as well as the body", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos – Schweizer Premiumzigarren",
    "Guten Tag\n\nWir sind ein Schweizer Unternehmen.\n\nFreundliche Grüsse\nAlan Christopherson",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /em\/en dash/);
});

test("the outreach gate rejects a spaced separator hyphen in the subject", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos - Schweizer Premiumzigarren",
    "Guten Tag\n\nWir sind ein Schweizer Unternehmen.\n\nFreundliche Grüsse\nAlan Christopherson",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /spaced hyphen/);
});

test("French outreach rejects the English word cigars", () => {
  const result = reviewDraft(
    "Madame, Monsieur,\n\nNous proposons des cigars faits main.\n\nBien cordialement\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /cigares/);
});

test("outreach requires the complete two-line sender signature", () => {
  const result = reviewDraft(
    "Bonjour\n\nTres Hermanos est une entreprise suisse.\n\nAlan Christopherson",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /signature/);
});

test("first contact rejects a promise to send samples", () => {
  const result = reviewDraft(
    "Madame, Monsieur,\n\nJe me ferai un plaisir de vous faire parvenir un échantillon.\n\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /samples or goods/);
});

test("first contact rejects German sample promises regardless of word order", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nGerne sende ich Ihnen ein paar Muster zur Verkostung.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /samples or goods/);
});

test("first contact asks before committing to a personal visit", () => {
  const result = reviewDraft(
    "Sehr geehrte Damen und Herren\n\nIch komme persönlich vorbei, um die Möglichkeiten zu besprechen.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
    "first_contact",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /in-person visit/);
});

test("first contact requires the complete sender signature even when Alan is omitted", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihre Lounge",
    "Sehr geehrte Damen und Herren\n\nIhre Lounge hat Charakter.\n\nFreundliche Grüsse",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /signature/);
});

test("first contact requires a professional greeting", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihre Lounge",
    "Ihre Lounge hat Charakter.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /professional greeting/);
});

test("German outreach rejects obvious grammar and canonical product-name regressions", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für den Bären",
    "Sehr geehrte Damen und Herren\n\nDer Gasthaus ist traditionsreich. Unser No. 6 Big Hermano ist ein cremiger Blend.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /wrong German article/);
  assert.match(result.violations.join("\n"), /N°6 Big Hermano/);
  assert.match(result.violations.join("\n"), /English product jargon/);
});

test("first contact rejects Alan's disliked generic opener and premature conditions", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihr Haus",
    "Sehr geehrte Damen und Herren\n\nIch wende mich heute an Sie. Wir bieten attraktive Konditionen.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /Alan rejected this tone/);
  assert.match(result.violations.join("\n"), /commercial terms/);
});

test("first contact rejects CRM fields narrated back to the recipient", () => {
  const result = reviewOutreachMessage(
    "Zigarrendegustation im Hotel Bad Eptingen?",
    "Sehr geehrte Damen und Herren\n\nMein Name ist Alan Christopherson. Sie führen in Eptingen ein Hotel mit Restaurant und bieten Räume für Bankette an.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /CRM fields converted into prose/);
});

test("first contact rejects observation formulas and assumed guest interest", () => {
  const result = reviewOutreachMessage(
    "Kurze Degustation in der Lounge The Council?",
    "Sehr geehrte Damen und Herren\n\nIch bin Alan Christopherson von Tres Hermanos. Die Lounge The Council ist mir als traditionsreicher Treffpunkt bekannt. Ich denke, Tres Hermanos könnte für Ihre Gäste interessant sein.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /researched-observation formula/);
  assert.match(result.violations.join("\n"), /speculate about guest demand/);
});

test("first contact rejects unnatural branded-venue grammar and catalogue fragments", () => {
  const result = reviewOutreachMessage(
    "Kurze Degustation",
    "Sehr geehrte Damen und Herren\n\nMein Name ist Alan Christopherson und ich vertrete Tres Hermanos. Handgerollte Premiumzigarren, von mild bis kräftig.\n\nHätten Sie Interesse an einer Degustation in Ihrer The Council Lounge?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /ungrammatical possessive/);
  assert.match(result.violations.join("\n"), /catalogue-like sentence fragment/);
});

test("first contact accepts the purpose-led Bad Eptingen structure", () => {
  const result = reviewOutreachMessage(
    "Zigarrendegustation: Tres Hermanos",
    "Sehr geehrte Damen und Herren\n\nMein Name ist Alan Christopherson und ich vertrete Tres Hermanos. Wir sind ein Schweizer Unternehmen und produzieren unsere handgerollten Zigarren in der eigenen Fabrik in der Dominikanischen Republik.\n\nIch wollte Sie fragen, ob eine Zigarrendegustation im Rahmen eines Banketts oder Hotelanlasses für Sie interessant sein könnte.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, true);
});

test("first contact cannot rephrase a sample promise as bringing the collection", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihr Haus",
    "Sehr geehrte Damen und Herren\n\nKein Mindestbestellwert. Wir könnten Ihnen die Kollektion persönlich vorbeibringen.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /commercial terms/);
  assert.match(result.violations.join("\n"), /samples or goods/);
});

test("German outreach rejects common missing relative-clause commas", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihr Haus",
    "Sehr geehrte Damen und Herren\n\nDas passt für Gäste die nach dem Essen geniessen. Ich zeige eine Zusammenstellung die zu Ihrem Haus passt.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /Missing comma/);
});

test("German outreach rejects the common Favorit weak-noun error", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihr Haus",
    "Sehr geehrte Damen und Herren\n\nDer Cañonazo ist einem mittelkräftigen Favorit ähnlich.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /Favoriten/);
});

test("first contact rejects an unsolicited sample package even without a send verb", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihre Lounge",
    "Sehr geehrte Damen und Herren\n\nEin unverbindliches Musterpaket zur Verkostung. Hätten Sie Interesse?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /samples or goods/);
});

test("first contact rejects sending a product selection as a rephrased sample promise", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihre Lounge",
    "Sehr geehrte Damen und Herren\n\nIch sende Ihnen gern eine Auswahl zur Degustation.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /samples or goods/);
});

test("first contact rejects inflated absolute-fit marketing claims", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihre Lounge",
    "Sehr geehrte Damen und Herren\n\nDas passt ideal, bedient jeden Anspruch und erreicht die kennerischste Kundschaft.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /inflated or absolute-fit/);
});

test("first contact rejects every-guest claims and delivery commitments", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Ihr Haus",
    "Sehr geehrte Damen und Herren\n\nFür jeden Gast das passende Format. Wir liefern direkt.\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /inflated or absolute-fit/);
  assert.match(result.violations.join("\n"), /commercial terms/);
});

test("first contact rejects synthetic sales-copy bridges", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für den Bären",
    "Grüezi\n\nIn Ihrer Bärenstube verweilen Gäste. Da liegt eine gute Zigarre nah. Unsere Formate wecken Neugier.\n\nWäre eine Degustation interessant?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /synthetic sales-copy/);
});

test("first contact rejects catalogue-style lists of cigar formats", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für den Bären",
    "Grüezi\n\nTres Hermanos ist ein Schweizer Unternehmen mit eigener Produktion in der Dominikanischen Republik. Der Cañonazo, die N°2 Piramide und der N°5 Salomon wären interessant.\n\nWäre eine Degustation interessant?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, false);
  assert.match(result.violations.join("\n"), /catalogue/);
});

test("a short sourced degustation first contact passes", () => {
  const result = reviewOutreachMessage(
    "Zigarrendegustation im Gasthaus Bären",
    "Grüezi\n\nIhre Bärenstube und der Weinkeller bieten einen schönen Rahmen für einen Genussabend.\n\nTres Hermanos ist ein Schweizer Unternehmen mit eigener Zigarrenproduktion in der Dominikanischen Republik. Unsere handgerollten Zigarren reichen von mild bis kräftig.\n\nWäre eine Zigarrendegustation bei Ihnen grundsätzlich interessant?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, true);
});

test("concise hotel outreach with verified social proof passes", () => {
  const result = reviewOutreachMessage(
    "Tres Hermanos für Le Fumoir",
    "Sehr geehrte Damen und Herren\n\nLe Fumoir im Bellevue Palace führt eine eigene Zigarrenkarte mit kubanischen und südamerikanischen Klassikern.\n\nTres Hermanos ist ein Schweizer Unternehmen mit eigener Zigarrenproduktion in der Dominikanischen Republik. Unsere Zigarren sind bereits in Häusern wie dem Bürgenstock Resort Lake Lucerne und dem Hotel Schweizerhof Bern vertreten. Wir legen Wert auf verlässliche Zusammenarbeit und gleichbleibende Qualität.\n\nWäre eine Zigarrendegustation im Le Fumoir grundsätzlich interessant?\n\nFreundliche Grüsse\nAlan Christopherson\nTres Hermanos",
  );
  assert.equal(result.pass, true);
});
