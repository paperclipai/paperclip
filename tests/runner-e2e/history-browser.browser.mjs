// Explicit browser regression; synthetic history only, with no Paperclip/model runs.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { buildRunnerCampaign, campaignHistoryRecord, emptyRunnerHistory } from './history.ts';
import { renderRunnerHistoryIndex } from './history-index.ts';

const {values} = parseArgs({options:{screenshots:{type:'string'}}});
const result = (suite,profile,environment,model,targetUrl,status='passed',attempt=1) => ({
 schema:'paperclip.runner-e2e.result/v2',executionId:`${suite}.${profile}.${environment}.create`,suiteId:suite,
 suiteDefinitionHash:'fixture-definition',profileId:profile,environmentId:environment,caseId:'create',provider:profile,
 model,runtimeMode:'native',targetUrl,attempt,status,cleanup:'passed',durationMs:1000,
 startedAt:'2026-10-27T12:00:00Z',finishedAt:'2026-10-27T12:00:01Z',
});
const a=result('fixture-tasks','codex','local','model-a','http://localhost:3100');
const b=result('fixture-tasks','claude','daytona','model-b','https://qa.test.paperclip.app','failed');
const other=result('fixture-other','codex','daytona','model-a','https://qa.test.paperclip.app');
const record=(id,date,results,{full=false,preset}={})=>{
 const campaign=buildRunnerCampaign({campaignId:id,generatedAt:date,expected:results.map(row=>row.executionId),results});
 const record=campaignHistoryRecord(campaign,'https://reports.example.test/e2e');
 record.suites=record.suites.map(suite=>({...suite,expected:suite.suiteId==='fixture-tasks'?2:suite.selected,complete:full}));
 if(preset)record.preset=preset;
 return record;
};
const full=record('full-with-failure','2026-10-25T12:00:00Z',[a,b,other],{full:true});
full.source.ref='refs/heads/'+'long-branch'.repeat(20);
const subset=record('newer-subset','2026-10-26T12:00:00Z',[a]);
const unfinished=record('latest-unfinished','2026-10-27T12:00:00Z',[{...a,status:'failed',attempt:0},{...b,attempt:0}],{full:true});
const browserOnly={...result('fixture-app','browser','daytona',null,'https://qa.test.paperclip.app'),provider:null,runtimeMode:'none'};
const smoke=record('qa-smoke','2026-10-28T12:00:00Z',[browserOnly],{preset:'qa-smoke'});
const history={...emptyRunnerHistory(),updatedAt:'2026-10-28T12:00:00Z',latestCampaignId:'qa-smoke',campaigns:[smoke,unfinished,subset,full]};
const html=renderRunnerHistoryIndex(history);
const assets=new Map([
 ['/assets/InterVariable.woff2',{bytes:await readFile(new URL('../../ui/public/fonts/InterVariable.woff2',import.meta.url)),type:'font/woff2'}],
 ['/assets/favicon-32x32.png',{bytes:await readFile(new URL('../../ui/public/favicon-32x32.png',import.meta.url)),type:'image/png'}],
]);
const server=createServer((request,response)=>{
 const asset=assets.get(new URL(request.url,'http://localhost').pathname);
 response.setHeader('content-type',asset?.type??'text/html; charset=utf-8');response.end(asset?.bytes??html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/`;
let browser;
try{
 browser=await chromium.launch();
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(base+'?view=history');
 await expect(page.getByRole('navigation',{name:'E2E suites',exact:true})).toBeVisible();
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(4);
 await page.locator('[data-index-suite-link="fixture-tasks"]').click();
 await expect(page.getByRole('heading',{name:'fixture tasks',exact:true})).toBeVisible();
 await expect(page.locator('[data-index-latest="any"] a')).toHaveText('latest-unfinished');
 await expect(page.locator('[data-index-latest="full"] a')).toHaveText('full-with-failure');
 await page.getByLabel('Suite coverage',{exact:true}).selectOption('full');
 await expect(page.locator('[data-index-latest="any"] a')).toHaveText('full-with-failure');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(1);
 await expect(page.locator('[data-index-campaign]:not([hidden]) [data-index-row-status]')).toHaveText('failed');
 await page.getByLabel('Suite coverage',{exact:true}).selectOption('subset');
 await expect(page.locator('[data-index-latest="any"] a')).toHaveText('newer-subset');
 await expect(page.locator('[data-index-latest="full"] a')).toHaveText('full-with-failure');
 await expect(page.locator('[data-index-latest="full"] small')).toContainText('across coverage selections');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(1);
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveAttribute('data-index-id','newer-subset');
 await page.reload();await expect(page.getByLabel('Suite coverage',{exact:true})).toHaveValue('subset');
 await page.goBack();await expect(page.getByLabel('Suite coverage',{exact:true})).toHaveValue('full');
 await page.getByRole('button',{name:'Reset all filters',exact:true}).click();
 await page.getByLabel('Suite',{exact:true}).selectOption('fixture-tasks');
 await page.getByText('More filters',{exact:true}).click();
 await page.getByLabel('Target',{exact:true}).selectOption('https://qa.test.paperclip.app');
 await page.getByLabel('Model',{exact:true}).selectOption('model-a');
 await page.getByLabel('Agent execution',{exact:true}).selectOption('daytona');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(0);
 await expect(page.locator('[data-index-empty]')).toBeVisible();
 await page.getByRole('button',{name:'Reset all filters',exact:true}).click();
 await page.locator('[data-index-preset-link="qa-smoke"]').click();
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(1);
 await page.getByLabel('Model',{exact:true}).selectOption('__none__');
 await expect(page.locator('[data-index-campaign]:not([hidden]) [data-index-row-counts]')).toHaveText('1/1 matching executions passed · 1 executed');
 await page.locator('[data-index-suite-link="fixture-tasks"]').click();
 await expect(page.getByLabel('Run preset',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('Model',{exact:true})).toHaveValue('');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(3);
 await page.goto(base+'?view=history&suite=fixture-tasks&preset=qa-smoke');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(0);
 await expect(page.locator('[data-index-empty-message]')).toHaveText('No fixture tasks campaigns are included in QA smoke.');
 await page.getByRole('link',{name:'View fixture tasks runs',exact:true}).click();
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(3);
 await expect(page.getByLabel('Run preset',{exact:true})).toHaveValue('');
 await page.locator('[data-index-preset-link="qa-smoke"]').click();
 await page.getByLabel('Suite',{exact:true}).selectOption('fixture-tasks');
 await expect(page.getByLabel('Run preset',{exact:true})).toHaveValue('qa-smoke');
 await expect(page.locator('[data-index-empty-message]')).toHaveText('No fixture tasks campaigns are included in QA smoke.');
 const selectStyle=await page.getByLabel('Agent profile',{exact:true}).evaluate(select=>{
  const style=getComputedStyle(select);return {appearance:style.appearance,padding:parseInt(style.paddingRight),arrow:style.backgroundPosition};
 });
 if(selectStyle.appearance!=='none'||selectStyle.padding<32||!selectStyle.arrow.includes('12px'))throw Error('Dropdown arrow lacks inset: '+JSON.stringify(selectStyle));
 await page.getByRole('link',{name:'Overview',exact:true}).click();
 await expect(page.getByRole('heading',{name:'E2E tests',exact:true})).toBeVisible();
 await expect(page.getByLabel('Run preset',{exact:true})).toHaveValue('');
 await expect(page.locator('[data-index-overview]')).toBeVisible();
 await page.getByLabel('Target',{exact:true}).selectOption('https://qa.test.paperclip.app');
 await expect(page.locator('[data-index-overview]')).not.toBeVisible();
 await page.getByRole('button',{name:'Reset all filters',exact:true}).click();
 const neutralBorder=await page.getByLabel('Suite',{exact:true}).evaluate(control=>getComputedStyle(control).borderColor);
 const allFilters=new URLSearchParams({view:'attention',suite:'fixture-tasks',coverage:'full',target:'https://qa.test.paperclip.app',
  environment:'daytona',provider:'claude',model:'model-b',profile:'claude',runtime:'native',preset:'qa-smoke',
  status:'failed',from:'2026-10-24',through:'2026-10-29',q:'full'});
 await page.goto(base+'?'+allFilters);
 await expect(page.locator('[data-index-active-count]')).toHaveText('13 active');
 await expect(page.locator('[data-index-filter][data-filter-active=true]')).toHaveCount(13);
 await expect(page.getByLabel('Suite',{exact:true})).not.toHaveCSS('border-color',neutralBorder);
 await page.getByText('More filters',{exact:true}).click();
 await expect(page.locator('[data-index-more-count]')).toBeVisible();
 await expect(page.locator('[data-index-more-count]')).toHaveText('9 active');
 await page.reload();
 await expect(page.locator('[data-index-active-count]')).toHaveText('13 active');
 await page.getByLabel('Find suites',{exact:true}).fill('fixture tasks');
 await expect(page.locator('[data-index-suite-link]:visible')).toHaveCount(1);
 await page.getByRole('button',{name:'Reset all filters',exact:true}).click();
 await expect(page).toHaveURL(base+'?view=history');
 await expect(page.locator('[data-index-campaign]:not([hidden])')).toHaveCount(4);
 await expect(page.locator('[data-index-filter][data-filter-active=true]')).toHaveCount(0);
 await expect(page.locator('[data-index-active-count]')).toHaveText('None active');
 await expect(page.locator('[data-index-more-count]')).not.toBeVisible();
 await expect(page.getByLabel('Find suites',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('Suite',{exact:true})).toHaveCSS('border-color',neutralBorder);
 await expect(page.locator('[data-index-suite-link]:visible')).toHaveCount(await page.locator('[data-index-suite-link]').count());
 for(const control of await page.locator('[data-index-filter]').all())await expect(control).toHaveValue('');
 await page.goBack();
 await expect(page.locator('[data-index-active-count]')).toHaveText('13 active');
 await page.getByRole('button',{name:'Reset all filters',exact:true}).click();
 for(const width of [1440,1000,780,390]){
  await page.setViewportSize({width,height:1000});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw Error(`horizontal overflow at ${width}`);
 }
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 const phone=await mobile.newPage();await phone.goto(base+'?view=history');
 await phone.getByRole('button',{name:'Open navigation',exact:true}).tap();
 await phone.getByLabel('Find suites',{exact:true}).fill('fixture tasks');
 await phone.locator('[data-index-suite-link="fixture-tasks"]').tap();
 await expect(phone.locator('.report-sidebar')).not.toBeVisible();
 await expect(phone.locator('[data-index-latest="full"] a')).toHaveText('full-with-failure');
 if(values.screenshots){await mkdir(values.screenshots,{recursive:true});await phone.screenshot({path:values.screenshots+'/fixture-mobile.png',fullPage:true});}
 await mobile.close();
 if(errors.length)throw Error(errors.join('\n'));
 console.log('E2E history browser passed: recorded full runs, subsets, unfinished selections, correlated filters, QA preset, URL/back/reload, desktop and touch navigation. No provider calls.');
}finally{try{await browser?.close();}finally{await new Promise(resolve=>server.close(resolve));}}
