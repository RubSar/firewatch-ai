from remote_zip import RemoteZip
from pathlib import Path,PurePosixPath
from datetime import datetime,timezone
import hashlib,json,zipfile

root=Path('data/caldor-ir-v2026.2');root.mkdir(parents=True,exist_ok=False)
d=json.loads(Path('discovery/zenodo-latest.json').read_bytes());asset=d['files'][0]
reader=RemoteZip(asset['links']['self'],asset['size']);records=[]
with zipfile.ZipFile(reader) as z:
    members=[x for x in z.infolist() if
             (x.filename.startswith('v2026.2/kml/Caldor_2021_') and x.filename.endswith('.kml'))
             or x.filename in ['v2026.2/data_term_of_use.md','v2026.2/LICENSE','v2026.2/DATA_LICENSES/NIFC.txt','v2026.2/CHANGELOG.md']]
    assert sum(x.filename.endswith('.kml') for x in members)==21
    for info in members:
        if info.file_size>1_000_000:raise ValueError('Unexpected subset file size')
        body=z.read(info) # zipfile verifies each member CRC-32
        path=PurePosixPath(info.filename)
        if '..' in path.parts or path.is_absolute():raise ValueError('Unsafe ZIP member')
        relative=Path(*path.parts[1:]);target=root/relative
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(body)
        records.append({'path':relative.as_posix(),'archive_member':info.filename,'bytes':len(body),
                        'sha256':hashlib.sha256(body).hexdigest(),'zip_crc32':f'{info.CRC:08x}','zip_crc32_verified':True})
        print(relative, len(body),flush=True)
manifest={'schema_version':'firewatch.research.ir-source-subset.v1','retrieved_at_utc':datetime.now(timezone.utc).isoformat(),
          'source_doi':d['doi'],'source_record_id':d['id'],'version':d['metadata']['version'],'archive':asset,
          'whole_archive_checksum_verified':False,'range_response_bytes':reader.total,'range_requests':reader.requests,
          'files':records,'selection':'All 21 dated Caldor IR KMLs plus terms, NIFC license, archive license and changelog. Excludes MTBS KML, HDF5 and external executables.',
          'collector_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'range_reader_sha256':hashlib.sha256(Path('remote_zip.py').read_bytes()).hexdigest()}
(root/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
print('DOWNLOADED',reader.total,'range bytes')
