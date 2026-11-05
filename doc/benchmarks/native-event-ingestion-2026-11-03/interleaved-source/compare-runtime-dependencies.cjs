const {execFileSync}=require('node:child_process');
const {createHash}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const cwd=process.argv[2];
if (!cwd || !path.isAbsolute(cwd)) throw new Error('Pass an absolute repository checkout');
const YAML=require(path.join(cwd,'node_modules/.pnpm/yaml@2.9.1/node_modules/yaml/dist/index.js'));
const refs={before:process.argv[3],after:process.argv[4]};
if (!Object.values(refs).every(value => /^[a-f0-9]{40}$/.test(value))) throw new Error('Pass two immutable full commit IDs');
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const get=(ref,path)=>execFileSync('git',['show',ref+':'+path],{cwd,encoding:'utf8',maxBuffer:20*1024*1024});
const docs=Object.fromEntries(Object.entries(refs).map(([key,ref])=>[key,YAML.parse(get(ref,'pnpm-lock.yaml'))]));
function resolve(d,name,version){let key=name+'@'+version;if(d.snapshots[key])return key;key=key.replace(/\(patch_hash=[^)]+\)/g,'');if(d.snapshots[key])return key;throw new Error('Unresolved '+key);}
function graph(d,roots){const out={};function add(key){if(out[key])return;const snapshot=d.snapshots[key];const base=key.replace(/\(.*/,'');out[key]={snapshot,package:d.packages[base]??null};for(const [name,version] of Object.entries({...snapshot.dependencies,...snapshot.optionalDependencies})){if(version.startsWith('link:'))continue;add(resolve(d,name,version));}}roots.forEach(k=>add(k));return out;}
const details={};for(const [label,d]of Object.entries(docs)){
 const imports={};for(const importer of ['.','packages/db','server']){const i=d.importers[importer];imports[importer]={};for(const cat of ['dependencies','devDependencies','optionalDependencies'])for(const name of ['drizzle-orm','postgres','pg','embedded-postgres','tsx','drizzle-kit'])if(i?.[cat]?.[name])imports[importer][name]={category:cat,...i[cat][name]};}
 const db=d.importers['packages/db'];const roots=['drizzle-orm','postgres','embedded-postgres'].map(n=>resolve(d,n,db.dependencies[n].version));const tsx=resolve(d,'tsx',db.devDependencies.tsx.version);const pg=Object.keys(d.snapshots).find(x=>/^pg@8\.18\.0\(/.test(x))??'pg@8.18.0';
 const runtime=graph(d,roots);const launcher=graph(d,[tsx]);const pgGraph=graph(d,[pg]);
 const parents=Object.entries(d.snapshots).filter(([_,s])=>s.dependencies?.['get-tsconfig']||s.optionalDependencies?.['get-tsconfig']).map(([key,s])=>({key,version:s.dependencies?.['get-tsconfig']??s.optionalDependencies['get-tsconfig']}));
 details[label]={imports,roots,tsx,pg,runtime,launcher,pgGraph,getTsconfigParents:parents};
}
function diff(a,b){return {removed:Object.keys(a).filter(k=>!b[k]),added:Object.keys(b).filter(k=>!a[k]),changed:Object.keys(a).filter(k=>b[k]&&JSON.stringify(a[k])!==JSON.stringify(b[k]))};}
const comparisons={};for(const name of ['runtime','launcher','pgGraph'])comparisons[name]={nodeCounts:[Object.keys(details.before[name]).length,Object.keys(details.after[name]).length],...diff(details.before[name],details.after[name])};
const sourcePaths=['packages/db/src/run-event-payload.ts','server/src/services/native-runtime/canonical.ts','packages/db/src/client.ts','patches/postgres@3.4.9.patch','patches/embedded-postgres@18.1.0-beta.16.patch'];const sources={};for(const p of sourcePaths){try{sources[p]=Object.fromEntries(Object.entries(refs).map(([k,v])=>[k,hash(get(v,p))]));}catch(e){sources[p]={error:String(e)}}}
const toolingEdges=Object.fromEntries(Object.entries(docs).map(([label,d])=>[label,Object.entries(d.snapshots).filter(([_,x])=>x.dependencies?.['@esbuild-kit/esm-loader']).map(([key,x])=>({key,esmLoader:x.dependencies['@esbuild-kit/esm-loader']}))]));
const result={refs,comparisons,details,toolingEdges,sources,patchConfigEqual:get(refs.before,'package.json')===get(refs.after,'package.json'),limits:'Static locked dependency-graph and immutable source comparison; installed bits, OS and Node versions remain experiment provenance requirements.'};
if (!process.argv[5]) throw new Error('Pass a new output JSON path');
fs.writeFileSync(process.argv[5],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({comparisons,toolingEdges,imports:details.after.imports,getTsconfigParents:Object.fromEntries(Object.entries(details).map(([k,v])=>[k,v.getTsconfigParents])),sources,patchConfigEqual:result.patchConfigEqual},null,2));
