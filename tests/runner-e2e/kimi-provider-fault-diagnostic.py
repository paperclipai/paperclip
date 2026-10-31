import base64,hashlib,importlib.util,json,os,re,sys
from pathlib import Path
sys.dont_write_bytecode=True
EXPECTED_SOURCE_SHA256='585494ff2f10125c98c4102df5b6b6dba643de6c92266186711695b1e993efe6'

def run(fault,config,allow_signal):
 state={'schema':'paperclip.kimi11.remote-fault-diagnostic.v1','qualification':False,'stage':'inspect','status':'FAIL','failingGuard':None,'errno':None,'signalAttempted':False,'signalDispatched':False,'receipt':None,'externalModelCalls':0}
 original_signal=getattr(fault.signal,'pidfd_send_signal',None);original_inspect=fault.inspect;original_open=getattr(fault.os,'pidfd_open',None);inspections=0
 def inspect(config):
  nonlocal inspections
  inspections+=1;state['stage']='inspect_before' if inspections==1 else 'inspect_held'
  result=original_inspect(config)
  if inspections>1:state['stage']='pidfd_identity'
  return result
 def pidfd_open(pid):
  state['stage']='pidfd_open'
  return original_open(pid)
 def signal(fd,sig,info=None,flags=0):
  state['stage']='signal';state['signalAttempted']=True;state['signalDispatched']=None
  result=original_signal(fd,sig,info,flags);state['signalDispatched']=True;state['stage']='receipt';return result
 fault.inspect=inspect
 if original_signal is not None:fault.signal.pidfd_send_signal=signal
 if original_open is not None:fault.os.pidfd_open=pidfd_open
 try:
  if allow_signal:
   state['stage']='terminate';state['receipt']=fault.terminate(config)
  else:state['receipt']=fault.inspect(config)
  state['status']='PASS';state['stage']='complete'
 except OSError as e:state['errno']=e.errno;state['failingGuard']=None
 except RuntimeError as e:
  value=e.args[0] if len(e.args)==1 and isinstance(e.args[0],str) else ''
  code=value.removeprefix('kimi_provider_fault:') if value.startswith('kimi_provider_fault:') else ''
  state['failingGuard']=code if code in ALLOWED_GUARDS else 'unknown_guard'
 except Exception:pass
 finally:
  fault.inspect=original_inspect
  if original_signal is not None:fault.signal.pidfd_send_signal=original_signal
  if original_open is not None:fault.os.pidfd_open=original_open
 return state

ALLOWED_GUARDS=frozenset(['ancestry', 'ancestry_birth', 'ancestry_changed', 'argv_bound', 'boot_changed', 'bootstrap_template', 'closure_bound', 'closure_inventory', 'closure_metadata', 'closure_path', 'closure_pin', 'closure_shape', 'config_keys', 'cwd', 'dead_or_invalid_process', 'digest_shape', 'executable', 'file_bound', 'file_changed', 'file_realpath', 'file_shape', 'file_writable', 'guard_template', 'identity_changed_after_pidfd', 'input_bound', 'native_bootstrap_bytes', 'native_executable', 'native_guard_bytes', 'native_title', 'not_worker', 'parent_bootstrap', 'parent_descriptor_changed', 'parent_descriptor_shape', 'parent_directory_descriptor', 'parent_memfd_required', 'parent_memfd_seals', 'parent_node', 'parent_node_descriptor', 'parent_node_path', 'parent_source_pipe', 'pidfd_open', 'pidfd_required', 'pidfd_retired', 'pidfd_send_signal', 'process_bound', 'required_entries', 'root_binding', 'root_changed', 'root_flag', 'root_session', 'runner_changed', 'runner_executable', 'runner_shape', 'snapshot_digest', 'snapshot_path', 'snapshot_seal', 'stat_pid', 'unique_native_child'])

if __name__=='__main__':
 from types import ModuleType
 result={'schema':'paperclip.kimi11.remote-fault-diagnostic.v1','qualification':False,'stage':'input','status':'FAIL','failingGuard':None,'errno':None,'signalAttempted':False,'signalDispatched':False,'receipt':None,'externalModelCalls':0}
 try:
  if len(sys.argv)!=3 or len(sys.argv[1])>131072 or len(sys.argv[2])>131072:raise ValueError()
  source=base64.b64decode(sys.argv[1],validate=True)
  if hashlib.sha256(source).hexdigest()!=EXPECTED_SOURCE_SHA256:raise ValueError()
  fault=ModuleType('kimi_fault_diagnostic_original');exec(compile(source,'<pinned-kimi-fault-original>','exec'),fault.__dict__)
  config=json.loads(base64.b64decode(sys.argv[2],validate=True));result=run(fault,config,True)
 except Exception:pass
 print(json.dumps(result,separators=(',',':')));sys.exit(0 if result['status']=='PASS' else 1)
