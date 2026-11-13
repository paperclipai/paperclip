import { useState } from "react";
import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../../kit";
import { hostOf, pathOf, tabLabel } from "../kind";
import { Greek, OBJECT_SHADOW, Scaled, type ObjectSize } from "./Paper";

/** The two objects that are not sheets: the archive box and the link's address card. */

/**
 * A kraft archive box seen from the front: a lid a little wider than the body,
 * a hand-hole, and a paper label carrying the extension. The board has a
 * horizontal fibre as well as the speck.
 */
export function ArchiveBox({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const label = tabLabel(artifact) ?? "ZIP";
  return (
    <Scaled size={size} box="box">
      <span className="absolute inset-x-1/25 bottom-0 top-1/6 block overflow-hidden rounded-b-(--tac-page-r) bg-(--tac-kraft) bg-(image:--tac-kraft-grain) shadow-(--tac-kraft-edge)">
        {/* The lid's shadow on the body. */}
        <span className="absolute inset-x-0 top-0 block h-1/5 bg-(image:--tac-kraft-shade)" />
        <span className="absolute left-1/2 top-3/10 block h-1/8 w-3/10 -translate-x-1/2 rounded-full bg-(--tac-kraft-dark) shadow-(--tac-kraft-hole)" />
        <span className="absolute bottom-1/10 left-1/2 block -translate-x-1/2 rounded-(--tac-tab-r) bg-(--tac-paper) px-(--tac-tab-px) py-(--tac-tab-py) font-mono text-(length:--tac-type-tab) font-bold leading-none tracking-wide text-(--tac-ink) shadow-(--tac-tab-shadow)">
          {label}
        </span>
      </span>
      <span className="absolute inset-x-0 top-0 block h-1/5 rounded-(--tac-page-r) bg-(--tac-kraft-lid) bg-(image:--tac-kraft-grain) shadow-(--tac-kraft-edge)" />
    </Scaled>
  );
}

const CARD_LINES = ["w-4/5", "w-1/2"] as const;
const BAR_LINE = ["w-3/5"] as const;

function Arrow({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 17 17 7M8.5 7H17v8.5" />
    </svg>
  );
}

/**
 * A link's address card: pale blue stock with rounder corners than paper (it
 * is not a sheet, and manila is the folders'), and the address printed in a
 * white bar across its head — a dot, the whole host in mono, wrapping rather
 * than cut, and an out-arrow. Under the bar, the link's preview picture when
 * it has one that loads; otherwise its path over a couple of greeked lines.
 * At the two thread sizes the address is a bar, like every other line there.
 */
export function LinkCard({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const [failed, setFailed] = useState(false);
  const small = size === "xs" || size === "sm";
  const picture = artifact.thumbnailUrl && !small && !failed ? artifact.thumbnailUrl : null;
  return (
    <Scaled size={size} box="card">
      <span className="absolute inset-0 flex flex-col gap-(--tac-gap-block) overflow-hidden rounded-(--tac-card-r) bg-(--tac-card) bg-(image:--tac-grain) p-(--tac-page-pad) text-(length:--tac-type-body) shadow-(--tac-card-edge)">
        <span className="flex shrink-0 items-center gap-(--tac-gap-para) rounded-(--tac-card-r) bg-(--tac-card-bar) px-(--tac-gap-block) py-(--tac-gap-para) font-mono font-bold leading-(--tac-lead-title) text-(--tac-card-ink) shadow-(--tac-card-bar-edge)">
          <span className="block size-(--tac-gap-block) shrink-0 rounded-full bg-(--tac-card-dot)" />
          {small ? <Greek lines={BAR_LINE} className="min-w-0 flex-1 py-(--tac-bar-h)" /> : <span className="min-w-0 flex-1 break-all">{hostOf(artifact.url)}</span>}
          <Arrow className="w-(--tac-glyph) shrink-0 text-(--tac-card-soft)" />
        </span>
        {picture ? (
          <img
            src={picture}
            alt=""
            draggable={false}
            className="block min-h-0 w-full flex-1 rounded-(--tac-page-r) object-cover object-top shadow-(--tac-emulsion-edge)"
            onError={() => setFailed(true)}
          />
        ) : (
          <span className="flex min-h-0 flex-1 flex-col gap-(--tac-gap-block) overflow-hidden px-(--tac-gap-para) font-mono leading-(--tac-lead-title) text-(--tac-card-soft)">
            {small ? null : <span className="block break-all">{pathOf(artifact.url)}</span>}
            <Greek lines={CARD_LINES} className="opacity-70" />
          </span>
        )}
      </span>
    </Scaled>
  );
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * PANEL — the same card lying across the desk, as wide as its holder: the
 * address bar in UI-size mono (host and path, wrapping), then the preview
 * picture at its own shape. Not scaled; it takes the `pw` size's edge and
 * radius. A picture that fails to load is dropped and the card closes up.
 */
export function LinkCardWide({ artifact }: { artifact: LabArtifact }) {
  const [failed, setFailed] = useState(false);
  const picture = artifact.thumbnailUrl && !failed ? artifact.thumbnailUrl : null;
  return (
    <span
      data-tac-size="pw"
      className={cn(
        "relative flex w-full select-none flex-col gap-(--tac-print-edge) rounded-(--tac-card-r) bg-(--tac-card) bg-(image:--tac-grain) p-(--tac-print-edge) shadow-(--tac-card-edge)",
        OBJECT_SHADOW,
      )}
    >
      <span className="flex items-start gap-2 rounded-(--tac-card-r) bg-(--tac-card-bar) px-2.5 py-1.5 font-mono text-(length:--text-micro) font-semibold leading-4 text-(--tac-card-ink) shadow-(--tac-card-bar-edge)">
        <span className="mt-1 block size-2 shrink-0 rounded-full bg-(--tac-card-dot)" />
        <span className="min-w-0 flex-1 break-all">
          {hostOf(artifact.url)}
          <span className="font-normal text-(--tac-card-soft)">{pathOf(artifact.url)}</span>
        </span>
        <Arrow className="mt-0.5 size-3 shrink-0 text-(--tac-card-soft)" />
      </span>
      {picture ? (
        <span className="relative block w-full overflow-hidden rounded-(--tac-print-r) bg-(--tac-emulsion)" style={{ aspectRatio: clamp(artifact.aspect ?? 16 / 9, 1.2, 2.2) }}>
          <img src={picture} alt="" draggable={false} className="block size-full object-cover object-top" onError={() => setFailed(true)} />
          <span className="absolute inset-0 block shadow-(--tac-emulsion-edge)" />
        </span>
      ) : null}
    </span>
  );
}
