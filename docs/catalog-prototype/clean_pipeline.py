import numpy as np, cv2
from PIL import Image
def clean(pil, size=512, fill=0.86, bg=(247,243,234)):
    img=cv2.cvtColor(np.asarray(pil),cv2.COLOR_RGB2BGR)
    h0,w0=img.shape[:2]; s=640/max(h0,w0); img=cv2.resize(img,(int(w0*s),int(h0*s)),interpolation=cv2.INTER_AREA) if s<1 else img
    h,w=img.shape[:2]
    # 1) rough box from colour distance to border colour
    blur=cv2.GaussianBlur(img,(0,0),3).astype(float); e=max(3,int(min(h,w)*0.04))
    edge=np.concatenate([blur[:e].reshape(-1,3),blur[-e:].reshape(-1,3),blur[:,:e].reshape(-1,3),blur[:,-e:].reshape(-1,3)])
    ref=np.median(edge,0); ed=np.sqrt(((edge-ref)**2).sum(1)); dist=np.sqrt(((blur-ref)**2).sum(2))
    busy=np.percentile(ed,90)>80
    if busy:   # no plain background (close-up / already tight) -> just tone + square
        out=img; mask=None
    else:
        thr=max(28,np.percentile(ed,97)*1.6); m=(dist>thr).astype(np.uint8)
        m=cv2.morphologyEx(m,cv2.MORPH_OPEN,np.ones((3,3),np.uint8)); n,lab,st,_=cv2.connectedComponentsWithStats(m)
        if n<=1: out=img; mask=None
        else:
            big=1+np.argmax(st[1:,cv2.CC_STAT_AREA]); x,y,bw,bh=st[big,:4]; pad=int(0.06*max(bw,bh))
            rect=(max(1,x-pad),max(1,y-pad),min(w-2,bw+2*pad),min(h-2,bh+2*pad))
            # 2) GrabCut for an exact product mask
            gm=np.zeros((h,w),np.uint8); bgd=np.zeros((1,65)); fgd=np.zeros((1,65))
            cv2.grabCut(img,gm,rect,bgd,fgd,5,cv2.GC_INIT_WITH_RECT)
            mask=np.where((gm==1)|(gm==3),255,0).astype(np.uint8)
            n,lab,st,_=cv2.connectedComponentsWithStats(mask)
            if n>1: big=1+np.argmax(st[1:,cv2.CC_STAT_AREA]); mask=np.where(lab==big,255,0).astype(np.uint8)
            mask=cv2.morphologyEx(mask,cv2.MORPH_CLOSE,np.ones((9,9),np.uint8))
            # 3) deskew small tilts
            cnts,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE); (cx,cy),(rw,rh),ang=cv2.minAreaRect(max(cnts,key=cv2.contourArea))
            if rw<rh: ang=ang-90
            ang = ang+180 if ang<-45 else ang; ang = ang-90 if ang>45 else ang
            if 2<abs(ang)<25:
                M=cv2.getRotationMatrix2D((cx,cy),ang,1); img=cv2.warpAffine(img,M,(w,h),borderMode=cv2.BORDER_REPLICATE); mask=cv2.warpAffine(mask,M,(w,h))
            # 3b) drop cast shadows: masked pixels that are just darker, unsaturated background
            hsv=cv2.cvtColor(img,cv2.COLOR_BGR2HSV).astype(float); bgsel=mask==0
            bS=np.median(hsv[...,1][bgsel]); bV=np.median(hsv[...,2][bgsel])
            shadow=(mask>0)&(hsv[...,1]<bS+18)&(hsv[...,2]<bV-8)&(hsv[...,2]>bV*0.35)
            m2=mask.copy(); m2[shadow]=0; m2=cv2.morphologyEx(m2,cv2.MORPH_OPEN,np.ones((5,5),np.uint8))
            n2,l2,st2,_=cv2.connectedComponentsWithStats(m2)
            if n2>1:
                b2=1+np.argmax(st2[1:,cv2.CC_STAT_AREA]); m2=np.where(l2==b2,255,0).astype(np.uint8)
                m2=cv2.morphologyEx(m2,cv2.MORPH_CLOSE,np.ones((15,15),np.uint8))
                if m2.sum()>0.55*mask.sum(): mask=m2
            # 4) mild white-balance from background, lift exposure on the product only
            bgpix=img[mask==0].reshape(-1,3).astype(float)
            if len(bgpix)>500:
                g=np.median(bgpix,0); gain=np.clip(g.mean()/np.maximum(g,1),0.9,1.1); img=np.clip(img*gain,0,255).astype(np.uint8)
            Lp=cv2.cvtColor(img,cv2.COLOR_BGR2GRAY)[mask>0]; p=np.percentile(Lp,97)
            if p<200: img=np.clip(img.astype(float)*min(2.0,225/max(p,1)),0,255).astype(np.uint8)
            soft=cv2.GaussianBlur(mask,(0,0),1.6).astype(float)[...,None]/255
            canvas=np.full_like(img,bg[::-1]); out=(img*soft+canvas*(1-soft)).astype(np.uint8)
            ys,xs=np.where(mask>0); out=out[ys.min():ys.max()+1, xs.min():xs.max()+1]
    # 5) tone: lift exposure on product, mild contrast + sharpen
    if mask is None:
        g=cv2.cvtColor(out,cv2.COLOR_BGR2GRAY); p=np.percentile(g,97)
        if p<200: out=np.clip(out.astype(float)*min(2.0,225/max(p,1)),0,255).astype(np.uint8)
    out=cv2.addWeighted(out,1.35,cv2.GaussianBlur(out,(0,0),1.0),-0.35,0)
    # 6) square tile
    oh,ow=out.shape[:2]; k=size*fill/max(oh,ow); out=cv2.resize(out,(max(1,int(ow*k)),max(1,int(oh*k))),interpolation=cv2.INTER_AREA)
    tile=np.full((size,size,3),bg[::-1],np.uint8); y=(size-out.shape[0])//2; x=(size-out.shape[1])//2; tile[y:y+out.shape[0],x:x+out.shape[1]]=out
    return Image.fromarray(cv2.cvtColor(tile,cv2.COLOR_BGR2RGB))
