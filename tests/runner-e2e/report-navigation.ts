import { paperclipReportLogo } from "./report-brand.js";
import type { ReportExecution } from "./report-catalog.js";
import type { RunnerE2EHistoryIndex } from "./types.js";

export function reportHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function reportHistoryHref(history: RunnerE2EHistoryIndex | undefined, campaignId: string | undefined) {
  const url = history?.campaigns.find(campaign => campaign.campaignId === campaignId)?.publicUrl;
  return url?.replace(/campaigns\/[^/]+\/(?:index\.html)?$/, "") ?? "../../";
}

export function renderReportShell(input: {
  campaignId?: string;
  catalog?: readonly ReportExecution[];
  history?: RunnerE2EHistoryIndex;
}) {
  const h = reportHtml;
  const campaign = Boolean(input.catalog);
  const label = input.campaignId ?? "Current campaign";
  const root = campaign ? reportHistoryHref(input.history, input.campaignId) : "./";
  const suites = [...new Map((input.catalog ?? []).map(row => [row.suite.id, row.suite])).values()];
  const tree = campaign ? `<nav class="report-suite-tree" aria-label="Campaign suites"><p class="report-side-label">Suites</p>${suites.map(suite => {
    const cases = [...new Map(input.catalog!.filter(row => row.suite.id === suite.id).map(row => [row.task.id, row])).values()];
    return `<details data-nav-suite="${h(suite.id)}"><summary><a href="#suite-${h(suite.id)}" data-nav-suite-link="${h(suite.id)}">${h(suite.label)}<small>${cases.length}</small></a></summary><ul>${cases.map(row => `<li><a href="?view=case&amp;case=${encodeURIComponent(`${suite.id}.${row.task.id}`)}#execution-${h(row.id)}" data-nav-case="${h(`${suite.id}.${row.task.id}`)}" data-report-case-link="${h(`${suite.id}.${row.task.id}`)}"><span class="case-status-dot" aria-hidden="true"></span><span>${h(row.task.label)}</span></a></li>`).join("")}</ul></details>`;
  }).join("")}</nav>` : "";
  return `<div class="report-shell" data-report-scope="${campaign ? "campaign" : "global"}" data-campaign-label="${h(label)}">
    <button class="report-drawer-backdrop" type="button" data-nav-close aria-label="Close navigation" hidden></button>
    <aside class="report-sidebar" id="report-navigation" aria-label="Report navigation">
      <a class="brand-lockup report-brand" href="${h(root)}" aria-label="Paperclip evaluations">${paperclipReportLogo}<small>Evaluations</small></a>
      <div class="report-sidebar-scroll"><nav class="report-global-nav" aria-label="Evaluations">
        <a href="${campaign ? "?view=all" : "?view=overview"}" data-nav-view="${campaign ? "all" : "overview"}" aria-current="page"><span aria-hidden="true">◫</span>${campaign ? "All results" : "Overview"}</a>
        <a href="?view=attention" data-nav-view="attention"><span aria-hidden="true">○</span>Needs attention</a>
        <a href="${h(root)}?view=history" ${campaign ? "" : 'data-nav-view="history"'}><span aria-hidden="true">↶</span>Campaign history</a>
      </nav>${tree}</div><div class="report-sidebar-footer">Product E2E${campaign ? `<span>${input.catalog!.length} executions</span>` : ""}</div>
    </aside><div class="report-surface">
    <header class="report-topbar"><button type="button" class="report-menu-toggle" data-nav-toggle aria-label="Open navigation" aria-controls="report-navigation" aria-expanded="false">☰</button>
      <nav class="report-breadcrumbs" aria-label="Breadcrumb" data-nav-breadcrumbs><a href="${h(root)}?view=history">Campaigns</a>${campaign ? `<span aria-hidden="true">/</span><span>${h(label)}</span><span aria-hidden="true">/</span><span aria-current="page">All results</span>` : '<span aria-hidden="true">/</span><span aria-current="page">Overview</span>'}</nav>
      ${campaign && input.history?.campaigns.length ? `<select class="report-campaign-select" data-nav-campaign aria-label="Campaign">${!input.history.campaigns.some(item => item.campaignId === input.campaignId) ? `<option selected value="">${h(label)}</option>` : ""}${input.history.campaigns.map(item => `<option value="${h(item.publicUrl)}" ${item.campaignId === input.campaignId ? "selected" : ""}>${h(item.campaignId)}</option>`).join("")}</select>` : ""}
    </header>`;
}

export const reportShellScript = `
  (() => {
    const shell = document.querySelector('.report-shell');
    const toggle = document.querySelector('[data-nav-toggle]');
    const backdrop = document.querySelector('[data-nav-close]');
    const close = () => { shell.classList.remove('navigation-open'); toggle.setAttribute('aria-expanded', 'false'); backdrop.hidden = true; };
    toggle.addEventListener('click', () => { const open = !shell.classList.contains('navigation-open'); shell.classList.toggle('navigation-open', open); toggle.setAttribute('aria-expanded', String(open)); backdrop.hidden = !open; });
    backdrop.addEventListener('click', close);
    shell.querySelectorAll('.report-sidebar a').forEach(link => link.addEventListener('click', close));
    document.addEventListener('keydown', event => { if(event.key === 'Escape' && shell.classList.contains('navigation-open')) { close(); toggle.focus(); } });
    document.querySelector('[data-nav-campaign]')?.addEventListener('change', event => { if(event.target.value) location.href = event.target.value; });
  })();
`;

