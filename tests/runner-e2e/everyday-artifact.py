"""Independent acceptance oracle. Never runs the project's own test assertions."""
import argparse, json, os, pathlib, stat, subprocess, sys, tempfile, zipfile

BASE_CASES = [("Hello World", "hello-world"), ("  Queue--Ready!!  ", "queue-ready"),
              ("Already-Fine", "already-fine"), ("Café 東京", "caf"), ("!!!", ""),
              ("a__b  c", "a-b-c"), ("123", "123"), ("", "")]

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
        env={k:os.environ[k] for k in ['PATH','SYSTEMROOT'] if k in os.environ}
        env.update(HOME=str(root),TMPDIR=str(root),PYTHONDONTWRITEBYTECODE='1')
        def invoke(args):
            return subprocess.run([sys.executable,str(source),*args],cwd=source.parent,env=env,capture_output=True,text=True,timeout=10)
        for index,(text,expected) in enumerate(BASE_CASES):
            result=invoke([text]);check(f"base-{index}",result.returncode==0 and result.stdout.rstrip('\r\n')==expected,
                                     f"exit={result.returncode}; expected={expected!r}; observed={result.stdout[:160]!r}")
        # Import from the delivered module, not an evaluator reimplementation.
        imported=subprocess.run([sys.executable,'-c',"from slugify import slugify; assert slugify(' A B! ') == 'a-b'"],cwd=source.parent,env=env,capture_output=True,text=True,timeout=10)
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
    parser=argparse.ArgumentParser();parser.add_argument('archive');parser.add_argument('--mode',choices=['base','separator','max-length'],default='base');args=parser.parse_args()
    try:checks=inspect(args.archive,args.mode)
    except Exception as error:checks=[dict(id='artifact-readable',passed=False,detail=str(error))]
    print(json.dumps(dict(passed=all(c['passed'] for c in checks),checks=checks)))
    sys.exit(0 if all(c['passed'] for c in checks) else 1)
