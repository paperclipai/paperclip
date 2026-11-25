import { useRef, useState } from "react";
import DesignSandboxTaskThread from "@/components/design-sandbox/DesignSandboxTaskThread";
import { Button } from "@/components/ui/button";
import { storybookAgents } from "../../fixtures/paperclipData";

const agent = { ...storybookAgents[0]!, name: "Connector engineer" };
type ObservedStyle = { key: string; family: string; size: string; leading: string; weight: string; color: string; emphasis: string; tracking: string; opacity: string; example: string; text: string };

/** The sandbox owns the entire conversation composition, fixtures and controls.
 * This guide only frames it and optionally measures its rendered typography. */
export function ConversationTypographyPreview({ playback = false }: { playback?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [styles, setStyles] = useState<ObservedStyle[]>([]);
  const measure = () => {
    const recipes = new Map<string, ObservedStyle>();
    root.current?.querySelectorAll<HTMLElement>("[data-preview-case]").forEach(example => {
      const walker = document.createTreeWalker(example, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (!text || !parent || parent.closest('[aria-hidden="true"], .sr-only, script, style') || !parent.getClientRects().length) continue;
        const computed = getComputedStyle(parent);
        if (computed.visibility === "hidden" || computed.display === "none" || computed.opacity === "0") continue;
        const values = {
          family: computed.fontFamily, size: computed.fontSize, leading: computed.lineHeight,
          weight: computed.fontWeight, color: computed.color,
          emphasis: `${computed.fontStyle} / ${computed.textDecorationLine}`,
          tracking: computed.letterSpacing, opacity: computed.opacity,
        };
        const key = JSON.stringify(values);
        if (!recipes.has(key)) recipes.set(key, { key, ...values, example: example.getAttribute("aria-label") ?? "", text: text.slice(0, 90) });
      }
    });
    setStyles([...recipes.values()].sort((a, b) => parseFloat(b.size) - parseFloat(a.size) || a.family.localeCompare(b.family)));
  };

  return <main data-testid="conversation-typography-preview" className="flex h-dvh min-h-0 flex-col bg-background px-6 font-sans text-muted-foreground sm:px-10">
    <header className="flex shrink-0 flex-col gap-2 py-4">
      <p className="text-xs">Design proposals · Foundations · Typography</p>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{playback ? "Conversation playback" : "Conversation styles"}</h1>
      <p className="max-w-3xl text-sm leading-relaxed">{playback ? "Press Play to watch two exchanges: a component audit, then verification with planning, clarification, permission, a failed test and retry, a file preview, and streaming final replies. Demo answers and approvals advance automatically. Pause to inspect any moment, or replay from the beginning." : "The same 72 synthetic states, conversation composition and controls as the sandbox. Select a state to replay it, expand activity, or try its local composer actions."}</p>
      {!playback ? <details className="text-xs" onToggle={event => { if (event.currentTarget.open) measure(); }}>
        <summary className="w-fit cursor-pointer hover:text-foreground">Typography measurements</summary>
        <div className="mt-3 flex flex-col gap-3">
          <p>Measures currently rendered text in the selected states, including open disclosures. Refresh after changing a state or expanding content. Guide labels are excluded.</p>
          <Button variant="outline" size="sm" className="w-fit" onClick={measure}>Refresh measurements</Button>
          <div className="max-h-48 overflow-auto rounded-lg border border-border">
            <table data-testid="conversation-style-inventory" className="w-full text-left text-xs">
              <thead className="text-foreground"><tr>{["Text / state", "Family", "Size / leading", "Weight / emphasis", "Color / tracking / opacity"].map(label => <th key={label} className="px-3 py-2 font-semibold" scope="col">{label}</th>)}</tr></thead>
              <tbody>{styles.map(style => <tr key={style.key} className="border-t border-border align-top">
                <td className="px-3 py-2"><p className="text-foreground">{style.text}</p><p className="mt-1">{style.example}</p></td>
                <td className="px-3 py-2">{style.family}</td><td className="whitespace-nowrap px-3 py-2 font-mono">{style.size} / {style.leading}</td>
                <td className="px-3 py-2">{style.weight} · {style.emphasis}</td><td className="px-3 py-2 font-mono">{style.color} / {style.tracking} / {style.opacity}</td>
              </tr>)}</tbody>
            </table>
          </div>
          <p>{styles.length} observed styles. Shared source: ui/src/components/design-sandbox/DesignSandboxTaskThread.tsx and task-thread-fixtures.ts. These use production renderers with synthetic data; this is not verification of a deployed production version.</p>
        </div>
      </details> : null}
    </header>
    <div ref={root} className="flex min-h-0 flex-1 flex-col" data-testid="conversation-shared-preview">
      <DesignSandboxTaskThread previewMode={playback ? "playback" : "catalog"} header={null} agentName={agent.name} agent={agent} defaultConversation>
        <p className="py-4 text-sm">Saved task data is available in the sandbox. Choose a synthetic preview state here to compare conversation styles.</p>
      </DesignSandboxTaskThread>
    </div>
  </main>;
}
