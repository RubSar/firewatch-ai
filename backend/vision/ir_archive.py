"""Bounded read-only range access; no whole-archive checksum claim."""
import io,hashlib
from urllib.request import Request,urlopen

class RemoteZip(io.RawIOBase):
    def __init__(self,url,size):
        self.url=url;self.size=size;self.pos=0;self.total=0;self.requests=[];self.etag=None
    def seekable(self):return True
    def readable(self):return True
    def tell(self):return self.pos
    def seek(self,offset,whence=0):
        self.pos=offset if whence==0 else self.pos+offset if whence==1 else self.size+offset
        if not 0<=self.pos<=self.size:raise ValueError('Seek outside source')
        return self.pos
    def read(self,n=-1):
        if n<0:n=self.size-self.pos
        n=min(n,self.size-self.pos)
        if not n:return b''
        if n>30_000_000 or self.total+n>80_000_000:raise ValueError('Bounded archive transfer exceeded')
        start=self.pos;end=start+n-1
        req=Request(self.url,headers={'User-Agent':'FireWatchResearch/0.1','Range':f'bytes={start}-{end}','Accept-Encoding':'identity'})
        with urlopen(req,timeout=45) as r:
            if r.status!=206 or r.headers.get('Content-Range')!=f'bytes {start}-{end}/{self.size}':
                raise ValueError('Server must honor exact range; no full download fallback')
            etag=r.headers.get('ETag')
            if self.etag is not None and etag!=self.etag:raise ValueError('Archive changed between reads')
            self.etag=etag
            body=r.read(n+1)
            if len(body)!=n:raise ValueError('Incomplete range')
            self.requests.append({'start':start,'end':end,'bytes':len(body),'etag':r.headers.get('ETag'),
                                  'sha256':hashlib.sha256(body).hexdigest()})
        self.pos+=n;self.total+=n;return body
