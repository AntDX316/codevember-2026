# Takes the hidden inner parts (mouth bag, teeth, eye sockets, the cap under the shoulders) out of the three.js
# LeePerrySmith.glb and writes positions, normals, uvs and indices only, as head.glb.
# python3 clean-head.py LeePerrySmith.glb ../../../../../public/codevember/echo/dust/head.glb

import json,struct,sys
import numpy as np
def load(path):
  b=open(path,'rb').read()
  l=struct.unpack('<I',b[12:16])[0]
  j=json.loads(b[20:20+l]); bin_=b[20+l+8:]
  def acc(i):
    a=j['accessors'][i]; bv=j['bufferViews'][a['bufferView']]
    off=bv.get('byteOffset',0)+a.get('byteOffset',0)
    dt={5123:np.uint16,5126:np.float32}[a['componentType']]
    n={'SCALAR':1,'VEC3':3,'VEC2':2}[a['type']]
    return np.frombuffer(bin_,dt,a['count']*n,off).reshape(a['count'],n) if n>1 else np.frombuffer(bin_,dt,a['count'],off)
  return acc(0).reshape(-1,3).astype(int), acc(1), acc(2), acc(3)

import sys, json, struct


import numpy as np
I, P, N, UV = load(sys.argv[1])
par = list(range(len(P)))
def f(x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x
for a, b, c in I:
    par[f(a)] = f(b); par[f(b)] = f(c)
comp = np.array([f(t[0]) for t in I])
u, cnt = np.unique(comp, return_counts=True)
keep = np.zeros(len(I), bool)
for cn, uu in zip(cnt, u):
    m = comp == uu
    pts = P[I[m]].reshape(-1, 3)
    if cn > 10000: keep |= m            # the skin
    elif cn == 264: keep |= m          # the eyeballs
print('kept', keep.sum(), 'of', len(I))
I2 = I[keep]
used = np.unique(I2)
remap = -np.ones(len(P), int); remap[used] = np.arange(len(used))
I2 = remap[I2].astype(np.uint16).ravel()
P2 = P[used].astype(np.float32); N2 = N[used].astype(np.float32); UV2 = UV[used].astype(np.float32)
chunks = [I2.tobytes(), P2.tobytes(), N2.tobytes(), UV2.tobytes()]
views, off, binary = [], 0, b''
for c in chunks:
    while len(binary) % 4: binary += b'\0'
    views.append({'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(c)})
    binary += c
while len(binary) % 4: binary += b'\0'
j = {'asset': {'version': '2.0', 'generator': 'echo dust clean.py'},
     'buffers': [{'byteLength': len(binary)}], 'bufferViews': views,
     'accessors': [
         {'bufferView': 0, 'componentType': 5123, 'count': len(I2), 'type': 'SCALAR'},
         {'bufferView': 1, 'componentType': 5126, 'count': len(P2), 'type': 'VEC3', 'min': P2.min(0).tolist(), 'max': P2.max(0).tolist()},
         {'bufferView': 2, 'componentType': 5126, 'count': len(N2), 'type': 'VEC3'},
         {'bufferView': 3, 'componentType': 5126, 'count': len(UV2), 'type': 'VEC2'}],
     'meshes': [{'name': 'LeePerrySmith', 'primitives': [{'attributes': {'POSITION': 1, 'NORMAL': 2, 'TEXCOORD_0': 3}, 'indices': 0}]}],
     'nodes': [{'mesh': 0, 'name': 'LeePerrySmith'}], 'scenes': [{'nodes': [0]}], 'scene': 0}
js = json.dumps(j, separators=(',', ':')).encode()
while len(js) % 4: js += b' '
out = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(binary), 0x004E4942) + binary
open(sys.argv[2], 'wb').write(out)
print('wrote', len(out))
