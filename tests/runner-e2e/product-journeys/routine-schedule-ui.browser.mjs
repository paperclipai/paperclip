import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "@playwright/test";
import { fillRoutineCreateForm, enableRoutineScheduleTrigger, setRoutineScheduleEnabled } from "./routine-schedule-ui.ts";

// Render the production form, entity pickers, schedule rows and Radix primitives.
// Only unrelated display/editor boundaries are replaced. No app, provider or QA
// credential is needed. The full journey retains independent API readback/grades.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const uiRoot = path.join(root, "ui");
const uiRequire = createRequire(path.join(uiRoot, "package.json"));
const stubs = {
  "@/components/AgentAvatar": "export const AgentAvatar = () => null;",
  "@/components/Identity": "export const deriveInitials = name => name.slice(0, 2);",
  "@/lib/utils": "export const cn = (...values) => values.filter(Boolean).join(' ');",
  "../lib/utils": "export const cn = (...values) => values.filter(Boolean).join(' ');",
  "@/lib/router": "export const Link = ({to, children, ...props}) => <a href={to} {...props}>{children}</a>;",
  "@/components/MarkdownBody": "export const MarkdownBody = () => null;",
  "@/components/AgentActionButtons": "export const RunButton = () => null;",
  "@/components/TaskSummaryList": "export const TaskSummaryList = () => null;",
  "@/components/MarkdownEditor": `export const MarkdownEditor = ({value, onChange, ariaLabel}) =>
    <textarea aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} />;`,
  "@/components/RoutineVariablesEditor": "export const RoutineVariablesEditor = () => null;",
  "@/components/environment-variables-editor": "export const EnvironmentVariablesEditor = () => null;",
  "@/components/ScheduleEditor": `export const ScheduleEditor = () => null;
    export const describeSchedule = () => 'Every minute';`,
};
const compiled = await build({
  absWorkingDir: root,
  stdin: { resolveDir: uiRoot, loader: "tsx", contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { RoutineEditDialog, EMPTY_ROUTINE_FORM_DRAFT } from './src/components/routine-page/RoutineEditDialog';
    import { RoutinePage } from './src/components/routine-page/RoutinePage';
    const agent = { id: 'owned-agent', name: 'Owned QA agent' };
    const project = { id: 'owned-project', name: 'Owned QA project' };
    function Form() { return <RoutineEditDialog mode="create" open initial={EMPTY_ROUTINE_FORM_DRAFT}
      onOpenChange={() => {}} agents={[{id:'other-agent',name:'Other agent'},agent]}
      projects={[{id:'other-project',name:'Other project'},project]} people={[]} secrets={[]}
      onSave={draft => { window.saved = draft; window.saves++; }} />; }
    function Detail() {
      const [enabled,setEnabled] = useState(false);
      const routine = { id:'owned-routine', title:'Schedule control', status:'active', assigneeAgentId:agent.id,
        description:'', variables:[], env:null, triggers:[{id:'owned-trigger',kind:'schedule',enabled,
          cronExpression:'* * * * *',timezone:'America/Chicago'}] };
      return <RoutinePage routine={routine} agent={agent} project={project} history={[]} responsibilities={[]}
        onEdit={() => {}} onSaveSchedule={() => {}} onRemoveSchedule={() => {}}
        onSetTriggerPaused={async (id, paused) => { await fetch('/api/routine-triggers/'+id,
          {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:!paused})}); setEnabled(!paused); }} />;
    }
    window.saves=0; window.show = mode => createRoot(document.getElementById('root')).render(mode==='form'?<Form/>:<Detail/>);
  ` },
  bundle: true, write: false, format: "iife", jsx: "automatic",
  plugins: [{ name: "unrelated-ui-boundaries", setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      // React is owned by ui, not by the repository root in an isolated pnpm install.
      if (/^react(?:-dom)?(?:\/|$)/.test(args.path)) return { path: uiRequire.resolve(args.path) };
      if (stubs[args.path]) return { path: args.path, namespace: "fixture" };
      if (args.path.startsWith("@/")) {
        const base = path.join(root, "ui/src", args.path.slice(2));
        return { path: [base, base+".ts", base+".tsx"].find(existsSync) ?? base };
      }
    });
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "tsx", resolveDir: uiRoot }));
  } }],
});
const browser = await chromium.launch({ headless: true,
  ...(process.env.BROWSER_EXECUTABLE_PATH ? { executablePath: process.env.BROWSER_EXECUTABLE_PATH } : {}) });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(1500);
  await page.route('https://routine.fixture/**', route => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
  const mount = async mode => { await page.goto('https://routine.fixture/'); await page.addScriptTag({content:compiled.outputFiles[0].text}); await page.evaluate(mode => window.show(mode),mode); };
  await mount('form');
  const input = {title:'Scheduled check',agentName:'Owned QA agent',projectName:'Owned QA project',prompt:'Save the exact scheduled result.'};
  await fillRoutineCreateForm(page,input);
  await page.getByRole('button',{name:'Create routine',exact:true}).click();
  const saved = await page.evaluate(() => ({draft:window.saved,count:window.saves}));
  assert.equal(saved.count,1);
  assert.equal(saved.draft.title,input.title);
  assert.equal(saved.draft.assigneeAgentId,'owned-agent');
  assert.equal(saved.draft.projectId,'owned-project');
  assert.equal(saved.draft.description,input.prompt);
  assert.equal(saved.draft.schedule,null,'creation must not start a schedule');
  await mount('form');
  await assert.rejects(fillRoutineCreateForm(page,{...input,agentName:'Missing agent'}));
  assert.equal(await page.evaluate(() => window.saves),0,'a missing agent cannot submit or silently use another owner');
  await mount('form');
  await assert.rejects(fillRoutineCreateForm(page,{...input,projectName:'Missing project'}));
  assert.equal(await page.evaluate(() => window.saves),0,'a missing project cannot silently select another project');
  await mount('detail');
  const patches=[];
  await page.route('https://routine.fixture/api/routine-triggers/*',async route => {
    patches.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});
    await route.fulfill({contentType:'application/json',body:JSON.stringify({id:'owned-trigger',enabled:patches.at(-1).body.enabled})});
  });
  assert.equal((await enableRoutineScheduleTrigger(page,'/api/routine-triggers/owned-trigger')).status(),200);
  assert.equal((await setRoutineScheduleEnabled(page,'/api/routine-triggers/owned-trigger',false)).status(),200);
  assert.deepEqual(patches,[{path:'/api/routine-triggers/owned-trigger',body:{enabled:true}},
    {path:'/api/routine-triggers/owned-trigger',body:{enabled:false}}]);
  console.log('Production routine form, exact owner/project, missing agent/project refusal and schedule resume/pause passed.');
} finally { await browser.close(); }
