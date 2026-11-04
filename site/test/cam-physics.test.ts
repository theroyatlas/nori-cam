import {describe,it,expect} from 'vitest';
import catalog from '../public/cam/catalog.json';
import {applyEffects,cellsOf,placementOk} from '../public/cam-shared.js';
import {rng} from '../src/worker/cam/rng.ts';
import {simulatePush} from '../src/worker/cam/physics.ts';
import type {CamObject,Segment} from '../src/worker/cam/types.ts';

const objects=()=>structuredClone(catalog.entries.map(e=>e.object)) as unknown as CamObject[];
const setup=()=>{const all=objects(), object=all.find(o=>o.kind==='slipper')!;return {object,world:{objects:all}};};
const input=()=>({...setup(),velocity:[8,0] as [number,number]});

describe('fixed step object physics',()=>{
  it('serializes identical inputs identically and emits an applicable effect',()=>{
    const a=input(), result=simulatePush(a);
    expect(JSON.stringify(result)).toBe(JSON.stringify(simulatePush(a)));
    const last=result.keyframes.at(-1)!;
    const seg={id:1,end_at:last.at_ms,cut_at:null,superseded_at:null,effects:[result.effect]} as Segment;
    const moved=applyEffects(a.world.objects,[seg],last.at_ms).find(o=>o.id===a.object.id)!;
    expect([moved.x,moved.y]).toEqual([last.x,last.y]);
    expect(result.effect.at_ms).toBe(last.at_ms);
    console.log('slipper example',JSON.stringify(result.keyframes));
  });
  it('keeps 1000 seeded trajectories, including interpolated points, clear and legally placed',()=>{
    const seeds=[1,42,999,0xdeadbeef];
    for(const seed of seeds){
      const random=rng(seed);
      for(let i=0;i<250;i++){
        const a=setup(), velocity:[number,number]=[Math.floor(random()*101)-50,Math.floor(random()*101)-50];
        const result=simulatePush({...a,velocity});
        const others=a.world.objects.filter(o=>o.id!==a.object.id && o.blocks).flatMap(cellsOf);
        for(let k=0;k<result.keyframes.length;k++){
          const f=result.keyframes[k], prev=result.keyframes[Math.max(0,k-1)];
          expect([f.x,f.y,f.z,f.at_ms].every(Number.isFinite)).toBe(true);
          for(let s=0;s<=8;s++){
            const x=prev.x+(f.x-prev.x)*s/8, y=prev.y+(f.y-prev.y)*s/8;
            expect(x>=0 && x<=9 && y>=0 && y<=7).toBe(true);
            for(const [ox,oy] of others) expect(Math.abs(x-ox)>=1 || Math.abs(y-oy)>=1).toBe(true);
          }
        }
        const last=result.keyframes.at(-1)!;
        expect(placementOk(a.world,{...a.object,x:last.x,y:last.y}).ok).toBe(true);
      }
    }
  });
  it('bounces at decreasing heights and comes to rest',()=>{
    const result=simulatePush({...setup(),velocity:[0,0],dropHeight256:1024});
    const f=result.keyframes, peaks:number[]=[];
    for(let i=1;i<f.length-1;i++) if(f[i].z>f[i-1].z && f[i].z>=f[i+1].z) peaks.push(f[i].z);
    expect(peaks.length).toBeGreaterThanOrEqual(2);
    expect(peaks.every((p,i)=>i===0 || p<peaks[i-1])).toBe(true);
    expect(f.at(-1)!.z).toBe(0);
  });
  it('retraces the path when the nearest cell would occupy Nori',()=>{
    const a=setup(); const world={...a.world,nori:{x:4,y:2}};
    const result=simulatePush({...a,world,velocity:[15,0]});
    const frames=result.keyframes, last=frames.at(-1)!;
    expect(Math.max(...frames.map(f=>f.x))).toBeGreaterThan(3.5);
    expect([last.x,last.y]).toEqual([3,2]);
    expect(placementOk(world,{...a.object,x:last.x,y:last.y}).ok).toBe(true);
    expect(result.effect.dx).toBe(0);
  });
  it('sweeps multi-cell footprints at the maximum speed',()=>{
    const a=setup(); a.object.footprint=[[0,0],[1,0]];
    const blocker={...a.object,id:'blocker',x:6,y:2,footprint:[[0,0] as [number,number]]};
    a.world.objects.push(blocker);
    const frames=simulatePush({...a,velocity:[1000,0]}).keyframes;
    expect(frames.some(f=>f.x>3)).toBe(true);
    expect(frames.every(f=>f.x<=4)).toBe(true);
  });
  it('rejects immovable and invalid input',()=>{
    const a=setup(), bed=a.world.objects.find(o=>o.kind==='bed')!;
    expect(()=>simulatePush({...a,object:bed,velocity:[1,0]})).toThrow();
    expect(()=>simulatePush({...a,velocity:[NaN,0]})).toThrow();
    expect(()=>simulatePush({...a,velocity:[0,0],dropHeight256:-1})).toThrow();
  });
  it('measures median push time',()=>{
    const a=input(); for(let i=0;i<100;i++) simulatePush(a);
    const times:number[]=[];
    for(let i=0;i<501;i++){const start=performance.now();simulatePush(a);times.push(performance.now()-start);}
    times.sort((x,y)=>x-y); const median=times[250];
    console.log(`physics median push: ${median.toFixed(4)} ms`);
    expect(median).toBeLessThan(5);
  });
});
