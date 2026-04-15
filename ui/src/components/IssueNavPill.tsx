import { useCallback, useEffect, useState } from "react";
import { ArrowUp, FileText, MessageSquare } from "lucide-react";
import { cn } from "../lib/utils";

function resolveScrollTarget() {
  const mainContent = document.getElementById("main-content");
  if (mainContent instanceof HTMLElement) {
    const overflowY = window.getComputedStyle(mainContent).overflowY;
    const usesOwnScroll =
      (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") &&
      mainContent.scrollHeight > mainContent.clientHeight + 1;
    if (usesOwnScroll) return { type: "element" as const, element: mainContent };
  }
  return { type: "window" as const };
}

function scrollToElement(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function scrollToTop() {
  const target = resolveScrollTarget();
  if (target.type === "element") {
    target.element.scrollTo({ top: 0, behavior: "smooth" });
  } else {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function scrollToBottom() {
  const target = resolveScrollTarget();
  if (target.type === "element") {
    target.element.scrollTo({ top: target.element.scrollHeight, behavior: "smooth" });
  } else {
    const scroller = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }
}

function distanceFromTop(target: ReturnType<typeof resolveScrollTarget>) {
  if (target.type === "element") return target.element.scrollTop;
  return window.scrollY;
}

export function IssueNavPill() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const check = () => {
      setVisible(distanceFromTop(resolveScrollTarget()) > 200);
    };
    const mainContent = document.getElementById("main-content");
    check();
    mainContent?.addEventListener("scroll", check, { passive: true });
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    return () => {
      mainContent?.removeEventListener("scroll", check);
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  // Keyboard shortcuts: T=top, D=docs, N=newest comment
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case "t":
          e.preventDefault();
          scrollToTop();
          break;
        case "d":
          e.preventDefault();
          scrollToElement("issue-documents");
          break;
        case "n":
          e.preventDefault();
          scrollToBottom();
          break;
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed bottom-6 left-6 z-40 flex flex-col gap-1 rounded-lg border border-border bg-background/90 backdrop-blur-sm shadow-md p-1">
      <NavButton icon={ArrowUp} label="Top (T)" onClick={scrollToTop} />
      <NavButton icon={FileText} label="Docs (D)" onClick={() => scrollToElement("issue-documents")} />
      <NavButton icon={MessageSquare} label="Newest (N)" onClick={scrollToBottom} />
    </div>
  );
}

function NavButton({ icon: Icon, label, onClick }: { icon: typeof ArrowUp; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={cn(
        "flex items-center justify-center h-8 w-8 rounded-md",
        "text-muted-foreground hover:text-foreground hover:bg-accent transition-colors",
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
