"""Record prospective candidate-neutral source and actual pure-check evidence."""
from pathlib import Path
import datetime,hashlib,json

ROOT=Path(__file__).parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
composition=json.loads((ROOT/'composition.json').read_text())
checks=json.loads((ROOT/'checks/receipt.json').read_text());assert checks['passed']and checks['greenTests']==91
parent=Path(composition['parentPacketFile']);assert sha(parent)==composition['parentPacketSha256']
compatibility=Path('/private/tmp/native-ingestion-candidate-registration-compatibility.json')
assert compatibility.exists(),'Read the explorer compatibility report before finalizing this packet'
json.loads(compatibility.read_text())
def row(file):return{'path':str(file.relative_to(ROOT)),'bytes':file.stat().st_size,'sha256':sha(file)}
sources=[row(file)for file in sorted(ROOT.rglob('*'))if file.is_file()and file.name!='source-packet.json'and'checks'not in file.relative_to(ROOT).parts]
evidence=[row(file)for file in sorted((ROOT/'checks').rglob('*'))if file.is_file()]
packet={'schema':'paperclip.native-ingestion.h5e-v4-helper-source-packet.v4','generatedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceOnly':True,'executionReleased':False,'servingQualification':False,'performanceAcceptance':False,'owningApplicationProviderDatabaseBrowserVmStagingNetworkOrBuildExecution':False,'parentPacket':{'file':str(parent),'sha256':sha(parent),'unchanged':True},'frozenDrivers':json.loads(parent.read_text())['frozenDrivers'],'candidateRegistration':{'currentlyRegisteredSourceRevision':composition['currentlyRegisteredCandidateRevision'],'futureCandidateRegistered':False,'authority':composition['candidateSourceAuthority'],'qualifiedCandidateDescriptorIncluded':False,'registerBeforeFirstCandidateComparison':True,'retargetCompletedCandidateComparisons':False,'noNewRustOptimizationAssumed':True},'compatibilityReview':{'file':str(compatibility),'sha256':sha(compatibility),'mainV3ControlsMayContinueUnchanged':True,'oldCompanionQualificationOrNoiseReusableWithNewHelper':False,'newCompanionB0FunctionalQualificationRequiredBeforeCompanionAa':True},'preservedExperiment':'Frozen drivers, comparator, workload/oracle/timers/SLA/gap/control/durable rules/stage order/five pairs/four wins/noise/thresholds/runtime checks/inventory comparisons/arm seal set unchanged.','helpers':[{key:item[key]for key in ['file','bytes','sha256','parent','parentSha256']}for item in composition['clones']],'sourceFiles':sources,'verificationFiles':evidence,'reviewPatchSha256':sha(ROOT/'review.patch'),'checksReceiptSha256':sha(ROOT/'checks/receipt.json'),'checks':{'commands':len(checks['commands']),'greenTests':checks['greenTests'],'expectedRedFailures':2,'existingComparatorCli':checks['existingComparatorChecks']},'openGates':['Peer/root review before any companion A/A','One new companion V4 B0 functional qualification with v4 dependency/orchestrator identity after quiet boundary','Fresh companion A/A controls and fixed noise before any new optimization','Actual candidate release registration and qualification before unstarted comparisons','Original application performance/correctness/live/cloud Stop acceptance'],'historicalDataAndCurrentV3MainRunUnchanged':True}
assert sha(ROOT/'candidate-registration-compatibility.json')==sha(compatibility)
packet['compatibilityReview']['retainedCopy']='candidate-registration-compatibility.json'
(ROOT/'source-packet.json').write_text(json.dumps(packet,indent=2)+'\n')
print(json.dumps({'packetSha256':sha(ROOT/'source-packet.json'),'patchSha256':packet['reviewPatchSha256'],'sourceFiles':len(sources),'verificationFiles':len(evidence)}))
