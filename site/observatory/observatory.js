import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RectAreaLightUniformsLib} from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

// Timeline pose names that have no sprite of their own (the 2D room draws them as sit).
const POSE_ALIAS={sleep:'sleepy',back:'look_up',question:'look_up',startled:'alert_loaf',sneak:'walk'};
// Catalog gift colours, from cam-props.js PAL.
const PAL={parcel:0xcb9d70,parcelDark:0xa87f52,tape:0xe2c79c,slipper:0xe8913a,slipperDark:0xb96f24,slipperSole:0xf3e9d2,
 yarnA:0xe8dcc8,yarnB:0xd4a574,cushion:0x3a8a82,cushionDark:0x2f7069,button:0xc9a227};
// Debug/test clock: window.__noriObservatoryClock() may replace performance.now() for deterministic captures.
const clock=()=>{const f=window.__noriObservatoryClock;return typeof f==='function'?f():performance.now();};
const DROP_MS=700,DROP_H=1.8,LAND_MS=320,FX_MS=520,FRAME_MS=1000/30;

export async function createMiniatureRenderer({oldCanvas,manifest,images,onFailure}){
 const canvas=document.createElement('canvas');canvas.id='cam-observatory';canvas.hidden=true;
 // Fit the whole 16:9 room inside the window (contain), leaving room for the page footer; width:100% alone cropped
 // the top and bottom on wide windows.
 canvas.style.cssText='display:none;width:min(100%,calc((100vh - 64px)*16/9));height:auto;aspect-ratio:16/9';oldCanvas.parentElement.append(canvas);
 const report=window.noriObservatory={ready:false,objects:[],frames:0,errors:[],drops:[],fps:0,cat:null,source:'actual Nori cam snapshot + actual Worker gift sprites; no authored gift position'};
 const cfg=await fetch('/observatory/room-contract.json').then(r=>{if(!r.ok)throw Error('room contract '+r.status);return r.json();});
 RectAreaLightUniformsLib.init();
 const renderer=new T.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer:true});renderer.setPixelRatio(1);renderer.setSize(1280,720,false);
 renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=.85;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;
 const scene=new T.Scene();scene.background=new T.Color().setRGB(...cfg.world.color_linear);
 const camera=new T.OrthographicCamera(-4.3,4.3,2.41875,-2.41875,.01,100),c=cfg.cameras.front;
 camera.position.fromArray(c.position_gltf);camera.lookAt(new T.Vector3(...c.target_gltf));camera.updateProjectionMatrix();camera.updateMatrixWorld();
 const pmrem=new T.PMREMGenerator(renderer);scene.environment=pmrem.fromScene(new RoomEnvironment(),.04).texture;scene.environmentIntensity=.20;
 scene.add(new T.HemisphereLight(0xc8b7ee,0x7e4525,.42));
 const gltf=await new GLTFLoader().loadAsync('/observatory/room.glb');scene.add(gltf.scene);
 renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
 gltf.scene.traverse(o=>{if(o.isLight)o.visible=false;if(o.isMesh){const mats=Array.isArray(o.material)?o.material:[o.material];o.castShadow=!mats.some(m=>m.transparent||m.opacity<.95||m.emissiveIntensity>1);if(/glass|glow|flame|bulb|city|outside|maple/i.test(o.name))o.castShadow=false;o.receiveShadow=true;}});
 const point=p=>new T.Vector3(p[0],p[2],-p[1]);
 for(const spec of cfg.lights){const color=new T.Color().setRGB(...spec.color_linear);let light;
  if(spec.type==='AREA'){const s=Array.isArray(spec.size)?spec.size:[spec.size,spec.size];light=new T.RectAreaLight(color,spec.blender_watts*.035,...s);}
  else if(spec.type==='SPOT'){light=new T.SpotLight(color,spec.blender_watts*.11,0,T.MathUtils.degToRad(spec.spot_angle_deg/2),.65,2);light.target.position.copy(point(spec.target_blender));scene.add(light.target);light.castShadow=true;light.shadow.mapSize.set(1024,1024);light.shadow.bias=-.0001;light.shadow.normalBias=.025;}
  else{light=new T.PointLight(color,spec.blender_watts*.11,0,2);if(spec.name==='Lantern light'){light.castShadow=true;light.shadow.mapSize.set(512,512);light.shadow.bias=-.0001;}}
  light.position.copy(point(spec.position_blender));if(spec.target_blender&&spec.type==='AREA')light.lookAt(point(spec.target_blender));scene.add(light);
 }
 const texLoader=new T.TextureLoader(),catMap=new Map(),gifts=new Map(),cards=new Map();let disposed=false,lastCardPoll=0,cardsAvailable=true;
 const pixel=await texLoader.loadAsync(images.sit?.src||'/cam/sprites/sit.png');pixel.colorSpace=T.SRGBColorSpace;pixel.magFilter=T.NearestFilter;pixel.minFilter=T.NearestFilter;catMap.set('sit',pixel);
 // Preload every canonical pose so the first walking frame is not drawn with the sit sprite.
 await Promise.all(Object.keys(manifest).filter(k=>k!=='sit'&&images[k]).map(k=>texLoader.loadAsync(images[k].src).then(t=>{t.colorSpace=T.SRGBColorSpace;t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;catMap.set(k,t);}).catch(()=>{})));
 const cat=new T.Sprite(new T.SpriteMaterial({map:pixel,transparent:true,alphaTest:.08,depthWrite:false,color:0xffecd4}));scene.add(cat);
 const radial=(inner,outer,stops)=>{const cv=document.createElement('canvas');cv.width=cv.height=64;const g=cv.getContext('2d'),gr=g.createRadialGradient(32,32,inner,32,32,outer);for(const [o,col]of stops)gr.addColorStop(o,col);g.fillStyle=gr;g.fillRect(0,0,64,64);const t=new T.CanvasTexture(cv);t.colorSpace=T.SRGBColorSpace;return t;};
 const shadowTex=radial(3,30,[[0,'rgba(40,19,9,.45)'],[1,'rgba(40,19,9,0)']]);
 const dustTex=radial(14,31,[[0,'rgba(255,238,206,0)'],[.6,'rgba(255,238,206,.95)'],[1,'rgba(255,238,206,0)']]);
 const sparkTex=radial(0,14,[[0,'rgba(255,246,222,1)'],[.45,'rgba(255,226,170,.7)'],[1,'rgba(255,226,170,0)']]);
 function shadow(w,d){const m=new T.Mesh(new T.PlaneGeometry(w,d),new T.MeshBasicMaterial({map:shadowTex,transparent:true,depthWrite:false}));m.rotation.x=-Math.PI/2;scene.add(m);return m;}
 const catShadow=shadow(.46,.30);
 const web=(x,y,z=0)=>new T.Vector3((9-x)*.5,z*.25,-(y+.5)*.5);
 const screenX=v=>v.clone().project(camera).x;
 const reducedMotion=()=>!!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
 async function pollCards(){
  // Photo-gift sizes from the local owner server; the public Worker has no /owner/status, so stop after one miss.
  try{const r=await fetch('/owner/status');if(!r.ok||!/json/.test(r.headers.get('content-type')||'')){cardsAvailable=false;return;}const d=await r.json();for(const j of d.jobs||[]){if(j.status!=='gift_ready')continue;const v=JSON.parse(j.detail).result;if(v?.gift_id&&v.object_card)cards.set('o_'+v.gift_id,v.object_card);}}catch(e){cardsAvailable=false;}}
 const std=(color,rough=.9)=>new T.MeshStandardMaterial({color,roughness:rough});
 function catalogModel(kind){const g=new T.Group();const add=(geo,mat,x,y,z)=>{const m=new T.Mesh(geo,mat);m.position.set(x,y,z);g.add(m);return m;};
  if(kind==='slipper'){
   const sole=add(new T.CapsuleGeometry(.065,.17,4,12),std(PAL.slipperSole),0,.024,0);sole.rotation.z=Math.PI/2;sole.scale.set(.35,1,1);
   const upper=add(new T.SphereGeometry(.075,16,10,0,Math.PI*2,0,Math.PI/2),std(PAL.slipper),.06,.03,0);upper.scale.set(1.1,.75,1);
   add(new T.TorusGeometry(.055,.012,6,16,Math.PI),std(PAL.slipperDark),.0,.035,0).rotation.set(Math.PI/2,0,Math.PI/2);
   return {group:g,shadow:[.34,.18],h:.08};}
  if(kind==='toy'){
   g.scale.setScalar(1.3);add(new T.SphereGeometry(.09,18,12),std(PAL.yarnA),0,.09,0);
   for(const [rx,ry] of [[.3,0],[1.2,.6],[-.5,1.3]]){const r=add(new T.TorusGeometry(.088,.008,6,24),std(PAL.yarnB),0,.09,0);r.rotation.set(rx,ry,0);}
   const tail=add(new T.CylinderGeometry(.006,.006,.12,6),std(PAL.yarnB),.1,.012,.02);tail.rotation.z=Math.PI/2.4;
   return {group:g,shadow:[.24,.2],h:.18};}
  if(kind==='cushion'){
   const pad=add(new T.SphereGeometry(.2,20,12),std(PAL.cushion,1),0,.055,0);pad.scale.set(1,.28,1);
   add(new T.SphereGeometry(.018,10,8),std(PAL.button),0,.11,0);
   const seam=add(new T.TorusGeometry(.195,.008,6,32),std(PAL.cushionDark,1),0,.055,0);seam.rotation.x=Math.PI/2;
   return {group:g,shadow:[.44,.36],h:.11};}
  // cardboard_box and any other procedural gift: a closed parcel.
  add(new T.BoxGeometry(.32,.25,.28),std(PAL.parcel,1),0,.125,0);
  add(new T.BoxGeometry(.06,.252,.282),std(PAL.tape,1),0,.125,0);
  add(new T.BoxGeometry(.322,.012,.282),std(PAL.parcelDark,1),0,.245,0);
  return {group:g,shadow:[.36,.26],h:.25};
 }
 // Landing puff: a soft dust ring on the floor and a few warm sparkles; all fade within FX_MS.
 const effects=[];
 function landingFx(pos,size){const ring=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial({map:dustTex,transparent:true,depthWrite:false,opacity:.9}));ring.rotation.x=-Math.PI/2;ring.position.copy(pos);ring.position.y+=.006;scene.add(ring);
  const sparks=[];for(let k=0;k<5;k++){const s=new T.Sprite(new T.SpriteMaterial({map:sparkTex,transparent:true,depthWrite:false,color:0xfff1d6}));const a=k/5*Math.PI*2+.4;s.userData.dir=new T.Vector3(Math.cos(a),0,Math.sin(a));s.userData.rise=.18+.08*(k%2);s.position.copy(pos);scene.add(s);sparks.push(s);}
  effects.push({start:clock(),ring,sparks,pos:pos.clone(),size});}
 function stepFx(now){for(let i=effects.length-1;i>=0;i--){const f=effects[i],q=(now-f.start)/FX_MS;
  if(q>=1){scene.remove(f.ring);f.ring.material.dispose();f.ring.geometry.dispose();for(const s of f.sparks){scene.remove(s);s.material.dispose();}effects.splice(i,1);continue;}
  const e=1-(1-q)*(1-q),r=f.size*(.7+1.1*e);f.ring.scale.set(r,r*.8,1);f.ring.material.opacity=.9*(1-q*q);
  for(const s of f.sparks){const d=f.size*(.25+.45*e);s.position.copy(f.pos).addScaledVector(s.userData.dir,d);s.position.y+=.05+s.userData.rise*e;const sz=.1*(1-q*.5);s.scale.set(sz,sz,1);s.material.opacity=Math.sin(Math.PI*Math.min(1,q*1.6))*(1-q);}}}
 let seenIds=null;
 function updateGift(o,pose,carryingId,now){let e=gifts.get(o.id);
  if(!e){const media=o.sprite?.startsWith('/media/');const kind=String(o.kind||String(o.sprite||'').replace(/^procedural:/,''));const model=media?null:catalogModel(kind);
   e={sprite:null,url:null,pending:false,body:null,root:new T.Group(),model,media,shadowBase:model?model.shadow:[.30,.22],firstSeen:now,drop:null,known:!seenIds||seenIds.has(o.id),visualReady:!media};
   e.shadow=shadow(...e.shadowBase);
   e.parcel=model?model.group:new T.Mesh(new T.BoxGeometry(.32,.25,.28),new T.MeshStandardMaterial({color:0xb58759,roughness:1}));if(!model)e.parcel.position.y=.13;
   e.root.add(e.parcel);e.root.rotation.y=model?((hash(o.id)%100)/100-.5)*.8:0;scene.add(e.root);gifts.set(o.id,e);}
  if(e.media&&o.sprite?.startsWith('/media/')&&e.url!==o.sprite&&!e.pending){e.pending=true;texLoader.load(o.sprite,t=>{t.colorSpace=T.SRGBColorSpace;t.magFilter=T.LinearFilter;t.minFilter=T.LinearMipmapLinearFilter;
    if(e.sprite){e.root.remove(e.sprite);e.sprite.material.dispose();}
    e.sprite=new T.Sprite(new T.SpriteMaterial({map:t,transparent:true,alphaTest:.04,depthWrite:false}));
    const cv=document.createElement('canvas');cv.width=t.image.width;cv.height=t.image.height;const ct=cv.getContext('2d',{willReadFrequently:true});ct.drawImage(t.image,0,0);const a=ct.getImageData(0,0,cv.width,cv.height).data;
    let minX=cv.width,minY=cv.height,maxX=0,maxY=0;for(let y=0;y<cv.height;y++)for(let x=0;x<cv.width;x++)if(a[(y*cv.width+x)*4+3]>15){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x+1);maxY=Math.max(maxY,y+1);}
    e.body={w:cv.width,h:cv.height,bw:maxX-minX,bh:maxY-minY,foot:[(minX+maxX)/2,maxY]};e.sprite.center.set(e.body.foot[0]/cv.width,1-maxY/cv.height);e.root.add(e.sprite);e.url=o.sprite;e.pending=false;e.visualReady=true;
   },undefined,()=>{e.pending=false;e.visualReady=true;report.errors.push('gift sprite load failed');});}
  const placedOrCarried=!o.status||o.status==='placed'||o.status==='carried',fp=o.footprint?.length?o.footprint:[[0,0]],xs=fp.map(p=>p[0]),ys=fp.map(p=>p[1]);
  const x=o.x+(Math.min(...xs)+Math.max(...xs))/2,y=o.y+(Math.min(...ys)+Math.max(...ys))/2;
  const floor=web(x,y,o.z||0),pos=floor.clone();const carried=carryingId===o.id;if(carried)pos.copy(web(pose.x,pose.y,(pose.z||0)+1.2));
  // A gift new to this page session waits for its picture (at most 4 s), then drops from the sky.
  let visible=placedOrCarried&&(e.known||e.visualReady||now-e.firstSeen>4000);
  if(visible&&!e.known&&!e.drop){e.drop={start:now,landed:false,instant:reducedMotion()||carried};report.drops.push({id:o.id,at:now,instant:e.drop.instant});}
  let lift=0,sy=1,sx=1,shadowK=1;
  if(e.drop&&!e.drop.instant&&!carried){const q=(now-e.drop.start)/DROP_MS;
   if(q<1){lift=DROP_H*(1-q*q);shadowK=.35+.65*q*q;sy=1.06;sx=.96;}
   else{if(!e.drop.landed){e.drop.landed=true;landingFx(floor,Math.max(...e.shadowBase)*2.2);}
    const l=(now-e.drop.start-DROP_MS)/LAND_MS;if(l<1){const s=.2*Math.exp(-3.2*l)*Math.cos(l*Math.PI*2.4);sy=1-s;sx=1+s*.6;}}}
  e.parcel.visible=visible&&!e.sprite;e.root.visible=visible;e.root.position.copy(pos);e.root.position.y+=lift;e.root.scale.set(sx,sy,sx);
  e.shadow.visible=visible&&!carried;e.shadow.position.copy(floor);e.shadow.position.y+=.002;e.shadow.scale.set(shadowK,shadowK,1);e.shadow.material.opacity=.4+.6*shadowK;
  if(e.sprite){const cm=cards.get(o.id)?.space?.cm||{w:30,d:28,h:42},b=e.body;e.sprite.visible=visible;e.sprite.scale.set(cm.w/80*b.w/b.bw,cm.h/80*b.h/b.bh,1);e.sprite.position.set(0,.001,0);}
  return {id:o.id,x:o.x,y:o.y,z:o.z,kind:o.kind,sprite:o.sprite,visible,loaded:e.media?e.url===o.sprite:true,lift,position_blender:[pos.x,-pos.z,pos.y],source:'actual snapshot coordinates',card_cm:cards.get(o.id)?.space?.cm||null};
 }
 function hash(s){let h=2166136261;for(const ch of String(s)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619);}return h>>>0;}
 // Nori: canonical sprites only. Position follows the timeline path; a short follow rounds the path corners.
 const nori={disp:null,target:null,facing:1,walkDist:0,last:0,speed:0};
 function poseKey(name,moving){let k=String(name||'sit').replaceAll('-','_');if(!manifest[k])k=POSE_ALIAS[k]&&manifest[POSE_ALIAS[k]]?POSE_ALIAS[k]:'sit';
  if(moving&&k!=='jump'&&manifest.walk)return 'walk';return k;}
 function spriteFor(key){if(!catMap.has(key)&&images[key]){catMap.set(key,null);texLoader.load(images[key].src,t=>{t.colorSpace=T.SRGBColorSpace;t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;catMap.set(key,t);});}
  return catMap.get(key)?key:'sit';}
 function updateNori(s,now){const pose=s.pose,anim=s.anim||{};const dt=nori.last?Math.min(.25,(now-nori.last)/1000):0;nori.last=now;
  const climb=pose.primitive==='climb';const hopLift=(Number(pose.hop)||0)*.014;
  const target=web(pose.x,pose.y,pose.z||0);
  let step=0;if(nori.target){step=target.distanceTo(nori.target);}
  if(!nori.disp||step>1.6){nori.disp=target.clone();step=0;}
  else{const k=1-Math.exp(-dt/.08);nori.disp.lerp(target,k);}
  const prevTarget=nori.target;nori.target=target.clone();
  nori.speed=dt>0?nori.speed*.6+(step/dt)*.4:0;
  const moving=!climb&&(pose.primitive==='move_to'||String(pose.pose)==='walk'||nori.speed>.25)&&nori.speed>.05;
  if(moving)nori.walkDist+=step;
  const wanted=poseKey(pose.pose,moving),key=spriteFor(wanted),entry=manifest[key]||manifest.sit;
  // Facing in screen space: from the walking direction, else toward the target object, else unchanged.
  if(prevTarget&&step>1e-4){const dx=screenX(target)-screenX(prevTarget);if(Math.abs(dx)>1e-4)nori.facing=dx>0?1:-1;}
  else if(pose.target){const t=(s.objects||[]).find(o=>o.id===pose.target);if(t){const dx=screenX(web(t.x,t.y,t.z||0))-screenX(target);if(Math.abs(dx)>.01)nori.facing=dx>0?1:-1;}}
  const map=catMap.get(key)||pixel;if(cat.material.map!==map){cat.material.map=map;cat.material.needsUpdate=true;}
  // Walk cycle on the one walk frame: a small trot bob and rock, two steps per stride.
  let bob=0,rock=0,bsy=1;if(key==='walk'&&!reducedMotion()){const ph=nori.walkDist/.2*Math.PI;bob=Math.abs(Math.sin(ph))*.022;rock=Math.sin(ph)*.035;bsy=1+.03*Math.cos(ph*2);}
  const flip=(nori.facing*(entry.native_facing||1))<0?-1:1;
  const sx=(Number(anim.scaleX)||1),sy=(Number(anim.scaleY)||1)*bsy;
  // Sprites ignore a negative scale in three.js, so mirror through the texture (and the anchor) instead.
  map.repeat.x=flip;map.offset.x=flip<0?1:0;
  cat.center.set(flip<0?1-entry.foot[0]/entry.w:entry.foot[0]/entry.w,1-entry.foot[1]/entry.h);cat.scale.set(.48*entry.w/entry.body_h*sx,.48*entry.h/entry.body_h*sy,1);
  cat.material.rotation=rock*flip;
  cat.position.copy(nori.disp);cat.position.y+=.005+bob+hopLift;
  const lift=bob+hopLift;const sk=Math.max(.55,1-lift*1.6);catShadow.position.copy(nori.disp);catShadow.position.y=web(0,0,pose.z||0).y+.002;catShadow.scale.set(sk,sk,1);
  report.cat={pose:pose.pose,sprite:key,facing:nori.facing,flip,moving,speed:+nori.speed.toFixed(3),primitive:pose.primitive||null};
 }
 let lastDraw=0,fpsCount=0,fpsStart=0;
 function render(s){if(disposed||!s.pose||window.__pauseObservatory)return;const now=clock();if(Math.abs(now-lastDraw)<FRAME_MS-2)return;lastDraw=now;const pose=s.pose;
  if(cardsAvailable&&now-lastCardPoll>2000&&(s.objects||[]).some(o=>o.sprite?.startsWith('/media/')&&!cards.has(o.id))){lastCardPoll=now;void pollCards();}
  updateNori(s,now);
  const objects=(s.objects||[]).filter(o=>!o.id.startsWith('r40_')&&!o.id.startsWith('env:'));const ids=new Set(objects.map(o=>o.id));
  const records=objects.map(o=>updateGift(o,pose,s.carryingId,now));if(!seenIds)seenIds=new Set(ids);
  for(const [id,e]of gifts)if(!ids.has(id)){e.root.visible=e.shadow.visible=false;}
  stepFx(now);
  renderer.render(scene,camera);if(!report.ready){oldCanvas.hidden=true;oldCanvas.style.display='none';canvas.hidden=false;canvas.style.display='block';}
  fpsCount++;if(!fpsStart)fpsStart=now;if(now-fpsStart>=2000){report.fps=+(fpsCount*1000/(now-fpsStart)).toFixed(1);fpsCount=0;fpsStart=now;}
  Object.assign(report,{ready:true,frames:report.frames+1,time:s.time,pose:{...pose},objects:records,grid:s.grid,roomScaleToWorld:.8,effects:effects.length});
 }
 canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();report.errors.push('context lost');disposed=true;canvas.hidden=true;oldCanvas.hidden=false;oldCanvas.style.display='block';onFailure?.();});
 return {render,canvas,probe:()=>structuredClone(report),ready:()=>report.ready,finishFrame:()=>renderer.getContext().finish()};
}
