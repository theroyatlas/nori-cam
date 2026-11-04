// Builds the R40 observatory room into site/public so the Worker serves it as plain static files:
//   public/cam-observatory.js        esbuild bundle of observatory/observatory.js (same options as app/cam/observatory_assets.py)
//   public/observatory/room.glb      observatory/model/room.glb with its embedded PNGs moved out to files
//   public/observatory/tex/*.png     those PNGs
//   public/observatory/room-contract.json
// The PNGs leave the GLB because the site CSP (public/_headers, src/worker/headers.ts) allows images and fetches from
// 'self' only; GLTFLoader would otherwise load embedded images through blob: URLs, which that CSP blocks.
import {readFileSync,writeFileSync,copyFileSync,existsSync,mkdirSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const site=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dependencies=resolve(site,'node_modules');
if(!existsSync(resolve(dependencies,'three')))throw Error('Run npm ci in site before building.');
const version=JSON.parse(readFileSync(resolve(dependencies,'three/package.json'),'utf8')).version;if(version!=='0.187.0')throw Error('Expected Three.js 0.187.0');
const model=resolve(site,'observatory/model'),out=resolve(site,'public/observatory');

export function externalizeGlbImages(glb,prefix){
 if(glb.readUInt32LE(0)!==0x46546c67||glb.readUInt32LE(4)!==2)throw Error('not a glTF 2 binary');
 const jsonLen=glb.readUInt32LE(12);if(glb.readUInt32LE(16)!==0x4e4f534a)throw Error('first chunk is not JSON');
 const json=JSON.parse(glb.subarray(20,20+jsonLen).toString('utf8'));
 const binStart=20+jsonLen;const binLen=glb.readUInt32LE(binStart);if(glb.readUInt32LE(binStart+4)!==0x004e4942)throw Error('second chunk is not BIN');
 const bin=glb.subarray(binStart+8,binStart+8+binLen);
 const views=json.bufferViews||[],images=json.images||[],files=[];
 const imageViews=new Set();
 images.forEach((img,i)=>{if(img.bufferView===undefined)return;const v=views[img.bufferView];if((v.buffer??0)!==0)throw Error('image outside buffer 0');
  const ext=img.mimeType==='image/jpeg'?'jpg':'png',name=`${prefix}${i}.${ext}`;
  files.push({name,bytes:Buffer.from(bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength))});
  imageViews.add(img.bufferView);delete img.bufferView;delete img.mimeType;img.uri=name;});
 const remap=new Map(),kept=[],chunks=[];let offset=0;
 views.forEach((v,i)=>{if(imageViews.has(i))return;if((v.buffer??0)!==0)throw Error('bufferView outside buffer 0');
  const pad=(16-offset%16)%16;if(pad){chunks.push(Buffer.alloc(pad));offset+=pad;}
  chunks.push(Buffer.from(bin.subarray(v.byteOffset||0,(v.byteOffset||0)+v.byteLength)));
  remap.set(i,kept.length);kept.push({...v,buffer:0,byteOffset:offset});offset+=v.byteLength;});
 for(const a of json.accessors||[]){if(a.bufferView!==undefined)a.bufferView=remap.get(a.bufferView);
  if(a.sparse){a.sparse.indices.bufferView=remap.get(a.sparse.indices.bufferView);a.sparse.values.bufferView=remap.get(a.sparse.values.bufferView);}}
 if(JSON.stringify(json.extensions||{}).includes('bufferView')||(json.meshes||[]).some(m=>JSON.stringify(m).includes('bufferView')))throw Error('unexpected bufferView reference');
 json.bufferViews=kept;let newBin=Buffer.concat(chunks);newBin=Buffer.concat([newBin,Buffer.alloc((4-newBin.length%4)%4)]);json.buffers=[{byteLength:newBin.length}];
 let text=Buffer.from(JSON.stringify(json),'utf8');text=Buffer.concat([text,Buffer.alloc((4-text.length%4)%4,0x20)]);
 const head=Buffer.alloc(12);head.writeUInt32LE(0x46546c67,0);head.writeUInt32LE(2,4);head.writeUInt32LE(12+8+text.length+8+newBin.length,8);
 const ch=(len,type)=>{const b=Buffer.alloc(8);b.writeUInt32LE(len,0);b.writeUInt32LE(type,4);return b;};
 return {glb:Buffer.concat([head,ch(text.length,0x4e4f534a),text,ch(newBin.length,0x004e4942),newBin]),files};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const {build}=await import(pathToFileURL(resolve(dependencies,'esbuild/lib/main.js')));
 await build({entryPoints:[resolve(site,'observatory/observatory.js')],nodePaths:[dependencies],bundle:true,format:'esm',target:'chrome120',
  platform:'browser',minify:true,legalComments:'inline',outfile:resolve(site,'public/cam-observatory.js')});
 rmSync(out,{recursive:true,force:true});mkdirSync(resolve(out,'tex'),{recursive:true});
 const {glb,files}=externalizeGlbImages(readFileSync(resolve(model,'room.glb')),'tex/room-');
 for(const f of files)writeFileSync(resolve(out,f.name),f.bytes);
 writeFileSync(resolve(out,'room.glb'),glb);copyFileSync(resolve(model,'room-contract.json'),resolve(out,'room-contract.json'));
 console.log(`Built cam-observatory.js and observatory/ (room.glb ${glb.length} bytes, ${files.length} textures) using Three.js ${version}`);
}
