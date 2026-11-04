import pathlib,json,base64,argparse,hashlib
def assert_history_prelude(case):
 pre=case['preludeProof']
 foreground=[v for v in case['durable'] if v['token']==case['nonce'] and v['markerCode']==case['markerCode']]
 clocks=[v for v in case['providerClocks'] if v['nonce']==case['nonce']]
 activation=[v for v in case['activations'] if v['index']==0 and v['token']==case['nonce']]
 authority=[v for v in case['controllerAuthority']['rows'] if v['run_id']==pre['runId']]
 assert len(foreground)==len(clocks)==len(activation)==len(authority)==1
 assert pre['runId']==foreground[0]['runId']==clocks[0]['runId'] and pre['runId'] in case['runIds']
 assert authority[0]['issue_id']==activation[0]['issueId']
 assert pre['individualDeltas']==1000 and pre['uniqueSourceIdentities']==1000
 assert pre['verifiedAtMs']<case['epochMs'] and pre['retainedGlobalHead']>=1000

p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--revision',required=True);p.add_argument('--full',action='store_true');a=p.parse_args();d=pathlib.Path(a.directory);r=json.loads((d/'playwright.json').read_text());attachments=[]
def visit(value):
 if isinstance(value,list):
  for child in value:visit(child)
 elif isinstance(value,dict):
  attachments.extend(item for item in value.get('attachments',[])if item.get('name')=='native-ingestion-evidence')
  for key,child in value.items():
   if key!='attachments':visit(child)
visit(r);assert len(attachments)==1,len(attachments);item=attachments[0]
raw=base64.b64decode(item['body'])if item.get('body')else pathlib.Path(item['path']).read_bytes();report=json.loads(raw);(d/'native-ingestion-evidence.json').write_bytes(raw)
assert report.get('complete')is True and not report.get('primaryFailure'),report.get('primaryFailure')
assert report['sourceRevision']==report['compiledBuildRevision']==a.revision
assert report['protocolVersion']=='v5c-independent-agents-complete-settlement-original-sla'
assert report['observationMode']=='h5c-observe-original-sla-independent-agents-settlement' and report['observationComplete'] is True
assert report['measurementSha256']=='7995ffdbf14b772e4c39444f6b89ba8684bcd86ef8ae866ffb0f5dbd89f35ccd'
assert report['transport']=='sandbox-remote-with-local-stop'
assert report['admissionProtocol']=='two-at-a-time-provider-and-clock-readiness-before-common-epoch'
assert report['setupActivationConcurrency']==2
assert report['harnessProvenance']['sourceRevision']=='73ea8516739e81fa7f37cd67651b4a2c73674014'
assert report['qualificationOnly']is(not a.full)
assert report['serverArtifact']=='compiled' and report.get('diagnosticOnly')is False
assert report['cleanup']=={'errors':[],'complete':True}
expected=['paced','burst16','burst128','burst512','existing-history','operator-stop']if a.full else['qualification','operator-stop'];assert [c['name']for c in report['cases']]==expected
ids=report['remote']['agentIds'];setup=report['remote']['agentSetup']
assert len(ids)==(100 if a.full else 3) and len(set(ids))==len(ids)
assert setup['complete'] is True and setup['concurrency']==8 and setup['count']==len(ids)
assert len(setup['attempts'])==len(ids) and all(x['status']=='fulfilled'for x in setup['attempts'])
assert all(ids[x['index']]==x['agentId']for x in setup['attempts'])
rows=[]
for case in report['cases']:
 stop=case['name']=='operator-stop';assert case['persistedAfterReload']is True
 assert case['setupActivationConcurrency']==2 and case['participants']==case['runs']
 assert sorted(x['index']for x in case['activations'])==list(range(case['runs']))
 assert all(x['status']=='fulfilled'for x in case['activations'])
 waves=case['activationWaves'];assert len(waves)==(case['runs']//2)
 assert all(1<=len(w['indices'])<=2 and w['statuses']==['fulfilled']*len(w['indices'])for w in waves)
 if not a.full and not stop:assert(case['runs'],case['events'],case['intervalMs'])==(3,16,25)
 assert len(case['durable'])==case['runs']==len(case['runIds'])
 if case['name']=='existing-history':
  assert_history_prelude(case)
 assert case['matchedVisibleClocks']==len(case['visible']) and len(case['visible'])>=(3 if stop else case['events'])
 authority=case['controllerAuthority'];assert authority['kind']==('host-file-journal'if stop else'database-controller-checkpoint')
 assert authority['observedReadOnly']=='on'and authority['observedIsolation']=='repeatable read'
 assert len(authority['rows'])==case['runs']and authority['connectionClosedAtMs']<case['epochMs']
 for proof in case['durable']:
  assert proof['matchedSourceClocks']==proof['individualDeltas']
  assert proof['uniqueSourceIdentities']==proof['individualDeltas']
  if not stop:assert proof['individualDeltas']==case['events']
 if stop:
  s=case['localStopProof'];db=s['database']['rows'][0]
  assert db['status']=='cancelled'and db['cancellation_dispatch_state']=='acknowledged'
  assert all(s['processes'][k]is True for k in['runnerAbsent','groupAbsent','providerAbsent'])
  assert s['lease']['releasedAt']and s['lease']['cleanupStatus']!='failed'
  if not db['process_pid']and not db['process_group_id']:assert int(db['process_stopped_seq'])>int(db['process_identity_seq'])
 else:
  assert len(set(x['agent_id']for x in case['controllerAuthority']['rows']))==case['runs']
  assert all(x['agent_id']in ids for x in case['controllerAuthority']['rows'])
  assert len(case['remoteLeases'])==case['runs']
  assert all(lease['releasedAt']and lease['cleanupStatus']=='success'for lease in case['remoteLeases'])
 rows.append({'name':case['name'],'runs':case['runs'],'eventsPerRun':case['events'],'visibleMarkers':len(case['visible']),'individualDeltas':sum(v['individualDeltas']for v in case['durable']),'sourceClocksMatched':sum(v['matchedSourceClocks']for v in case['durable']),'runIds':case['runIds'],'transport':case['transport'],'setupWaves':len(case['activationWaves']),'setupMs':case['allReadyObservedAtMs']-case['setupReadinessStartedAtMs'],'drainThroughTerminalMs':case['drainThroughTerminalMs']})
summary={'complete':True,'qualificationOnly':True,'performanceAcceptanceEligible':False,'sourceRevision':a.revision,'harnessRevision':report['harnessProvenance']['sourceRevision'],'reportSha256':hashlib.sha256(raw).hexdigest(),'fullFixture':a.full,'cases':rows,'cleanup':report['cleanup']};(d/'independent-qualification-check.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
