"""Calibrate the independent oracle with correct and deliberately broken deliveries."""
import importlib.util
import pathlib
import stat
import socket
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("oracle", pathlib.Path(__file__).with_name("everyday-artifact.py"))
oracle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(oracle)

GOOD = '''import argparse,re
def slugify(text): return re.sub(r'[^a-z0-9]+','-',text.strip().lower()).strip('-')
if __name__ == '__main__':
 p=argparse.ArgumentParser();p.add_argument('text');p.add_argument('--separator',choices=['-','_'],default='-');p.add_argument('--max-length',type=int)
 a=p.parse_args()
 if a.max_length is not None and a.max_length<=0:p.error('positive length required')
 value=slugify(a.text).replace('-',a.separator)
 if a.max_length is not None:value=value[:a.max_length].rstrip(a.separator)
 print(value)
'''

class ArtifactOracleTests(unittest.TestCase):
    def grade(self, source=GOOD, mode='base', extras=None):
        with tempfile.TemporaryDirectory() as tmp:
            archive=pathlib.Path(tmp)/'project.zip'
            with zipfile.ZipFile(archive,'w') as z:
                z.writestr('project/slugify.py',source)
                z.writestr('project/README.md','Usage: python3 slugify.py "Hello World"')
                # Deliberately passing but useless agent-authored tests must not determine our verdict.
                z.writestr('project/test_slugify.py','assert True')
                for name,content in (extras or {}).items():z.writestr(name,content)
            return oracle.inspect(archive,mode)

    def test_correct_delivery_passes_all_modes(self):
        for mode in ['base','separator','max-length']:
            with self.subTest(mode=mode):self.assertTrue(all(c['passed'] for c in self.grade(mode=mode)))

    def test_wrong_output_fails_despite_agent_tests(self):
        checks=self.grade(GOOD.replace("print(value)","print('hello-world')"))
        self.assertFalse(all(c['passed'] for c in checks))

    def test_missing_late_requirement_fails(self):
        source=GOOD.replace("if a.max_length is not None:value=value[:a.max_length].rstrip(a.separator)","if False:pass")
        self.assertFalse(all(c['passed'] for c in self.grade(source,'max-length')))

    def test_trailing_separator_bug_fails(self):
        checks=self.grade(GOOD.replace(".rstrip(a.separator)",""),'max-length')
        self.assertFalse(next(c['passed'] for c in checks if c['id']=='length-6'))

    def test_invalid_separator_bug_fails(self):
        checks=self.grade(GOOD.replace("choices=['-','_'],", ""),'separator')
        self.assertFalse(next(c['passed'] for c in checks if c['id']=='reject-invalid-separator'))

    def test_artifact_cannot_read_host_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            marker=pathlib.Path(tmp)/'host-private-marker';marker.write_text('private fixture')
            prefix=f"import pathlib\nassert not pathlib.Path({str(marker)!r}).exists(), 'host filesystem is visible'\n"
            self.assertTrue(all(c['passed'] for c in self.grade(prefix+GOOD)))

    def test_artifact_cannot_reach_host_loopback(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1',0));server.listen(64)
            port=server.getsockname()[1]
            prefix=f"import socket\ns=socket.socket();s.settimeout(0.2)\nassert s.connect_ex(('127.0.0.1',{port})) != 0, 'host network is visible'\ns.close()\n"
            self.assertTrue(all(c['passed'] for c in self.grade(prefix+GOOD)))

    def test_artifact_cannot_modify_the_read_only_delivery(self):
        prefix="import pathlib\ntry: pathlib.Path(__file__).write_text('changed')\nexcept OSError: pass\nelse: raise AssertionError('project is writable')\n"
        self.assertTrue(all(c['passed'] for c in self.grade(prefix+GOOD)))

    def test_generated_output_is_bounded(self):
        with self.assertRaisesRegex(ValueError, 'output limit'):
            self.grade("print('x'*1000000)")

    def test_duplicate_source_fails(self):
        self.assertFalse(all(c['passed'] for c in self.grade(extras={'other/slugify.py':GOOD})))

    def test_path_traversal_is_rejected_before_execution(self):
        for name in ['../escape','/absolute','back\\slash']:
            with self.subTest(name=name),self.assertRaisesRegex(ValueError,'Unsafe archive'):
                self.grade(extras={name:'bad'})

    def test_symlink_is_rejected(self):
        member=zipfile.ZipInfo('link');member.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaisesRegex(ValueError,'Unsafe archive'):
            self.grade(extras={member:'/tmp/target'})

if __name__=='__main__':unittest.main()
