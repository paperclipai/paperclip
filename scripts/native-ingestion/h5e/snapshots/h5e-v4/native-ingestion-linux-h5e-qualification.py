import pathlib,subprocess,json,os,socket,datetime,hashlib,traceback,argparse
p=argparse.ArgumentParser();p.add_argument('--full',action='store_true');p.add_argument('--tree',choices=['B0','B1','B2-base'],default='B2-base');p.add_argument('--name',required=True);a=p.parse_args()
base=pathlib.Path('/home/ubuntu/native-ingestion');repo=base/'paperclip';h=base/'harness-h5e';out=base/'evidence/h5e/qualification'/a.name;out.mkdir(parents=True,exist_ok=False)
pins={'B0':('aligned-cf-baseline','7550ffa5d6447d2615bc89fc5313f4cbb958b615'),'B1':('aligned-cf-cursors','2cf1454406cbd582a11f04476713eceb746eada5'),'B2-base':('aligned-cf-batching-base','0b616ccc90bf43cb26adac056a22ff01a84f982b')};app=base/pins[a.tree][0]
ref='73ea8516739e81fa7f37cd67651b4a2c73674014';protocol='7995ffdbf14b772e4c39444f6b89ba8684bcd86ef8ae866ffb0f5dbd89f35ccd';comparator='3deceda0ef909829dfc3c2169d5d88ccb7c1ce9aa2881998e8ee07d23c1b56dc';lock='54a81b2ed3f1f85eaa085c034560ac248e384db34fbc7aba8c5a3846c29b3ce8'
r={'startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'qualificationOnly':True,'performanceAcceptanceEligible':False,'fullFixture':a.full,'sourceRevision':pins[a.tree][1],'harnessRevision':ref,'steps':[]}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def save():(out/'owner-receipt.json').write_text(json.dumps(r,indent=2)+'\n')
def cmd(name,args,cwd,env=None,timeout=None):
 row={'name':name,'argv':list(map(str,args)),'cwd':str(cwd),'startedAt':now()};r['steps'].append(row);save()
 with(out/(name+'.log')).open('xb')as log:result=subprocess.run(args,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=timeout)
 row.update({'exit':result.returncode,'finishedAt':now()});save();assert result.returncode==0,(name,result.returncode)
try:
 assert(base/'aligned-cf-builds.exit').read_text().strip()=='0'
 qualified=json.loads((base/'aligned-cf-builds-qualified.json').read_text())
 assert {row['variant']:row['revision'] for row in qualified['results']}=={v:pin for v,(directory,pin) in pins.items()}
 rows=[]
 for q in pathlib.Path('/proc').iterdir():
  if not q.name.isdigit():continue
  try:
   exe=os.readlink(q/'exe')
   if pathlib.Path(exe).name in['node','postgres','paperclip-runner','rustc','cargo','chrome','chromium','chrome-headless-shell']:rows.append({'pid':int(q.name),'executable':exe})
  except OSError:pass
 assert not rows,rows
 for directory,pin in pins.values():
  root=base/directory;assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==pin
  assert not subprocess.check_output(['git','status','--short'],cwd=root,text=True).strip()
  assert json.loads((root/'server/dist/build-info.json').read_text())['commit']==pin
 assert h.exists(), 'Stage the exact independent driver before qualification'
 assert not(h/'node_modules').is_symlink();assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=h,text=True).strip()==ref
 assert not subprocess.check_output(['git','status','--short'],cwd=h,text=True).strip()
 files=['native-event-ingestion.journey.ts','playwright-native-ingestion.config.ts','fixtures/in-feed-codex.mjs','fixtures/native-ingestion-bin/codex','fixtures/composer-stop-codex-loader.mjs','fixtures/native-ingestion-bootstrap.mjs','fixtures/native-ingestion-remote-server.mjs','fixtures/native-ingestion-protocol-qualification.mjs','fixtures/native-ingestion-h5.mjs']
 assert hashlib.sha256(b''.join((h/'tests/e2e'/f).read_bytes()for f in files)).hexdigest()==protocol
 assert hashlib.sha256((h/'scripts/compare-native-ingestion-browser.ts').read_bytes()).hexdigest()==comparator
 assert hashlib.sha256((h/'pnpm-lock.yaml').read_bytes()).hexdigest()==lock
 assert hashlib.sha256((h/'tests/e2e/fixtures/native-ingestion-h5.md').read_bytes()).hexdigest()=='9fa1ba019e2385e0e9c23e2c66aebaeaf915e8204f04f00fa7e9bc0f83059291'
 r['resourceWatchdogMillis']=1800000;r['resourceWatchdogScope']='Resource-only including startup/test/teardown; original SLA and H5 observation unchanged';r['protocolSha256']=protocol;r['comparatorSha256']=comparator;r['driverLockSha256']=lock
 with socket.socket()as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 env=dict(os.environ)
 for key in ['DATABASE_URL','PAPERCLIP_RUNNER_STATE_DIR','PAPERCLIP_INGESTION_SERVER_COMMAND','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_DIR','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_FS','PAPERCLIP_NATIVE_INGESTION_DIAGNOSTIC_INSPECTOR','PAPERCLIP_INGESTION_BROWSER_CAPTURE','PAPERCLIP_INGESTION_SMOKE','NODE_OPTIONS','PAPERCLIP_INGESTION_OBSERVATION_MODE']:env.pop(key,None)
 binary=str(app/'packages/paperclip-runner/runner/target/release/paperclip-runnerd')
 overrides={'PAPERCLIP_INGESTION_OBSERVATION_MODE':'h5c-observe-original-sla-independent-agents-settlement','PAPERCLIP_INGESTION_TRANSPORT':'sandbox-remote-with-local-stop','PAPERCLIP_INGESTION_APP_ROOT':str(app),'PAPERCLIP_INGESTION_EVIDENCE_DIR':str(out),'PAPERCLIP_E2E_PORT':str(port),'PAPERCLIP_RUNNER_BINARY':binary,'PAPERCLIP_RUNNER_REMOTE_BINARY_PATH':binary,'PAPERCLIP_INGESTION_VARIANT':a.name+'-FUNCTIONAL-QUALIFICATION-ONLY','PAPERCLIP_INGESTION_DRIVER_DEPENDENCIES':'Independent H5e frozen offline ignore-scripts driver install; application owns independent normal locked install/build'}
 if not a.full:overrides['PAPERCLIP_INGESTION_SMOKE']='1'
 overrides['PATH']=env['PATH'];env.update(overrides);r['environmentOverrides']=overrides;save();subprocess.run(['sync'],check=True)
 node=pathlib.Path('/opt/native-ingestion/node-v26.4.0-linux-x64/bin/node')
 helper=base/'helpers/native-ingestion-run-h5e-browser.mjs'
 assert hashlib.sha256(helper.read_bytes()).hexdigest()=='191de2cbebab6936433778a2348f61a242a2f29c006b0aa5794443cb040c3347'
 path_guard="const {assertPathNode}=await import("+json.dumps(str(helper))+");console.log(JSON.stringify(await assertPathNode(process.env,process.execPath,process.argv[1])));"
 path_argv=[str(node),'--input-type=module','-e',path_guard,str(app)]
 path_result=subprocess.run(path_argv,cwd=app,env=env,check=True,capture_output=True,text=True)
 r['nodePathPreflight']={'executable':str(node),'argv':path_argv[1:],'cwd':str(app),'pathNode':json.loads(path_result.stdout)}
 (out/'path-node-preflight.json').write_text(json.dumps(r['nodePathPreflight'],indent=2)+'\n');save()
 cmd('playwright',['timeout','--signal=INT','--kill-after=40s','30m',str(node),'node_modules/@playwright/test/cli.js','test','--config','tests/e2e/playwright-native-ingestion.config.ts'],h,env,1845)
 r['playwrightPassed']=True;r['finishedAt']=now();save()
