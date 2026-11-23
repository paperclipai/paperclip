import { cn } from "@/lib/utils";
import type { LabArtifact } from "../../../kit";
import { excerptBlocks, isTaskDocument, tabLabel, tabTone } from "../kind";
import { ExtTab, Greek, Paper, Scaled, Spine, Stamp, type ObjectSize } from "./Paper";

/**
 * Portrait sheets: the typeset page (document, Markdown, PDF, blank file) and
 * the carbon sheet (code). Everything in here is laid out at design size and
 * scaled by `Scaled`.
 */

const FADE = { maskImage: "var(--tac-fade-bottom)" } as const;

const GREEK_A = ["w-full", "w-11/12", "w-full", "w-4/5"] as const;
const GREEK_B = ["w-full", "w-10/12", "w-full", "w-11/12", "w-3/5"] as const;
const GREEK_C = ["w-full", "w-11/12", "w-2/3"] as const;

/**
 * A sheet of paper with a dog-eared corner and the artifact's real opening
 * set on it in serif: the first line as the title, the rest lighter, fading
 * toward the bottom edge. A PDF has no text to show, so its title stands
 * over greeked lines behind a red spine; a generic file is a blank sheet
 * with only its name, type and size typed at the head (nothing at all at the
 * two smallest sizes). A file carries its extension on a tab; a task document
 * has no file, so it carries its revision as a rubber stamp instead.
 */
export function DocumentSheet({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const tab = tabLabel(artifact);
  const pdf = artifact.kind === "pdf";
  const blank = artifact.kind === "file";
  const small = size === "xs" || size === "sm";
  const { title, blocks } = excerptBlocks(artifact);
  return (
    <Scaled size={size} box="page">
      <Paper back={(artifact.pageCount ?? 1) > 1}>
        {pdf ? <Spine tone="pdf" /> : null}
        {blank ? (
          // Nothing to preview: the sheet stays blank but for what is known about the file, typed at its head.
          small ? null : (
            <span className="absolute inset-0 block break-all px-(--tac-page-pad) pt-(--tac-page-pad) font-mono text-(length:--tac-type-body) leading-(--tac-lead-body) text-(--tac-ink-soft)">
              <span className="float-right block h-(--tac-ear-clear) w-(--tac-ear-clear)" />
              <span className="block font-semibold text-(--tac-ink)">{artifact.filename ?? artifact.title}</span>
              {artifact.contentType ? <span className="block">{artifact.contentType}</span> : null}
              {artifact.sizeLabel ? <span className="block">{artifact.sizeLabel}</span> : null}
            </span>
          )
        ) : (
          <span className="absolute inset-0 block break-words px-(--tac-page-pad) pt-(--tac-page-pad) font-(family-name:--tac-font-serif) text-(--tac-ink)" style={FADE}>
            {/* Keeps the first lines clear of the folded corner. */}
            <span className="float-right block h-(--tac-ear-clear) w-(--tac-ear-clear)" />
            <span className="block text-(length:--tac-type-title) font-semibold leading-(--tac-lead-title) tracking-tight">{title}</span>
            <span className="mt-(--tac-gap-block) block text-(length:--tac-type-body) leading-(--tac-lead-body) text-(--tac-ink-soft)">
              {blocks.length > 0 ? (
                blocks.map((block, index) =>
                  block.type === "heading" ? (
                    <span key={index} className="mt-(--tac-gap-block) block font-semibold text-(--tac-ink)">
                      {block.text}
                    </span>
                  ) : block.type === "bullet" ? (
                    <span key={index} className="mt-(--tac-gap-para) flex gap-(--tac-gap-para)">
                      <span>•</span>
                      <span>{block.text}</span>
                    </span>
                  ) : (
                    <span key={index} className="mt-(--tac-gap-para) block first:mt-0">
                      {block.text}
                    </span>
                  ),
                )
              ) : (
                <>
                  {artifact.summary ? <span className="block italic">{artifact.summary}</span> : null}
                  <Greek lines={GREEK_A} className="mt-(--tac-gap-block)" />
                  <Greek lines={GREEK_B} className="mt-(--tac-gap-block)" />
                  <Greek lines={GREEK_C} className="mt-(--tac-gap-block)" />
                </>
              )}
            </span>
          </span>
        )}
        {isTaskDocument(artifact) ? <Stamp>rev {artifact.revision}</Stamp> : null}
      </Paper>
      {tab ? <ExtTab label={tab} tone={tabTone(artifact)} /> : null}
    </Scaled>
  );
}

function codeTint(line: string): string {
  const text = line.trim();
  if (text.startsWith("<!--") || text.startsWith("//") || text.startsWith("/*") || text.startsWith("#")) return "text-(--tac-code-note)";
  if (text.startsWith("<") || text.startsWith('"')) return "text-(--tac-code-tag)";
  return "text-(--tac-code-ink)";
}

/**
 * A dark carbon sheet with a numbered gutter and the file's real first lines
 * in mono. Dark in both themes: it is the one sheet that is not paper-white.
 */
export function CodeSheet({ artifact, size }: { artifact: LabArtifact; size: ObjectSize }) {
  const tab = tabLabel(artifact);
  const lines = (artifact.excerpt ?? "").split("\n").slice(0, 28);
  return (
    <Scaled size={size} box="page">
      <Paper tone="carbon">
        <span className="absolute inset-y-0 left-0 block w-(--tac-gutter) bg-(--tac-carbon-gutter) text-(length:--tac-type-body)" />
        <span className="absolute inset-0 block pt-(--tac-page-pad) font-mono text-(length:--tac-type-body) leading-(--tac-lead-body)" style={FADE}>
          {lines.map((line, index) => (
            <span key={index} className="flex">
              <span className="block w-(--tac-gutter) shrink-0 pr-(--tac-gap-para) text-right text-(--tac-code-dim)">{index + 1}</span>
              <span className={cn("block whitespace-pre pl-(--tac-gap-para)", codeTint(line))}>{line || " "}</span>
            </span>
          ))}
        </span>
      </Paper>
      {tab ? <ExtTab label={tab} tone="code" /> : null}
    </Scaled>
  );
}
