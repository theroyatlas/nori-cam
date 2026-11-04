import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// Isolated config directory: no project .env/.dev.vars files or account bindings.
const directory=new URL('../.wrangler/cam-smoke/',import.meta.url);
mkdirSync(directory,{recursive:true});
writeFileSync(new URL('empty-vars',directory),'');
writeFileSync(new URL('wrangler.json',directory),JSON.stringify({
  name:'nori-cam-offline-smoke',main:fileURLToPath(new URL('../src/worker/cam/smoke.ts',import.meta.url)),
  compatibility_date:'2026-10-01',
  d1_databases:[{binding:'DB',database_name:'cam-smoke',database_id:'00000000-0000-0000-0000-000000000001',migrations_dir:fileURLToPath(new URL('../migrations/',import.meta.url))}],
},null,2));
console.log(fileURLToPath(new URL('wrangler.json',directory)));
