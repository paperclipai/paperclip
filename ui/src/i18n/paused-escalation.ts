import { isRussianLocale, translateLabel } from "./tx";

const PAUSED_ESCALATION_BODY =
  /^Escalations from (.+?) route to paused agent (.+?)\. Work assigned to a paused agent never runs; unpause (.+?) or change who this agent reports to\.$/;

export function pausedEscalationCopy(
  language: string | undefined,
  english: string,
  agentName: string,
  pausedAncestorName?: string | null,
): { title: string; body: string } {
  const locale = isRussianLocale(language) ? "ru" : language;
  const title = translateLabel(locale, "Escalation path is paused");
  if (locale !== "ru") return { title, body: english };
  const match = PAUSED_ESCALATION_BODY.exec(english);
  const from = agentName || match?.[1] || "";
  const paused = pausedAncestorName || (match && match[2] === match[3] ? match[2] : "");
  if (!from || !paused) return { title, body: english };
  return {
    title,
    body:
      `Эскалации от агента ${from} идут агенту ${paused} на паузе. ` +
      `Работа, назначенная агенту на паузе, не запускается. ` +
      `Снимите ${paused} с паузы или измените, кому подчиняется этот агент.`,
  };
}
