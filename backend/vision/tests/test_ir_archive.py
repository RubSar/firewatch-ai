import copy,io
from pathlib import Path
import sys,unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from ir_archive import RemoteZip
from fetch_ir_reference import validate_manifest


class Response(io.BytesIO):
    def __init__(self,body,status=206,content_range='bytes 2-4/10',etag='one'):
        super().__init__(body);self.status=status;self.headers={'Content-Range':content_range,'ETag':etag}


class ArchiveTests(unittest.TestCase):
    def test_exact_range_and_bounds(self):
        r=RemoteZip('https://zenodo.org/example',10);r.seek(2)
        with patch('ir_archive.urlopen',return_value=Response(b'234')) as opened:
            self.assertEqual(r.read(3),b'234');self.assertEqual(r.tell(),5)
            self.assertEqual(opened.call_args.args[0].get_header('Range'),'bytes=2-4')
        with self.assertRaises(ValueError):r.seek(-1)
        self.assertEqual(r.read(0),b'')
    def test_full_download_fallback_rejected(self):
        r=RemoteZip('https://zenodo.org/example',10)
        with patch('ir_archive.urlopen',return_value=Response(b'0123456789',status=200)):
            with self.assertRaisesRegex(ValueError,'exact range'):r.read(10)
    def test_archive_change_rejected(self):
        r=RemoteZip('https://zenodo.org/example',10);r.etag='prior'
        with patch('ir_archive.urlopen',return_value=Response(b'012',content_range='bytes 0-2/10',etag='new')):
            with self.assertRaisesRegex(ValueError,'changed'):r.read(3)
    def test_oversized_read_rejected_before_network(self):
        r=RemoteZip('https://zenodo.org/example',100_000_000)
        with patch('ir_archive.urlopen') as opened:
            with self.assertRaisesRegex(ValueError,'Bounded'):r.read(40_000_000)
            opened.assert_not_called()
    def test_manifest_paths_duplicates_and_host(self):
        m={'archive':{'size':100,'links':{'self':'https://zenodo.org/api/records/1/files/example.zip/content'}},
           'files':[{'path':'kml/one.kml','archive_member':'v1/kml/one.kml','sha256':'a'*64,'bytes':10}]}
        validate_manifest(m)
        for bad in ('../outside','C:/outside','..\\outside'):
            x=copy.deepcopy(m);x['files'][0]['path']=bad
            with self.assertRaisesRegex(ValueError,'Unsafe'):validate_manifest(x)
        x=copy.deepcopy(m);x['files']*=2
        with self.assertRaisesRegex(ValueError,'Duplicate'):validate_manifest(x)
        x=copy.deepcopy(m);x['archive']['links']['self']='https://example.com/data'
        with self.assertRaisesRegex(ValueError,'Zenodo'):validate_manifest(x)


if __name__=='__main__':unittest.main()
