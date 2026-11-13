import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../../kit";
import { tabLabel } from "../kind";
import { ExtTab, Greek, Paper, Scaled, type ObjectSize } from "./Paper";

/** Landscape sheets: ledger paper (spreadsheets) and the slide. */

const LEDGER_ROWS = 12;
const LEDGER_COLS = 3;

/**
 * Ledger paper: punched down the left margin, a green head band, green rules,
 * and the sheet's real first rows in mono. No dog-ear — it came off a pad.
 */
export function LedgerSheet({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const tab = tabLabel(artifact);
  const rows = (artifact.excerpt ?? "")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(","));
  return (
    <Scaled size={size} box="ledger">
      <Paper ear={false} mask="var(--tac-mask-punch)" className="text-(length:--tac-type-body)">
        <span className="absolute inset-y-0 left-(--tac-ledger-margin) right-0 block border-l-(length:--tac-rule-w) border-(--tac-ledger-rule) font-mono leading-none text-(--tac-ink)">
          {Array.from({ length: LEDGER_ROWS }, (_, row) => (
            <span
              key={row}
              className={cn(
                "grid h-(--tac-ledger-row) grid-cols-3 border-b-(length:--tac-rule-w) border-(--tac-ledger-rule)",
                row === 0 && "bg-(--tac-ledger-head) font-bold text-(--tac-ledger-ink)",
              )}
            >
              {Array.from({ length: LEDGER_COLS }, (_, col) => (
                <span
                  key={col}
                  className="flex items-center overflow-hidden whitespace-nowrap border-r-(length:--tac-rule-w) border-(--tac-ledger-rule) px-(--tac-gap-para) last:border-r-0"
                >
                  {rows[row]?.[col] ?? ""}
                </span>
              ))}
            </span>
          ))}
        </span>
      </Paper>
      {tab ? <ExtTab label={tab} tone="sheet" /> : null}
    </Scaled>
  );
}

const FADE_END = { maskImage: "var(--tac-fade-end)" } as const;
const FOOTER_LINE = ["w-full"] as const;

/**
 * A 16:9 sheet: the deck's cover. With a first-slide thumbnail it is that
 * picture; without one (the usual case — a .pptx carries no preview) it is a
 * title slide set from what is known: a short accent rule in the tab's
 * orange, the real title large across the whole width, and a footer rule
 * with "1 / N". The title wraps and dissolves at the foot of its box —
 * printed paper is never ellipsized. A second slide lies under it when the
 * deck has more than one.
 */
export function SlideSheet({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const [failed, setFailed] = useState(false);
  const tab = tabLabel(artifact);
  const cover = artifact.thumbnailUrl && !failed ? artifact.thumbnailUrl : null;
  const pages = artifact.pageCount ?? 1;
  return (
    <Scaled size={size} box="slide">
      <Paper ear={false} back={pages > 1}>
        {cover ? (
          <img src={cover} alt="" draggable={false} className="absolute inset-0 block size-full object-cover" onError={() => setFailed(true)} />
        ) : (
          <span className="absolute inset-0 flex flex-col p-(--tac-page-pad) font-sans text-(--tac-ink)">
            <span className="block text-(length:--tac-type-body)">
              <span className="block h-(--tac-bar-h) w-1/8 rounded-full bg-(--tac-tab-slides)" />
            </span>
            <span
              className="mt-(--tac-gap-para) block min-h-0 flex-1 overflow-hidden break-words text-(length:--tac-type-title) font-bold leading-(--tac-lead-title) tracking-tight"
              style={FADE_END}
            >
              {artifact.title}
            </span>
            <span className="flex items-center justify-between gap-(--tac-page-pad) border-t-(length:--tac-rule-w) border-(--tac-ink-faint) pt-(--tac-gap-para) font-mono text-(length:--tac-type-body) leading-none text-(--tac-ink-soft)">
              <Greek lines={FOOTER_LINE} className="w-1/4" />
              {pages > 1 ? <span className="shrink-0">1 / {pages}</span> : null}
            </span>
          </span>
        )}
      </Paper>
      {/* A slide is too short to give up a corner, so its tab stands above the top edge like an index tab. */}
      {tab ? <ExtTab label={tab} tone="slides" place="top" /> : null}
    </Scaled>
  );
}
