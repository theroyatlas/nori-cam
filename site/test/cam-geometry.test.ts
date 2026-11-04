import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {cellsOf,placementOk,bfsPath,lightAt,sunPatchAt,applyEffects} from '../public/cam-shared.js';
import catalog from '../public/cam/catalog.json';
import type {CamObject} from '../src/worker/cam/types.ts';
const box=()=>structuredClone(catalog.entries[0].object) as unknown as CamObject;
describe('cam geometry',()=>{
 it('rotates relative cells without changing input',()=>{const b=box();b.footprint=[[0,0],[1,0]];b.rotation=90;expect(cellsOf(b)).toEqual([[6,4],[6,5]]);expect(b.footprint).toEqual([[0,0],[1,0]]);});
 it('excludes carried footprints',()=>{const b=box();b.status='carried';expect(cellsOf(b)).toEqual([]);});
 it('accepts a free placement; rejects bounds, overlap and Nori collision',()=>{const b=box();expect(placementOk({objects:[]},b).ok).toBe(true);expect(placementOk({objects:[]},{...b,x:10}).ok).toBe(false);expect(placementOk({objects:[{...b,id:'other'}]},b).ok).toBe(false);expect(placementOk({objects:[],nori:{x:6,y:4}},b).ok).toBe(false);});
 it('allows nonblocking overlap',()=>{const b=box();expect(placementOk({objects:[{...b,id:'other'}]},{...b,blocks:false}).ok).toBe(true);});
 it('rejects a wall that disconnects the room',()=>{const b=box();b.x=5;b.y=0;b.footprint=Array.from({length:8},(_,y)=>[0,y]);expect(placementOk({objects:[]},b).reason).toBe('disconnected room');});
 it('returns 409 when no cell remains',()=>{const b=box();b.x=0;b.y=0;b.footprint=Array.from({length:80},(_,i)=>[i%10,Math.floor(i/10)]);expect(placementOk({objects:[]},b).status).toBe(409);});
 it('BFS routes around blocking cells',()=>{const b=box(),path=bfsPath({objects:[b]},[5,4],[7,4])!;expect(path.length).toBe(5);expect(path).not.toContainEqual([6,4]);expect(bfsPath({objects:[b]},[5,4],[6,4])).toBeNull();});
 it.each([[0,'night'],[7,'morning'],[12,'day'],[16,'evening'],[20,'night']])('London 2026-11-02 at %i has phase %s',(h,phase)=>{expect(lightAt(Date.UTC(2026,10,2,Number(h))).phase).toBe(phase);});
 it('NOAA winter spot values and moving sun patch',()=>{const noon=Date.UTC(2026,10,2,12);expect(lightAt(noon).altitude).toBeCloseTo(23.9,0);expect(lightAt(noon).azimuth).toBeGreaterThan(180);expect(sunPatchAt(noon)).not.toBeNull();expect(sunPatchAt(noon,{cloud_pct:90})).toBeNull();expect(sunPatchAt(noon+12*3600000)).toBeNull();expect(sunPatchAt(noon-3600000)!.x).toBeGreaterThan(sunPatchAt(noon+3600000)!.x);});

 it('migration creates all 14 tables idempotently offline',()=>{const db=new DatabaseSync(':memory:');try{const sql=readFileSync(new URL('../migrations/0002_cam.sql',import.meta.url),'utf8');db.exec(sql);db.exec(sql);const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();expect(rows).toHaveLength(14);const columns=db.prepare('PRAGMA table_info(segments)').all().map(r=>r.name);expect(columns).toEqual(expect.arrayContaining(['cut_at','settled_at','superseded_at','trigger_status']));}finally{db.close();}});
});
