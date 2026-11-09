import type { ReactNode } from "react";
import type { DirectionKit, LabGroup } from "../kit";
import { KIND_SPECIMENS, STACK_SPECIMENS } from "../fixtures";
import { TASK_DETAIL_PANE_WIDTH } from "./PanelFrame";
import { Slot } from "./Slot";

/**
 * The vocabulary sheet: for one kit, a specimen of every `LabKind` in each of
 * its five slots, at the width that slot has in the product. No app chrome —
 * this is for reading a kit's language, not for judging it in context.
 */

// The thread column as the reference screenshots show it, beside an open pane.
const THREAD_COLUMN_WIDTH = 835;

const KIND_GROUP: LabGroup = {
  id: "specimens",
  taskIdentifier: "ACM-3",
  title: "One of each kind",
  count: KIND_SPECIMENS.length,
  updatedLabel: "Sep 28, 2026",
  artifacts: KIND_SPECIMENS,
};

const LABEL = "font-mono text-(length:--text-nano) uppercase tracking-(--tracking-label) text-muted-foreground";

function Unit({ title, slot, note, children }: { title: string; slot: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1 border-b border-border pb-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <p className={LABEL}>
          {slot}
          {note ? ` — ${note}` : null}
        </p>
      </header>
      {children}
    </section>
  );
}

export function KindsSheet({ kit }: { kit: DirectionKit }) {
  return (
    <div className="flex min-h-225 flex-col gap-12 bg-background p-6 text-foreground">
      <header className="flex flex-col gap-1">
        <p className={LABEL}>Vocabulary sheet · {kit.id}</p>
        <h1 className="text-lg font-semibold">{kit.name}</h1>
        <p className="text-sm text-muted-foreground">{kit.tagline}</p>
      </header>

      <div className="flex items-start gap-8">
        <div className="flex min-w-0 flex-col gap-12" style={{ width: THREAD_COLUMN_WIDTH }}>
          <Unit title="Thread · work-product rows" slot="ThreadWorkProduct" note={`${THREAD_COLUMN_WIDTH}px column, one row per specimen`}>
            <div className="flex flex-col gap-6">
              {KIND_SPECIMENS.map((artifact) => (
                <div key={artifact.id} className="flex flex-col gap-1.5">
                  <span className={LABEL}>
                    {artifact.kind}
                    {artifact.ext ? ` · .${artifact.ext}` : null}
                    {artifact.review ? ` · ${artifact.review}` : null}
                  </span>
                  <Slot kit={kit}>
                    <kit.ThreadWorkProduct artifact={artifact} />
                  </Slot>
                </div>
              ))}
            </div>
          </Unit>
          <Unit title="Thread · attachments block" slot="ThreadAttachments" note="every specimen under one message">
            {/* Same wrapper the thread frame gives the block (TaskChatBubble.tsx:217). */}
            <Slot kit={kit} className="flex w-full flex-col gap-1">
              <kit.ThreadAttachments artifacts={KIND_SPECIMENS} />
            </Slot>
          </Unit>
        </div>

        <div className="shrink-0" style={{ width: TASK_DETAIL_PANE_WIDTH }}>
          <Unit title="Panel · Artifacts tab" slot="PanelBody" note={`${TASK_DETAIL_PANE_WIDTH}px pane, 16px body padding`}>
            <div className="border-x border-border bg-card p-4">
              <Slot kit={kit}>
                <kit.PanelBody artifacts={KIND_SPECIMENS} />
              </Slot>
            </div>
          </Unit>
        </div>
      </div>

      <div className="flex w-full max-w-6xl flex-col gap-12">
        <Unit title="Gallery · opened stack" slot="GalleryStack" note="one tile per specimen, page width">
          <Slot kit={kit}>
            <kit.GalleryStack group={KIND_GROUP} />
          </Slot>
        </Unit>
        <Unit title="Gallery · stacks" slot="GalleryStacks" note="1, 3 and 21 artifacts">
          <Slot kit={kit}>
            <kit.GalleryStacks groups={STACK_SPECIMENS} />
          </Slot>
        </Unit>
      </div>
    </div>
  );
}
