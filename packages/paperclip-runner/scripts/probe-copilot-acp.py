"""Run the pinned real Copilot binary against a deterministic loopback model.
No credentials are inherited; COPILOT_OFFLINE disables provider network access.
This proves a protocol fixture, never GitHub/model/Daytona qualification.
"""
import argparse,json,subprocess,tempfile,pathlib,os,select,time,threading,http.server,hashlib,shutil,contextlib,sys
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--package-root',required=True)
parser.add_argument('--comparison-version',choices=['1.0.89'],help='Explicit offline comparison only; production remains pinned to 1.0.88')
parser.add_argument('--scenario',choices=['deny-write','deny-shell','deny-read','attached-shell','detached-shell','discover-inputs','native-question','native-plan'],default='deny-write')
parser.add_argument('--mode',choices=['agent','plan','autopilot'],default='agent')
resume_group=parser.add_mutually_exclusive_group()
resume_group.add_argument('--resume',action='store_true',help='Close and load the same native session before prompting')
resume_group.add_argument('--restart',action='store_true',help='SIGKILL and replace the provider after one allowed seed mutation; load and verify no replay')
parser.add_argument('--tool-policy-node',help='Apply the repository tool policy before native permission dispatch using this Node 24 binary')
args=parser.parse_args()
if args.tool_policy_node and args.scenario!='detached-shell':parser.error('--tool-policy-node requires detached-shell')
package_root=pathlib.Path(args.package_root).resolve()
metadata=json.loads((package_root/'package.json').read_text())
pins={'@github/copilot-darwin-arm64':'a9ff8babb10b7e443182ae96a8bc50a9c826ef1c773e1344c396eb5bf7f512c3','@github/copilot-darwin-x64':'85eb919f6b9b9dd833ce5e326cbf974b3ee2d4a9ac525c59d4ec9c9ec085715b','@github/copilot-linux-x64':'0059754cf78c3f3bf2c9d4564dfa7e9e25f3a3f8f411f2f0cdad9363f5662748'}
if args.comparison_version:pins={'@github/copilot-darwin-arm64':'97c12874d9adb9738374a9fb8a52cd724b81132ff815140f7e017bac706feba7'}
assert metadata['version']==(args.comparison_version or '1.0.88') and metadata['name'] in pins
assert not (package_root/'copilot').is_symlink()
assert hashlib.sha256((package_root/'copilot').read_bytes()).hexdigest()==pins[metadata['name']]
model_tool_names=[]
model_tool_results=[]
model_tool_schemas={}
command='sleep 2; printf ACP_SHELL_DONE > settlement.txt'

binary=str(package_root/'copilot')
def stop_process(process):
 # Cleanup must still reap a child whose stdin broke or which ignores TERM.
 try:
  if process.stdin:process.stdin.close()
 except OSError:pass
 try:
  process.terminate()
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
 finally:
  for stream in (process.stdout,process.stderr):
   if stream:stream.close()

