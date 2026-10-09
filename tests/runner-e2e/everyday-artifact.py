"""Independent acceptance oracle. Never runs the project's own test assertions."""
import argparse, json, os, pathlib, selectors, stat, subprocess, sys, tempfile, time, uuid, zipfile

BASE_CASES = [("Hello World", "hello-world"), ("  Queue--Ready!!  ", "queue-ready"),
              ("Already-Fine", "already-fine"), ("Café 東京", "caf"), ("!!!", ""),
              ("a__b  c", "a-b-c"), ("123", "123"), ("", "")]

# Published multi-platform python:3.13-slim digest. Never pull implicitly during a model run.
SANDBOX_IMAGE = 'python@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285'

def preflight():
    for args in [['docker', 'version', '--format', '{{.Server.Version}}'],
                 ['docker', 'image', 'inspect', SANDBOX_IMAGE]]:
        result = subprocess.run(args, capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError(f'Artifact sandbox qualification failed. Start Docker and run: docker pull {SANDBOX_IMAGE}')

class ArtifactSandbox:
    """Only extracted delivery files enter the container. No host secrets or network."""
    def __init__(self, root, source):
        self.root = root
        self.cwd = '/project/' + str(source.parent.relative_to(root))
        self.source = '/project/' + str(source.relative_to(root))
        self.name = 'paperclip-artifact-oracle-' + uuid.uuid4().hex

    def __enter__(self):
        preflight()
        self.root.chmod(0o755)
        args = ['docker', 'run', '--detach', '--rm', '--pull=never', '--name', self.name,
                '--network=none', '--read-only', '--cap-drop=ALL',
                '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=128m',
                '--memory-swap=128m', '--cpus=1', '--user=65534:65534',
                '--log-driver=none', '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
                '--mount', f'type=bind,source={self.root},target=/project,readonly',
                '--workdir', self.cwd, SANDBOX_IMAGE, 'python', '-I', '-c',
                'import time; time.sleep(180)']
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=15)
            if result.returncode:
                raise RuntimeError('Artifact sandbox could not start: ' + result.stderr[:500])
        except BaseException:
            self.close()
            raise
        return self

    def close(self):
        subprocess.run(['docker', 'rm', '--force', self.name], capture_output=True, timeout=10)

    def __exit__(self, *unused):
        self.close()

    def invoke(self, args, *, imported=False):
        code = ['-c', "import sys; sys.path.insert(0, " + repr(self.cwd) + "); from slugify import slugify; assert slugify(' A B! ') == 'a-b'"] if imported else [self.source, *args]
        command = ['docker', 'exec', '--workdir', self.cwd, self.name, 'python', '-I', '-B', *code]
        # Bound output as it arrives. A generated program must not exhaust host memory or disk.
        proc = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        deadline = time.monotonic() + 10
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(proc.stdout, selectors.EVENT_READ, 'stdout')
                selector.register(proc.stderr, selectors.EVENT_READ, 'stderr')
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise ValueError('Artifact command exceeded the time limit')
                    for key, _ in selector.select(remaining):
                        chunk = os.read(key.fd, 4096)
                        if not chunk:
                            selector.unregister(key.fileobj)
                            continue
                        output[key.data].extend(chunk)
                        if sum(map(len, output.values())) > 65_536:
                            raise ValueError('Artifact command exceeded the output limit')
            code = proc.wait(timeout=max(0.01, deadline-time.monotonic()))
            return subprocess.CompletedProcess(command, code,
                output['stdout'].decode('utf-8', errors='replace'),
                output['stderr'].decode('utf-8', errors='replace'))
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.wait()
            proc.stdout.close()
            proc.stderr.close()

def inspect(archive, mode):
    checks = []
    def check(name, passed, detail=""):
        checks.append(dict(id=name, passed=bool(passed), detail=detail))
    with tempfile.TemporaryDirectory(prefix="paperclip-artifact-oracle-") as tmp:
        root=pathlib.Path(tmp)
        with zipfile.ZipFile(archive) as z:
            entries=z.infolist()
            if len(entries)>250 or sum(e.file_size for e in entries)>10_000_000:
                raise ValueError("Archive exceeds the bounded source project size")
            for entry in entries:
                p=pathlib.PurePosixPath(entry.filename)
                if p.is_absolute() or ".." in p.parts or "\\" in entry.filename or stat.S_ISLNK(entry.external_attr >> 16):
                    raise ValueError("Unsafe archive member")
            z.extractall(root)
        sources=list(root.rglob("slugify.py"))
        check("one-slugify-source",len(sources)==1)
        check("readme-present",any(p.name.lower().startswith('readme') for p in root.rglob('*')))
        check("project-tests-present",any(p.name.startswith('test') and p.suffix=='.py' for p in root.rglob('*')))
        if len(sources)!=1:return checks
        source=sources[0]
        with ArtifactSandbox(root, source) as sandbox:
            invoke = sandbox.invoke
            for index,(text,expected) in enumerate(BASE_CASES):
                result=invoke([text]);check(f"base-{index}",result.returncode==0 and result.stdout.rstrip('\r\n')==expected,
                                         f"exit={result.returncode}; expected={expected!r}; observed={result.stdout[:160]!r}")
            # Import from the delivered module, not an evaluator reimplementation.
            imported=invoke([], imported=True)
            check('importable-function',imported.returncode==0)
            if mode=='separator':
                for separator,expected in [('_','queue_ready'),('-','queue-ready')]:
                    result=invoke(['  Queue--Ready!!  ','--separator',separator]);check('separator-'+separator,result.returncode==0 and result.stdout.strip()==expected)
                check('reject-invalid-separator',invoke(['hello','--separator','/']).returncode!=0)
            if mode=='max-length':
                for size,expected in [('7','queue-r'),('6','queue'),('1','q')]:
                    result=invoke(['  Queue--Ready!!  ','--max-length',size]);check('length-'+size,result.returncode==0 and result.stdout.strip()==expected)
                check('reject-zero-length',invoke(['hello','--max-length','0']).returncode!=0)
    return checks

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('archive',nargs='?');parser.add_argument('--preflight',action='store_true');parser.add_argument('--mode',choices=['base','separator','max-length'],default='base');args=parser.parse_args()
    try:
        if args.preflight:
            preflight();checks=[dict(id='artifact-sandbox-ready',passed=True,detail='Pinned image available')]
        elif args.archive:checks=inspect(args.archive,args.mode)
        else:parser.error('archive is required unless --preflight is set')
    except Exception as error:checks=[dict(id='artifact-readable',passed=False,detail=str(error))]
    print(json.dumps(dict(passed=all(c['passed'] for c in checks),checks=checks)))
    sys.exit(0 if all(c['passed'] for c in checks) else 1)
