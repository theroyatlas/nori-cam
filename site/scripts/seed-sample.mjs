// Copy the FAKE sample data (site/sample/data) into site/public/data so the journal and posts pages run locally.
// Only the pages' data files are copied; demo-events.json and demo-examples.json in public/data are never touched.
// Files that already exist are overwritten (the copies are git-ignored); nothing is deleted.
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const from = (n) => fileURLToPath(new URL(`sample/data/${n}`, root));
const to = (n) => fileURLToPath(new URL(`public/data/${n}`, root));
for (const n of ['journal.json', 'posts.json', 'experiences.json', 'media-manifest.json']) {
  if (!existsSync(from(n))) throw new Error(`missing ${from(n)}; run: python app/scripts/make_site_sample.py`);
  copyFileSync(from(n), to(n));
  console.log('seeded', n);
}
