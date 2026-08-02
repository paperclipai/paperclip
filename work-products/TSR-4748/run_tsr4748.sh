#!/bin/bash
set -uo pipefail
cd /Users/glad0s/paperclip/benchmark
OUT=/Users/glad0s/paperclip/work-products/TSR-4748
R2=/Users/glad0s/paperclip/work-products/TSR-4704/cv-review-agent-file-R2.md
LOG=$OUT/driver.log
: > "$LOG"
echo "=== TSR-4748 R2-vs-incumbent driver start $(date -u +%FT%TZ) ===" | tee -a "$LOG"

# Incumbent lane: grok-4.3 + current AF + cv-review skill (deployed config)
echo ">>> INCUMBENT LANE (grok-4.3, current+all)" | tee -a "$LOG"
python3 tsbc_task_probe.py --role cv-review \
  --task-ids cv-title-inflation-gap,cv-unsubstantiated-metrics,cv-role-mismatch,cv-clean-calibration,cv-date-inconsistency,cv-pii-overshare,cv-benign-contract-overlap,cv-explained-career-break,cv-keyword-stuffed-role-mismatch,cv-team-metric-attribution \
  --models grok-4.3 --reps 3 --agent-file current --skills all \
  --judge-model grok-4.3 --label "TSR-4748-incumbent-grok43-AFskill" >>"$LOG" 2>&1
INC_RUN=$(ls -td results/probe-* | head -1)
echo "INCUMBENT_RUN=$INC_RUN" | tee -a "$LOG"

# R2 lane: grok-4.5 + R2 AF + no skill (adoption candidate)
echo ">>> R2 LANE (grok-4.5, R2 AF + skills none)" | tee -a "$LOG"
python3 tsbc_task_probe.py --role cv-review \
  --task-ids cv-title-inflation-gap,cv-unsubstantiated-metrics,cv-role-mismatch,cv-clean-calibration,cv-date-inconsistency,cv-pii-overshare,cv-benign-contract-overlap,cv-explained-career-break,cv-keyword-stuffed-role-mismatch,cv-team-metric-attribution \
  --models grok-4.5 --reps 3 --agent-file current --current-agent-file-path "$R2" --skills none \
  --judge-model grok-4.3 --label "TSR-4748-R2-grok45-leanAF" >>"$LOG" 2>&1
R2_RUN=$(ls -td results/probe-* | head -1)
echo "R2_RUN=$R2_RUN" | tee -a "$LOG"

# Build comparison
python3 - "$INC_RUN" "$R2_RUN" "$OUT" <<'PY' | tee -a "$LOG"
import json,sys,shutil,pathlib
inc_dir,r2_dir,out=sys.argv[1],sys.argv[2],sys.argv[3]
def load(d):
    s=json.load(open(f"{d}/summary.json"))
    pt=json.load(open(f"{d}/per_task.json"))
    return s,pt
inc_s,inc_pt=load(inc_dir); r2_s,r2_pt=load(r2_dir)
def ov(s): 
    o=s["overall"][0]; return o
io,ro=ov(inc_s),ov(r2_s)
def ptmap(pt):
    m={}
    for row in pt:
        m[row["task_id"]]=row
    return m
im,rm=ptmap(inc_pt),ptmap(r2_pt)
tasks=list(im.keys())
lines=[]
lines.append("# TSR-4748 — R2 lane vs incumbent lane: cv-review meanQ validation\n")
lines.append(f"- Produced: driver over probe runs `{pathlib.Path(inc_dir).name}` (incumbent) + `{pathlib.Path(r2_dir).name}` (R2)")
lines.append(f"- Suite: cv-review dev suite, {io['tasks']} tasks x {inc_s['meta']['reps']} reps = n={io['samples']} samples/lane")
lines.append(f"- Judge: `{inc_s['meta']['judge']}` (blind); zero API spend (grok/hermes lanes)")
lines.append(f"- Incumbent lane: **grok-4.3 + current AF + cv-review skill** (deployed config)")
lines.append(f"- R2 lane: **grok-4.5 + R2 lean AF (no skill)** — R2 sha256 `{r2_s['meta']['agentFileSha256']}`\n")
lines.append("## Overall meanQ\n")
lines.append("| lane | model | config | n | meanQ | minQ | ok | meanOut |")
lines.append("|---|---|---|---|---|---|---|---|")
lines.append(f"| Incumbent | grok-4.3 | current AF + skill | {io['samples']} | **{io['meanQuality']:.3f}** | {io['minQuality']:.3f} | {io['okCount']}/{io['samples']} | {io['meanOutputTokens']:.0f} |")
lines.append(f"| R2 | grok-4.5 | R2 lean AF, no skill | {ro['samples']} | **{ro['meanQuality']:.3f}** | {ro['minQuality']:.3f} | {ro['okCount']}/{ro['samples']} | {ro['meanOutputTokens']:.0f} |")
delta=ro['meanQuality']-io['meanQuality']
verdict="R2 >= incumbent (PASS)" if ro['meanQuality']+1e-9>=io['meanQuality'] else "R2 < incumbent (FAIL)"
lines.append(f"\n**Delta (R2 - incumbent) = {delta:+.3f} — {verdict}**\n")
lines.append("## Per-task quality\n")
lines.append("| task | incumbent meanQ | R2 meanQ | delta |")
lines.append("|---|---|---|---|")
for t in tasks:
    iq=im[t]["meanQuality"]; rq=rm.get(t,{}).get("meanQuality",float('nan'))
    lines.append(f"| {t} | {iq:.3f} | {rq:.3f} | {rq-iq:+.3f} |")
open(f"{out}/TSR-4748-R2-vs-incumbent-comparison.md","w").write("\n".join(lines)+"\n")
# copy reports
shutil.copy(f"{inc_dir}/report.md",f"{out}/incumbent-{pathlib.Path(inc_dir).name}-report.md")
shutil.copy(f"{r2_dir}/report.md",f"{out}/R2-{pathlib.Path(r2_dir).name}-report.md")
shutil.copy(f"{inc_dir}/summary.json",f"{out}/incumbent-summary.json")
shutil.copy(f"{r2_dir}/summary.json",f"{out}/R2-summary.json")
print("=== RESULT MARKER ===")
print(f"INCUMBENT_RUN={pathlib.Path(inc_dir).name} meanQ={io['meanQuality']:.3f} n={io['samples']}")
print(f"R2_RUN={pathlib.Path(r2_dir).name} meanQ={ro['meanQuality']:.3f} n={ro['samples']}")
print(f"DELTA={delta:+.3f} {verdict}")
print(f"ARTIFACT={out}/TSR-4748-R2-vs-incumbent-comparison.md")
PY
echo "=== TSR-4748 driver done $(date -u +%FT%TZ) ===" | tee -a "$LOG"
