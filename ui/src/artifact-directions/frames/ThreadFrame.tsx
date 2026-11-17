import type { ReactNode } from "react";
import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { StatusIcon } from "@/components/StatusIcon";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import type { DirectionKit, LabArtifact } from "../kit";
import { CEO, DESIGNER, TASKS, THREAD_ATTACHMENTS, THREAD_WORK_PRODUCTS } from "../fixtures";
import { SupportButton } from "./AppShell";
import { Slot } from "./Slot";
import { AgentIdentity, ComposerShell, Mention, MessageFooter, Prose, ProseLink, TaskRef, WorkedRow } from "./thread-parts";

/**
 * Static mock of the task thread in the task-chat shell (the default).
 *
 * In one scroll it reproduces what the reference screenshots show across
 * three: the agent's message with its attachments block, a short CEO reply,
 * then a run of "Worked" rows interleaved with work-product rows. The kit
 * supplies only the attachments block and the rows.
 */

/** BreadcrumbBar.tsx:128-189 with `taskDetailLayout`; crumbs from IssueDetail.tsx:5530-5540. */
function TaskTopBar({ panelOpen }: { panelOpen: boolean }) {
  const Toggle = panelOpen ? PanelRightClose : PanelRightOpen;
  return (
    <div className="relative h-(--sz-60px) shrink-0 flex items-center border-b border-border px-4 md:px-6">
      <div className="min-w-0 overflow-hidden flex-1">
        <Breadcrumb className="min-w-0 overflow-hidden">
          <BreadcrumbList className="flex-nowrap">
            <BreadcrumbItem className="shrink-0">
              <span className="min-w-0 truncate font-semibold uppercase tracking-wider text-muted-foreground">Tasks</span>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbPage className="flex min-w-0 gap-1.5 items-baseline">
                <span className="flex shrink-0 items-center self-center">
                  <StatusIcon status="done" className="size-3" />
                </span>
                <span className="min-w-0 truncate">{TASKS["ACM-3"]}</span>
                <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">ACM-3</span>
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <SupportButton />
      <span className="ml-5 inline-flex size-9 shrink-0 items-center justify-center text-muted-foreground">
        <Toggle className="h-4 w-4" />
      </span>
    </div>
  );
}

/** TaskChatThreadView.tsx:277-290 — the top margin between two timeline items. */
const GAP = { item: "mt-6", turn: "mt-3" } as const;

function Item({ gap, children }: { gap?: keyof typeof GAP; children: ReactNode }) {
  return <div className={gap ? GAP[gap] : undefined}>{children}</div>;
}

/** TaskChatBubble.tsx:217-263: identity, body, attachments and footer, 4px apart. */
function Bubble({ children }: { children: ReactNode }) {
  return <div className="flex w-full flex-col gap-1 items-start">{children}</div>;
}

function Row({ kit, artifact }: { kit: DirectionKit; artifact: LabArtifact }) {
  return (
    <Slot kit={kit}>
      <kit.ThreadWorkProduct artifact={artifact} />
    </Slot>
  );
}

