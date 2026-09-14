export type IconName =
  | "activity" | "authority" | "branch" | "close" | "diff" | "documents"
  | "download" | "evidence" | "pause" | "play" | "protocol" | "reset"
  | "spark" | "state" | "stop" | "terminal" | "timeline";

const PATHS: Record<IconName, string> = {
  activity: "M3 12h3l2-6 4 12 3-9 2 5h4",
  authority: "M12 3l7 4v5c0 4.6-2.8 7.6-7 9-4.2-1.4-7-4.4-7-9V7zM9 12l2 2 4-4",
  branch: "M6 3v12a3 3 0 0 0 3 3h6M15 18l-3-3m3 3-3 3M6 7h6a3 3 0 0 0 3-3V3",
  close: "M5 5l14 14M19 5 5 19",
  diff: "M8 5v14M4 9h8M17 7v10M14 12h6",
  documents: "M6 3h9l3 3v15H6zM15 3v4h4M9 11h6M9 15h6",
  download: "M12 3v12m-5-5 5 5 5-5M5 21h14",
  evidence: "M4 5h16v14H4zM8 9h8M8 13h5",
  pause: "M8 5v14M16 5v14",
  play: "M8 5v14l11-7z",
  protocol: "M4 8h14m-3-3 3 3-3 3M20 16H6m3-3-3 3 3 3",
  reset: "M5 8a8 8 0 1 1-1 7M5 8V3m0 5h5",
  spark: "M12 2l1.7 5.3L19 9l-5.3 1.7L12 16l-1.7-5.3L5 9l5.3-1.7zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  state: "M9 4H6a2 2 0 0 0-2 2v3M15 4h3a2 2 0 0 1 2 2v3M9 20H6a2 2 0 0 1-2-2v-3M15 20h3a2 2 0 0 0 2-2v-3M9 9h6v6H9z",
  stop: "M7 7h10v10H7z",
  terminal: "M5 7l4 5-4 5m7 0h7",
  timeline: "M5 5v14M5 8h5M5 13h9M5 18h13",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="pit-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
