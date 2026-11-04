import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { initialState } from '../src/worker/cam/engine.ts';
import type { Env } from '../src/worker/api.ts';
export const NOW=Date.UTC(2026,10,2,12);
// Real SQLite statements and transactions, with the small async D1 API surface.
export function database(at=NOW,allMigrations=false) {
 const sql=new DatabaseSync(':memory:');
 const files=allMigrations?readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort():['0002_cam.sql','0003_cam_seed.sql'];
 for(const file of files) sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 sql.prepare('UPDATE world SET timeline_until=?,state_json=?').run(at,JSON.stringify(initialState(at)));
 class Statement {
  values:unknown[]=[];
  constructor(public query:string){}
  bind(...values:unknown[]) {this.values=values;return this;}
  execute() {const s=sql.prepare(this.query);if(s.columns().length)return {results:s.all(...this.values as never[]),meta:{changes:0}};const r=s.run(...this.values as never[]);return {results:[],meta:{changes:Number(r.changes)}};}
  async first(){return this.execute().results[0]??null;}
  async all(){return this.execute();}
  async run(){return this.execute();}
 }
 const db={prepare:(q:string)=>new Statement(q),async batch(statements:Statement[]){sql.exec('BEGIN');try{const r=statements.map(s=>s.execute());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}} as unknown as D1Database;
 return {sql,db,env:{DB:db} as Env};
}