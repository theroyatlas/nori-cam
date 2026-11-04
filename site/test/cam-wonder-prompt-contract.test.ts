import {it,expect} from 'vitest';
import {database,NOW} from '../scripts/cam-test-db.ts';
import {brainContext} from '../src/worker/cam/inspect.ts';
import {snapshot} from '../src/worker/cam/store.ts';
import {validateWonderResult} from '../src/worker/cam/spark-validate.ts';

it('Wonder sees the object capability fields required by the unchanged validator',async()=>{
 const {db,env,sql}=database(NOW,true);
 const context=await brainContext(env as any,NOW),snap=await snapshot(db,NOW);
 expect(context.objects.length).toBeGreaterThan(0);
 for(const object of context.objects){
  const actual=snap.objects.find(o=>o.id===object.id)!;
  expect(object.size).toBe(actual.size);
  expect(object.origin_type).toBe(actual.origin?.type);
  expect(object.prop_poses).toEqual(actual.card.prop_poses||[]);
 }
 sql.close();
});

it('one exact experience event is enough; schema drift and invalid world actions remain rejected',async()=>{
 const {db,sql}=database(NOW,true),snap=await snapshot(db,NOW),object=snap.objects.find(o=>o.status==='placed')!;
 const event='experience_settled:actual:0:7';
 const result={reflection:{summary:'I examined the object.',event_ids:[event]},tomorrow:{action:'sniff',object_id:object.id,
  window_minutes:120,reason_tag:'revisit',summary:'Examine this same object again.'},habit_candidate:null};
 expect(validateWonderResult(result,snap,NOW,[event])).toEqual({valid:true,errors:[]});
 expect(validateWonderResult({...result,reflection:{...result.reflection,event_ids:['exp:actual']}},snap,NOW,[event]).valid).toBe(false);
 expect(validateWonderResult({...result,tomorrow:{...result.tomorrow,confidence:.9}},snap,NOW,[event]).valid).toBe(false);
 expect(validateWonderResult({...result,tomorrow:{...result.tomorrow,object_id:'invented'}},snap,NOW,[event]).errors).toContain('object_not_placed');
 sql.close();
});