export const reportNavigationStyles = `
  :root { --report-sidebar-width: 250px; --navigation-sticky-offset: 64px; }
  html { scroll-behavior: auto; }
  [hidden] { display: none !important; }
  .report-shell { min-height: 100dvh; }
  .report-surface { margin-left: var(--report-sidebar-width); min-width: 0; }
  .report-surface main { width: 100%; max-width: 1320px; margin: 0 auto; padding: 32px 36px 72px; }
  .report-sidebar { position: fixed; inset: 0 auto 0 0; width: var(--report-sidebar-width); display: flex; flex-direction: column; background: var(--card, var(--raised)); border-right: 1px solid var(--border); z-index: 20; }
  .report-brand { min-height: 68px; padding: 20px; display: flex; align-items: center; gap: 9px; font-size: 14px; text-decoration: none; }
  .report-brand small { font-size: 10px; font-weight: 400; margin-left: auto; color: var(--muted-foreground); }
  .report-brand svg { width: auto; height: 24px; flex: none; }
  .report-sidebar-scroll { min-height: 0; flex: 1; overflow: auto; padding: 0 10px 24px; scrollbar-width: thin; }
  .report-global-nav { display: grid; gap: 3px; }
  .report-global-nav a { display: flex; gap: 11px; align-items: center; padding: 9px 10px; font-size: 12px; color: var(--muted-foreground); border-radius: 5px; text-decoration: none; }
  .report-global-nav a:hover,.report-suite-tree a:hover { background: var(--raised); color: var(--foreground); }
  .report-global-nav a[aria-current=page] { color: var(--foreground); background: var(--raised); }
  .report-side-label { padding: 18px 10px 7px; margin: 0; font: 10px var(--font-mono); color: var(--muted-foreground); text-transform: uppercase; letter-spacing: .08em; }
  .report-suite-tree details > summary { display: flex; align-items: center; gap: 4px; list-style: none; cursor: pointer; padding-left: 4px; }
  .report-suite-tree summary::-webkit-details-marker { display: none; }
  .report-suite-tree summary::before { content: '›'; width: 12px; flex: none; color: var(--muted-foreground); }
  .report-suite-tree details[open] > summary::before { content: '⌄'; }
  .report-suite-tree a { display: flex; align-items: center; gap: 8px; min-width: 0; flex: 1; padding: 8px 5px; border-radius: 5px; text-decoration: none; font-size: 12px; color: var(--muted-foreground); }
  .report-suite-tree a small { margin-left: auto; font: 10px var(--font-mono); }
  .report-suite-tree a[aria-current=page],.report-suite-tree a.in-view { color: var(--foreground); background: var(--raised); }
  .report-suite-tree ul { display: grid; gap: 2px; margin: 0; padding: 0 0 8px 22px; list-style: none; }
  .report-suite-tree ul a { font-size: 11px; align-items: baseline; }
  .report-suite-tree .case-status-dot { flex: 0 0 5px; width: 5px; height: 5px; }
  .report-sidebar-footer { display: flex; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); color: var(--muted-foreground); font-size: 10px; padding: 17px 20px; }
  header.report-topbar { position: sticky; top: 0; z-index: 12; display: flex; align-items: center; justify-content: space-between; flex-wrap: nowrap; min-height: 64px; gap: 20px; margin: 0; padding: 12px 36px; border-bottom: 1px solid var(--border); background: var(--background); }
  .report-breadcrumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 5px 8px; font-size: 11px; min-width: 0; color: var(--muted-foreground); }
  .report-breadcrumbs a { text-decoration: none; }
  .report-breadcrumbs a:hover { text-decoration: underline; }
  .report-breadcrumbs [aria-current=page] { color: var(--foreground); }
  .report-breadcrumbs a,.report-breadcrumbs span { overflow-wrap: anywhere; }
  .report-campaign-select { font: 11px var(--font-sans); padding: 8px; color: var(--foreground); background: var(--card); border: 1px solid var(--border); border-radius: 5px; width: 220px; max-width: 30%; flex: none; }
  .report-menu-toggle { display: none; border: 0; padding: 0; background: transparent; color: var(--foreground); font-size: 20px; cursor: pointer; }
  .report-drawer-backdrop { display: none; }
  .report-header h1 { font-size: 32px; }
  .report-header .lede { font-size: 12px; }
  .report-source { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted-foreground); font-size: 11px; }
  .report-header { align-items: start; gap: 24px; }
  .report-actions { flex-wrap: wrap; }
  .campaign-billing-details { margin: 8px 0 24px; }
  .campaign-billing-details > summary { cursor: pointer; color: var(--muted-foreground); font-size: 12px; }
  [data-campaign-overview] .campaign-suites { grid-template-columns: repeat(2,minmax(0,1fr)); gap: 0 28px; }
  [data-campaign-overview] .campaign-suite-row { grid-template-columns: minmax(0,1fr) auto; gap: 4px 16px; }
  [data-campaign-overview] .campaign-suite-state { grid-column: 1/-1; text-align: left; font-size: 10px; }
  .report-surface .report-header { grid-template-columns: 1fr; }
  .report-surface .results-heading { scroll-margin-top: calc(var(--navigation-sticky-offset) + 24px); }
  .report-surface .suite-section { scroll-margin-top: calc(var(--navigation-sticky-offset) + 24px); margin-top: 56px; }
  .report-surface .section-heading h2 { font-size: 26px; }
  .report-surface .suite-case-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .report-journey { margin: 32px 0 44px; scroll-margin-top: calc(var(--navigation-sticky-offset) + 24px); }
  .report-journey-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 20px; margin: 0 0 14px; }
  .report-journey-heading h3 { margin: 0; font-size: 15px; font-weight: 600; }
  .report-journey-heading a { text-decoration: none; }
  .report-journey-heading a:hover { text-decoration: underline; }
  .report-journey-heading > a { font-size: 11px; color: var(--muted-foreground); white-space: nowrap; }
  .execution-previews { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,390px),1fr)); gap: 20px; align-items: start; }
  .execution-preview { min-width: 0; }
  .execution-preview-label { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; font-size: 10px; color: var(--muted-foreground); }
  .execution-preview-label strong { color: var(--foreground); font-weight: 500; }
  .report-surface .profile-sticky { position: static; }
  .execution-preview .case { scroll-margin-top: calc(var(--navigation-sticky-offset) + 24px); }
  .case-open { text-decoration: none; }
  .case-open:hover { text-decoration: underline; }
  .case-config-options { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 16px; }
  .case-config-options button { display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 7px 9px; font-size: 11px; color: var(--muted-foreground); background: var(--background); border: 1px solid var(--border); border-radius: 5px; }
  .case-config-options button[aria-pressed=true] { color: var(--foreground); background: var(--raised); border-color: var(--border-strong); }
  .case-config-options button:focus-visible,.report-menu-toggle:focus-visible { outline: 2px solid currentColor; outline-offset: 3px; }
  .case-page-heading { margin-bottom: 26px; }
  .case-page-heading h1 { font-size: 28px; margin-bottom: 12px; }
  .case-page-heading a { font-size: 12px; color: var(--muted-foreground); }
  .report-shell[data-view=case] .report-journey-heading,.report-shell[data-view=case] .suite-case-toc,.report-shell[data-view=case] .suite-section > .section-heading,.report-shell[data-view=case] .suite-summary,.report-shell[data-view=case] .execution-preview-label { display: none; }
  .report-shell[data-view=case] .suite-section,.report-shell[data-view=case] .report-journey { margin: 0; }
  .report-shell[data-view=case] .execution-previews { display: block; }
  .report-shell[data-view=case] .case { scroll-margin-top: calc(var(--navigation-sticky-offset) + 24px); }
  @media(max-width:1100px) { :root { --report-sidebar-width: 220px; }.report-surface main { padding: 28px 24px 60px; }header.report-topbar { padding: 12px 24px; }.report-campaign-select { max-width: 35%; }.report-surface .suite-summary { grid-template-columns: repeat(3,minmax(0,1fr)); } }
  @media(max-width:760px) {
    .report-surface { margin-left: 0; }.report-surface main { padding: 24px 17px 56px; }
    .report-sidebar { display: none; width: min(290px,85vw); }.navigation-open .report-sidebar { display: flex; }
    .navigation-open .report-drawer-backdrop { display: block; position: fixed; inset: 0; border: 0; background: var(--overlay,#0009); z-index: 19; }
    header.report-topbar { display: grid; grid-template-columns: 24px minmax(0,1fr); gap: 10px; padding: 12px 17px; }
    .report-menu-toggle { display: block; grid-row: 1; grid-column: 1; }.report-campaign-select { grid-row: 1; grid-column: 2; justify-self: end; max-width: 100%; width: 220px; }
    .report-breadcrumbs { grid-column: 1/-1; font-size: 10px; }
    .report-surface .suite-case-list { grid-template-columns: 1fr; }
    [data-campaign-overview] .campaign-suites { grid-template-columns: 1fr; }
    .report-surface .suite-summary { grid-template-columns: repeat(2,minmax(0,1fr)); }
    .report-surface .report-header h1 { font-size: 28px; }.report-surface .section-heading h2 { font-size: 24px; }
    .execution-previews { grid-template-columns: 1fr; }.report-journey-heading { align-items: start; }.report-journey-heading > a { max-width: 80px; white-space: normal; text-align: right; }
    .report-surface .report-filters input,.report-surface .report-filters select { font-size: 16px; }
    .report-shell[data-view=case] .gallery { grid-template-columns: 1fr; }
  }
  @media print { .report-sidebar,.report-topbar { display: none; }.report-surface { margin-left: 0; }.report-surface main { padding: 0; } }
`;