except BaseException as error:r.update({'passed':False,'error':str(error),'traceback':traceback.format_exc(),'finishedAt':now()});save();(out/'owner.exit').write_text('1\n');raise

finally:
 helper=base/'helpers/native-ingestion-run-h5e-browser.mjs'
 guard="import net from 'node:net'; import {physicalQuietGuard} from '"+str(helper)+"'; const s=net.createServer(); await new Promise((ok,bad)=>{s.once('error',bad);s.listen(Number(process.argv[2]),'127.0.0.1',ok)}); await new Promise(ok=>s.close(ok)); await physicalQuietGuard({receiptFile:process.argv[1],phase:'post-arm',armStage:'H5e-QUALIFICATION-ONLY'});"
 try:
  result=subprocess.run(['node','--input-type=module','-e',guard,str(out/'physical-quiet-after.json'),str(r['environmentOverrides']['PAPERCLIP_E2E_PORT'])],check=True,capture_output=True,text=True)
  (out/'port-after.json').write_text(json.dumps({'complete':True,'port':r['environmentOverrides']['PAPERCLIP_E2E_PORT'],'checkedAt':now(),'nodeBindAndListenPassed':True})+'\n')
  if r.get('playwrightPassed'):
   r['passed']=True;r['cleanupComplete']=True;save();(out/'owner.exit').write_text('0\n')
 except BaseException as cleanup_error:
  r['externalQuietFailure']=str(cleanup_error);r['passed']=False;r['cleanupComplete']=False;save();(out/'owner.exit').write_text('1\n');raise
