import {writeFileSync} from 'node:fs';
import {EXECUTOR} from '../public/cam-shared.js';
writeFileSync(new URL('../public/cam/executor.json',import.meta.url),JSON.stringify(EXECUTOR,null,2)+'\n');
