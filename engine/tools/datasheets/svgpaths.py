import re, sys, json
import xml.etree.ElementTree as ET
NS='{http://www.w3.org/2000/svg}'
def mat(t):
    if not t: return (1,0,0,1,0,0)
    m=re.match(r'matrix\(([^)]*)\)',t)
    if m: return tuple(float(x) for x in re.split(r'[ ,]+',m.group(1).strip()))
    m=re.match(r'translate\(([^)]*)\)',t)
    if m:
        v=[float(x) for x in re.split(r'[ ,]+',m.group(1).strip())]; return (1,0,0,1,v[0],v[1] if len(v)>1 else 0)
    raise ValueError(t)
def mul(a,b):
    return (a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5])
def ap(m,x,y): return (m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5])
def flatten(d):
    toks=re.findall(r'[MLCZ]|-?[\d.]+(?:e-?\d+)?',d)
    subs=[];cur=[];i=0;cmd=None
    while i<len(toks):
        t=toks[i]
        if t in 'MLCZ':
            cmd=t;i+=1
            if t=='Z':
                if cur: cur.append(cur[0])
                continue
            if t=='M':
                if len(cur)>1: subs.append(cur)
                cur=[]
            continue
        if cmd in 'ML':
            cur.append((float(toks[i]),float(toks[i+1])));i+=2
        elif cmd=='C':
            p0=cur[-1];p=[(float(toks[i+k]),float(toks[i+k+1])) for k in (0,2,4)];i+=6
            for s in range(1,9):
                u=s/8;a=(1-u)**3;b=3*u*(1-u)**2;c=3*u*u*(1-u);e=u**3
                cur.append((a*p0[0]+b*p[0][0]+c*p[1][0]+e*p[2][0],a*p0[1]+b*p[0][1]+c*p[1][1]+e*p[2][1]))
    if len(cur)>1: subs.append(cur)
    return subs
def paths(svgfile):
    root=ET.parse(svgfile).getroot()
    out=[]
    def walk(el,m,indefs):
        tag=el.tag.replace(NS,'')
        if tag=='defs': return
        m2=mul(m,mat(el.get('transform')))
        if tag=='path' and el.get('d'):
            st=el.get('style','') ; 
            attrs={k:el.get(k) for k in ('stroke','fill','stroke-width')}
            subs=[[ap(m2,x,y) for x,y in s] for s in flatten(el.get('d'))]
            out.append(dict(attrs=attrs,subs=subs))
        for c in el: walk(c,m2,indefs)
    walk(root,(1,0,0,1,0,0),False)
    return out
if __name__=='__main__':
    ps=paths(sys.argv[1])
    for k,p in enumerate(ps):
        pts=[q for s in p['subs'] for q in s]
        if not pts: continue
        xs=[q[0] for q in pts];ys=[q[1] for q in pts]
        print(k,len(p['subs']),len(pts),'bbox %.1f %.1f %.1f %.1f'%(min(xs),min(ys),max(xs),max(ys)),p['attrs'])
