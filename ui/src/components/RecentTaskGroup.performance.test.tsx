// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { RecentTaskGroup } from './RecentTaskGroup';
import { queryKeys } from '@/lib/queryKeys';
import { __liveUpdatesTestUtils } from '@/context/LiveUpdatesProvider';
import { recentTaskHierarchy } from '@/lib/recent-task-hierarchy';
import { createCoalescingQueryClient } from '@/lib/query-invalidation-batcher';

const observed = vi.hoisted(()=>({callbacks:new Map<Element,IntersectionObserverCallback>(),requests:[] as any[], hold:false}));
vi.mock('@/api/issues',()=>({issuesApi:{listCompact:async(companyId:string,f:any,options?:{signal?:AbortSignal})=>{
  observed.requests.push({parentId:f.parentId,afterId:f.afterId});
  if (observed.hold) await new Promise<void>((_resolve,reject)=> {
    const signal=options?.signal;
    if(signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
  const start=f.afterId?Number(f.afterId.split(':').at(-1))+1:0;
  return Array.from({length:10},(_,i)=>({id:`${f.parentId}:${start+i}`,companyId,parentId:f.parentId,title:`Child ${start+i}`,status:'todo',identifier:null}));
}}}));
vi.mock('./RecentTaskNavItem',()=>({RecentTaskNavItem:({task}:any)=><a>{task.title}</a>}));
vi.mock('./StatusIcon',()=>({StatusIcon:()=>null}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;

it('measures visibility, paging and real live-event invalidation fanout',async()=>{
  class Observer {
    cb:IntersectionObserverCallback;
    constructor(cb:IntersectionObserverCallback){this.cb=cb;}
    observe(el:Element){observed.callbacks.set(el,this.cb);}
    unobserve(){}
    disconnect(){}
  }
  vi.stubGlobal('IntersectionObserver',Observer);
  const company='company',user='viewer';
  const tasks=Array.from({length:50},(_,i)=>({id:`parent-${i}`,companyId:company,title:`Parent ${i}`,identifier:null,status:'todo' as const,recordedAt:0,subtaskCount:100}));
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  const batcher=__liveUpdatesTestUtils.createLiveInvalidationBatcher(client,company);
  const liveClient=createCoalescingQueryClient(client,batcher);
  const div=document.createElement('div');document.body.appendChild(div);const root=createRoot(div);
  let summaryRequests=0;
  const summary=new QueryObserver(client,{queryKey:queryKeys.issues.summaryBatch(company,user,tasks.map(t=>t.id)),queryFn:async()=>{summaryRequests++;return []},staleTime:30_000});
  const unobserve=summary.subscribe(()=>{});
  const flush=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,30));});};
  const refresh=async(entityId='unrelated', parentIds?:string[], action='issue.updated', actorId='agent')=>{observed.requests.length=0;summaryRequests=0;await act(async()=>{
    __liveUpdatesTestUtils.invalidateActivityQueries(liveClient,company,{entityType:'issue',entityId,action,actorType:action.startsWith('issue.read_')?'user':'agent',actorId,details:{},...(parentIds ? {recentSubtaskParentIds:parentIds} : {})},{userId:user} as any);
    await batcher.flush();
  });await flush();return {childRequests:observed.requests.length,summaryRequests,requestsByParent:Object.fromEntries(tasks.map(t=>[t.id,observed.requests.filter(r=>r.parentId===t.id).length]).filter(([,n])=>n))};};
  try{
    await act(async()=>root.render(<QueryClientProvider client={client}>{tasks.map(task=><RecentTaskGroup task={task} userId={user} key={task.id}><a>{task.title}</a></RecentTaskGroup>)}</QueryClientProvider>));await flush();
    const report:any={environment:'jsdom; actual RecentTaskGroup/query hooks/coalesced live invalidation; simplified leaf markup',measurement:'requests per single flushed live-update batch; production ambient batches are spaced 5000ms',parents:50,initialOffscreenRequests:observed.requests.length};
    expect(report.initialOffscreenRequests).toBe(0);
    const anchors=[...observed.callbacks.entries()];
    async function reveal(start:number,end:number,visible=true){await act(async()=>{for(const [el,cb]of anchors.slice(start,end))cb([{isIntersecting:visible,target:el} as any],{} as any)});await flush();}
    await reveal(0,8);report.firstEightVisibleRequests=observed.requests.length;expect(report.firstEightVisibleRequests).toBe(8);
    report.unrelatedEventWithEightVisited=await refresh();
    // Load three pages of one group, then return it to ten visible children.
    const group=div.querySelector('[aria-label="Subtasks of Parent 0"]')!;
    for(let page=0;page<2;page++){await act(async()=>{[...group.querySelectorAll('button')].find(b=>b.textContent?.includes('Show more'))!.click()});await flush();}
    await act(async()=>{[...group.querySelectorAll('button')].find(b=>b.textContent==='Show less')!.click()});await flush();
    report.afterShowLess=await refresh();
    report.relevantAfterShowLess=await refresh('parent-0:0', ['parent-0']);
    expect(report.relevantAfterShowLess.childRequests).toBe(1);
    expect(observed.requests[0].afterId).toBeUndefined();
    report.newChildBeyondPreview=await refresh('new-child', ['parent-7']);
    expect(report.newChildBeyondPreview.requestsByParent).toEqual({'parent-7':1});
    report.reparent=await refresh('new-child', ['parent-6','parent-7']);
    expect(report.reparent.requestsByParent).toEqual({'parent-6':1,'parent-7':1});
    report.uncachedDeletion=await refresh('parent-7', [], 'issue.child_deleted');
    expect(report.uncachedDeletion.requestsByParent).toEqual({'parent-7':1});
    report.ownRead=await refresh('parent-7:0', ['parent-7'], 'issue.read_marked', user);
    expect(report.ownRead.requestsByParent).toEqual({'parent-7':1});
    report.otherRead=await refresh('parent-7:0', ['parent-7'], 'issue.read_marked', 'other-user');
    expect(report.otherRead.childRequests).toBe(0);
    // A current server supplies an empty authorized-parent set for unrelated work.
    report.unrelatedWithParentHints=await refresh('unrelated', []);
    expect(report.unrelatedWithParentHints).toMatchObject({childRequests:0,summaryRequests:0});
    await reveal(0,8,false);
    report.relevantOffscreen=await refresh('parent-7:0', ['parent-7']);
    expect(report.relevantOffscreen.childRequests).toBe(0);
    observed.requests.length=0;
    await reveal(7,8);
    report.returnToViewportRequests=observed.requests.length;
    expect(report.returnToViewportRequests).toBe(1);
    await reveal(8,50);
    report.afterAllFiftyHaveBeenViewed=await refresh();
    await act(async()=>{div.querySelector<HTMLButtonElement>('[aria-label="Collapse subtasks of Parent 0"]')!.click()});await flush();
    report.afterCollapseOne=await refresh();
    expect((await refresh('parent-0:0', ['parent-0'])).childRequests).toBe(0);
    report.largeHierarchy=[];
    for(const size of [50,500,5000,10000]){
      const entries=Array.from({length:size},(_,i)=>({...tasks[0],id:`task-${i}`,parentId:i%2?`task-${i-1}`:null,subtaskCount:i%2?0:1}));
      const samples=[];for(let i=0;i<25;i++){const start=performance.now();const h=recentTaskHierarchy(entries,'/PAP/issues/task-1');expect(h.nestedIds.size).toBe(size/2);samples.push(performance.now()-start);}
      samples.sort((a,b)=>a-b);report.largeHierarchy.push({size,medianMs:samples[12],maxMs:samples.at(-1)});
    }
    expect(report.unrelatedEventWithEightVisited.childRequests).toBe(0);
    expect(report.afterShowLess.childRequests).toBe(0);
    expect(report.afterAllFiftyHaveBeenViewed.childRequests).toBe(0);
    expect(report.afterCollapseOne.childRequests).toBe(0);
    console.log(JSON.stringify(report));
  }finally{batcher.dispose();unobserve();await act(async()=>root.unmount());client.clear();div.remove();vi.unstubAllGlobals();}
},30000);


