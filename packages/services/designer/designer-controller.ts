import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { xspawn } from './cross-platform.ts';
import { createBrowser, type Browser } from './browser.ts';
import { sessionDir, saveIteration, type IterationRecord } from './artifact-store.ts';
import { upsertSession, appendHistory, getSession, type StoredSession } from './session-store.ts';
import { REPO_ROOT } from './repo-root.ts';
import { ensureCdpUp } from './cdp-ensure.ts';

export interface Selectors {
  login: { signedInIndicator: string | null };
  home: {
    creator: string;
    nameInput: string;
    wireframeButtonText: string;
    highFiButtonText: string;
    createButton: string;
    projectsList: string;
    projectCard: string;
  };
  composer: {
    promptTextarea: string;
    sendButton: string;
    stopButton: string | null;
    attachButton?: string;
    modelButton?: string;
  };
  preview: {
    iframeOrContainer: string;
    exportButtonText: string;
    shareButtonText: string;
    emptyStateHeading: string;
  };
  messages: {
    chatMessagesContainer: string;
    generatingIndicator: string | null;
  };
  [k: string]: unknown;
}

export interface ChatTurn {
  role: 'assistant' | 'user' | 'unknown';
  text: string;
}

export interface SessionStatus {
  key: string;
  stored: StoredSession | null;
  currentUrl: string;
  inSession: boolean;
  onHome: boolean;
  availableFiles: string[];
  // True when the latest turn is Claude punting with the "Claude has some questions →"
  // teaser. The questions UI itself is ephemeral — it disappears on refresh and has no
  // stable DOM contract — so we don't try to scrape and answer them. Caller should
  // surface this to a human, or re-prompt with `decisive: true` to bypass.
  awaitingClarification: boolean;
}

export type FailureMode = null | 'timeout' | 'unstable' | 'no_change';

export interface IterateResult {
  done: { ok: boolean; elapsedMs: number; failureMode: FailureMode };
  changed: boolean;
  /** Live claude.ai/design URL for the human — interactive, tweaks work. Default taste path. */
  url: string;
  activeFile: string | null;
  newFiles: string[];
  removedFiles: string[];
  htmlPath: string | null;
  screenshotPath: string | null;
  htmlBytes: number;
  htmlHash: string | null;
  chatReply: string | null;
}

export interface AskResult {
  ok: boolean;
  elapsedMs: number;
  reply: string | null;
  failureMode: null | 'timeout';
}

export interface HandoffResult {
  ok: true;
  handoffUrl: string;
  bundleDir: string;
  slugDir: string;
  readmePath: string;
  readmeBytes: number;
  tarballPath: string;
  tarballBytes: number;
  files: string[];
  repaired: RepairReport;
}

export interface RepairReport {
  renamed: Array<{ from: string; to: string }>;
  skipped: string[];
}

const DESIGN_HOME = 'https://claude.ai/design';

// Appended to every designer_prompt payload. The live MCP surface
// (listFiles / openFile / newFiles diff) scrapes a flat root from the
// file panel; files nested under folders stay invisible until handoff.
// Enforcing flat layout here keeps the live flow honest. Users who genuinely
// want nested layouts should explicitly contradict this in their prompt and
// rely on `designer_handoff` for authoritative file access.
const FLAT_LAYOUT_SUFFIX = '\n\nFile layout: keep all generated files at the project root. No subfolders.';
const DECISIVE_SUFFIX =
  '\n\nIf you would otherwise stop to ask clarifying questions, do not. Choose the most defensible answer for each axis yourself and proceed. Note your assumption in a one-line `<!-- assumed: ... -->` comment at the top of the relevant file so I can override on the next turn.';

function loadSelectors(): Selectors {
  const base = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'selectors.json'), 'utf8')) as Selectors;
  const overridePath = path.join(os.homedir(), '.designer', 'selectors.override.json');
  if (fs.existsSync(overridePath)) {
    try {
      return deepMerge(base, JSON.parse(fs.readFileSync(overridePath, 'utf8'))) as Selectors;
    } catch (e) {
      console.warn(`[designer] failed to parse ${overridePath}: ${(e as Error).message}`);
    }
  }
  return base;
}

