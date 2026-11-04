import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {RectAreaLightUniformsLib} from 'three/addons/lights/RectAreaLightUniformsLib.js';
import {objectBounds,objectVisualKind,contactPlane,canonicalPose,walkFootTargets} from '../public/cam-miniature-world.js';
import {pruneFloatingFragments} from '../public/cam-props.js';
import {createRoomDressing} from './r39-room-dressing.js';

const ZS=Math.sqrt(2/3),W=384,H=320;
const web=(x,y,z=0)=>new THREE.Vector3(y,z*ZS,-x);
const world=p=>({x:-p.z,y:p.x,z:p.y/ZS});
const sourceName=o=>o.userData.nori_object_name||o.name;
const names={
 desk:['table leg','table apron','low oak table','book pages','book cover','lamp base','lamp stem','linen lamp','open lamp hem','reconstructed metal mug','drink surface','cup handle'],
 box:['box bottom','box side','box end','open paper flap','folded paper flap','tape on box','small use mark'],
 bowl:['water tray','water dish','water surface'],
};
const shellNames=['solid room plinth','continuous timber underlay','quiet oak floor','back plaster','window wall','back sage wainscot','left sage wainscot','back picture rail','left picture rail','quiet panel seam','back baseboard','left baseboard','window upright','window horizontal','deep window sill','window center upright','window crossbar','quiet world outside','outside leaves'];

