// Original, deterministic display-box architecture and supported decorative details.
// No world objects, support planes, interaction IDs or simulation state are added.
import * as T from 'three';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
export function createRoomDressing(scene,ZS){
 const shell=new T.Group();shell.name='R39 noninteractive peripheral architecture';scene.add(shell);
 const point=(x,y,z=0)=>new T.Vector3(y,z*ZS,-x),mats=new Map();
 const mat=(name,color)=>{if(!mats.has(name))mats.set(name,new T.MeshStandardMaterial({name:'r39 '+name,color,roughness:.94,metalness:0}));return mats.get(name);};
 const plaster=mat('warm plaster','#dbd4bc'),oak=mat('honey oak','#a88662'),edge=mat('dark endgrain','#786249'),cream=mat('linen cream','#dfd6bd'),sage=mat('faded sage','#7e9589'),blue=mat('window petrol','#607f7f'),clay=mat('book terracotta','#b88169'),paper=mat('paper','#e7d9b8'),ink=mat('ink','#626755'),glass=new T.MeshBasicMaterial({color:'#bdd0c7'});
 function box(parent,name,p,s,m){const o=new T.Mesh(new T.BoxGeometry(s[1],s[2]*ZS,s[0]),m);o.name='r39 '+name;o.position.copy(point(...p));o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 function cylinder(parent,name,p,r,h,m){const o=new T.Mesh(new T.CylinderGeometry(r,r,h*ZS,20),m);o.name='r39 '+name;o.position.copy(point(...p));o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 function books(parent,x,y,z,width=.65,depth=.16){
  [sage,paper,clay].forEach((m,i)=>{box(parent,'stacked book pages',[x+(i%2)*.025,y,z+.045+i*.105],[width-.025,.82*depth,.07],paper);box(parent,'book cover',[x+(i%2)*.025,y,z+.09+i*.105],[width,depth,.025],m);});
 }
 function uprightBooks(parent,x,y,z,count){
  for(let i=0;i<count;i++){const h=.40+(i%3)*.12;box(parent,'shelved book',[x+i*.13,y,z+h/2],[.105,.16,h],[sage,clay,cream,blue][i%4]);box(parent,'book spine label',[x+i*.13,y+.086,z+h*.35],[.057,.012,.025],paper);}
 }
 function clothTexture(){
  const c=document.createElement('canvas');c.width=c.height=32;const g=c.getContext('2d');g.fillStyle='#e4dcc9';g.fillRect(0,0,32,32);g.fillStyle='#bec6ae';for(let i=0;i<32;i+=8){g.fillRect(i,0,2,32);g.fillRect(0,i,32,1);}const t=new T.CanvasTexture(c);t.colorSpace=T.SRGBColorSpace;t.magFilter=T.NearestFilter;t.wrapS=t.wrapT=T.RepeatWrapping;t.repeat.set(3,3);return t;
 }
 const cloth=cream.clone();cloth.name='r39 woven cloth';cloth.map=clothTexture();
 const studyCanvas=document.createElement('canvas');studyCanvas.width=48;studyCanvas.height=64;
 const study=studyCanvas.getContext('2d');study.fillStyle='#d9cfb5';study.fillRect(0,0,48,64);
 study.strokeStyle='#737f69';study.lineWidth=2;study.beginPath();study.moveTo(23,53);study.lineTo(25,16);study.stroke();
 study.fillStyle='#8b9979';
 for(const [x,y,r] of [[17,25,-.5],[31,34,.5],[17,43,-.5]]){study.save();study.translate(x,y);study.rotate(r);study.beginPath();study.ellipse(0,0,8,4,0,0,Math.PI*2);study.fill();study.restore();}
 study.fillStyle='#b49c77';study.fillRect(11,57,26,1);
 const studyTexture=new T.CanvasTexture(studyCanvas);studyTexture.colorSpace=T.SRGBColorSpace;studyTexture.magFilter=T.NearestFilter;
 const studyMaterial=new T.MeshBasicMaterial({map:studyTexture,color:0xffffff});
 function batchArchitecture(){
  const batches=new Map();
  for(const o of [...shell.children]){
   if(!o.isMesh)continue;o.updateMatrix();
   const key=o.material.uuid+':'+o.castShadow+':'+o.receiveShadow;
   if(!batches.has(key))batches.set(key,[]);
   batches.get(key).push(o);
  }
  for(const rows of batches.values()){
   if(rows.length<2)continue;
   const geometry=mergeGeometries(rows.map(o=>o.geometry.clone().applyMatrix4(o.matrix)));
   const merged=new T.Mesh(geometry,rows[0].material);merged.name='r39 batched '+rows[0].material.name;
   merged.castShadow=rows[0].castShadow;merged.receiveShadow=rows[0].receiveShadow;
   merged.userData.decorativeParts=rows.map(o=>o.name);
   rows.forEach(o=>{shell.remove(o);o.geometry.dispose();});shell.add(merged);
  }
 }
 let gridKey='';
 function resize(grid){
  const key=grid.w+':'+grid.h;if(key===gridKey)return;gridKey=key;
  while(shell.children.length){const o=shell.children.pop();o.traverse?.(m=>m.geometry?.dispose());o.parent=null;}
  const w=grid.w,h=grid.h,cx=(w-1)/2,cy=(h-1)/2;
  const base=box(shell,'display box base',[cx,cy,-.22],[w+.44,h+.44,.42],edge);base.castShadow=false;
  const under=box(shell,'continuous floor underlay',[cx,cy,-.035],[w,h,.055],oak);under.castShadow=false;
  const floorM=['#b29a77','#b79e7c','#ac946f'].map((c,i)=>mat('floor '+i,c));
  for(let row=0;row<h*2;row++){const y=-.25+row*.5;for(let col=0;col<4;col++){const len=w/4,x=-.5+(col+.5)*len;const o=box(shell,'quiet long floorboard',[x,y,-.012],[len-.012,.492,.024],floorM[(row+col)%3]);o.castShadow=false;}}
  // All cabinetry, shelving and cloth are behind x/y=-.5, outside navigable cells.
  box(shell,'rear plaster wall',[cx,-.82,2.23],[w+.42,.18,4.46],plaster);
  box(shell,'rear sage lower panel',[cx,-.704,.52],[w+.1,.045,1.04],sage);
  for(const z of [.10,1.04,4.48])box(shell,'rear oak trim',[cx,-.66,z],[w+.2,.07,.08],z===1.04?cream:edge);
  for(let x=.15;x<w-.5;x+=1.1)box(shell,'quiet panel join',[x,-.674,.56],[.018,.012,.80],cream);
  // Broad window cutout with four vertical lights and restrained gathered curtains.
  const winA=Math.min(2.7,h*.34),winB=h-1.0,winC=(winA+winB)/2,winW=winB-winA;
  box(shell,'window wall below',[-.82,cy,.65],[.18,h+.42,1.30],plaster);
  box(shell,'window wall header',[-.82,cy,4.34],[.18,h+.42,.30],plaster);
  for(const [a,b] of [[-.7,winA],[winB,h-.28]])box(shell,'window plaster wing',[-.61,(a+b)/2,2.73],[.18,b-a,2.86],plaster);
  box(shell,'window wall sage panel',[-.535,cy,.52],[.045,h+.1,1.04],sage);
  for(const z of [.10,1.04])box(shell,'window wall trim',[-.515,cy,z],[.025,h+.16,.07],z===1.04?cream:edge);
  const sky=box(shell,'quiet sky',[-.925,winC,2.72],[.015,winW,2.70],glass);sky.castShadow=sky.receiveShadow=false;
  for(const y of [winA,winB])box(shell,'deep window jamb',[-.64,y,2.73],[.22,.12,2.94],cream);
  for(const z of [1.34,4.14])box(shell,'window header sill',[-.63,winC,z],[.24,winW+.12,.12],cream);
  for(let i=1;i<4;i++)box(shell,'window narrow mullion',[-.69,winA+winW*i/4,2.74],[.10,.055,2.72],blue).castShadow=false;
  box(shell,'window transom',[-.68,winC,2.65],[.10,winW,.055],blue).castShadow=false;
  box(shell,'oak window ledge',[-.65,winC,1.26],[.28,winW+.35,.12],oak);
  for(const y of [winA+.17,winB-.17]){
   for(let j=0;j<3;j++)cylinder(shell,'gathered linen curtain',[-.655,y+(j-1)*.10,2.81],.065,2.55,j%2?cloth:cream).castShadow=false;
   box(shell,'curtain tie',[-.57,y,2.02],[.07,.34,.06],sage);
  }
  books(shell,-.65,winA+.70,1.32,.15,.50);
  // Shallow built-in storage is background architecture, not a climbable new object.
  const start=w*.57,end=w-.63,mid=(start+end)/2;
  box(shell,'storage niche back',[mid,-.69,2.12],[end-start,.045,2.86],blue);
  for(const z of [.04,1.18,2.05,3.00,3.65])box(shell,'supported display shelf',[mid,-.625,z],[end-start+.14,.23,.09],oak);
  for(const x of [start-.04,end+.04])box(shell,'niche side frame',[x,-.625,1.84],[.10,.23,3.70],oak);
  const unit=(end-start)/3;
  for(let i=0;i<3;i++){box(shell,'closed linen storage door',[start+(i+.5)*unit,-.53,.61],[unit-.055,.035,1.02],i===1?sage:oak);box(shell,'inset drawer pull',[start+(i+.5)*unit,-.512,.95],[.20,.012,.025],edge);}
  uprightBooks(shell,start+.18,-.625,2.10,Math.min(7,Math.floor((end-start)*1.6)));
  books(shell,end-.48,-.625,2.10,.56,.19);
  box(shell,'folded household linen',[start+.65,-.625,3.09],[.95,.19,.18],cloth);
  for(let i=0;i<3;i++)box(shell,'linen fold edge',[start+.65,-.514,3.03+i*.06],[.88,.01,.014],cream);
  books(shell,end-.60,-.625,3.05,.70,.18);
  // A small pinned study groups the vertical space with the existing drawing zone.
  const px=w*.30;
  box(shell,'notice board oak frame',[px,-.64,2.85],[1.62,.17,1.42],oak);
  box(shell,'notice board woven backing',[px,-.544,2.85],[1.43,.018,1.24],sage);
  box(shell,'pinned paper left',[px-.23,-.529,2.90],[.58,.012,.84],paper);
  box(shell,'pinned paper right',[px+.38,-.529,2.75],[.37,.012,.55],cream);
  for(let i=0;i<4;i++)box(shell,'quiet pencil trace',[px-.23,-.52,2.69+i*.10],[.28-(i%2)*.08,.004,.012],ink);
  // Not interactable: these details intentionally remain behind the boundary plane.
  batchArchitecture();
 }
 function mode(night){glass.color.set(night?'#506779':'#bdd0c7');studyMaterial.color.set(night?'#646d79':'#ffffff');}
 function dressEntity(e){
  if(e.kind==='drawing_wall')e.root.traverse(o=>{if(o.name==='paper drawing')o.material=studyMaterial;});
  if(e.kind==='computer_desk'){
   const group=new T.Group();group.name='r39 desk details within footprint';e.root.add(group);e.r39Details=group;
   books(group,-.28,-.26,.01,.25,.22);
   box(group,'open notebook',[.18,.25,.018],[.32,.27,.03],paper);
   box(group,'notebook fold',[.18,.25,.038],[.008,.25,.008],edge);
   for(let i=0;i<3;i++)box(group,'notebook pencil strokes',[.23,.19+i*.045,.037],[.07,.008,.006],sage);
   box(group,'resting pencil',[.18,.43,.035],[.30,.018,.018],clay);
  }
  if(e.kind==='bed'||e.kind==='cushion'){
   e.root.traverse(o=>{if(o.name==='soft bed centre at floor'){
    const p=o.geometry.attributes.position,uv=[];
    for(let i=0;i<p.count;i++)uv.push(.5-p.getZ(i),p.getX(i)+.5);
    o.geometry.setAttribute('uv',new T.Float32BufferAttribute(uv,2));
    o.material.map=cloth.map;o.material.color.set('#ddd2b6');o.material.needsUpdate=true;
   }});
  }
  if(e.kind==='cat_tree'){
   // Thin wrapped rings follow the existing central post; no extra platforms.
   const count=18,rings=new T.InstancedMesh(new T.CylinderGeometry(.094,.094,.018*ZS,16),cream,count),matrix=new T.Matrix4();
   rings.name='r39 sisal winding';rings.castShadow=rings.receiveShadow=true;
   for(let i=0;i<count;i++)rings.setMatrixAt(i,matrix.makeTranslation(0,(.24+i*.12)*ZS,0));
   e.root.add(rings);
  }
 }
 function updateEntity(e,object,b,fitW,fitD,top){
  if(e.r39Details){e.r39Details.position.y=(top-b.z)*ZS;e.r39Details.scale.set(fitD,1,fitW);}
 }
 return {resize,mode,dressEntity,updateEntity,shell};
}
