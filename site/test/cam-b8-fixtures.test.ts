import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {cellsOf,placementOk,walkable} from '../public/cam-shared.js';

// B8: the two full-room fixtures must describe a legal room. Segments are read
// against the fixture's own objects with the same geometry the Worker uses
// (cellsOf/walkable/placementOk in cam-shared.js). Climbs, high places and
// enclosed boxes are entered on purpose, so their path cells are not floor cells.
const FIXTURES=['../public/cam/fixture/now.json','../test/fixtures/cam-live-real.json'];
const key=(c:number[])=>c.join(',');
function enteredByDesign(seg:any,byId:Map<string,any>){
 if(seg.primitive==='climb') return true;
 const target=seg.target?byId.get(seg.target):null;
 return !!target&&(target.tags||[]).some((t:string)=>t==='enclosed'||t==='high_place');
}
describe.each(FIXTURES)('B8 full-room fixture %s',(rel)=>{
 const fx=JSON.parse(readFileSync(new URL(rel,import.meta.url),'utf8'));
 const objects:any[]=fx.objects;
 const byId=new Map(objects.map((o:any)=>[o.id,o]));
 it('includes every placed seeded world object from the catalog',()=>{
  const catalog=JSON.parse(readFileSync(new URL('../public/cam/catalog.json',import.meta.url),'utf8'));
  for(const {object:o} of catalog.entries){
   if(o.status!=='placed') continue;
   // now.json keeps its own box, o_box1, which the walk/hop/sleep beat targets; it is the seeded cardboard box.
   const id=(rel.includes("now.json")&&o.id==="o_cardboard_box")?"o_box1":o.id;
   const got=byId.get(id);
   expect(got,o.id).toBeDefined();
   expect(got.kind).toBe(o.kind);
   expect([got.x,got.y,got.z]).toEqual([o.x,o.y,o.z]);
   expect(got.placement).toBe(o.placement);
   expect(got.levels??null).toEqual(o.levels??null);
  }
 });
 it('every object passes placement against the others',()=>{
  for(const o of objects){
   const others=objects.filter(x=>x!==o);
   const r=placementOk({objects:others},o);
   expect(r.ok,`${o.id}: ${r.reason??''}`).toBe(true);
  }
 });
 it('every segment position is a legal floor cell, not inside a blocking object',()=>{
  const blocked=new Set(objects.filter(o=>o.blocks).flatMap(cellsOf).map(key));
  const free=new Set(walkable({objects}).map(key));
  const bad:string[]=[];
  for(const seg of fx.segments){
   if(enteredByDesign(seg,byId)) continue;
   for(const c of seg.path||[]){
    if(!free.has(key(c))||blocked.has(key(c))) bad.push(`${seg.id}:${seg.action}@${key(c)}`);
   }
  }
  expect(bad).toEqual([]);
 });
});
