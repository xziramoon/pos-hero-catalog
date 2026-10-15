import numpy as np
from PIL import Image, ImageFilter
def auto(im,size=512,fill=0.88,bg=(247,243,234)):
    sm=im.copy(); sm.thumbnail((320,320)); sm=sm.filter(ImageFilter.GaussianBlur(2.5))
    a=np.asarray(sm).astype(float); h,w,_=a.shape
    e=max(3,int(min(h,w)*0.04))
    edge=np.concatenate([a[:e].reshape(-1,3),a[-e:].reshape(-1,3),a[:,:e].reshape(-1,3),a[:,-e:].reshape(-1,3)])
    ref=np.median(edge,0); dist=np.sqrt(((a-ref)**2).sum(2))
    edist=np.sqrt(((edge-ref)**2).sum(1)); thr=max(28,np.percentile(edist,97)*1.6)
    sat=a.max(2)-a.min(2); esat=np.percentile(edge.max(1)-edge.min(1),97)
    mask=(dist>thr)|(sat>esat+40)
    mask=np.asarray(Image.fromarray((mask*255).astype('uint8')).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(5)))>0
    # keep the largest blob's bbox approx: use row/col projections
    ys,xs=np.where(mask)
    sx,sy=im.width/w,im.height/h
    cover=mask.mean()
    edge_busy=np.percentile(edist,90)>80 or np.median(edge.max(1)-edge.min(1))>55
    if len(xs)>60 and cover<0.6 and not edge_busy:
        x0,x1=np.percentile(xs,[0.5,99.5]); y0,y1=np.percentile(ys,[0.5,99.5]); pad=0.04*max(x1-x0,y1-y0)
        im=im.crop((int(max(0,x0-pad)*sx),int(max(0,y0-pad)*sy),int(min(w,x1+pad)*sx),int(min(h,y1+pad)*sy)))
    # tone: lift exposure equally on all channels so highlights reach ~240
    L=np.asarray(im.convert('L')).astype(float); p=np.percentile(L,97)
    if p<215:
        k=min(2.2,235/max(p,1)); im=Image.fromarray(np.clip(np.asarray(im).astype(float)*k,0,255).astype('uint8'))
    s=size*fill/max(im.size); im=im.resize((max(1,int(im.width*s)),max(1,int(im.height*s))),Image.LANCZOS)
    c=Image.new('RGB',(size,size),bg); c.paste(im,((size-im.width)//2,(size-im.height)//2)); return c
