"""Prospective source-only v4: bind candidate source through the exact root release."""
from pathlib import Path
import difflib,hashlib,json

ROOT=Path(__file__).parent
PARENT=Path('/private/tmp/native-ingestion-h5e-tools-v3')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
packet_file=PARENT/'source-packet.json'
assert sha(packet_file)=='caab406f96294313b9ab05ed4f26a083023cbb4d61075993cfbf9b8fc15129c7'
packet=json.loads(packet_file.read_text())
for key in ['sourceFiles','verificationFiles']:
    for row in packet[key]:assert sha(PARENT/row['path'])==row['sha256'],row['path']
changes=[]
def clone(name,replacements=()):
    source=PARENT/name;value=source.read_text();applied=[]
    for old,new in replacements:
        assert value.count(old)==1,(name,old,value.count(old))
        value=value.replace(old,new);applied.append({'old':old,'new':new,'count':1})
    destination=ROOT/name;destination.write_text(value)
    changes.append({'parent':str(source),'parentSha256':sha(source),'file':name,'sha256':sha(destination),'bytes':destination.stat().st_size,'replacements':applied})
    return sha(destination)
policy=[
 ("const B2_REVISION = '75b3578cfccf040b087a55a624e01baa2bca37f9';\n",''),
 ("    assert.equal(descriptor.revision, B2_REVISION, 'B2 must use the reviewed current TypeScript batching source revision');","    assert.ok(!Object.values(BASELINES).includes(descriptor.revision), 'B2 source cannot reuse a frozen B0/B1 baseline revision');"),
 ('B2 source75b3578 needs its own actual production-build receipt, isolated native target and qualified actual binary hash; native input equality does not imply cross-role artifact equality. No H5 VM execution is released by this file.','B2 needs a prospectively registered exact root-release source and its own actual production-build receipt, isolated native target and qualified actual binary hash; native input equality does not imply cross-role artifact equality. No H5 VM execution is released by this file.'),
]
main_sha=clone('native-ingestion-run-h5e-browser.mjs',policy)
dependency_sha=clone('native-ingestion-h5c-cf-build-guards.mjs',policy)
old_main=next(row['sha256']for row in packet['helpers']if row['file']=='native-ingestion-run-h5e-browser.mjs')
old_dependency=next(row['sha256']for row in packet['helpers']if row['file']=='native-ingestion-h5c-cf-build-guards.mjs')
for name in ['native-ingestion-h5e-linux-readiness.mjs','native-ingestion-h5e-full-linux-readiness.mjs','native-ingestion-linux-h5e-qualification.py']:
    clone(name,[(old_main,main_sha)])
for name in ['native-ingestion-extract-h5e-qualification-foreground.py','native-ingestion-validate-h5e-evidence.mjs']:clone(name)
clone('native-ingestion-run-blocked-stop-v4.mjs',[(old_dependency,dependency_sha)])
for name in ['generate_templates.py','runtime-checks.json','source-guards.test.mjs']:(ROOT/name).write_bytes((PARENT/name).read_bytes())
(ROOT/'composition.json').write_text(json.dumps({'schema':'native-ingestion-h5e-source-composition/v4','sourceOnly':True,'executionReleased':False,'parentPacketFile':str(packet_file),'parentPacketSha256':sha(packet_file),'candidateSourceAuthority':'Exact authorized root release perVariantBuilds.B2 descriptor and its actual qualified receipt; live Git/clean/build/native/inventory checks remain.','currentlyRegisteredCandidateRevision':'75b3578cfccf040b087a55a624e01baa2bca37f9','futureCandidateRegistered':False,'candidateTargetPolicy':'independent-in-both-input-modes','crossRoleArtifactEqualityRequired':False,'actualDifferentHashReviewRequiredBeforeTreatmentAcceptance':True,'clones':changes},indent=2)+'\n')
patch=''.join(''.join(difflib.unified_diff(Path(row['parent']).read_text().splitlines(True),(ROOT/row['file']).read_text().splitlines(True),fromfile=row['parent'],tofile=str(ROOT/row['file'])))for row in changes)
(ROOT/'review.patch').write_text(patch)
print(json.dumps({'clones':len(changes),'mainSha256':main_sha,'dependencySha256':dependency_sha,'patchSha256':sha(ROOT/'review.patch')}))