function deepMerge(a: unknown, b: unknown): unknown {
  if (Array.isArray(a) || Array.isArray(b)) return b ?? a;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return b ?? a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const k of Object.keys(b as Record<string, unknown>))
    out[k] = deepMerge((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
  return out;
}

export class DesignerController {
  readonly key: string;
  readonly selectors: Selectors;
  readonly browser: Browser;
  private _preSendHtml = '';

  constructor({ key, headed = true }: { key?: string; headed?: boolean } = {}) {
    this.key = key || 'default';
    this.selectors = loadSelectors();
    this.browser = createBrowser({ session: `designer-${this.key}`, headed });
  }

  async currentUrl(): Promise<string> {
    return (await this.browser.url().catch(() => '')) || '';
  }

  async isOnHome(): Promise<boolean> {
    const u = await this.currentUrl();
    return /\/design\/?$/.test(u) || u.endsWith('/design');
  }

  async isInSession(): Promise<boolean> {
    const u = await this.currentUrl();
    return /\/design\/p\/[a-f0-9-]+/i.test(u);
  }

  async getStatus(): Promise<SessionStatus> {
    const stored = getSession(this.key);
    const url = await this.currentUrl();
    const inSession = /\/design\/p\/[a-f0-9-]+/i.test(url);
    const availableFiles = inSession ? await this.listFiles().catch(() => []) : [];
    const awaitingClarification = inSession ? await this.detectAwaitingClarification() : false;
    return {
      key: this.key,
      stored,
      currentUrl: url,
      inSession,
      onHome: /\/design\/?$/.test(url) || url.endsWith('/design'),
      availableFiles,
      awaitingClarification
    };
  }

  // Heuristic only. The questions popover is ephemeral, but the teaser text stays
  // in the chat turn body. If the most recent turn is from Claude and contains the
  // teaser, treat the session as blocked on a clarification. Returns false if the
  // page is mid-stream (we'd race the textnode walk against React's commit phase).
  private async detectAwaitingClarification(): Promise<boolean> {
    const turns = await this.getChatTurns().catch(() => [] as ChatTurn[]);
    if (turns.length === 0) return false;
    const last = turns[turns.length - 1];
    if (!last || last.role !== 'assistant') return false;
    return /Claude has some questions/i.test(last.text);
  }

  async session({
    action = 'status',
    name,
    fidelity = 'wireframe'
  }: { action?: 'status' | 'ensure_ready' | 'resume' | 'create'; name?: string; fidelity?: 'wireframe' | 'highfi' } = {}): Promise<unknown> {
    if (action === 'status') return this.getStatus();
    if (action === 'ensure_ready') {
      const r = await this.ensureReady();
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'resume') {
      const stored = getSession(this.key);
      if (!stored?.designUrl) throw new Error(`No stored session for key=${this.key}. Use action='create' with a name.`);
      const r = await this.resumeSession();
      return { ...r, status: await this.getStatus() };
    }
    if (action === 'create') {
      if (!name) throw new Error("action='create' requires a name.");
      const r = await this.createSession(name, fidelity);
      return { ...r, status: await this.getStatus() };
    }
    throw new Error(`Unknown action: ${action}`);
  }

  // Pick the live claude.ai/design tab among possibly many CDP pages, switch
  // agent-browser's binding to it, and verify readiness via DOM anchors.
  // Returns the count of candidates considered (for error messaging).
  private async selectMatchingTab(): Promise<{ matched: boolean; candidates: number }> {
    const tabs = await this.browser.tabs().catch(() => [] as Awaited<ReturnType<Browser['tabs']>>);
    if (tabs.length === 0) return { matched: false, candidates: 0 };

    const stored = getSession(this.key);
    const targetRoot = stored?.designUrl?.split('?')[0];
    const candidates = tabs.filter((t) => {
      if (t.type !== 'page' || !t.url) return false;
      if (targetRoot) return t.url.startsWith(targetRoot);
      return /^https:\/\/claude\.ai\/design(\/|$|\?)/.test(t.url);
    });
    if (candidates.length === 0) return { matched: false, candidates: 0 };

    // Prefer the active tab first, then by index ascending.
    candidates.sort((a, b) => (Number(b.active) - Number(a.active)) || (a.index - b.index));

    for (const cand of candidates) {
      await this.browser.activateTab(cand.index).catch(() => null);
      const composerOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
      const homeOk = this.selectors.login.signedInIndicator
        ? await this.browser.isVisible(this.selectors.login.signedInIndicator).catch(() => false)
        : false;
      if (composerOk || homeOk) {
        upsertSession(this.key, { lastUrl: await this.currentUrl() });
        return { matched: true, candidates: candidates.length };
      }
    }
    return { matched: false, candidates: candidates.length };
  }

  async ensureReady(): Promise<{ ok: true; url: string; inSession: boolean }> {
    await ensureCdpUp();

    const picked = await this.selectMatchingTab();
    if (picked.matched) {
      return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession() };
    }

    // No live design tab matched. Fall back to opening home and re-checking.
    if (picked.candidates === 0) {
      const u = await this.currentUrl();
      if (!/claude\.ai\/design/.test(u)) {
        await this.browser.open(DESIGN_HOME);
        await this.browser.waitLoad('networkidle').catch(() => null);
      }
    }

    const homeOk = this.selectors.login.signedInIndicator
      ? await this.browser.isVisible(this.selectors.login.signedInIndicator).catch(() => false)
      : false;
    const sessionOk = await this.browser.isVisible(this.selectors.composer.promptTextarea).catch(() => false);
    if (!homeOk && !sessionOk) {
      const suffix = picked.candidates > 0 ? ` (checked ${picked.candidates} tab(s))` : '';
      throw new Error(`Not signed in to claude.ai/design, or on an unrecognized page${suffix}. Sign in in the CDP-attached Chrome.`);
    }
    upsertSession(this.key, { lastUrl: await this.currentUrl() });
    return { ok: true, url: await this.currentUrl(), inSession: await this.isInSession() };
  }

  async createSession(name: string, fidelity: 'wireframe' | 'highfi' = 'wireframe'): Promise<{ ok: true; url: string; name: string; fidelity: string }> {
    const s = this.selectors.home;
    await this.browser.open(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
    await this.browser.waitFor(s.creator);

    // Fill via native setter so React's form controller registers the value.
    await this.browser.evalValue<boolean>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(s.nameInput)});
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(name)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`
    );

    const text = fidelity === 'highfi' ? s.highFiButtonText : s.wireframeButtonText;
    await this._clickButtonByText(new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await new Promise((r) => setTimeout(r, 200));
    await this.browser.evalValue<boolean>(
      `(() => { const b = document.querySelector(${JSON.stringify(s.createButton)}); if (!b) throw new Error('create button missing'); b.click(); return true; })()`
    );
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (await this.isInSession()) break;
    }
    if (!(await this.isInSession())) throw new Error('Session creation did not navigate to a /p/ url in time.');
    const url = await this.currentUrl();
    upsertSession(this.key, { designUrl: url, name, fidelity, lastUrl: url });
    appendHistory(this.key, { kind: 'session_create', name, fidelity, url });
    return { ok: true, url, name, fidelity };
  }

  async resumeSession(): Promise<{ ok: true; url: string }> {
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No designUrl stored for key=${this.key}. Create one first.`);
    await this.browser.open(stored.designUrl);
    await this.browser.waitLoad('networkidle').catch(() => null);
    return { ok: true, url: stored.designUrl };
  }

  async _submitPrompt(prompt: string): Promise<void> {
    const { promptTextarea, sendButton } = this.selectors.composer;
    await this.browser.waitFor(promptTextarea);
    // React-controlled textarea: bypass React's value ownership via the native
    // HTMLTextAreaElement setter, then fire a bubbling input event. This is
    // the canonical React-safe programmatic input pattern.
    await this.browser.evalValue<boolean>(
      `(() => {
        const ta = document.querySelector(${JSON.stringify(promptTextarea)});
        if (!ta) throw new Error('textarea not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(prompt)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.focus();
        return true;
      })()`
    );
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const disabled = await this.browser.evalValue<boolean>(
        `(() => { const b = document.querySelector(${JSON.stringify(sendButton)}); return !b || b.disabled; })()`
      );
      if (!disabled) break;
    }
    await this.browser.evalValue<boolean>(
      `(() => {
        const b = document.querySelector(${JSON.stringify(sendButton)});
        if (!b) throw new Error('send button not found');
        b.click();
        return true;
      })()`
    );
  }

  async sendPrompt(prompt: string, { decisive = false }: { decisive?: boolean } = {}): Promise<{ ok: true }> {
    const before = await this.fetchServedHtml();
    this._preSendHtml = before.html;
    const effective = prompt + FLAT_LAYOUT_SUFFIX + (decisive ? DECISIVE_SUFFIX : '');
    await this._submitPrompt(effective);
    const suffixApplied = decisive ? 'flat_layout+decisive' : 'flat_layout';
    appendHistory(this.key, { kind: 'prompt', prompt, suffixApplied });
    return { ok: true };
  }

  async waitForGenerationDone({
    timeoutMs = 20 * 60_000,
    stabilityMs = 4000,
    pollMs = 1500
  }: { timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}): Promise<{
    ok: boolean;
    elapsedMs: number;
    url?: string;
    iframeSrc?: string;
    htmlBytes?: number;
    html?: string;
    error?: string;
  }> {
    const start = Date.now();
    const preHtml = this._preSendHtml || '';
    let lastHtml = '';
    let lastLen = -1;
    let stableSince = 0;
    let sawChange = false;

    while (Date.now() - start < timeoutMs) {
      const { html, src } = await this.fetchServedHtml();
      const len = html.length;
      if (!preHtml) {
        if (len > 0) sawChange = true;
      } else if (html && html !== preHtml) {
        sawChange = true;
      }
      if (sawChange) {
        if (len === lastLen && html === lastHtml) {
          if (!stableSince) stableSince = Date.now();
          if (Date.now() - stableSince > stabilityMs) {
            const url = await this.currentUrl();
            return { ok: true, elapsedMs: Date.now() - start, url, iframeSrc: src, htmlBytes: len, html };
          }
        } else {
          stableSince = 0;
        }
      }
      lastHtml = html;
      lastLen = len;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: false, error: 'timeout', elapsedMs: Date.now() - start };
  }

  async snapshotDesign({
    html: knownHtml,
    iframeSrc: knownSrc
  }: { html?: string | null; iframeSrc?: string } = {}): Promise<{
    html: string | null;
    screenshotPath: string | null;
    url: string;
    iframeSrc: string;
  }> {
    const iframeSrc = knownSrc || (await this.getIframeSrc());
    let html: string | null = knownHtml ?? null;
    if (html == null && iframeSrc && /claudeusercontent\.com/.test(iframeSrc)) {
      const res = await fetch(iframeSrc, { headers: { Accept: 'text/html' } }).catch(() => null);
      if (res && res.ok) html = await res.text();
    }
    const dir = sessionDir(this.key);
    const shotPath = path.join(dir, `shot-${Date.now()}.png`);
    const shotOk = await this.browser
      .screenshot(shotPath, { full: true })
      .then(() => true)
      .catch(() => false);
    const url = await this.currentUrl();
    return { html, screenshotPath: shotOk ? shotPath : null, url, iframeSrc };
  }

  async _ensureInSession(): Promise<void> {
    await this.ensureReady();
    if (await this.isInSession()) return;
    const stored = getSession(this.key);
    if (!stored?.designUrl) throw new Error(`No active session for key=${this.key}. Call createSession first.`);
    await this.resumeSession();
  }

  async iterate(
    prompt: string,
    { file, timeoutMs, stabilityMs, decisive }: { file?: string; timeoutMs?: number; stabilityMs?: number; decisive?: boolean } = {}
  ): Promise<IterateResult> {
    await this._ensureInSession();
    if (file) await this.openFile(file);

    const preFiles = await this.listFiles().catch((): string[] => []);
    const preChatCount = (await this.getChatTurns()).length;

    await this.sendPrompt(prompt, { decisive });
    const done = await this.waitForGenerationDone({ timeoutMs, stabilityMs });

    const postFiles = await this.listFiles().catch((): string[] => []);
    const postTurns = await this.getChatTurns();
    const lastTurn = postTurns[postTurns.length - 1];
    const chatReply =
      postTurns.length > preChatCount && lastTurn && lastTurn.role === 'assistant'
        ? lastTurn.text.replace(/^Claude(?:\n+)?/, '').trim()
        : null;

    const newFiles = postFiles.filter((f) => !preFiles.includes(f));
    const removedFiles = preFiles.filter((f) => !postFiles.includes(f));

    const snap = await this.snapshotDesign({ html: done.html, iframeSrc: done.iframeSrc });
    const htmlHash = snap.html ? hashHex(snap.html) : null;
    const activeFile = extractFileParam(snap.url);

    let failureMode: FailureMode = null;
    if (!done.ok) failureMode = done.error === 'timeout' ? 'timeout' : 'unstable';
    else if (snap.html === this._preSendHtml && newFiles.length === 0) failureMode = 'no_change';

    const fidelity = getSession(this.key)?.fidelity || null;
    const record: IterationRecord = saveIteration(this.key, {
      prompt,
      fidelity,
      html: snap.html,
      screenshotPath: snap.screenshotPath,
      url: snap.url,
      meta: { done: { ok: done.ok, elapsedMs: done.elapsedMs }, failureMode, activeFile, newFiles, htmlHash }
    });
    appendHistory(this.key, { kind: 'iteration', record: record.files, newFiles });

    return {
      done: { ok: done.ok, elapsedMs: done.elapsedMs, failureMode },
      changed: !!(snap.html && snap.html !== this._preSendHtml) || newFiles.length > 0,
      url: snap.url,
      activeFile,
      newFiles,
      removedFiles,
      htmlPath: record.files.html || null,
      screenshotPath: record.files.screenshot || null,
      htmlBytes: snap.html ? snap.html.length : 0,
      htmlHash,
      chatReply
    };
  }

  async listProjects(): Promise<Array<{ name: string | null; sub: string | null; url: string | null }>> {
    await this.browser.open(DESIGN_HOME);
    await this.browser.waitLoad('networkidle').catch(() => null);
    await this.browser.waitFor(this.selectors.home.projectsList).catch(() => null);
    const json = await this.browser.evalValue<Array<{ name: string | null; sub: string | null; url: string | null }>>(
      `(() => {
        const cards = Array.from(document.querySelectorAll('[data-testid="project-card"]'));
        return cards.map((c) => {
          const link = c.tagName === 'A' ? c : c.querySelector('a[href*="/design/p/"]');
          const href = link && link.href ? link.href : null;
          const text = (c.innerText || '').split('\\n').map((s) => s.trim()).filter(Boolean);
          return { name: text[0] || null, sub: text[1] || null, url: href };
        });
      })()`
    ).catch(() => []);
    return Array.isArray(json) ? json : [];
  }

  async listFiles(): Promise<string[]> {
    const { files } = await this.listFilesDetailed();
    return files;
  }

  // Returns top-level files + whether folders were detected in the panel.
  // The live panel shows folders collapsed and doesn't expose an API we can
  // auth against (/files endpoint is 401, no aria-expanded on rows, clicks
  // don't expand programmatically). When folders are present, the caller
  // should fall back to designer_handoff for an authoritative list.
  async listFilesDetailed(): Promise<{ files: string[]; folders: string[]; authoritative: boolean }> {
    // Navigate to THIS key's project if we're not already there. Being in
    // any /p/ session isn't enough — a different key's files would be
    // returned against the currently-visible project by mistake.
    const stored = getSession(this.key);
    const currentUrl = await this.currentUrl();
    const targetRoot = stored?.designUrl?.split('?')[0];
    const currentRoot = currentUrl.split('?')[0];
    if (!targetRoot) {
      throw new Error(`No designUrl stored for key=${this.key}. createSession or resumeSession first.`);
    }
    if (currentRoot !== targetRoot) {
      await this.browser.open(stored.designUrl!);
      await this.browser.waitLoad('networkidle').catch(() => null);
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Open the Design Files dialog to get the richer file/folder listing.
    // Idempotent — if already open, the click is a no-op (or toggles; we
    // accept the occasional toggle as the tradeoff for not probing state).
    await this.browser.evalValue<boolean>(
      `(() => {
        const spans = Array.from(document.querySelectorAll('span'));
        const label = spans.find(s => s.children.length === 0 && (s.textContent || '').trim() === 'Design Files');
        if (!label) return false;
        let row = label;
        while (row && row.onclick === null) row = row.parentElement;
        if (row) row.click();
        return true;
      })()`
    ).catch(() => null);
    await new Promise((r) => setTimeout(r, 600));

    const result = await this.browser.evalValue<{ files: string[]; folders: string[]; designFilesLabelVisible: boolean }>(
      `(() => {
        // Walk all text nodes — Claude's file panel wraps filenames in styled-
        // component <div>s whose class hashes change across deploys. Tag-based
        // scraping misses them; text-node walking is resilient.
        const seen = new Set();
        const files = [];
        let designFilesLabelVisible = false;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.textContent || '').trim();
          if (t === 'Design Files') designFilesLabelVisible = true;
          if (!/^[A-Za-z0-9 _.()\\-]+\\.(html|js|css|jsx|tsx|ts|md|json|svg)$/i.test(t)) continue;
          if (t.length > 80 || seen.has(t)) continue;
          seen.add(t);
          files.push(t);
        }
        // Folders: rows whose sibling text is 'Folder' (a Claude-side label).
        // Still tag-based since folder rows are structurally different —
        // revisit if this breaks.
        const folderSet = new Set();
        const divs = Array.from(document.querySelectorAll('div'));
        for (const d of divs) {
          if (d.onclick === null) continue;
          const lines = (d.innerText || '').trim().split('\\n').map((l) => l.trim());
          if (lines.length >= 2 && lines[1] === 'Folder' && lines[0] && lines[0].length < 40) {
            folderSet.add(lines[0]);
          }
        }
        return { files, folders: Array.from(folderSet), designFilesLabelVisible };
      })()`
    ).catch(() => ({ files: [] as string[], folders: [] as string[], designFilesLabelVisible: false }));

    const files = Array.isArray(result.files) ? result.files : [];
    const folders = Array.isArray(result.folders) ? result.folders : [];
    // Empty rail under a visible "Design Files" label means we scraped the
    // wrong tab or the panel didn't open — don't tell callers it's truth.
    const emptyButLabelVisible = files.length === 0 && result.designFilesLabelVisible === true;
    return {
      files,
      folders,
      authoritative: !emptyButLabelVisible && folders.length === 0
    };
  }

  async openFile(filename: string): Promise<{ ok: true; file: string; url: string } | { ok: false; error: string; file: string; url: string }> {
    const stored = getSession(this.key);
    const baseUrl = stored?.designUrl || (await this.currentUrl()).split('?')[0] || '';
    if (!/\/design\/p\//.test(baseUrl)) throw new Error('No project open for this key.');
    const target = `${baseUrl.split('?')[0]}?file=${encodeURIComponent(filename)}`;
    await this.browser.open(target);
    const wanted = encodeURIComponent(filename);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const src = await this.getIframeSrc();
      if (src.includes(wanted)) return { ok: true, file: filename, url: await this.currentUrl() };
    }
    return { ok: false, error: 'iframe-swap-timeout', file: filename, url: await this.currentUrl() };
  }

  async fetchFile(filename: string): Promise<{ ok: boolean; file: string; iframeSrc?: string; html: string; htmlBytes: number; error?: string }> {
    const swap = await this.openFile(filename);
    if (!swap.ok) return { ok: false, error: swap.error, file: filename, html: '', htmlBytes: 0 };
    const { html, src } = await this.fetchServedHtml();
    return { ok: true, file: filename, iframeSrc: src, html, htmlBytes: html.length };
  }

  async getChatTurns(): Promise<ChatTurn[]> {
    return (
      (await this.browser
        .evalValue<ChatTurn[]>(
          `(() => {
            const c = document.querySelector('[data-testid="chat-messages"]');
            const inner = c && c.children[0];
            if (!inner) return [];
            return Array.from(inner.children).map((d) => {
              const txt = (d.innerText || '').trim();
              const isAssistant = /^Claude(\\n|$)/.test(txt);
              const isUser = /^You(\\n|$)/.test(txt);
              return { role: isAssistant ? 'assistant' : isUser ? 'user' : 'unknown', text: txt };
            });
          })()`
        )
        .catch(() => [] as ChatTurn[])) || []
    );
  }

  async ask(
    prompt: string,
    { file, timeoutMs = 5 * 60_000, stabilityMs = 2500, pollMs = 1000 }: { file?: string; timeoutMs?: number; stabilityMs?: number; pollMs?: number } = {}
  ): Promise<AskResult> {
    await this._ensureInSession();
    if (file) await this.openFile(file);
    const beforeCount = (await this.getChatTurns()).length;
    await this._submitPrompt(prompt);
    appendHistory(this.key, { kind: 'ask', prompt });

    const start = Date.now();
    let lastText = '';
    let stableSince = 0;

    while (Date.now() - start < timeoutMs) {
      const turns = await this.getChatTurns();
      if (turns.length >= beforeCount + 2) {
        const last = turns[turns.length - 1];
        if (last && last.role === 'assistant') {
          if (last.text === lastText && last.text.length > 0) {
            if (!stableSince) stableSince = Date.now();
            if (Date.now() - stableSince > stabilityMs) {
              const reply = last.text
                .replace(/^Claude(?:\n+)?/, '')
                .replace(/^(?:Searching|Reading|Thinking)\s*\n+/i, '')
                .trim();
              appendHistory(this.key, { kind: 'ask_reply', textBytes: reply.length });
              return { ok: true, elapsedMs: Date.now() - start, reply, failureMode: null };
            }
          } else {
            stableSince = 0;
            lastText = last.text;
          }
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: false, elapsedMs: Date.now() - start, reply: null, failureMode: 'timeout' };
  }

  async getIframeSrc(): Promise<string> {
    const src = await this.browser
      .evalValue<string>(
        `(() => { const el = document.querySelector(${JSON.stringify(this.selectors.preview.iframeOrContainer)}); return (el && el.src) || ''; })()`
      )
      .catch(() => '');
    return src || '';
  }

  async fetchServedHtml(): Promise<{ src: string; html: string }> {
    const src = await this.getIframeSrc();
    if (!src || !/claudeusercontent\.com/.test(src)) return { src: '', html: '' };
    try {
      const res = await fetch(src, { headers: { Accept: 'text/html' } });
      if (!res.ok) return { src, html: '' };
      return { src, html: await res.text() };
    } catch {
      return { src, html: '' };
    }
  }

  async handoff({ openFile }: { openFile?: string } = {}): Promise<HandoffResult> {
    await this._ensureInSession();
    if (openFile) await this.openFile(openFile);

    // Claude.ai/design moved Export actions under the Share dropdown
    // (~2026-04-19). Try Share first; fall back to Export for older builds.
    const opened = await this._clickButtonByText(/^Share$/).catch(() => null);
    if (!opened) await this._clickButtonByText(/^Export$/);
    await new Promise((r) => setTimeout(r, 400));
    await this._clickButtonByText(/handoff to claude code/i);

    let handoffUrl = '';
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const text = await this._dialogText();
      const match = String(text || '').match(/https:\/\/api\.anthropic\.com\/v1\/design\/h\/[A-Za-z0-9_-]+(?:\?[^\s]*)?/);
      if (match && match[0]) {
        handoffUrl = match[0];
        break;
      }
    }
    if (!handoffUrl) throw new Error('Handoff URL did not appear in the dialog.');

    await this.browser
      .evalValue<boolean>(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      .catch(() => null);

    const dir = sessionDir(this.key);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bundleDir = path.join(dir, `handoff-${stamp}`);
    fs.mkdirSync(bundleDir, { recursive: true });
    const tgzPath = path.join(bundleDir, 'bundle.tar.gz');

    const res = await fetch(handoffUrl);
    if (!res.ok) throw new Error(`Handoff fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tgzPath, buf);

    await new Promise<void>((resolve, reject) => {
      const child = xspawn('tar', ['-xzf', tgzPath, '-C', bundleDir], { stdio: 'pipe' });
      let err = '';
      child.stderr!.on('data', (d: Buffer) => (err += d.toString()));
      child.on('close', (code: number | null) =>
        code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${err}`))
      );
    });

    const entries = fs.readdirSync(bundleDir).filter((e) => e !== 'bundle.tar.gz');
    const projectSlug = entries.find((e) => fs.statSync(path.join(bundleDir, e)).isDirectory());
    const slugDir = projectSlug ? path.join(bundleDir, projectSlug) : bundleDir;
    const repaired = repairEmDashLinks(path.join(slugDir, 'project'));
    const readmePath = path.join(slugDir, 'README.md');
    const readme = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : null;
    const files = listAllFiles(slugDir).map((p) => path.relative(bundleDir, p));

    appendHistory(this.key, { kind: 'handoff', url: handoffUrl, bundleDir, fileCount: files.length, repaired });
    return {
      ok: true,
      handoffUrl,
      bundleDir,
      slugDir,
      readmePath,
      readmeBytes: readme ? readme.length : 0,
      tarballPath: tgzPath,
      tarballBytes: buf.length,
      files,
      repaired
    };
  }

  async _clickButtonByText(pattern: RegExp | string): Promise<boolean> {
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    return this.browser.evalValue<boolean>(
      `(() => {
        const re = new RegExp(${JSON.stringify(re.source)}, ${JSON.stringify(re.flags)});
        const btn = Array.from(document.querySelectorAll('button')).find(b => re.test((b.textContent || '').trim()));
        if (!btn) throw new Error('button not found: ' + ${JSON.stringify(re.source)});
        btn.click();
        return true;
      })()`
    );
  }

  async _dialogText(): Promise<string> {
    return (
      (await this.browser
        .evalValue<string>(
          `(() => {
            const dlg = document.querySelector('[role=dialog]');
            return (dlg && dlg.innerText) || '';
          })()`
        )
        .catch(() => '')) || ''
    );
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => null);
  }
}

