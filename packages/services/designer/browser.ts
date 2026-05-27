import { xspawn } from './cross-platform.ts';

const BIN = process.env.DESIGNER_AGENT_BROWSER_BIN || 'agent-browser';
const DEFAULT_SESSION = process.env.DESIGNER_SESSION_NAME || 'designer';
// Default to the dedicated debug Chrome on :9222. Without this, callers that
// don't export DESIGNER_CDP (e.g. codex shelling `designer` directly) silently
// fall through to AGENT_BROWSER_SESSION_NAME mode and agent-browser launches
// its own Chromium instead of attaching to the user's live signed-in Chrome.
// Set DESIGNER_CDP='' explicitly to opt out and use the session-managed flow.
const CDP = process.env.DESIGNER_CDP ?? '9222';

export interface CreateBrowserOptions {
  session?: string;
  headed?: boolean;
  timeoutMs?: number;
  cdp?: string;
}

export interface SnapshotOptions {
  interactive?: boolean;
  scope?: string;
}

export interface TabInfo {
  active: boolean;
  index: number;
  title: string;
  type: string;
  url: string;
}

export interface Browser {
  session: string;
  run(args: string[], opts?: { input?: string; parseJson?: boolean }): Promise<string>;
  open(url: string): Promise<string>;
  close(): Promise<string | null>;
  url(): Promise<string>;
  title(): Promise<string>;
  tabs(): Promise<TabInfo[]>;
  activateTab(index: number): Promise<void>;
  snapshot<T = unknown>(opts?: SnapshotOptions): Promise<T>;
  snapshotText(opts?: SnapshotOptions): Promise<string>;
  click(sel: string): Promise<string>;
  fill(sel: string, text: string): Promise<string>;
  type(sel: string, text: string): Promise<string>;
  press(key: string): Promise<string>;
  getText(sel: string): Promise<string>;
  getAttr(sel: string, name: string): Promise<string>;
  getHtml(sel: string): Promise<string>;
  isVisible(sel: string): Promise<boolean>;
  waitFor(selOrMs: string | number): Promise<string>;
  waitLoad(state?: string): Promise<string>;
  screenshot(path?: string, opts?: { full?: boolean }): Promise<string>;
  eval(js: string): Promise<string>;
  evalValue<T = unknown>(js: string): Promise<T>;
}

export function createBrowser({
  session = DEFAULT_SESSION,
  headed = true,
  timeoutMs = 30_000,
  cdp = CDP
}: CreateBrowserOptions = {}): Browser {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BROWSER_DEFAULT_TIMEOUT: String(timeoutMs),
    ...(cdp ? {} : { AGENT_BROWSER_SESSION_NAME: session }),
    ...(headed && !cdp ? { AGENT_BROWSER_HEADED: '1' } : {})
  };

  function connectFlags(): string[] {
    if (!cdp) return [];
    if (cdp === 'auto' || cdp === '1' || cdp === 'true') return ['--auto-connect'];
    return ['--cdp', cdp];
  }

  function run(
    args: string[],
    { input, parseJson = false }: { input?: string; parseJson?: boolean } = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const finalArgs = [...connectFlags(), ...args];
      const child = xspawn(BIN, finalArgs, { env: baseEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err: Error) => reject(err));
      child.on('close', (code: number | null) => {
        if (code !== 0) {
          const err = new Error(`agent-browser ${finalArgs.join(' ')} exited ${code}: ${stderr.trim() || stdout.trim()}`);
          (err as Error & { code?: number | null; stdout?: string; stderr?: string }).code = code;
          return reject(err);
        }
        if (!parseJson) return resolve(stdout.trim());
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from agent-browser: ${(e as Error).message}\n--stdout--\n${stdout}`));
        }
      });
      if (input != null) {
        child.stdin!.write(input);
        child.stdin!.end();
      }
    });
  }

  return {
    session,
    run,
    open: (url) => run(['open', url]),
    close: () => run(['close']).catch(() => null),
    url: () => run(['get', 'url']),
    title: () => run(['get', 'title']),
    tabs: async () => {
      const out = await run(['tab', 'list', '--json']);
      const env = JSON.parse(out) as { success?: boolean; data?: { tabs?: TabInfo[] }; error?: unknown };
      if (env.success === false) {
        throw new Error(`agent-browser tab list failed: ${JSON.stringify(env.error)}`);
      }
      return env.data?.tabs ?? [];
    },
    activateTab: async (index) => {
      await run(['tab', String(index)]);
    },
    snapshot: <T = unknown>({ interactive = true, scope }: SnapshotOptions = {}) => {
      const args = ['snapshot', '--json'];
      if (interactive) args.push('-i');
      if (scope) args.push('-s', scope);
      return run(args, { parseJson: true }) as Promise<T>;
    },
    snapshotText: ({ interactive = true, scope }: SnapshotOptions = {}) => {
      const args = ['snapshot'];
      if (interactive) args.push('-i');
      if (scope) args.push('-s', scope);
      return run(args);
    },
    click: (sel) => run(['click', sel]),
    fill: (sel, text) => run(['fill', sel, text]),
    type: (sel, text) => run(['type', sel, text]),
    press: (key) => run(['press', key]),
    getText: (sel) => run(['get', 'text', sel]),
    getAttr: (sel, name) => run(['get', 'attr', name, sel]),
    getHtml: (sel) => run(['get', 'html', sel]),
    isVisible: (sel) => run(['is', 'visible', sel]).then((s) => s.trim() === 'true'),
    waitFor: (selOrMs) => run(['wait', String(selOrMs)]),
    waitLoad: (state = 'networkidle') => run(['wait', '--load', state]),
    screenshot: (path, { full = false } = {}) => {
      const args = ['screenshot'];
      if (path) args.push(path);
      if (full) args.push('--full');
      return run(args);
    },
    // Pipe JS via stdin (agent-browser's `--stdin` flag) instead of argv.
    // Argv-passed JS gets mangled by every shell layer (parens, quotes,
    // newlines all suffer) — most painfully on Windows where cmd.exe
    // doesn't preserve multiline strings — but this is the correct cross-
    // platform path: no escaping required, JS goes through verbatim.
    eval: (js) => run(['eval', '--stdin'], { input: js }),
    evalValue: async <T = unknown>(js: string): Promise<T> => {
      const out = await run(['eval', '--stdin'], { input: js });
      try {
        return JSON.parse(out) as T;
      } catch (e) {
        throw new Error(`evalValue: stdout was not JSON-parseable: ${(e as Error).message}\n--stdout--\n${out.slice(0, 500)}`);
      }
    }
  };
}
