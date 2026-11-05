from pathlib import Path
import json, hashlib

ROOT = Path(__file__).parent
BUILD = Path('/private/tmp/native-ingestion-evidence-cf/builds')
MAIN = Path('/private/tmp/paperclip-native-event-harness-h5e')
COMPANION = Path('/private/tmp/paperclip-native-event-blocked-stop-v4')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
composition = json.loads((ROOT/'composition.json').read_text())
files = {row['file']: row for row in composition['clones']}
descriptors = json.loads(Path('/private/tmp/native-ingestion-cf-build-descriptors.json').read_text())
freeze = json.loads(Path('/private/tmp/native-ingestion-cf-driver-source-freeze.json').read_text())
readback_root = Path('/private/tmp/native-ingestion-cf-runtime-path-readback')
assert sha(readback_root/'manifest.json') == 'e8f69f51db226a743e41595a358e4ff6a92b748f1bc400f954b695bdaa7c01fd'
manifest = json.loads((readback_root/'manifest.json').read_text())
for row in manifest['files']:
    p = readback_root/row['name']; assert p.stat().st_size == row['bytes'] and sha(p) == row['sha256']
assert sha(readback_root/'stdout.json') == '4498a01f20116a1a83860568411e780c7de65e26509824df682cc9ce811fb02b'
runtime = json.loads((readback_root/'stdout.json').read_text())
assert runtime['complete'] and runtime['preQuiet']['quiet'] and runtime['postQuiet']['quiet']
assert runtime['pnpmActualNodeObservation']['observed']
node = runtime['nodePathSelection']['actualProcess']
assert node['version'] == 'v26.4.0' and node['cwd'] == descriptors['builds']['B0']['appRoot']
node_version_file = BUILD/'aligned-cf-build-logs/node-version.log'
assert node_version_file.read_text().strip() == node['version']
assert runtime['pnpmPathSelection']['selectedAbsolute'] == '/usr/local/bin/pnpm'
pnpm = next(row for row in runtime['commands'] if row['argv'][0] == runtime['pnpmPathSelection']['selectedAbsolute'])
checks = {
    'node': {'executable': node['execPath'], 'args': ['--version'], 'expected': node['version']},
    'pnpm': {'executable': runtime['pnpmPathSelection']['selectedAbsolute'], 'args': pnpm['argv'][1:], 'expected': pnpm['output'].strip()},
}
for name in ['postgres','chromium','rustc','cargo']:
    candidates = [row for row in runtime['otherRuntimeChecks'] if Path(row['selectedAbsolute']).name == ('chrome-headless-shell' if name == 'chromium' else name)]
    assert len(candidates) == 1
    row = candidates[0]; assert row['matchesPriorPacket']
    checks[name] = {'executable': row['selectedAbsolute'], 'args': row['args'], 'expected': row['versionOutput'].strip()}
assert sorted(checks) == ['cargo','chromium','node','pnpm','postgres','rustc']
guard_file = BUILD/'evidence/aligned-cf/environment/watchdog-extension-cf-next08.json'
assert sha(guard_file) == '9fdcdc640978d7540164cda67616410850c5592d05207e552736f8060dc78b9c'
guard = json.loads(guard_file.read_text())
assert guard['complete'] and guard['newExpiry'] == '2026-11-05T08:08:02Z'
runtime_provenance = {'file': str(readback_root/'stdout.json'), 'sha256': sha(readback_root/'stdout.json'), 'manifestFile': str(readback_root/'manifest.json'), 'manifestSha256': sha(readback_root/'manifest.json'), 'nodeVersionSource': 'Actual process.version plus CF normal-build node-version.log; --version is the guard command', 'nodeVersionFile': str(node_version_file), 'nodeVersionFileSha256': sha(node_version_file), 'pnpmCanonicalFile': runtime['pnpmPathSelection']['canonicalFile'], 'pnpmFileSha256': runtime['pnpmPathSelection']['fileSha256'], 'actualPnpmNodeObservation': runtime['pnpmActualNodeObservation'], 'PATH': runtime['PATH'], 'cwd': runtime['cwd']}
guard_provenance = {'file': str(guard_file), 'sha256': sha(guard_file), 'hardResourceExpiryUtc': guard['newExpiry'], 'finalExplicitTerminationStillRequired': True}
(ROOT/'runtime-checks.json').write_text(json.dumps({'runtimeChecks': checks, 'provenance': runtime_provenance},indent=2)+'\n')