function hashHex(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function extractFileParam(url: string): string | null {
  try {
    return new URL(url).searchParams.get('file');
  } catch {
    return null;
  }
}

// Claude's handoff pipeline (as of 2026-04) writes em-dashes (—, U+2014) into
// the index.html hrefs but saves on-disk filenames with regular hyphens (-).
// We detect this mismatch and rename files to match the hrefs. Safe if fixed
// upstream: if the href already resolves, we leave everything alone.
function repairEmDashLinks(projectDir: string): RepairReport {
  const report: RepairReport = { renamed: [], skipped: [] };
  if (!fs.existsSync(projectDir)) return report;
  const indexPath = path.join(projectDir, 'index.html');
  if (!fs.existsSync(indexPath)) return report;

  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const hrefs = new Set<string>();
  for (const m of indexHtml.matchAll(/href="([^"#?]+\.html)"/g)) {
    const raw = m[1];
    if (!raw) continue;
    try {
      hrefs.add(decodeURIComponent(raw));
    } catch {
      hrefs.add(raw);
    }
  }

  for (const wanted of hrefs) {
    const wantedPath = path.join(projectDir, wanted);
    if (fs.existsSync(wantedPath)) continue;
    const candidate = wanted.replace(/\u2014/g, '-').replace(/\s-\s/g, ' - ');
    const candidatePath = path.join(projectDir, candidate);
    if (candidate !== wanted && fs.existsSync(candidatePath)) {
      fs.renameSync(candidatePath, wantedPath);
      report.renamed.push({ from: candidate, to: wanted });
    } else {
      report.skipped.push(wanted);
    }
  }
  return report;
}

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur) continue;
    for (const entry of fs.readdirSync(cur)) {
      const p = path.join(cur, entry);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}