export function ThreadFrame({ kit, panelOpen }: { kit: DirectionKit; panelOpen: boolean }) {
  const [critique, guide, pptx, pdf, image, source] = THREAD_WORK_PRODUCTS;
  const attachments = (
    <Slot kit={kit} className="flex w-full flex-col gap-1">
      <kit.ThreadAttachments artifacts={THREAD_ATTACHMENTS} />
    </Slot>
  );
  return (
    // Layout.tsx:724-730 — on task detail the breadcrumb bar sits inside the left column.
    <div className="flex min-w-0 flex-1 flex-col">
      <TaskTopBar panelOpen={panelOpen} />
      {/* Layout.tsx:749-765 (main, task detail: pt-0) */}
      <main className="flex-1 p-4 outline-none md:p-6 pt-0 md:pt-0">
        {/* TaskChatThreadView.tsx:427-433 */}
        <div className="mx-auto flex w-full max-w-(--tc-shell-max-w) flex-col px-1 py-3 md:px-0 md:py-4 pt-3">
          <Item>
            <Bubble>
              <AgentIdentity name={DESIGNER} />
              <Prose>
                <p>Interface Craft revision complete.</p>
                <ul>
                  <li>
                    Applied Josh Puckett’s saved critique method and recorded{" "}
                    <ProseLink to="document-interface-craft-critique">findings and before/after changes</ProseLink>. Added a cap-led cover,
                    simplified strategy hierarchy, matched A/B comparison fields and applications, and separated founder decisions.
                    Retained the supplied logo, Paperclip reference, proposed audience and claim labels.
                  </li>
                  <li>
                    Uploaded and registered <ProseLink to="work-product-ic-pptx">editable PowerPoint</ProseLink>,{" "}
                    <ProseLink to="work-product-ic-pdf">matching PDF</ProseLink>,{" "}
                    <ProseLink to="work-product-ic-image">slide overview</ProseLink>,{" "}
                    <ProseLink to="work-product-ic-guide">guide</ProseLink> and{" "}
                    <ProseLink to="work-product-ic-zip">editing source</ProseLink>. Prior revisions preserved.
                  </li>
                  <li>
                    <ProseLink to="document-interface-craft-deck-guide">Checks</ProseLink>: both files reopen with 12 slides/pages; visible
                    text matches; all PDF pages visually inspected with no clipping or unintended overlap. Text and shapes are editable;
                    supplied logo remains raster. Native PowerPoint rendering remains untested; PDF is the inspected reference.
                  </li>
                  <li>
                    Next: <Mention name={CEO} /> checks coherence and claims, then presents this pass for founder acceptance through{" "}
                    <TaskRef identifier="ACM-1" status="in_review" />. Production completion does not imply founder approval or permission
                    to publish.
                  </li>
                </ul>
              </Prose>
              {/* TaskChatBubble.tsx:264-352 — flush with the column edge, no px-1. */}
              {kit.threadAttachmentsAfterFooter ? null : attachments}
              <MessageFooter timestamp="11:08 AM" />
            </Bubble>
            {/* A kit may hang the block under the footer instead, 12px below it (the V1 mock does). */}
            {kit.threadAttachmentsAfterFooter ? <div className="mt-3">{attachments}</div> : null}
          </Item>
          <Item gap="item">
            <Bubble>
              <AgentIdentity name={CEO} />
              <Prose>
                <p>
                  The revised <ProseLink to="work-product-ic-pdf">deck PDF</ProseLink> is saved.{" "}
                  <TaskRef identifier="ACM-3" status="done" /> remains complete.
                </p>
                <p>
                  An ownership conflict prevented my review there. I’ve routed it to <TaskRef identifier="ACM-1" status="in_review" />;
                  CEO review and founder acceptance remain pending.
                </p>
              </Prose>
              <MessageFooter timestamp="11:12 AM" />
            </Bubble>
          </Item>
          <Item gap="item">
            <Row kit={kit} artifact={critique} />
          </Item>
          <Item gap="item">
            <Row kit={kit} artifact={guide} />
          </Item>
          <Item gap="turn">
            <WorkedRow />
          </Item>
          <Item gap="turn">
            <Row kit={kit} artifact={pptx} />
          </Item>
          <Item gap="turn">
            <WorkedRow />
          </Item>
          <Item gap="turn">
            <Row kit={kit} artifact={pdf} />
          </Item>
          <Item gap="turn">
            <WorkedRow />
          </Item>
          <Item gap="turn">
            <Row kit={kit} artifact={image} />
          </Item>
          <Item gap="turn">
            <WorkedRow />
          </Item>
          <Item gap="turn">
            <Row kit={kit} artifact={source} />
          </Item>
        </div>
        <ComposerShell />
      </main>
    </div>
  );
}
