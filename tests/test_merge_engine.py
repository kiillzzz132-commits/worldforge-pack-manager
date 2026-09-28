import json
import tempfile
import unittest
from pathlib import Path

from worldforge_pack_manager.merge_engine import analyze, build_pack, sha1_file, smart_merge_json, validate_pack, zip_pack


class MergeEngineTests(unittest.TestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.root = Path(self.td.name)

    def tearDown(self):
        self.td.cleanup()

    def write_json(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def base_pack(self, name):
        p = self.root / name
        (p / "assets").mkdir(parents=True)
        self.write_json(p / "pack.mcmeta", {"pack": {"pack_format": 46, "description": name}})
        return p

    def test_font_provider_merge(self):
        a=self.root/'a.json'; b=self.root/'b.json'
        self.write_json(a,{"providers":[{"type":"bitmap","file":"x:a.png"}]})
        self.write_json(b,{"providers":[{"type":"bitmap","file":"x:b.png"}]})
        out=smart_merge_json(a,b,'font')
        self.assertEqual(len(out['providers']),2)

    def test_analyze_and_build(self):
        old=self.base_pack('old'); new=self.base_pack('new')
        (old/'assets/x/textures').mkdir(parents=True); (new/'assets/x/textures').mkdir(parents=True)
        (old/'assets/x/textures/a.txt').write_text('old',encoding='utf-8')
        (new/'assets/x/textures/a.txt').write_text('new',encoding='utf-8')
        self.write_json(old/'assets/x/font/default.json',{"providers":[{"file":"x:a.png"}]})
        self.write_json(new/'assets/x/font/default.json',{"providers":[{"file":"x:b.png"}]})
        report=analyze(old,new)
        self.assertGreaterEqual(report['counts']['conflicts'],1)
        self.assertGreaterEqual(report['counts']['smart_merged'],1)
        out=self.root/'out'
        result=build_pack(old,new,out,{"assets/x/textures/a.txt":"old"})
        self.assertTrue(result['validation']['valid'])
        self.assertEqual((out/'assets/x/textures/a.txt').read_text(),'old')
        merged=json.loads((out/'assets/x/font/default.json').read_text())
        self.assertEqual(len(merged['providers']),2)

    def test_zip_root_and_sha1(self):
        p=self.base_pack('pack'); z=self.root/'pack.zip'; zip_pack(p,z)
        self.assertEqual(len(sha1_file(z)),40)
        import zipfile
        with zipfile.ZipFile(z) as f:
            self.assertIn('pack.mcmeta',f.namelist())

    def test_validation_rejects_bad_json(self):
        p=self.base_pack('bad'); f=p/'assets/x/bad.json'; f.parent.mkdir(parents=True,exist_ok=True); f.write_text('{bad')
        self.assertFalse(validate_pack(p)['valid'])


if __name__ == '__main__':
    unittest.main()
