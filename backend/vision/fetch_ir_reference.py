"""Re-acquire a frozen public NIROPS subset; require every recorded file hash."""
import argparse
from datetime import datetime,timezone
from pathlib import Path,PurePosixPath
from urllib.parse import urlparse
import hashlib,json,zipfile

from ir_archive import RemoteZip


def validate_manifest(manifest):
    archive=manifest['archive'];url=archive['links']['self'];parsed=urlparse(url)
    if parsed.scheme!='https' or parsed.hostname!='zenodo.org' or not parsed.path.startswith('/api/records/'):
        raise ValueError('Expected a public Zenodo record asset')
    if not isinstance(archive['size'],int) or not 0<archive['size']<2_000_000_000:raise ValueError('Unbounded archive size')
    files=manifest['files']
    if not 1<=len(files)<=40 or sum(row['bytes'] for row in files)>30_000_000:raise ValueError('Unbounded subset')
    paths=[]
    for row in files:
        for name in (row['path'],row['archive_member']):
            p=PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name or ':' in name:raise ValueError('Unsafe archive path')
        if len(row['sha256'])!=64 or any(c not in '0123456789abcdef' for c in row['sha256']):raise ValueError('Invalid checksum')
        if not isinstance(row['bytes'],int) or not 0<=row['bytes']<=2_000_000:raise ValueError('Unbounded member')
        paths.append(row['path'])
    if len(paths)!=len(set(paths)):raise ValueError('Duplicate output paths')
    return url


def acquire(manifest_path,output):
    body=Path(manifest_path).read_bytes();manifest=json.loads(body);url=validate_manifest(manifest)
    out=Path(output)
    if out.exists():raise FileExistsError(out)
    out.mkdir(parents=True)
    reader=RemoteZip(url,manifest['archive']['size'])
    with zipfile.ZipFile(reader) as archive:
        names=[x.filename for x in archive.infolist()]
        if len(names)!=len(set(names)):raise ValueError('Duplicate archive members')
        for row in manifest['files']:
            member=archive.getinfo(row['archive_member'])
            if member.file_size!=row['bytes']:raise ValueError('Source size changed')
            data=archive.read(member)
            if hashlib.sha256(data).hexdigest()!=row['sha256']:raise ValueError('Source checksum changed')
            path=out/row['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    # Original evidence is retained verbatim, with new retrieval provenance separately.
    (out/'source-manifest.json').write_bytes(body)
    result={'retrieved_at_utc':datetime.now(timezone.utc).isoformat(),'source_manifest_sha256':hashlib.sha256(body).hexdigest(),
            'file_count':len(manifest['files']),'all_expected_sha256_verified':True,'whole_archive_checksum_verified':False,
            'range_response_bytes':reader.total,'range_requests':reader.requests}
    (out/'reacquisition.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
    print('Verified',len(manifest['files']),'files')


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('--output',required=True)
    a=p.parse_args();acquire(a.manifest,a.output)


if __name__=='__main__':main()
