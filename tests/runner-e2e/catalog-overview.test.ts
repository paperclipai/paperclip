import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
const { JSDOM } = createRequire(new URL("../../server/package.json", import.meta.url))("jsdom") as typeof import("../../server/node_modules/@types/jsdom/index.js");
import { mkdtemp, writeFile, stat, rm, readFile, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { regenerateCatalogOverview } from "./dashboard-regenerate.js";
import { parseCatalogOverview, type CatalogOverview } from "./catalog-overview.js";
import { renderRunnerE2EDashboard } from "./dashboard.js";

function fixture(): CatalogOverview {
  const catalog = new URL("./chat-scenarios/", import.meta.url);
  const ids = readdirSync(catalog).filter(name => name.endsWith(".yaml")).flatMap(name => [...readFileSync(new URL(name,catalog),"utf8").matchAll(/^  - id: ([a-z0-9.-]+)$/gm)].map(match => match[1]!));
  const example = ids.indexOf("projects.create-project"); [ids[0],ids[example]]=[ids[example]!,ids[0]!];
  const rows: CatalogOverview["rows"] = ids.map((scenarioId,i)=>({scenarioId, mainOutcome:i<25?"passed":i<169?"failed":"unmeasured",allowance:i<102?"exhausted":i>=169&&i<218?"unused-initial":i===243?"unknown":"final-available",sourceReadiness:"not-assessed",executionRecord:i<169?"main-measured":i<218?"never-run":i===243?"unknown":"candidate-measured"}));
  return { schema:"paperclip.catalog-overview/v2", asOf:"2026-10-29T17:54:00Z", definitions:{lazy:242,legacy:2,featureAreas:35,capabilities:191,declaredGaps:5}, accounting:{mainMeasurements:215,retainedRawResults:295,closedSlots:296,exhaustedFinals:102,theoreticalMainCeiling:152}, rows };
}
function page(data: CatalogOverview) {
  return renderRunnerE2EDashboard({title:"Catalog",generatedAt:data.asOf,expected:[],catalog:[],entries:[],catalogOverview:data});
}

describe("display-only catalog overview", () => {
  it("requires the fixed scope and rejects private carrier fields rather than serializing them", () => {
    const data=fixture();
    expect(parseCatalogOverview(data).rows).toHaveLength(244);
    expect(() => parseCatalogOverview({...data,privatePath:"/private/hidden"})).toThrow("Unexpected");
    expect(() => parseCatalogOverview({...data,rows:data.rows.map((r,i)=>i? r : {...r,errorBody:"secret"})})).toThrow("Unexpected");
    expect(() => parseCatalogOverview({...data,definitions:{...data.definitions,legacy:0}})).toThrow("Frozen");
  });
  it("rejects duplicate rows, invalid IDs/states, impossible counts and mixed real results", () => {
    const data=fixture();
    expect(() => parseCatalogOverview({...data,rows:[...data.rows.slice(1),data.rows[1]]})).toThrow("Duplicate");
    expect(() => parseCatalogOverview({...data,rows:data.rows.map((r,i)=>i?r:{...r,scenarioId:'<img src=x onerror=alert(1)>'})})).toThrow("Invalid public");
    expect(() => parseCatalogOverview({...data,rows:data.rows.map((r,i)=>i?r:{...r,mainOutcome:'candidate-pass'})})).toThrow("Invalid");
    expect(() => parseCatalogOverview({...data,accounting:{...data.accounting,mainMeasurements:2}})).toThrow("Inconsistent");
    expect(() => renderRunnerE2EDashboard({title:"mixed",generatedAt:data.asOf,expected:["real-case"],catalog:[],entries:[],catalogOverview:data})).toThrow("cannot be mixed");
  });
  it("renders metadata counts and scopes without fake result cards or evidence links", () => {
    const data=fixture(); const doc=new JSDOM(page(data)).window.document;
    expect(doc.querySelectorAll('[data-catalog-row]')).toHaveLength(244);
    expect(doc.querySelectorAll('[data-report-case]')).toHaveLength(0);
    expect(doc.querySelector('[data-report-scope]')?.getAttribute('data-report-scope')).toBe('global');
    const text=doc.querySelector('main')!.textContent!;
    for(const value of ['25','144','75','49 unused initials','295 retained results','296 closed ordinal slots','102 exhausted finals','152/244','242 lazy definitions plus 2 implemented legacy']) expect(text).toContain(value);
    expect(text).toContain('Fully native auxiliary setup and complete usage qualification are not established');
    expect(text).not.toContain('No result artifact was uploaded');
    expect(text).not.toContain('2 unimplemented');
    expect(doc.querySelectorAll('a[href*="create-project"]')).toHaveLength(1);
    expect(doc.querySelectorAll('img[src], a[href*="artifact"], a[href*="private/"]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-catalog-row][data-allowance="unused-initial"]')).toHaveLength(49);
  });
  it("separates candidate failures from unmeasured main and exposes only supplied public descriptions", () => {
    const data=fixture(); data.rows[218]!.executionRecord="candidate-failed";
    const id=data.rows[218]!.scenarioId;
    const html=renderRunnerE2EDashboard({title:"Catalog",generatedAt:data.asOf,expected:[],catalog:[],entries:[],catalogOverview:data,catalogOverviewDescriptions:new Map([[id,{query:'Explain <this> & that',expectedOutcome:'A saved public outcome'}]])});
    const doc=new JSDOM(html).window.document,row=doc.getElementById('catalog-'+id)!;
    expect(row.textContent).toContain('No main measurement');
    expect(row.textContent).toContain('Candidate run: FAIL');
    expect(row.querySelector('details')!.textContent).toContain('Explain <this> & that');
    expect(html).toContain('Explain &lt;this&gt; &amp; that');
    expect(doc.querySelector('[data-execution-scope]')!.textContent).toContain('25 cases measured outside main · 49 never run · 1');
    expect(() => parseCatalogOverview({...data,rows:data.rows.map((r,i)=>i===218?{...r,executionRecord:'never-run'}:r)})).toThrow('Inconsistent recorded');
  });
  it("preserves a valid main outcome when its allowance is unknown", () => {
    const data=fixture(); data.rows[0]!.allowance="unknown";
    expect(parseCatalogOverview(data).accounting.exhaustedFinals).toBe(102);
    const doc=new JSDOM(page(data)).window.document,row=doc.getElementById('catalog-'+data.rows[0]!.scenarioId)!;
    expect(row.textContent).toContain('Recorded pass');
    expect(row.textContent).toContain('Main measurement recorded');
    expect(row.textContent).toContain('Allowance unknown');
    expect(row.textContent).toContain('Recover ordinal evidence');
    expect(doc.querySelector('.summary')!.textContent).toContain('25Recorded feature-work passes');
    expect(() => parseCatalogOverview({...data,accounting:{...data.accounting,exhaustedFinals:104}})).toThrow('Inconsistent catalog accounting');
  });
  it("rejects unknown allowance when execution is positively known never-run", () => {
    const data=fixture(); data.rows[169]!.allowance="unknown";
    expect(() => parseCatalogOverview(data)).toThrow('Inconsistent recorded execution scope');
  });
  it("shows a later candidate pass without promoting the recorded main failure", () => {
    const data=fixture(); data.rows[25]!.latestCandidateOutcome="passed";
    const doc=new JSDOM(page(data)).window.document,row=doc.getElementById('catalog-'+data.rows[25]!.scenarioId)!;
    expect(row.getAttribute('data-outcome')).toBe('failed');
    expect(row.textContent).toContain('Recorded fail');
    expect(row.textContent).toContain('Main measurement recorded · Latest candidate run: PASS');
    expect(doc.querySelector('.summary')!.textContent).toContain('25Recorded feature-work passes144Latest main failures75Without a main measurement');
    expect(doc.querySelector('[data-execution-scope]')!.textContent).toContain('26 cases measured outside main');
    expect(doc.querySelectorAll('[data-report-case]')).toHaveLength(0);
    expect(parseCatalogOverview(data).rows[25]!.mainOutcome).toBe('failed');
    expect(() => parseCatalogOverview({...data,rows:data.rows.map((r,i)=>i===25?{...r,latestCandidateOutcome:'made-up'}:r)})).toThrow('Invalid catalog overview state');
    expect(() => parseCatalogOverview({...fixture(),rows:fixture().rows.map((r,i)=>i===169?{...r,latestCandidateOutcome:'passed'}:r)})).toThrow('Inconsistent recorded');
  });
  it.each([[152,"below"],[196,"equal to"],[200,"above"]] as const)("compares a ceiling of %i accurately", (ceiling, comparison) => {
    const data=fixture(); data.accounting.theoreticalMainCeiling=ceiling;
    expect(new JSDOM(page(data)).window.document.querySelector('main')!.textContent).toContain(`${ceiling}/244, ${comparison} the 196-case target`);
  });
  it("filters and resets actual DOM rows without treating unused initials as failures", () => {
    const dom=new JSDOM(page(fixture()),{runScripts:'dangerously',pretendToBeVisual:true});
    const doc=dom.window.document;
    for (const selector of ['[data-nav-view="attention"]','.report-global-nav a[href$="?view=history"]','.report-breadcrumbs']) expect(dom.window.getComputedStyle(doc.querySelector(selector)!).display).toBe('none');
    expect(dom.window.getComputedStyle(doc.querySelector('[data-nav-view="overview"]')!).display).not.toBe('none');
    const select=doc.querySelector<HTMLSelectElement>('[data-catalog-outcome]')!;select.value='unmeasured';select.dispatchEvent(new dom.window.Event('input'));
    expect([...doc.querySelectorAll<HTMLElement>('[data-catalog-row]')].filter(r=>!r.hidden)).toHaveLength(75);
    const allowance=doc.querySelector<HTMLSelectElement>('[data-catalog-allowance]')!;allowance.value='unknown';allowance.dispatchEvent(new dom.window.Event('input'));
    expect(doc.querySelector('[data-catalog-count]')!.textContent).toBe('1 of 244 scenarios');
    doc.querySelector<HTMLButtonElement>('[data-catalog-reset]')!.click();
    expect([...doc.querySelectorAll<HTMLElement>('[data-catalog-row]')].filter(r=>!r.hidden)).toHaveLength(244);
    const search=doc.querySelector<HTMLInputElement>('[data-catalog-query]')!;search.value='create project';search.dispatchEvent(new dom.window.Event('input'));
    expect(doc.querySelector('[data-catalog-count]')!.textContent).toBe('1 of 244 scenarios');
    dom.window.close();
  });
  it("loads only bounded display metadata and refuses existing outputs and symlink inputs", async () => {
    const dir=await mkdtemp(path.join(os.tmpdir(),'catalog-overview-test-'));
    try {
      const metadata=path.join(dir,'display.json'); await writeFile(metadata,JSON.stringify(fixture()));
      const output=path.join(dir,'preview');
      await regenerateCatalogOverview({metadataFile:metadata,outputDirectory:output});
      expect((await stat(output)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(output,'index.html'))).mode & 0o777).toBe(0o600);
      expect(await readFile(path.join(output,'index.html'),'utf8')).toContain('All 244 scenarios');
      expect(await readFile(path.join(output,'index.html'),'utf8')).toContain('What this test asks');
      await expect(regenerateCatalogOverview({metadataFile:metadata,outputDirectory:output})).rejects.toThrow();
      await writeFile(metadata,JSON.stringify({...fixture(),rows:fixture().rows.map((r,i)=>i?r:{...r,scenarioId:'projects.invented-scenario'})}));
      await expect(regenerateCatalogOverview({metadataFile:metadata,outputDirectory:path.join(dir,'invented-out')})).rejects.toThrow('frozen scenario IDs');
      const link=path.join(dir,'link.json'); await symlink(metadata,link);
      await expect(regenerateCatalogOverview({metadataFile:link,outputDirectory:path.join(dir,'link-out')})).rejects.toThrow();
      await writeFile(metadata,' '.repeat(256*1024+1));
      await expect(regenerateCatalogOverview({metadataFile:metadata,outputDirectory:path.join(dir,'big-out')})).rejects.toThrow('bounded');
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it("links the dated immutable snapshot from real campaign and metadata navigation", () => {
    const data=fixture();
    const ordinary=renderRunnerE2EDashboard({title:"Campaign",generatedAt:data.asOf,expected:[],catalog:[],entries:[]});
    for (const html of [ordinary,page(data)]) {
      const dom=new JSDOM(html),link=dom.window.document.querySelector<HTMLAnchorElement>('[data-nav-catalog]')!;
      expect(link.textContent).toContain('Chat catalog · Oct 29');
      expect(link.href).toBe('https://d1p6rlowie26tp.cloudfront.net/runner-e2e/campaigns/chat-catalog-overview-20261029-175400z/');
      expect(dom.window.getComputedStyle(link).display).not.toBe('none');
      expect(dom.window.document.querySelectorAll('[data-nav-catalog]')).toHaveLength(1);
      dom.window.close();
    }
  });
  it("keeps the normal campaign branch and its missing-result behavior", () => {
    const normal=renderRunnerE2EDashboard({title:'Existing campaign',generatedAt:'2026-10-29T17:54:00Z',expected:[],catalog:[],entries:[]});
    expect(normal).toContain('aria-label="Campaign summary"');
    expect(normal).not.toContain('data-catalog-overview>');
    expect(normal).toContain('data-report-scope="campaign"');
    const window=new JSDOM(normal).window;
    expect(window.getComputedStyle(window.document.querySelector('[data-nav-view="attention"]')!).display).not.toBe('none');
  });
});
