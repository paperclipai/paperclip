import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "@/lib/router";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { SiteNav } from "@/components/SiteNav";
import { LandingFooter } from "./Landing";

type Page = { path: string; title: string };
type Group = { group: string; pages: Page[] };
type Tab = { tab: string; groups: Group[] };
type Manifest = { name: string; description: string; tabs: Tab[] };

const BASE = "/docs-content";

function stripFrontmatter(md: string) {
  return md.replace(/^---\s*[\s\S]*?\s*---\s*/, "");
}

export function DocsViewer() {
  const location = useLocation();
  const navigate = useNavigate();
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);

  // sync theme on mount (standalone route)
  useEffect(() => {
    const t = (() => { try { return localStorage.getItem("paperclip.theme"); } catch { return null; } })();
    if (t) document.documentElement.classList.toggle("dark", t === "dark");
  }, []);

  // current page path (after /docs/)
  const current = useMemo(() => {
    const p = location.pathname.replace(/^\/docs\/?/, "").replace(/\/$/, "");
    return p || null;
  }, [location.pathname]);

  // load manifest once
  useEffect(() => {
    fetch(`${BASE}/manifest.json`).then((r) => r.json()).then(setManifest).catch(() => {});
  }, []);

  // default to first page when no path
  const firstPage = manifest?.tabs[0]?.groups[0]?.pages[0]?.path ?? null;
  useEffect(() => {
    if (!current && firstPage) navigate(`/docs/${firstPage}`, { replace: true });
  }, [current, firstPage, navigate]);

  // active tab = the tab containing the current page
  const activeTab = useMemo(() => {
    if (!manifest) return null;
    const path = current ?? firstPage;
    return manifest.tabs.find((t) => t.groups.some((g) => g.pages.some((p) => p.path === path))) ?? manifest.tabs[0];
  }, [manifest, current, firstPage]);

  // load the markdown for the current page
  useEffect(() => {
    const path = current ?? firstPage;
    if (!path) return;
    setLoading(true);
    fetch(`${BASE}/${path}.md`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((md) => { setBody(stripFrontmatter(md)); setLoading(false); })
      .catch(() => { setBody("# Not found\n\nThis page could not be loaded."); setLoading(false); });
  }, [current, firstPage]);

  const go = (path: string) => navigate(`/docs/${path}`);
  const switchTab = (tab: Tab) => { const p = tab.groups[0]?.pages[0]?.path; if (p) go(p); };

  return (
    <div className="agnb-scroll h-screen overflow-y-auto bg-[#F6F3EC] text-gray-900 antialiased dark:bg-[#1b1410] dark:text-neutral-100">
      <SiteNav />
      <div className="mx-auto flex max-w-6xl gap-10 px-6 py-10">
        {/* Sidebar */}
        <aside className="hidden w-60 shrink-0 lg:block">
          <div className="sticky top-24">
            {/* tab pills */}
            <div className="mb-5 flex flex-wrap gap-1.5">
              {manifest?.tabs.map((t) => (
                <button
                  key={t.tab}
                  onClick={() => switchTab(t)}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[12px] font-medium transition",
                    activeTab?.tab === t.tab
                      ? "bg-[#f97316]/10 text-[#f97316]"
                      : "text-gray-500 hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100",
                  )}
                >
                  {t.tab}
                </button>
              ))}
            </div>
            {/* groups + pages of active tab */}
            <nav className="space-y-6">
              {activeTab?.groups.map((g) => (
                <div key={g.group}>
                  <p className="mb-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-gray-400 dark:text-neutral-500">{g.group}</p>
                  <ul className="space-y-0.5">
                    {g.pages.map((p) => {
                      const active = (current ?? firstPage) === p.path;
                      return (
                        <li key={p.path}>
                          <button
                            onClick={() => go(p.path)}
                            className={cn(
                              "block w-full rounded-md px-2.5 py-1.5 text-left text-[13.5px] transition",
                              active
                                ? "bg-[#f97316]/10 font-medium text-[#f97316]"
                                : "text-gray-600 hover:bg-black/[0.03] hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100",
                            )}
                          >
                            {p.title}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <main className="agnb-docs min-w-0 flex-1 pb-24">
          {loading ? (
            <p className="text-sm text-gray-400">Loading…</p>
          ) : (
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a({ href, children, ...props }) {
                  let h = href ?? "#";
                  // internal doc links: /agnb/x or relative -> /docs/...
                  if (h.startsWith("/") && !h.startsWith("/docs") && !h.startsWith("http")) h = `/docs${h}`;
                  const internal = h.startsWith("/docs");
                  return (
                    <a
                      href={h}
                      onClick={internal ? (e) => { e.preventDefault(); navigate(h); } : undefined}
                      {...(!internal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      {...props}
                    >
                      {children}
                    </a>
                  );
                },
                img({ src, ...props }) {
                  let s = (src as string) ?? "";
                  if (s.startsWith("/")) s = `${BASE}${s}`;
                  return <img src={s} {...props} />;
                },
              }}
            >
              {body}
            </Markdown>
          )}
        </main>
      </div>

      <LandingFooter />

      <style>{`
        .agnb-docs { font-size: 15.5px; line-height: 1.7; color: #374151; }
        .dark .agnb-docs { color: #c9c2ba; }
        .agnb-docs h1 { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 1rem; color: #0a0a0a; }
        .agnb-docs h2 { font-size: 1.4rem; font-weight: 700; letter-spacing: -0.01em; margin: 2.2rem 0 0.8rem; color: #0a0a0a; }
        .agnb-docs h3 { font-size: 1.1rem; font-weight: 600; margin: 1.6rem 0 0.5rem; color: #0a0a0a; }
        .dark .agnb-docs :is(h1,h2,h3,h4) { color: #f5f1ec; }
        .agnb-docs p { margin: 0 0 1rem; }
        .agnb-docs a { color: #f97316; text-decoration: none; font-weight: 500; }
        .agnb-docs a:hover { text-decoration: underline; }
        .agnb-docs ul, .agnb-docs ol { margin: 0 0 1rem; padding-left: 1.3rem; }
        .agnb-docs li { margin: 0.3rem 0; }
        .agnb-docs ul { list-style: disc; }
        .agnb-docs ol { list-style: decimal; }
        .agnb-docs code { font-family: ui-monospace, monospace; font-size: 0.85em; background: rgba(249,115,22,0.1); color: #c2410c; padding: 0.12em 0.4em; border-radius: 4px; }
        .dark .agnb-docs code { color: #fdba74; background: rgba(249,115,22,0.14); }
        .agnb-docs pre { background: #15110d; color: #e5e2dd; padding: 1rem 1.1rem; border-radius: 12px; overflow-x: auto; margin: 0 0 1.2rem; border: 1px solid rgba(255,255,255,0.08); }
        .agnb-docs pre code { background: none; color: inherit; padding: 0; font-size: 0.82rem; }
        .agnb-docs blockquote { border-left: 3px solid #f97316; padding-left: 1rem; margin: 0 0 1rem; color: #6b7280; }
        .agnb-docs table { width: 100%; border-collapse: collapse; margin: 0 0 1.2rem; font-size: 0.9em; }
        .agnb-docs th, .agnb-docs td { border: 1px solid rgba(0,0,0,0.1); padding: 0.5rem 0.75rem; text-align: left; }
        .dark .agnb-docs th, .dark .agnb-docs td { border-color: rgba(255,255,255,0.1); }
        .agnb-docs th { background: rgba(0,0,0,0.03); font-weight: 600; }
        .dark .agnb-docs th { background: rgba(255,255,255,0.04); }
        .agnb-docs hr { border: 0; border-top: 1px solid rgba(0,0,0,0.08); margin: 2rem 0; }
        .dark .agnb-docs hr { border-color: rgba(255,255,255,0.08); }
      `}</style>
    </div>
  );
}
