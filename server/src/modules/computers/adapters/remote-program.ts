/** Fixed remote program. Inputs travel as JSON, never interpolated into Python or shell. */
export const remoteProgram = String.raw`
import os,sys,json,hashlib,base64,tempfile,subprocess,fcntl,stat,shutil
p=json.load(sys.stdin)
def fail(code):
 print(json.dumps({'error':code}));sys.exit(0)
def digest(data):return hashlib.sha256(data).hexdigest()
def run(args,cwd=None):
 r=subprocess.run(args,cwd=cwd,capture_output=True,text=True)
 if r.returncode:fail('command_failed')
 return r.stdout.strip()
root=p['root']
if not root.startswith('/home/user/paperclip/') or '..' in root.split('/'):fail('invalid')
# Reject symlinks even in existing ancestors; one Unix user is not an OS boundary.
def safe(path):
 if not isinstance(path,str) or path.startswith('/') or '\x00' in path or '..' in path.split('/'):fail('invalid')
 current=root
 for part in path.split('/'):
  if part in ('','.'):continue
  current=os.path.join(current,part)
  if os.path.islink(current):fail('invalid')
 if os.path.commonpath([root,os.path.realpath(current)])!=root:fail('invalid')
 return current
current='/'
for part in root.split('/'):
 if not part:continue
 current=os.path.join(current,part)
 if os.path.islink(current):fail('invalid')
act=p['action']
if act=='owned-port':
 port=p['port'];owner=p['ownerId'];inodes=set()
 for table in ['/proc/net/tcp','/proc/net/tcp6']:
  for line in open(table).readlines()[1:]:
   cols=line.split()
   if int(cols[1].split(':')[1],16)==port and cols[3]=='0A':inodes.add(cols[9])
 for pid in os.listdir('/proc'):
  if not pid.isdigit():continue
  try:
   if 'paperclip-'+owner+'.slice' not in open('/proc/'+pid+'/cgroup').read():continue
   for fd in os.listdir('/proc/'+pid+'/fd'):
    target=os.readlink('/proc/'+pid+'/fd/'+fd)
    if target.startswith('socket:[') and target[8:-1] in inodes:print('{}');sys.exit(0)
  except (FileNotFoundError,PermissionError,ProcessLookupError):pass
 fail('conflict')
if act=='seed':
 if os.path.exists(root):print(json.dumps({'seeded':False}));sys.exit(0)
 os.makedirs(os.path.dirname(root),exist_ok=True)
 temp=tempfile.mkdtemp(prefix='.seed-',dir=os.path.dirname(root))
 try:
  for name,value in p['files'].items():
   dest=safe(name);relative=os.path.relpath(dest,root)
   if relative=='.':fail('invalid')
   target=os.path.join(temp,relative);os.makedirs(os.path.dirname(target),exist_ok=True)
   with open(target,'wb') as f:f.write(base64.b64decode(value,validate=True))
  try:os.rename(temp,root);result=True
  except FileExistsError:result=False
  print(json.dumps({'seeded':result}))
 finally:
  if os.path.exists(temp):shutil.rmtree(temp)
 sys.exit(0)
if act=='workspace':
 os.makedirs(root,exist_ok=True)
 repo=p.get('repositoryUrl');branch=p.get('branch');task=p.get('taskId');base_ref=p.get('baseRef')
 if base_ref and (base_ref.startswith('-') or '\n' in base_ref):fail('invalid')
 checkout=os.path.join(root,'checkout')
 if repo:
  if not (repo.startswith('https://') or repo.startswith('ssh://') or repo.startswith('git@')) or '\n' in repo:fail('invalid')
  if not os.path.exists(checkout):run(['git','clone','--',repo,checkout])
  elif run(['git','remote','get-url','origin'],checkout)!=repo:fail('conflict')
 else:
  os.makedirs(checkout,exist_ok=True)
  if not os.path.isdir(os.path.join(checkout,'.git')):run(['git','init',checkout])
 if branch:
  if branch.startswith('-') or '\n' in branch:fail('invalid')
  run(['git','check-ref-format','--branch',branch])
 if p.get('mode')=='worktree':
  if not task:fail('invalid')
  target=os.path.join(root,'tasks',task);os.makedirs(os.path.dirname(target),exist_ok=True)
  if not os.path.exists(target):run(['git','worktree','add','-b','paperclip/'+task,target,base_ref or branch or 'HEAD'],checkout)
  run(['git','rev-parse','--show-toplevel'],target)
 else:
  target=checkout
  if branch:run(['git','checkout',branch],checkout)
 print(json.dumps({'remoteCwd':target}));sys.exit(0)
# Hold directory descriptors throughout each operation. Ancestor symlink swaps cannot
# redirect a checked pathname outside the selected placement.
def directory(parts,create=False,start=None):
 fd=os.dup(start) if start is not None else os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in parts:
   if not part or part=='.':continue
   if part=='..':fail('invalid')
   try:nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   except FileNotFoundError:
    if not create:raise
    try:os.mkdir(part,0o700,dir_fd=fd)
    except FileExistsError:pass
    nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
   os.close(fd);fd=nxt
  return fd
 except BaseException:os.close(fd);raise
try:rootfd=directory(root.split('/'))
except FileNotFoundError:fail('not_found')
except OSError:fail('invalid')
def parent(relative,create=False):
 safe(relative)
 parts=[part for part in relative.split('/') if part not in ('','.')]
 if not parts:fail('invalid')
 return directory(parts[:-1],create,rootfd),parts[-1]
path=p.get('path','');safe(path)
lock=os.open('.paperclip-editor.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600,dir_fd=rootfd)
fcntl.flock(lock,fcntl.LOCK_EX)
try:
 if act=='list':
  fd=directory(path.split('/'),start=rootfd)
  try:
   out=[]
   for entry in os.scandir(fd):
    if entry.name=='.paperclip-editor.lock' or entry.is_symlink():continue
    info=entry.stat(follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode) and not stat.S_ISREG(info.st_mode):continue
    out.append({'name':entry.name,'kind':'directory' if stat.S_ISDIR(info.st_mode) else 'file','size':info.st_size,'mtimeMs':info.st_mtime*1000})
   print(json.dumps(out))
  finally:os.close(fd)
 elif act=='read':
  parentfd,name=parent(path)
  try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parentfd)
  finally:os.close(parentfd)
  with os.fdopen(fd,'rb') as f:
   st=os.fstat(f.fileno())
   if not stat.S_ISREG(st.st_mode) or st.st_size>p.get('maxBytes',16*1024*1024):fail('invalid')
   data=f.read(p.get('maxBytes',16*1024*1024)+1)
  if len(data)>p.get('maxBytes',16*1024*1024):fail('invalid')
  print(json.dumps({'base64':base64.b64encode(data).decode(),'sha256':digest(data)}))
 elif act in ('write','remove','move'):
  parentfd,name=parent(path,create=act=='write')
  try:
   old=None
   try:fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW,dir_fd=parentfd)
   except FileNotFoundError:fd=None
   if fd is not None:
    with os.fdopen(fd,'rb') as f:
     if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):fail('invalid')
     h=hashlib.sha256()
     while True:
      block=f.read(65536)
      if not block:break
      h.update(block)
     old=h.hexdigest()
   if old!=p.get('expectedSha256'):fail('conflict')
   if act=='write':
    data=base64.b64decode(p['base64'],validate=True)
    if len(data)>16*1024*1024:fail('invalid')
    import secrets
    temp='.paperclip-write-'+secrets.token_hex(16)
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=parentfd)
    try:
     with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
     os.replace(temp,name,src_dir_fd=parentfd,dst_dir_fd=parentfd)
    finally:
     try:os.unlink(temp,dir_fd=parentfd)
     except FileNotFoundError:pass
    print(json.dumps({'sha256':digest(data)}))
   elif act=='remove':
    if old is None:fail('not_found')
    os.unlink(name,dir_fd=parentfd);print('{}')
   else:
    if old is None:fail('not_found')
    targetfd,target=parent(p['to'],create=True)
    try:
     try:os.link(name,target,src_dir_fd=parentfd,dst_dir_fd=targetfd,follow_symlinks=False)
     except FileExistsError:fail('conflict')
     os.unlink(name,dir_fd=parentfd)
    finally:os.close(targetfd)
    print(json.dumps({'sha256':old}))
  finally:os.close(parentfd)
 else:fail('invalid')
except FileNotFoundError:fail('not_found')
except OSError:fail('invalid')
finally:os.close(lock);os.close(rootfd)
`;
