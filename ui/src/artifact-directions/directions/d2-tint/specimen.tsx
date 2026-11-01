import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import "./tokens.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { KIND_SPECIMENS, STACK_SPECIMENS } from "../../fixtures";
import { LAB_KINDS, type LabArtifact } from "../../kit";
import { GalleryPreview, usePreviewKind } from "./GalleryPreview";
import { GalleryStacks } from "./GalleryStacks";
import { KindGlyph, type GlyphSize } from "./KindGlyph";
import { FoldedPreview, KindWell, Lead } from "./Lead";
import { MetaLine } from "./MetaLine";
import { StateMark } from "./StateMark";
import { glyphLabel, metaParts } from "./kinds";

/**
 * Builder's aid: every primitive of the direction at every size, for all ten
 * kinds. Served by the lab's dev server at
 * /src/artifact-directions/directions/d2-tint/specimen.html — not part of the kit.
 */

const light = new URLSearchParams(window.location.search).get("theme") === "light";
document.documentElement.classList.toggle("dark", !light);
document.documentElement.style.colorScheme = light ? "light" : "dark";

const SIZES: GlyphSize[] = ["mini", "xs", "sm", "md", "lg", "tuck"];
const byKind = LAB_KINDS.map((kind) => KIND_SPECIMENS.find((a) => a.kind === kind)).filter((a): a is LabArtifact => Boolean(a));
const markdown = KIND_SPECIMENS.find((a) => a.kind === "document" && a.revision == null);
const glyphs = markdown ? [...byKind, markdown] : byKind;
const previews = KIND_SPECIMENS.filter((a) => a.thumbnailUrl);

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-mono text-(length:--text-nano) uppercase tracking-(--tracking-label) text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Preview({ artifact }: { artifact: LabArtifact }) {
  const [kind, onError] = usePreviewKind(artifact);
  return (
    <div data-kind={artifact.kind} className="@container flex flex-col gap-2 rounded-lg bg-(--tint-slab) p-2">
      <GalleryPreview artifact={artifact} kind={kind} onError={onError} />
      <MetaLine parts={metaParts(artifact, { facts: true })} className="px-1.5" />
    </div>
  );
}

function Specimen() {
  return (
    <main data-direction="d2-tint" className="flex min-h-screen flex-col gap-10 bg-background p-8 text-foreground">
      <Block title="Kind glyph — mini · xs · sm · md · lg · tuck (the folder face), on the page and on a slab. A task document has no extension: pictogram alone.">
        <div className="flex flex-col gap-4">
          {[false, true].map((onSlab) => (
            <div key={String(onSlab)} className={onSlab ? "flex flex-wrap gap-6 rounded-lg bg-(--tint-slab) p-4" : "flex flex-wrap gap-6 p-4"}>
              {glyphs.map((a) => (
                <div key={a.id} data-kind={a.kind} className="flex items-end gap-2">
                  {SIZES.map((size) => (
                    <KindGlyph key={size} kind={a.kind} label={glyphLabel(a)} size={size} />
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Block>

      <Block title="Lead — the thread row's one box (72×46): a picture, or the xs glyph on its kind well">
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-(--tint-slab) p-4">
          {glyphs.map((a) => (
            <div key={a.id} data-kind={a.kind}>
              <Lead artifact={a} />
            </div>
          ))}
        </div>
      </Block>

      <Block title="Folded preview — sm · md · lg">
        <div className="flex flex-wrap items-end gap-6 rounded-lg bg-(--tint-slab) p-4">
          {previews.map((a) => (
            <div key={a.id} data-kind={a.kind} className="flex items-end gap-3">
              <FoldedPreview artifact={a} fold="sm" className="h-11.5 w-18" />
              <FoldedPreview artifact={a} fold="md" className="h-24 w-36" />
              <FoldedPreview artifact={a} fold="lg" className="h-40 w-64" />
            </div>
          ))}
        </div>
      </Block>

      <Block title="Kind well — md glyph on the kind's quiet fill, all ten kinds side by side">
        <div className="grid grid-cols-5 gap-3">
          {byKind.map((a) => (
            <div key={a.id} data-kind={a.kind} className="flex flex-col gap-2 rounded-lg bg-(--tint-slab) p-2">
              <KindWell artifact={a} size="md" className="h-24" />
              <MetaLine parts={metaParts(a, { facts: true })} />
            </div>
          ))}
        </div>
      </Block>

      <Block title="Gallery preview — picture, text sheet (neutral) or kind well (tinted), one per kind">
        <div className="grid grid-cols-4 gap-3">
          {glyphs.map((a) => (
            <Preview key={a.id} artifact={a} />
          ))}
        </div>
      </Block>

      <Block title="Stack — a single artifact, three, and a pile; kind tally and review tally">
        <GalleryStacks groups={STACK_SPECIMENS} />
      </Block>

      <Block title="State mark — sm · md, on a slab and on the page">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3 rounded-lg bg-(--tint-slab) p-3">
            <StateMark review="needs_review" />
            <StateMark review="changes_requested" />
            <StateMark review="needs_review" size="md" />
            <StateMark review="changes_requested" size="md" />
          </div>
          <div className="flex items-center gap-3 p-3">
            <StateMark review="needs_review" className="bg-(--tint-slab)" />
            <StateMark review="changes_requested" size="md" className="bg-(--tint-slab)" />
          </div>
        </div>
      </Block>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TooltipProvider>
      <Specimen />
    </TooltipProvider>
  </StrictMode>,
);