export async function createMiniatureRenderer({oldCanvas,manifest,images,onFailure,debug=false}){
 const canvas=document.createElement('canvas');canvas.id='cam-miniature';canvas.hidden=true;canvas.style.display='none';
 canvas.setAttribute('role','img');canvas.setAttribute('aria-label','阿短的共享房間');canvas.style.imageRendering='pixelated';
 oldCanvas.before(canvas);
 const renderer=new THREE.WebGLRenderer({canvas,antialias:false,preserveDrawingBuffer:true});
 renderer.setPixelRatio(1);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NoToneMapping;
 renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
 const raster={value:new THREE.Vector2(W,H)},nightUniform={value:0};
 const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(),shell=new THREE.Group();scene.add(shell);
 const dressing=createRoomDressing(scene,ZS);
 const gltf=await new GLTFLoader().loadAsync('/cam/miniature/scene.glb').catch(error=>{renderer.dispose();canvas.remove();throw error;});
 const actors=new Map(),feet=[],blink=[],prefabs={},entities=new Map(),fallbackTextures=new Map(),materials=new Map();
 const original=gltf.scene;original.updateMatrixWorld(true);
 function actorMaterial(m){
  if(m.userData.livePixel)return;m.userData.livePixel=true;
  m.onBeforeCompile=shader=>{
   shader.uniforms.noriRaster=raster;shader.uniforms.noriNight=nightUniform;
   shader.vertexShader='uniform vec2 noriRaster;\n'+shader.vertexShader;
   shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n vec2 noriPixel=(gl_Position.xy/gl_Position.w*.5+.5)*noriRaster;gl_Position.xy=(floor(noriPixel+.5)/noriRaster*2.-1.)*gl_Position.w;');
   shader.fragmentShader='uniform float noriNight;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nnormal=normalize(mat3(viewMatrix)*vec3(.38,.843,-.38));');
   shader.fragmentShader=shader.fragmentShader.replace('#include <opaque_fragment>',`vec3 noriLight=outgoingLight/max(diffuseColor.rgb,vec3(.001));float noriValue=max(dot(noriLight,vec3(.2126,.7152,.0722)),.001);float noriExposure=clamp(noriValue,mix(.45,.20,noriNight),mix(1.05,1.15,noriNight));outgoingLight=diffuseColor.rgb*noriExposure*mix(vec3(1.),noriLight/noriValue,.5);\n#include <opaque_fragment>`);
  };m.customProgramCacheKey=()=> 'nori-live-pixel-v1';
 }
 original.traverse(o=>{
  if(o.userData.nori_pose)actors.set(o.userData.nori_pose,o);
  if(o.userData.nori_foot)feet.push(o);
  if(o.userData.nori_blink_row!==undefined)blink.push(o);
  if(!o.isMesh)return;
  const name=sourceName(o);o.castShadow=!name.startsWith('selective ink ')&&name!=='quiet world outside';o.receiveShadow=true;
  for(const m of (Array.isArray(o.material)?o.material:[o.material])){
   materials.set(m.name,m);if(o.userData.nori_part)actorMaterial(m);
  }
 });
 for(const actor of actors.values()){
  scene.attach(actor);actor.visible=false;actor.matrixAutoUpdate=false;
  actor.traverse(o=>{o.userData.basePosition=o.position.clone();o.userData.baseQuaternion=o.quaternion.clone();});
 }
 function take(meshes,center){
  const group=new THREE.Group();scene.add(group);
  for(const mesh of meshes){group.attach(mesh);mesh.position.sub(web(...center));}
  scene.remove(group);return group;
 }
 const remaining=[];original.traverse(o=>{if(o.isMesh)remaining.push(o);});
 const groups={desk:[],box:[],bowl:[]};
 for(const o of remaining){
  const name=sourceName(o).replace(/^selective ink /,'');
  const kind=Object.keys(names).find(k=>names[k].some(p=>name.startsWith(p)));
  if(kind){groups[kind].push(o);continue;}
   if(shellNames.some(p=>name.startsWith(p))){
   if(name.startsWith('quiet oak floor')||name==='continuous timber underlay'||name==='solid room plinth')o.castShadow=false;
   shell.attach(o);
   if(name==='quiet world outside'){o.material=new THREE.MeshBasicMaterial({color:0xc6d8c8});o.castShadow=false;o.userData.sky=true;}
  }
 }
 prefabs.desk=take(groups.desk,[7,2.5,0]);prefabs.box=take(groups.box,[2.05,5.9,0]);prefabs.bowl=take(groups.bowl,[.98,8.8,0]);
 for(const group of Object.values(prefabs)){
  group.updateMatrixWorld(true);const b=new THREE.Box3().setFromObject(group,true),center=b.getCenter(new THREE.Vector3());
  group.userData.extent={width:b.max.z-b.min.z,depth:b.max.x-b.min.x};
  for(const child of group.children){child.position.x-=center.x;child.position.z-=center.z;}
 }
 function material(name,color){if(!materials.has(name))materials.set(name,new THREE.MeshStandardMaterial({name,color,roughness:.9,metalness:0}));return materials.get(name);}
 const oak=material('live oak',0xad8059),edge=material('live endgrain',0x8c674b),linen=material('live linen',0xa2ac91),ceramic=material('live ceramic',0xc3b59a),dark=material('live screen',0x384f4b);
 function cube(parent,name,center,size,mat){const o=new THREE.Mesh(new THREE.BoxGeometry(size[1],size[2]*ZS,size[0]),mat);o.name=name;o.position.copy(web(...center));o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 function disk(parent,name,center,radius,height,mat){const o=new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,height*ZS,24),mat);o.name=name;o.position.copy(web(...center));o.castShadow=true;o.receiveShadow=true;parent.add(o);return o;}
 const aoCanvas=document.createElement('canvas');aoCanvas.width=aoCanvas.height=64;const ag=aoCanvas.getContext('2d'),gradient=ag.createRadialGradient(32,32,3,32,32,32);gradient.addColorStop(0,'rgba(0,0,0,.8)');gradient.addColorStop(.5,'rgba(0,0,0,.4)');gradient.addColorStop(1,'rgba(0,0,0,0)');ag.fillStyle=gradient;ag.fillRect(0,0,64,64);const aoTexture=new THREE.CanvasTexture(aoCanvas);
 function contact(width,depth,opacity){const o=new THREE.Mesh(new THREE.PlaneGeometry(depth,width),new THREE.MeshBasicMaterial({map:aoTexture,color:0x302b26,transparent:true,opacity,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1}));o.rotation.x=-Math.PI/2;o.renderOrder=1;scene.add(o);return o;}
 const bodyShadow=contact(1.05,.65,.27),footShadows=Array.from({length:4},()=>contact(.27,.22,.3));
 RectAreaLightUniformsLib.init();
 const sun=new THREE.DirectionalLight(0xffe3b3,.91);sun.position.copy(web(-5,3,9));sun.target.position.copy(web(4,5,0));sun.castShadow=true;sun.shadow.mapSize.set(1024,1024);Object.assign(sun.shadow.camera,{left:-10,right:10,top:10,bottom:-10,near:.1,far:40});sun.shadow.camera.updateProjectionMatrix();sun.shadow.normalBias=.025;sun.shadow.bias=.0008;sun.shadow.radius=2;scene.add(sun,sun.target);
 const windowLight=new THREE.RectAreaLight(0xffe8c7,6,4,4),bounce=new THREE.RectAreaLight(0xd5e5f2,2,8,8),moon=new THREE.RectAreaLight(0x7ba6ff,4.2,4,4),nightBounce=new THREE.RectAreaLight(0xaebde8,.9,8,8);
 scene.add(windowLight,bounce,moon,nightBounce,new THREE.AmbientLight(0xb6c5d1,.06));
 const lamp=new THREE.PointLight(0xffab59,215/(4*Math.PI),30,2);lamp.castShadow=true;lamp.shadow.mapSize.set(512,512);lamp.shadow.camera.near=.1;lamp.shadow.normalBias=.012;lamp.shadow.radius=2;scene.add(lamp);
 let current=null,lastShape='',lastTime=null,activeActor=null,frameCount=0,ready=false;
 const last={objects:[],pose:null,time:null,feet:{},mode:'day',grid:null};
 function pixelMatrix(x,y,z,flip=1,breath=1){return new THREE.Matrix4().set(-flip/32,1/32,0,y,0,0,ZS/16*breath,z*ZS,-flip/32,-1/32,0,-x,0,0,0,1);}
 function prepareBillboard(image,entry,matOverride,canonical=false){
  const w=entry.w||image.naturalWidth,h=entry.h||image.naturalHeight,foot=entry.foot||[w/2,h];
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute([-foot[0],0,foot[1]-h,w-foot[0],0,foot[1]-h,w-foot[0],0,foot[1],-foot[0],0,foot[1]],3));geo.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,1,1,0,1],2));geo.setIndex([0,1,2,0,2,3]);geo.computeVertexNormals();
  let pixels=image;
  if(canonical){const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.imageSmoothingEnabled=false;g.drawImage(image,0,0);const data=g.getImageData(0,0,w,h);if(pruneFloatingFragments(data.data,w,h))g.putImageData(data,0,0);pixels=c;}
  const texture=new THREE.Texture(pixels);texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=texture.minFilter=THREE.NearestFilter;texture.generateMipmaps=false;texture.needsUpdate=true;
  const mat=matOverride||new THREE.MeshStandardMaterial({map:texture,alphaTest:.5,roughness:1,side:THREE.DoubleSide});actorMaterial(mat);
  const o=new THREE.Mesh(geo,mat);o.matrixAutoUpdate=false;o.castShadow=true;o.receiveShadow=true;scene.add(o);return o;
 }
 for(const [pose,entry] of Object.entries(manifest)){
  if(actors.has(pose))continue;
  const image=images[pose];if(!image)continue;try{await image.decode();fallbackTextures.set(pose,prepareBillboard(image,entry,null,true));}catch{}
 }
 function makeEntity(object){
  const kind=objectVisualKind(object),root=new THREE.Group();scene.add(root);
  const e={root,kind,object,shadow:null,source:null,screen:null,image:null,pending:null};
  if(kind==='computer_desk'){e.source=prefabs.desk.clone(true);root.add(e.source);e.screen=cube(root,'computer screen',[0,-.12,1.94],[.47,.065,.34],dark);cube(root,'monitor stem',[0,-.12,1.66],[.04,.05,.20],edge);cube(root,'keyboard',[.12,.18,1.514],[.45,.16,.028],ceramic);}
  else if(kind==='cardboard_box'){e.source=prefabs.box.clone(true);root.add(e.source);}
  else if(kind==='water_bowl'||kind==='food_bowl'){e.source=prefabs.bowl.clone(true);root.add(e.source);if(kind==='food_bowl')e.source.traverse(o=>{if(sourceName(o)==='water surface')o.material=oak;});}
  else if(kind==='bed'||kind==='cushion'){
   // A rectangular soft bed has a compressed floor-height centre, not a raised rigid support.
   const vertices=[],indices=[];
   for(let row=0;row<=8;row++)for(let col=0;col<=8;col++){
    const x=col/8-.5,y=row/8-.5,edge=Math.max(Math.abs(x),Math.abs(y)),u=Math.max(0,(edge-.22)/.28),z=Math.sin(Math.PI*u)*.18;
    vertices.push(y,z*ZS,-x);
    if(row<8&&col<8){const i=row*9+col;indices.push(i,i+9,i+10,i,i+10,i+1);}
   }
   const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.setIndex(indices);geometry.computeVertexNormals();
   const cloth=linen.clone();cloth.side=THREE.DoubleSide;cloth.polygonOffset=true;cloth.polygonOffsetFactor=-1;cloth.polygonOffsetUnits=-1;
   const bed=new THREE.Mesh(geometry,cloth);bed.name='soft bed centre at floor';bed.castShadow=false;bed.receiveShadow=true;root.add(bed);
  }
  else if(kind==='cat_tree'){
   cube(root,'tree base',[0,0,.05],[.9,.9,.1],edge);disk(root,'sisal post',[0,0,1.25],.09,2.5,ceramic);
   for(const z of (object.levels||[]).map(l=>l.z-(object.z||0)))cube(root,'tree platform '+z,[0,0,z-.055],[.86,.78,.11],linen);
  }
  else if(kind==='wall_shelf'){cube(root,'shelf top at object elevation',[0,0,-.055],[.92,.76,.11],oak);cube(root,'shelf wall bracket',[0,-.25,-.20],[.10,.12,.30],edge);}
  else if(kind==='drawing_wall'){
   cube(root,'drawing frame',[-.43,0,2.7],[.08,.90,1.10],oak);cube(root,'paper drawing',[-.38,0,2.7],[.018,.76,.96],ceramic);
  }
  else if(kind==='slipper'){const o=new THREE.Mesh(new THREE.SphereGeometry(.45,16,8),linen);o.name='soft slipper';o.scale.set(.7,.18,1);o.position.y=.09*ZS;o.castShadow=o.receiveShadow=true;root.add(o);}
  else if(kind==='toy'||kind==='yarn_ball'){const o=new THREE.Mesh(new THREE.SphereGeometry(.27,16,10),material('muted yarn',0xaa8176));o.position.y=.27*ZS;o.castShadow=o.receiveShadow=true;root.add(o);}
  else if(kind==='image'){
   const img=new Image();e.image=img;e.pending='loading';img.onload=()=>{e.pending='ready';e.billboard=prepareBillboard(img,{w:img.naturalWidth,h:img.naturalHeight,foot:[img.naturalWidth/2,img.naturalHeight]});lastTime=null;};img.onerror=()=>{e.pending='failed';};img.src=object.sprite;
   cube(root,'parcel while gift image loads',[0,0,.20],[.65,.65,.4],material('paper parcel',0xc29d71));
  }
  else {cube(root,'parcel fallback',[0,0,.22],[.7,.7,.44],material('paper parcel',0xc29d71));}
  dressing.dressEntity(e);
  if(kind!=='drawing_wall'&&kind!=='wall_shelf')e.shadow=contact(1.18,1.18,.24);
  return e;
 }
 function updateObjects(objects,pose,carryingId){
  const ids=new Set();const records=[];
  for(const object of objects){
   if(objectVisualKind(object)==='env:sun')continue;
   const carried=object.status==='carried'||object.id===carryingId;
   if(!carried&&object.status&&object.status!=='placed')continue;
   ids.add(object.id);let e=entities.get(object.id);
   if(e&&e.kind!==objectVisualKind(object)){scene.remove(e.root);if(e.billboard)scene.remove(e.billboard);if(e.shadow)scene.remove(e.shadow);entities.delete(object.id);e=null;}
   if(!e){e=makeEntity(object);entities.set(object.id,e);}
   e.object=object;const b=objectBounds(object),quarter=Math.abs((object.rotation||0)%180)===90,fitW=quarter?b.depth:b.width,fitD=quarter?b.width:b.depth;let x=b.x,y=b.y,z=b.z;
   if(carried){x=pose.x+(pose.facing||1)*.22;y=pose.y-(pose.facing||1)*.22;z=pose.z+.8;}
   e.root.visible=true;e.root.position.copy(web(x,y,z));e.root.rotation.y=-(object.rotation||0)*Math.PI/180;e.root.scale.set(1,1,1);
   if(e.source){
    if(e.kind==='computer_desk'){
     const top=(object.levels||[]).find(l=>l.id==='top')?.z??z+1.5;
     e.source.scale.set(fitD/prefabs.desk.userData.extent.depth,(top-z)/1.84,fitW/prefabs.desk.userData.extent.width);
     for(const m of e.root.children){const offset={'computer screen':.44,'monitor stem':.16,'keyboard':.014}[m.name];if(offset!==undefined)m.position.y=(top-z+offset)*ZS;}
    }else if(e.kind==='cardboard_box')e.source.scale.set(fitD/prefabs.box.userData.extent.depth,1,fitW/prefabs.box.userData.extent.width);
    else e.source.scale.set(fitD/prefabs.bowl.userData.extent.depth,1,fitW/prefabs.bowl.userData.extent.width);
   }
   if(e.kind==='bed'||e.kind==='cushion'||e.kind==='slipper'||e.kind==='toy'||e.kind==='yarn_ball')e.root.scale.set(fitD,1,fitW);
   dressing.updateEntity(e,object,b,fitW,fitD,(object.levels||[]).find(l=>l.id==='top')?.z??z+1.5);
   if(e.billboard){
    const scale=Math.min(1,(b.width+b.depth)*16/e.image.naturalWidth);
    e.billboard.matrix.copy(pixelMatrix(x,y,z,1));e.billboard.matrix.scale(new THREE.Vector3(scale,scale,scale));e.billboard.visible=e.pending==='ready';e.root.visible=e.pending!=='ready';
   }
   if(e.screen){const active=pose.target===object.id&&pose.action==='use_computer';e.screen.material=active?material('active screen',0x739f91):dark;e.screen.material.emissive.set(active?0x31564b:0);e.screen.material.emissiveIntensity=active?.5:0;}
   if(e.shadow){e.shadow.visible=!carried;e.shadow.position.copy(web(x,y,z+.01));e.shadow.scale.set(b.depth, b.width,1);}
   records.push({id:object.id,kind:e.kind,x,y,z,footprint:[b.minX,b.minY,b.maxX,b.maxY],status:object.status||'placed',media:e.pending});
  }
  for(const [id,e] of entities)if(!ids.has(id)){e.root.visible=false;if(e.billboard)e.billboard.visible=false;if(e.shadow)e.shadow.visible=false;}
  return records;
 }
 function resize(){
  const available=document.documentElement.clientWidth,height=document.documentElement.clientHeight,logical=Math.min(W,Math.floor(available/2)*2),scale=Math.max(1,Math.min(2,Math.floor(available/W),Math.floor(height/H)));
  renderer.setSize(logical,H,false);raster.value.set(logical,H);canvas.style.width=logical*scale+'px';canvas.style.height=H*scale+'px';
  const span=logical/(16*Math.sqrt(2));camera.left=-span/2;camera.right=span/2;camera.top=H/(32*Math.sqrt(2));camera.bottom=-camera.top;camera.near=.1;camera.far=100;camera.updateProjectionMatrix();lastTime=null;
 }
 window.addEventListener('resize',resize);resize();
 function sampleFeet(){
  const result={};if(!activeActor||activeActor.userData.nori_pose!=='walk')return result;scene.updateMatrixWorld(true);
  for(const m of feet){const attr=Object.keys(m.geometry.attributes).find(k=>k.toLowerCase().includes('nori_foot'));if(!attr)continue;const a=m.geometry.attributes[attr];let i=0;while(i<a.count&&a.getX(i)<.5)i++;if(i===a.count)continue;result[m.userData.nori_foot]=world(m.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(m.matrixWorld));}return result;
 }
 function updateActor(pose,time,segments,anim,motion){
  const requested=canonicalPose(pose.pose,manifest),key=requested==='alert_loaf'?'sit':requested,root=actors.get(key)||fallbackTextures.get(key)||actors.get('sit');
  for(const actor of [...actors.values(),...fallbackTextures.values()])actor.visible=actor===root;
  activeActor=root;const entry=manifest[key]||manifest.sit,flip=pose.facing===(entry.native_facing||1)?1:-1;
  root.matrix.copy(pixelMatrix(pose.x,pose.y,pose.z+(pose.hop||0)/16,flip,1));
  root.traverse(o=>{
   if(o===root)return;if(o.userData.basePosition)o.position.copy(o.userData.basePosition);if(o.userData.baseQuaternion)o.quaternion.copy(o.userData.baseQuaternion);
   const name=o.userData.nori_part||'';
   if(name.endsWith(' head'))o.position.z-=motion.headBobPx||0;
   if(name.endsWith(' tail'))o.rotateY((motion.tailAngleDeg||0)*Math.PI/180);
  });
  for(const b of blink)b.visible=(anim.blink||0)>(b.userData.nori_blink_row+.5)/b.userData.nori_blink_total;
  scene.updateMatrixWorld(true);
  const targets=key==='walk'?walkFootTargets(segments,pose,time):{};
  if(key==='walk')for(const mesh of feet){
   const target=targets[mesh.userData.nori_foot];if(!target)continue;
   const key=Object.keys(mesh.geometry.attributes).find(k=>k.toLowerCase().includes('nori_foot')),a=mesh.geometry.attributes[key];let index=0;while(index<a.count&&a.getX(index)<.5)index++;
   mesh.morphTargetInfluences.fill(0);
   const base=mesh.getVertexPosition(index,new THREE.Vector3()),want=web(target.x,target.y,target.z).applyMatrix4(mesh.matrixWorld.clone().invert()),delta=want.sub(base);
   for(const [name,value] of [['foot_x',delta.x],['foot_y',-delta.z],['foot_z',delta.y]])mesh.morphTargetInfluences[mesh.morphTargetDictionary[name]]=value;
  }
  const support=contactPlane(pose,current.objects);bodyShadow.position.copy(web(pose.x,pose.y,support+.01));bodyShadow.material.opacity=.28/(1+Math.max(0,pose.z-support+(pose.hop||0)/16)*4);bodyShadow.visible=pose.part!=='inside';
  const actual=sampleFeet();for(let i=0;i<feet.length;i++){const mesh=feet[i],p=actual[mesh.userData.nori_foot],shadow=footShadows[i];shadow.visible=!!p;if(!p)continue;const h=contactPlane(p,current.objects),gap=Math.max(0,p.z-h);shadow.position.copy(web(p.x,p.y,h+.014));shadow.material.opacity=.32*Math.max(0,1-gap/.16);}
  const result={key,root:world(root.getWorldPosition(new THREE.Vector3())),targets,actual};
  if(debug){const b=new THREE.Box3().setFromObject(root,true);result.bounds={min:{x:-b.max.z,y:b.min.x,z:b.min.y/ZS},max:{x:-b.min.z,y:b.max.x,z:b.max.y/ZS}};result.matrix=root.matrixWorld.elements.slice();}
  return result;
 }
 function render(snapshot){
  current=snapshot;const {pose,objects,time,grid,view,anim,motion,segments,carryingId}=snapshot;if(!pose)return;
  // The server time drives both live and replay. No independent animation clock or world state.
  if(lastTime!==null&&Math.abs(time-lastTime)<30)return;lastTime=time;
  const shape=grid.w+':'+grid.h;if(shape!==lastShape){
   shell.visible=false;dressing.resize(grid);
   const center=web((grid.w-1)/2,(grid.h-1)/2,2.5);camera.position.copy(center).add(new THREE.Vector3(1,ZS,-1).normalize().multiplyScalar(30));camera.lookAt(center);camera.updateMatrixWorld(true);
   windowLight.position.copy(web(-.8,grid.h*.45,3.7));windowLight.lookAt(web(grid.w/2,grid.h/2,0));moon.position.copy(windowLight.position);moon.quaternion.copy(windowLight.quaternion);
   bounce.position.copy(web(grid.w/2,grid.h,8));bounce.lookAt(web(grid.w/2,grid.h/2,1));nightBounce.position.copy(bounce.position);nightBounce.quaternion.copy(bounce.quaternion);lastShape=shape;
  }
  const night=view?.sky==='night';nightUniform.value=night?1:0;sun.visible=windowLight.visible=bounce.visible=!night;moon.visible=nightBounce.visible=lamp.visible=night;
  dressing.mode(night);
  renderer.setClearColor(night?0x28252b:0xe5daca,1);canvas.style.background=night?'#28252b':'#e5daca';
  shell.traverse(o=>{if(o.userData.sky)o.material.color.set(night?0x52667c:0xc6d8c8);});
  const records=updateObjects(objects,pose,carryingId),desk=objects.find(o=>objectVisualKind(o)==='computer_desk'&&(!o.status||o.status==='placed'));
  if(desk){const b=objectBounds(desk),top=(desk.levels||[]).find(l=>l.id==='top')?.z??b.z+1.5;lamp.position.copy(web(b.x+.95*b.width/3.35,b.y-.35*b.depth/2.3,b.z+2.98*(top-b.z)/1.84));}
  else lamp.visible=false;
  for(const e of entities.values())e.root.traverse(o=>{if(sourceName(o)==='linen lamp'){o.material.emissive.set(0xebd6ab);o.material.emissiveIntensity=night?.65:.04;}});
  const actor=updateActor(pose,time,segments,anim,motion);
  if(debug)for(const record of records){
   const e=entities.get(record.id),box=new THREE.Box3().setFromObject(e.billboard?.visible?e.billboard:e.root,true);record.renderBounds={min:{x:-box.max.z,y:box.min.x,z:box.min.y/ZS},max:{x:-box.min.z,y:box.max.x,z:box.max.y/ZS}};
   record.supports=[];e.root.traverse(o=>{const name=sourceName(o);if(!o.isMesh)return;if(name==='low oak table'||name==='shelf top at object elevation'||name.startsWith('tree platform ')){const bounds=new THREE.Box3().setFromObject(o,true);record.supports.push({name,z:bounds.max.y/ZS});}if(name==='soft bed centre at floor'){const point=o.getVertexPosition(40,new THREE.Vector3()).applyMatrix4(o.matrixWorld);record.supports.push({name,z:point.y/ZS});}});
  }
  renderer.render(scene,camera);if(!ready){oldCanvas.hidden=true;oldCanvas.style.display='none';canvas.hidden=false;canvas.style.display='block';ready=true;}
  frameCount++;Object.assign(last,{time,mode:night?'night':'day',grid:{...grid},pose:{...pose},actor,objects:records,frames:frameCount,logical:[canvas.width,canvas.height],display:[canvas.getBoundingClientRect().width,canvas.getBoundingClientRect().height],drawCalls:renderer.info.render.calls});
 }
 canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();canvas.hidden=true;canvas.style.display='none';oldCanvas.hidden=false;oldCanvas.style.display='block';onFailure?.();});
 return {render,probe:()=>structuredClone(last),canvas,ready:()=>ready,finishFrame:()=>renderer.getContext().finish()};
}