main_release = {'schema':'paperclip.native-ingestion.h5-root-release.v1','authorized':False,'scope':'UNAUTHORIZED SOURCE TEMPLATE ONLY; qualification and independent source review must pass before root issues a separate exact release.','stage':'browser-aa-b0','outputRoot':'/home/ubuntu/native-ingestion/evidence/h5e/series','orchestratorSha256':files['native-ingestion-run-h5e-browser.mjs']['sha256'],'harnessRoot':'/home/ubuntu/native-ingestion/harness-h5e','harnessRevision':freeze['drivers'][0]['revision'],'protocolSha256':freeze['mainMeasurementSha256'],'comparatorSha256':freeze['comparatorSha256'],'inventoryHelperSha256':sha(MAIN/'scripts/native-ingestion-h5-inventory.mjs'),'protocolDocumentSha256':sha(MAIN/'tests/e2e/fixtures/native-ingestion-h5.md'),'lockSha256':sha(MAIN/'pnpm-lock.yaml'),'gatesSha256':sha(MAIN/'scripts/native-ingestion-performance-gates.mjs'),'workloadSha256':freeze['registrationSha256'],'observationMode':'h5c-observe-original-sla-independent-agents-settlement','protocolVersion':'v5c-independent-agents-complete-settlement-original-sla','resourceWatchdogMillis':1800000,'stageResourceWatchdogMillis':14400000,'perVariantBuilds':{'B0':descriptors['builds']['B0']},'priorStageReports':{},'noiseReports':{},'runtimeChecks':checks,'prerequisiteEvidence':{'smallReportSha256':None,'fullReportSha256':None,'companionV4ReportSha256':None,'qualificationSamplesMustNotBeReused':True,'guardReceiptSha256':sha(guard_file),'hardResourceExpiryUtc':guard['newExpiry']},'runtimeProvenance':runtime_provenance,'guardProvenance':guard_provenance}
templates = ROOT/'templates'; templates.mkdir(exist_ok=True)
(templates/'main-aa-b0.unauthorized.json').write_text(json.dumps(main_release,indent=2)+'\n')
for full,name in [(False,'small-b0'),(True,'full-b0')]:
    r = {'schema':'paperclip.native-ingestion.h5e-qualification-source-template.v1','authorized':False,'qualificationOnly':True,'performanceAcceptanceEligible':False,'full':full,'variant':'B0','app':descriptors['builds']['B0'],'harnessRoot':main_release['harnessRoot'],'harnessRevision':main_release['harnessRevision'],'measurementSha256':main_release['protocolSha256'],'readinessNamespace':'/home/ubuntu/native-ingestion/evidence/h5e/setup-'+name,'outputRoot':'/home/ubuntu/native-ingestion/evidence/h5e/qualification/'+name,'helperFiles':{key:row['sha256'] for key,row in files.items() if 'blocked-stop' not in key and 'h5c-cf' not in key},'runtimeChecks':checks,'runtimeProvenance':runtime_provenance,'guardProvenance':guard_provenance,'resourceWatchdogMillis':1800000,'originalBudgetsUnchanged':True,'qualifierArgv':['python3','/home/ubuntu/native-ingestion/helpers/native-ingestion-linux-h5e-qualification.py',*(['--full'] if full else []),'--tree','B0','--name',name],'releasePending':'This JSON does not authorize or launch the qualifier. Root must issue an explicit byte-bound execution release after review.'}
    (templates/('qualification-'+name+'.unauthorized.json')).write_text(json.dumps(r,indent=2)+'\n')

companion_files = ['native-event-ingestion-blocked-stop.journey.ts','playwright-native-ingestion-blocked-stop.config.ts','fixtures/native-ingestion-blocked-stop-authority.ts','fixtures/native-ingestion-blocked-stop-clock.ts','fixtures/native-ingestion-blocked-stop-db.ts','fixtures/native-ingestion-blocked-stop-protocol.mjs','fixtures/native-ingestion-blocked-stop-protocol.test.mjs','fixtures/native-ingestion-blocked-stop-validate.mjs','fixtures/native-ingestion-blocked-stop.md','fixtures/native-ingestion-h5.mjs','fixtures/native-ingestion-h5.md']
prior_prep = json.loads(Path('/private/tmp/native-ingestion-h5e-source-prep/source-equivalence.json').read_text())['checks']['companion']
companion_release = {'schema':'paperclip.native-ingestion.blocked-stop-root-release.v1','authorized':False,'stage':'qualification-b0','outputRoot':'/home/ubuntu/native-ingestion/evidence/blocked-stop-v4/series','orchestratorSha256':files['native-ingestion-run-blocked-stop-v4.mjs']['sha256'],'h5HelperFile':'/home/ubuntu/native-ingestion/helpers/native-ingestion-h5c-cf-build-guards.mjs','h5HelperSha256':files['native-ingestion-h5c-cf-build-guards.mjs']['sha256'],'harnessRoot':'/home/ubuntu/native-ingestion/harness-blocked-stop-v4','harnessRevision':freeze['drivers'][1]['revision'],'inheritedH5cRevision':'e431ec63d41fe90c6fd68bd2fc2bb969feeca917','lockSha256':sha(COMPANION/'pnpm-lock.yaml'),'companionFiles':{file:sha(COMPANION/'tests/e2e'/file) for file in companion_files},'workloadSha256':prior_prep['workloadSha256'],'precisionRuleSha256':prior_prep['precisionRuleSha256'],'resourceWatchdogMillis':1800000,'runtimeChecks':checks,'perVariantBuilds':{'B0':descriptors['builds']['B0']},'priorStageReports':{},'noiseReports':{},'runtimeProvenance':runtime_provenance,'guardProvenance':guard_provenance,'releasePending':'UNAUTHORIZED source template. No qualification or timing arm has run on this driver.'}
(templates/'companion-v4-qualification-b0.unauthorized.json').write_text(json.dumps(companion_release,indent=2)+'\n')
print(json.dumps({'templates':4,'allAuthorized':False,'runtimeLabels':sorted(checks),'guardExpiry':guard['newExpiry'],'companionHashes':len(companion_release['companionFiles'])}))