it('cancels pending HTTP reads and queued groups when they leave the viewport', async () => {
  observed.callbacks.clear(); observed.requests.length=0; observed.hold=true;
  class Observer {
    constructor(private cb:IntersectionObserverCallback) {}
    observe(el:Element) { observed.callbacks.set(el,this.cb); }
    disconnect() {}
  }
  vi.stubGlobal('IntersectionObserver',Observer);
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  const div=document.createElement('div'); document.body.appendChild(div);
  const root=createRoot(div);
  const settle=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  try {
    const tasks=Array.from({length:50},(_,i)=>({id:`parent-${i}`,companyId:'company',title:`Parent ${i}`,identifier:null,status:'todo' as const,recordedAt:0,subtaskCount:100}));
    await act(async()=>root.render(<QueryClientProvider client={client}>{tasks.map(task=><RecentTaskGroup task={task} userId="viewer" key={task.id}><a>{task.title}</a></RecentTaskGroup>)}</QueryClientProvider>));
    const anchors=[...observed.callbacks.entries()];
    const show=(visible:boolean)=>act(async()=>{
      for(const [el,cb] of anchors) cb([{isIntersecting:visible,target:el} as IntersectionObserverEntry],{} as IntersectionObserver);
    });
    await show(true); await settle();
    expect(observed.requests).toHaveLength(3);
    expect(client.isFetching()).toBe(50);
    await show(false); await settle();
    expect(client.isFetching()).toBe(0);
    expect(observed.requests).toHaveLength(3);
    observed.hold=false;
    const [el,cb]=anchors[49]!;
    await act(async()=>cb([{isIntersecting:true,target:el} as IntersectionObserverEntry],{} as IntersectionObserver));
    await settle();
    expect(observed.requests.map(r=>r.parentId)).toEqual(['parent-0','parent-1','parent-2','parent-49']);
  } finally {
    observed.hold=false;
    await act(async()=>root.unmount());client.clear();div.remove();vi.unstubAllGlobals();
  }
});
