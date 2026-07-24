import { skillAccentColor } from "@/lib/skill-create";

/**
 * Minimal shape needed to render a skill's square icon. `DiscoveryCard`
 * (store) and the agent-skills row model both satisfy this, so the icon can be
 * shared without pulling the whole store page into other modules.
 */
export interface SkillIconCard {
  key: string;
  name: string;
  slug?: string | null;
  iconUrl: string | null;
  color: string | null;
}

export function SkillCardIcon({ card, size = 36 }: { card: SkillIconCard; size?: number }) {
  if (card.iconUrl) {
    return (
      <img
        src={card.iconUrl}
        alt=""
        className="shrink-0 rounded-md object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const accent = skillAccentColor(card.key, card.color);
  const letter = (card.slug || card.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-md font-semibold text-white"
      style={{ width: size, height: size, backgroundColor: accent, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </span>
  );
}
