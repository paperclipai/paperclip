import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Minus, Plus } from "lucide-react";

const LINKS = [
  { label: "Agents", href: "/platform/agents" },
  { label: "Governance", href: "/platform/governance" },
  { label: "Integrations", href: "/platform/integrations" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];

const CONTACT = "/contact";
const SIGN_IN = "/signin";

/** Shared top nav for the landing + all marketing pages. */
export function SiteNav() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const el = document.querySelector(".agnb-scroll");
    const onScroll = () => setScrolled((el?.scrollTop ?? window.scrollY) > 16);
    el?.addEventListener("scroll", onScroll);
    window.addEventListener("scroll", onScroll);
    return () => {
      el?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const linkCls =
    "rounded-md px-3 py-2 text-[13.5px] font-medium text-gray-500 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100";

  return (
    <header
      className={cn(
        "sticky top-0 z-50 w-full backdrop-blur-xl transition-all",
        scrolled
          ? "border-b border-black/[0.06] bg-[#F6F3EC]/80 dark:border-white/[0.06] dark:bg-[#1b1410]/80"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <div className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <a href="/auth" className="flex items-center">
          <img src="/logo-full-light.svg" alt="All Gas No Brakes" className="h-11 w-auto dark:hidden" />
          <img src="/logo-full-dark.svg" alt="All Gas No Brakes" className="hidden h-11 w-auto dark:block" />
        </a>

        {/* Center links */}
        <nav className="absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 items-center gap-1 lg:flex">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className={linkCls}
            >
              {l.label}
            </a>
          ))}
        </nav>

        {/* Right */}
        <div className="flex items-center gap-2.5">
          <a href={CONTACT} className="hidden rounded-md px-3.5 py-2 text-[13px] font-medium text-gray-600 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100 sm:inline-flex">
            Contact Sales
          </a>
          <a href={SIGN_IN} className="rounded-md bg-[#f97316] px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-[#ea6a0c]">
            Sign in
          </a>
          <button
            onClick={() => setMobileOpen((v) => !v)}
            className="inline-flex size-9 items-center justify-center rounded-md text-gray-600 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100 lg:hidden"
            aria-label="menu"
          >
            {mobileOpen ? <Minus className="size-5" /> : <Plus className="size-5" />}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <div className="border-t border-black/[0.06] bg-[#F6F3EC]/95 px-6 py-3 backdrop-blur dark:border-white/[0.06] dark:bg-[#1b1410]/95 lg:hidden">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              onClick={() => setMobileOpen(false)}
              className="block py-2.5 text-[15px] font-medium text-gray-600 transition hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {l.label}
            </a>
          ))}
          <a href={CONTACT} className="block py-2.5 text-[15px] font-medium text-gray-600 dark:text-neutral-400">Contact Sales</a>
        </div>
      )}
    </header>
  );
}
