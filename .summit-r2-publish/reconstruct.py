"""One-time, hash-verified import of the approved standalone Summit R2 preview.
Only the preview index is written. Public source is read as inert bytes, never executed.
"""
from pathlib import Path
import base64, hashlib, io, json, struct, sys, zlib
from curl_cffi import requests
from PIL import Image

ROOT = Path(__file__).resolve().parent
TARGET = Path('summit-affiliate-preview/index.html')
FINAL = '135c930ee3939937d04795f09edd363c6c2a749174766f3d2272ff17424f2abb'
BASE = '9dd3ab67a530b11d67638880bb3a6015529d6b8c86edacbc7060d2729726a058'
NORMAL = 'b9c9fc52ecd2acaee8b16c04d33831a469a5f3059596eb3f1241059709885588'
PATCH = '6704d9872d501df2d44a834524ea764eb7e43171733b2a984892e6bdde0bc73d'
sha = lambda b: hashlib.sha256(b).hexdigest()
old = TARGET.read_bytes()
if sha(old) == FINAL:
    print('The approved R2 is already present.'); sys.exit(0)
assert sha(old) == BASE, 'Preview changed since approval; refusing to overwrite it.'
encoded = b''.join((ROOT / ('part%02d.b64' % i)).read_bytes().strip() for i in range(11))
assert sha(encoded) == PATCH, 'Patch transfer checksum mismatch.'
packed = zlib.decompress(base64.b64decode(encoded, validate=True))
assert packed[:4] == b'R2D2'

def download(url):
    response = requests.get(url, impersonate='chrome', timeout=60, headers={'Referer':'https://salesbysummit.com/portal'})
    response.raise_for_status()
    assert len(response.content) < 25000000, 'Unexpected source size.'
    return response.content

live = download('https://salesbysummit.com/portal')
print('Public design dictionary:', len(live), sha(live))
pos = 4
parts = []
missing = []
index = 0
while pos < len(packed):
    op = packed[pos]; pos += 1
    if op == 2:
        n = struct.unpack_from('<I', packed, pos)[0]; pos += 4
        assert n <= len(packed) - pos
        piece = packed[pos:pos+n]; pos += n
    else:
        assert op in (0, 1), 'Invalid patch opcode.'
        offset, n = struct.unpack_from('<II', packed, pos); pos += 8
        assert n <= 5000000
        if op == 0:
            assert offset+n <= len(old)
            piece = old[offset:offset+n]
        else:
            digest = packed[pos:pos+8]; anchor = packed[pos+8:pos+24]; pos += 24
            piece = live[offset:offset+n]
            if hashlib.sha256(piece).digest()[:8] != digest:
                found = False
                candidate = live.find(anchor)
                while candidate != -1:
                    test = live[candidate:candidate+n]
                    if hashlib.sha256(test).digest()[:8] == digest:
                        piece = test; found = True; break
                    candidate = live.find(anchor, candidate+1)
                if not found:
                    override = ROOT / ('override-%04d.b64' % index)
                    if override.exists():
                        piece = zlib.decompress(base64.b64decode(override.read_bytes()))
                        assert len(piece) == n and hashlib.sha256(piece).digest()[:8] == digest
                    else:
                        missing.append({'op':index,'offset':offset,'length':n,'sha8':digest.hex(),'anchor':base64.b64encode(anchor).decode()})
                        piece = b''
    parts.append(piece); index += 1
if missing:
    print('MISSING_FRAGMENTS=' + json.dumps(missing))
    sys.exit('Source differs; preview remains unchanged.')
normal = b''.join(parts)
assert sha(normal) == NORMAL, 'Reconstructed source checksum mismatch.'
assets = [
 ('6ab57ecad760da4bf39a2fc1.webp',(660,275),'2232549c80ef1cc9849b769669fb505513232ac7a5e35770ab3441dc2593e60e'),
 ('6ab57eca974a9da6eea76257.webp',(660,275),'c1fa26536d61d702e29ce744d79f2dec5c5029dbcb4dcba1dcbcbfbf0634bdbf'),
 ('6ab57ecab04308f7529ae2b6.webp',(660,275),'5e087dc8938afcf5498a61afbdf7c9e64416a53e03f1a3e58cda4de5955ef4b6'),
 ('6ab57ecacab050e11f59f6ce.webp',(660,275),'92678750d7f8c02ffd65636907e8def704ed6a25a1c06b5fb115cc3c7bd4ba44'),
 ('6ab57ecacab050e11f59f6c8.webp',(450,800),'a9ac8cb8065f733f58c4037576088955c1b2bc6db6e2292b497f908a586f43a8')
]
for i, (name, size, digest) in enumerate(assets):
    data = download('https://assets.cdn.filesafe.space/RFkxsdcGBcOfhviXJvpg/media/' + name)
    image = Image.open(io.BytesIO(data)).resize(size, Image.Resampling.LANCZOS)
    buf = io.BytesIO(); image.save(buf, 'WEBP', quality=83, method=6)
    data = buf.getvalue()
    assert sha(data) == digest, 'Image checksum mismatch: ' + str(i)
    normal = normal.replace(('__SUMMIT_R2_IMAGE_%d__' % i).encode(), b'data:image/webp;base64,' + base64.b64encode(data))
assert len(normal) == 3130786 and sha(normal) == FINAL, 'Final R2 checksum mismatch; nothing published.'
assert normal.lstrip().lower().startswith(b'<!doctype html>')
TARGET.write_bytes(normal)
print('Verified exact approved R2:', len(normal), sha(normal))
