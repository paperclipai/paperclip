"""Bounded source/guard validation only; no application or measurement launch."""
from pathlib import Path
import ast, datetime, hashlib, json, os, re, subprocess

ROOT=Path(__file__).parent
OUT=ROOT/'checks'; OUT.mkdir(exist_ok=True)
NODE='/private/tmp/native-ingestion-node24/bin/node'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
now=lambda:datetime.datetime.now(datetime.timezone.utc).isoformat()
composition=json.loads((ROOT/'composition.json').read_text())
receipt={'sourceOnly':True,'applicationProviderDatabaseBrowserVmStagingNetworkBuildOrMeasurementsExecuted':False,'startedAtUtc':now(),'commands':[],'heldForRootAndPeerReview':True}

def run(name,argv,expected=0,env=None):
    result=subprocess.run(argv,cwd=ROOT,capture_output=True,env=env)
    stdout=OUT/(name+'.stdout');stderr=OUT/(name+'.stderr')
    stdout.write_bytes(result.stdout);stderr.write_bytes(result.stderr)
    row={'name':name,'argv':argv,'cwd':str(ROOT),'expectedExit':expected,'exit':result.returncode,'passed':result.returncode==expected,'stdoutSha256':sha(stdout),'stderrSha256':sha(stderr)}
    receipt['commands'].append(row)
    (OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    assert row['passed'],(name,result.returncode,result.stdout.decode()[-3000:],result.stderr.decode()[-3000:])
    return result

receipt['nodeVersion']=subprocess.check_output([NODE,'--version'],text=True).strip()
assert receipt['nodeVersion']=='v24.22.2'
for row in composition['clones']:
    if row['replacements'] and row['file'].endswith('.mjs'):
        run('syntax-'+Path(row['file']).stem,[NODE,'--check',str(ROOT/row['file'])])
for file in ROOT.glob('*.py'):ast.parse(file.read_text(),filename=str(file))
receipt['pythonAstFiles']=sorted(file.name for file in ROOT.glob('*.py'))
env=dict(os.environ);env.pop('PROVENANCE_HELPER_ROOT',None)
red=run('red-v3-rejects-prospective-qualified-source',[NODE,'--test','--test-reporter=tap','--test-name-pattern=qualified current75 and prospective sources use exact descriptor receipts',str(ROOT/'native-provenance.test.mjs')],1,dict(env,PROVENANCE_HELPER_ROOT='/private/tmp/native-ingestion-h5e-tools-v3'))
assert red.stdout.count(b'B2 must use the reviewed current TypeScript batching source revision')==2
assert re.search(rb'# tests 2\n',red.stdout) and re.search(rb'# fail 2\n',red.stdout)
receipt['expectedRed']={'tests':2,'failed':2,'reason':'V3 hardcodes current75 source and rejects an otherwise coherent future qualified descriptor before any live app could start.'}
counts=[]
for file in ['native-provenance.test.mjs','source-guards.test.mjs']:
    result=run('green-'+Path(file).stem,[NODE,'--test','--test-reporter=tap',str(ROOT/file)],env=env)
    tests=int(re.search(rb'# tests (\d+)\n',result.stdout)[1]); passed=int(re.search(rb'# pass (\d+)\n',result.stdout)[1]); failed=int(re.search(rb'# fail (\d+)\n',result.stdout)[1])
    assert tests==passed and failed==0;counts.append({'file':file,'tests':tests,'passed':passed,'failed':failed})
comparator_file=Path('/private/tmp/paperclip-native-event-harness-h5e/scripts/native-ingestion-performance-gates.test.mjs')
comparator=run('existing-qualified-native-comparator-cli',[NODE,'--test','--test-reporter=tap','--test-name-pattern=H5 CLI retains baseline SLA failure',str(comparator_file)],env=env)
for case in ['each arm accepts its distinct qualified Runner binary','a serving binary outside its qualified receipt is rejected','a second qualified binary within one arm is rejected','A/A cannot compare two qualified Runner binaries',"later original-deadline proof must use the candidate's qualified binary"]:
    assert case.encode()in comparator.stdout,case
assert re.search(rb'# fail 0\n',comparator.stdout)
receipt['existingComparatorChecks']={'file':str(comparator_file),'fileSha256':sha(comparator_file),'tests':int(re.search(rb'# tests (\d+)\n',comparator.stdout)[1]),'passed':int(re.search(rb'# pass (\d+)\n',comparator.stdout)[1]),'failed':0,'purpose':'Actual frozen CLI checks qualified cross-role binaries, serving/receipt mismatches, within-role changes, A/A stability and later original proof identity.'}
for name in ['native-ingestion-run-h5e-browser.mjs','native-ingestion-h5c-cf-build-guards.mjs','native-ingestion-run-blocked-stop-v4.mjs']:
    run('dry-run-'+Path(name).stem,[NODE,str(ROOT/name)])
for flag in ['--execute','--validate-release']:
    result=run('dependency-reject-'+flag.removeprefix('--'),[NODE,str(ROOT/'native-ingestion-h5c-cf-build-guards.mjs'),flag],1)
    assert b'Dependency-only CF build guards cannot execute a main stage' in result.stderr
for name,helper in [('main-aa-b0.unauthorized.json','native-ingestion-run-h5e-browser.mjs'),('companion-v4-qualification-b0.unauthorized.json','native-ingestion-run-blocked-stop-v4.mjs')]:
    file=ROOT/'templates'/name;release=json.loads(file.read_text());assert release['authorized'] is False
    args=[NODE,str(ROOT/helper),'--validate-release','--stage='+release['stage'],'--release='+str(file),'--output-root='+release['outputRoot']]
    if name.startswith('companion'):args+=['--release-sha256='+sha(file)]
    run('reject-'+name,args,1)
for row in composition['clones']:
    assert sha(Path(row['parent']))==row['parentSha256'];assert sha(ROOT/row['file'])==row['sha256']
parent=Path(composition['parentPacketFile']);assert sha(parent)==composition['parentPacketSha256']
receipt['unchangedAncestorPackets']=[]
while parent:
    ancestor=json.loads(parent.read_text())
    for key in ['sourceFiles','verificationFiles']:
        for row in ancestor[key]:assert sha(parent.parent/row['path'])==row['sha256'],row['path']
    receipt['unchangedAncestorPackets'].append({'file':str(parent),'sha256':sha(parent)})
    link=ancestor.get('parentPacket')
    if not link:break
    parent=Path(link['file']);assert sha(parent)==link['sha256']
for checkout,pin in [('/private/tmp/paperclip-native-event-harness-h5e','73ea8516739e81fa7f37cd67651b4a2c73674014'),('/private/tmp/paperclip-native-event-blocked-stop-v4','a89f321ab5654211cbff7be1ee15c110b8db4a5f')]:
    assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=checkout,text=True).strip()==pin
    assert subprocess.check_output(['git','status','--short'],cwd=checkout,text=True).strip()==''
receipt.update(passed=True,greenSuites=counts,greenTests=sum(row['tests']for row in counts),templatesAuthorized=False,parentPacketAndFrozenDriversUnchanged=True,finishedAtUtc=now())
(OUT/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({'passed':True,'commands':len(receipt['commands']),'greenTests':receipt['greenTests'],'expectedRedFailures':2,'receiptSha256':sha(OUT/'receipt.json')}))
