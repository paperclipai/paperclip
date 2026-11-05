import fs from 'node:fs/promises';
import path from 'node:path';
import postgres from '/home/ubuntu/native-ingestion/paperclip/packages/db/node_modules/postgres/src/index.js';
const out=process.argv[2], exitFile=process.argv[3];
if(!out?.startsWith('/tmp/'))throw Error('Owned diagnostic output required');
const dir=path.join(out,'profile'), end=Date.now()+16*60_000;
await fs.mkdir(out,{recursive:true});
const save=(name,v)=>fs.writeFile(path.join(out,name),JSON.stringify(v,null,2)+'\n');
const append=(name,v)=>fs.appendFile(path.join(out,name),JSON.stringify(v)+'\n');
let client, metadata, dataDirectory, inspection, socket, seq=0, focusedStartedAt, focusedStopped=false;
const requests=new Map();
async function rpc(method,params={}){
 const id=++seq;let timer;
 try{return await Promise.race([new Promise((resolve,reject)=>{requests.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(method+' timed out')),5000);})]);}
 finally{clearTimeout(timer);requests.delete(id);}
}
let nextPg=0, nextMarker=0;
const receipt={diagnosticOnly:true,performanceAcceptanceEligible:false,startedAt:new Date().toISOString(),focusedCpuSeconds:30,sql:'Read-only external connection, activity/locks/count snapshots, 3-second statement limits; no query parameters/credentials logged',overhead:'Additional PG diagnostics and an app-only focused CPU profiler; excluded from acceptance'};
try{
 while(Date.now()<end){
  try{await fs.access(exitFile);break;}catch{}
  let files=[];try{files=await fs.readdir(dir);}catch{}
  if(!metadata){const file=files.find(x=>/^app-\d+\.metadata\.json$/.test(x));if(file)metadata=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));}
  if(metadata&&!client&&Date.now()>=nextPg){
   try{const config=JSON.parse(await fs.readFile(metadata.configPath,'utf8'));dataDirectory=config.database.embeddedPostgresDataDir;if(!dataDirectory.includes('/paperclip-e2e-home-'))throw Error('Wrong fixture directory');await fs.access(path.join(dataDirectory,'postmaster.pid'));client=postgres({host:'127.0.0.1',port:config.database.embeddedPostgresPort??54329,user:'paperclip',password:'paperclip',database:'paperclip',max:1,connect_timeout:3,idle_timeout:30,connection:{application_name:'native_ingestion_diagnostic_only_observer',default_transaction_read_only:'on',statement_timeout:'3000'}});const cluster=await client.unsafe("select current_setting('data_directory') as directory,current_setting('transaction_read_only') as read_only");if(cluster[0].directory!==dataDirectory||cluster[0].read_only!=='on')throw Error('Wrong/readwrite fixture');receipt.cluster={directory:dataDirectory,readOnly:true};}
   catch(error){await append('pg-live.ndjson',{at:Date.now(),connectError:String(error)});if(client){await client.end({timeout:1});client=undefined;}nextPg=Date.now()+10000;}
  }
  if(client&&Date.now()>=nextPg){
   const sample={at:Date.now(),diagnosticOnly:true};
   try{sample.activity=await client.unsafe("select pid,application_name,state,wait_event_type,wait_event,extract(epoch from clock_timestamp()-xact_start) as transaction_age_seconds,left(query,1000) as query from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()");sample.locks=await client.unsafe("select pid,locktype,relation::regclass::text as relation,mode,granted,pg_blocking_pids(pid) as blockers from pg_locks where pid<>pg_backend_pid()");sample.counts=await client.unsafe("select run_id,event_type,payload->'prpEvent'->>'eventType' as prp_event_type,count(*)::int as rows,max(source_seq) as maximum_source_seq from heartbeat_run_events group by run_id,event_type,payload->'prpEvent'->>'eventType'");}
   catch(error){sample.error=String(error);}
   await append('pg-live.ndjson',sample);nextPg=Date.now()+10000;
  }
  if(metadata&&!socket&&!focusedStopped){
   const file=files.find(x=>/^app-\d+\.inspector\.json$/.test(x));
   if(file){inspection=JSON.parse(await fs.readFile(path.join(dir,file),'utf8'));if(inspection.pid!==metadata.pid||!/^ws:\/\/127\.0\.0\.1:\d+\//.test(inspection.url))throw Error('Wrong inspector');socket=new WebSocket(inspection.url);await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Inspector open timed out')),5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',reject,{once:true});});socket.addEventListener('message',e=>{const v=JSON.parse(e.data);const req=requests.get(v.id);if(req)v.error?req.reject(Error(JSON.stringify(v.error))):req.resolve(v.result);});await rpc('Profiler.enable');receipt.inspectorPid=inspection.pid;}
  }
  if(socket&&!focusedStartedAt&&!focusedStopped&&Date.now()>=nextMarker){
   for(const file of files.filter(x=>/^provider-\d+\.ndjson$/.test(x))){const handle=await fs.open(path.join(dir,file),'r');let buffer=Buffer.alloc(4096);let read;try{read=await handle.read(buffer,0,buffer.length,0);}finally{await handle.close();}const text=buffer.subarray(0,read.bytesRead).toString();if(text.includes('"markerCode":"0c"')){await rpc('Profiler.start');focusedStartedAt=Date.now();receipt.focusedStartedAtMs=focusedStartedAt;receipt.trigger='First provider-observer markerCode0c, the fixed100-run case foreground';await save('independent-observer-receipt.json',receipt);break;}}
   nextMarker=Date.now()+1000;
  }
  if(socket&&focusedStartedAt&&!focusedStopped&&Date.now()-focusedStartedAt>=30000){const result=await rpc('Profiler.stop');await fs.mkdir(path.join(dir,'cpu'),{recursive:true});await save('profile/cpu/focused-100-run-app.cpuprofile',result.profile);receipt.focusedStoppedAtMs=Date.now();receipt.focusedProfileComplete=true;focusedStopped=true;socket.close();socket=undefined;await save('independent-observer-receipt.json',receipt);}
  await new Promise(r=>setTimeout(r,1000));
 }
}catch(error){receipt.error=String(error);}
finally{if(client)await client.end({timeout:1});if(socket)socket.close();receipt.finishedAt=new Date().toISOString();await save('independent-observer-receipt.json',receipt);}
console.log(JSON.stringify(receipt));