with contextlib.ExitStack() as cleanup:
 root=pathlib.Path(tempfile.mkdtemp(prefix='paperclip-copilot-offline-'))
 cleanup.callback(shutil.rmtree, root)
 calls=0
 total_model_calls=0
 session=None
 seeding=False
 seed_command='printf X >> replay-count.txt'
 final_prompt_id=None
 outside=root.parent/(root.name+'-protected.txt')
 outside.write_text('PRIVATE_FIXTURE_SENTINEL')
 cleanup.callback(outside.unlink,missing_ok=True)
 tool_name={'deny-write':'create','deny-shell':'bash','deny-read':'view','attached-shell':'bash','detached-shell':'bash','native-question':'ask_user','native-plan':'exit_plan_mode'}.get(args.scenario)
 tool_arguments={'deny-write':{'path':str(root/'denied.txt'),'file_text':'MUST NOT EXIST'},'deny-shell':{'command':'printf MUST_NOT_EXIST > denied.txt','description':'Denied command fixture'},'deny-read':{'path':str(outside)},'attached-shell':{'command':command,'description':'Bounded settlement fixture','mode':'async','detach':False},'detached-shell':{'command':command,'description':'Bounded detached settlement fixture','mode':'async','detach':True},'native-question':{'question':'Choose one','choices':['A','B'],'allowFreeform':False},'native-plan':{'summary':'Fixture plan','planContent':'Do fixture work'}}.get(args.scenario)
 marker_at_prompt_result=False
 policy_rejection=None
 class PolicyRejected(Exception):pass
 class Handler(http.server.BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def do_GET(self):
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'data':[{'id':'gpt-4.1','object':'model','owned_by':'fixture'}]}).encode())
  def do_POST(self):
   global calls,total_model_calls,model_tool_names,model_tool_results,model_tool_schemas
   calls+=1
   total_model_calls+=1
   data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))))
   model_tool_names=sorted(set(model_tool_names+[x.get('function',{}).get('name') for x in data.get('tools',[]) if x.get('function',{}).get('name')]))
   for tool in data.get('tools',[]):
    function=tool.get('function',{})
    if function.get('name') in ('bash','read_bash','write_bash','stop_bash','task','powershell','write_powershell','read_powershell'):model_tool_schemas[function['name']]=function
   model_tool_results.extend(x.get('content') for x in data.get('messages',[]) if x.get('role')=='tool')
   if total_model_calls>6:raise RuntimeError('Fixture model exceeded its bounded request count')
   if data.get('stream'):
    self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
    values=[{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','content':'Fixture complete.'},'finish_reason':None}]},{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':3,'total_tokens':13}}]
    selected_tool='bash' if seeding else tool_name
    selected_arguments={'command':seed_command,'description':'Single non-replayed seed mutation'} if seeding else tool_arguments
    if calls==1 and selected_tool:values=[{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{'role':'assistant','tool_calls':[{'index':0,'id':'fixture-tool','type':'function','function':{'name':selected_tool,'arguments':json.dumps(selected_arguments)}}]},'finish_reason':None}]},{'id':'fixture-1','object':'chat.completion.chunk','choices':[{'index':0,'delta':{},'finish_reason':'tool_calls'}]}]
    for value in values:self.wfile.write(('data: '+json.dumps(value)+'\n\n').encode())
    self.wfile.write(b'data: [DONE]\n\n')
   else:
    self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(json.dumps({'id':'fixture-1','object':'chat.completion','choices':[{'index':0,'message':{'role':'assistant','content':'Fixture complete.'},'finish_reason':'stop'}],'usage':{'prompt_tokens':10,'completion_tokens':3,'total_tokens':13}}).encode())
 server=http.server.HTTPServer(('127.0.0.1',0),Handler)
 cleanup.callback(server.server_close)
 threading.Thread(target=server.serve_forever,daemon=True).start()
 cleanup.callback(server.shutdown)
 env={'PATH':'/usr/bin:/bin','HOME':str(root/'home'),'XDG_CONFIG_HOME':str(root/'config'),'XDG_CACHE_HOME':str(root/'cache'),'XDG_DATA_HOME':str(root/'data'),'COPILOT_HOME':str(root/'copilot'),'COPILOT_CACHE_HOME':str(root/'copilot-cache'),'COPILOT_ALLOW_ALL':'false','COPILOT_PKG_CACHE_HOME':str(root/'extract'),'COPILOT_AUTO_UPDATE':'false','COPILOT_OFFLINE':'true','COPILOT_PROVIDER_BASE_URL':f'http://127.0.0.1:{server.server_port}','COPILOT_PROVIDER_TYPE':'openai','COPILOT_PROVIDER_MODEL_ID':'gpt-4.1','COPILOT_MODEL':'gpt-4.1','NO_COLOR':'1'}
 for key in ('HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','COPILOT_HOME','COPILOT_CACHE_HOME','COPILOT_PKG_CACHE_HOME'):pathlib.Path(env[key]).mkdir()
 (root/'copilot/config.json').write_text(json.dumps({'trustedFolders':[],'disableAllHooks':True,'memory':False,'ide':{'autoConnect':False}}))
 launch=[binary,'--acp','--stdio','--no-auto-update','--disable-builtin-mcps','--no-remote','--no-remote-export','--no-bash-env']
 p=subprocess.Popen(launch,env=env,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 cleanup.callback(stop_process, p)
 responses={};wire=[];permission_responses=[];buf={p.stdout:b'',p.stderr:b''};nextid=0;marker_at_prompt_result=False

 def pump(wait=1):
  global policy_rejection
  for stream in select.select([p.stdout,p.stderr],[],[],wait)[0]:
   data=os.read(stream.fileno(),65536)
   if not data:continue
   buf[stream]+=data
   while b'\n' in buf[stream]:
    line,buf[stream]=buf[stream].split(b'\n',1)
    if not line:continue
    if stream==p.stderr:continue
    message=json.loads(line);wire.append(message)
    if args.tool_policy_node and message.get('method')=='session/update':
     checked=subprocess.run([args.tool_policy_node,str(pathlib.Path(__file__).with_name('probe-copilot-tool-policy.mjs'))],input=json.dumps(message['params']['update']),text=True,capture_output=True,timeout=5,env={'PATH':'/usr/bin:/bin'})
     if checked.returncode:
      if checked.returncode!=42 or checked.stdout.strip()!='COPILOT_DETACHED_WORK_UNSUPPORTED':raise RuntimeError('Repository tool policy probe failed unexpectedly')
      policy_rejection=checked.stdout.strip()
      p.terminate();p.wait(timeout=5)
      raise PolicyRejected(policy_rejection)
    if 'id' in message and 'method' not in message:responses[message['id']]=message
    if message.get('method')=='session/request_permission':
     requested_command=message['params'].get('toolCall',{}).get('rawInput',{}).get('command')
     allow=(args.scenario in ('attached-shell','detached-shell') and requested_command==command) or (seeding and requested_command==seed_command)
     reject=next((o for o in message['params']['options'] if o['kind']==('allow_once' if allow else 'reject_once')),None)
     outcome={'outcome':'selected','optionId':reject['optionId']} if reject else {'outcome':'cancelled'}
     permission_responses.append({'id':message['id'],'outcome':outcome})
     p.stdin.write((json.dumps({'jsonrpc':'2.0','id':message['id'],'result':{'outcome':outcome}})+'\n').encode());p.stdin.flush()

 def request(method,params):
  global nextid
  nextid+=1;n=nextid;p.stdin.write((json.dumps({'jsonrpc':'2.0','id':n,'method':method,'params':params})+'\n').encode());p.stdin.flush();deadline=time.monotonic()+30
  while n not in responses and time.monotonic()<deadline:pump()
  if n not in responses:raise TimeoutError(method)
  return responses[n]
 try:
  initialize_params={'protocolVersion':1,'clientCapabilities':{'_meta':{'github.com/copilot':{'events':['session.idle','session.plan_changed','session.background_tasks_changed','session.completion_receipt','user_input.requested','exit_plan_mode.requested','assistant.usage']}}},'clientInfo':{'name':'paperclip-offline-fixture','version':'1'}}
  request('initialize',initialize_params)
  session=request('session/new',{'cwd':str(root),'mcpServers':[]})
  if 'result' in session:
   session_id=session['result']['sessionId']
   if args.mode!='agent':
    request('session/set_mode',{'sessionId':session_id,'modeId':'https://agentclientprotocol.com/protocol/session-modes#'+args.mode})
   if args.resume or args.restart:
    # A native session with no conversation is not durably resumable.
    seeding=args.restart
    calls=0 if seeding else -1
    request('session/prompt',{'sessionId':session_id,'prompt':[{'type':'text','text':'Initialize the fixture conversation.'}]})
    seeding=False
    calls=0
    if args.restart:
     assert (root/'replay-count.txt').read_text()=='X', 'Seed mutation did not execute exactly once'
     p.kill();p.wait(timeout=5);stop_process(p)
     p=subprocess.Popen(launch,env=env,cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
     cleanup.callback(stop_process,p)
     buf={p.stdout:b'',p.stderr:b''}
     request('initialize',initialize_params)
    else:request('session/close',{'sessionId':session_id})
    session=request('session/load',{'sessionId':session_id,'cwd':str(root),'mcpServers':[]})
   if 'error' in session:raise RuntimeError('Copilot rejected session load')
   final_prompt_id=nextid+1
   request('session/prompt',{'sessionId':session_id,'prompt':[{'type':'text','text':'Reply with Fixture complete.'}]})
   marker_at_prompt_result=(root/('settlement.txt' if args.scenario in ('attached-shell','detached-shell') else 'denied.txt')).exists()
   if args.scenario=='detached-shell':
    # Observe the bounded child after terminal; never turn a late marker into success.
    observation_deadline=time.monotonic()+3
    while time.monotonic()<observation_deadline:pump(.1)
   else:
    for _ in range(3):pump(.1)
 except PolicyRejected:
  # No permission response was sent. Wait past the fixture delay to prove no effect.
  time.sleep(3)
 finally:
  failure=sys.exc_info()[1]
  try:
   marker_exists=(root/('settlement.txt' if args.scenario in ('attached-shell','detached-shell') else 'denied.txt')).exists()
   report={'schema':'paperclip.copilot-acp-evidence/v1','harnessVersion':metadata['version'],'package':metadata['name'],'executableSha256':pins[metadata['name']],'modelSource':'deterministic loopback fixture, COPILOT_OFFLINE=true; not a live model qualification','scenario':args.scenario,'toolPolicyScope':'repository tool-update admission only' if args.tool_policy_node else None,'toolPolicyRejection':policy_rejection,'mode':args.mode,'resumed':args.resume or args.restart,'providerKilledAndReplaced':args.restart,'replayMutationCount':len((root/'replay-count.txt').read_text()) if (root/'replay-count.txt').exists() else None,'costUsd':0,'filesystemMarkerExistedAtPromptResult':marker_at_prompt_result,'filesystemMarkerExistedAfterPrompt':marker_exists,'modelCalls':total_model_calls,'modelToolNames':model_tool_names,'modelToolSchemas':model_tool_schemas,'modelToolResults':model_tool_results,'permissionResponses':permission_responses,'wire':wire}
   serialized=json.dumps(report,indent=2).replace(str(root),'/fixture/workspace').replace(str(root).lstrip('/'),'fixture/workspace').replace(binary,'/fixture/verified/copilot')
   print(serialized)
  except Exception:
   if failure is None:raise

 if args.tool_policy_node:
  assert policy_rejection=='COPILOT_DETACHED_WORK_UNSUPPORTED' and not permission_responses and not marker_exists, 'Detached policy failed to prevent native side effects'
  sys.exit(0)

 if not session or 'result' not in session or responses.get(final_prompt_id,{}).get('result',{}).get('stopReason')!='end_turn':
  raise RuntimeError('Copilot did not complete the fixture turn')
 if marker_at_prompt_result != (args.scenario in ('attached-shell','detached-shell')) or marker_exists != marker_at_prompt_result:
  raise RuntimeError('Copilot violated the fixture filesystem expectation')

 if args.scenario.startswith('deny-') and not permission_responses:
  raise RuntimeError('Copilot did not request permission before the denied operation')
 if args.scenario=='deny-read' and any('PRIVATE_FIXTURE_SENTINEL' in str(result) for result in model_tool_results):
  raise RuntimeError('Copilot leaked the denied file to the model')
 if args.scenario in ('native-question','native-plan','discover-inputs') and any(name in model_tool_names for name in ('ask_user','exit_plan_mode')):
  raise RuntimeError('Native blocking input is advertised without a qualified responder')

 if args.scenario in ('native-question','native-plan') and not any("Tool '"+str(tool_name)+"' does not exist" in str(result) for result in model_tool_results):
  raise RuntimeError('Forced native input did not prove explicit tool unavailability')

 if args.restart and (root/'replay-count.txt').read_text()!='X':
  raise RuntimeError('Provider restart replayed or lost a seed mutation')
