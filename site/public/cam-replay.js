// Historical geometry comes only from the replay snapshot/history, never from current positions.
import {poseAt} from './cam-shared.js';
import {holdPoseName} from './cam-live.js';

export function replayPoseAt(segments,time){
  const end=s=>Math.min(s.end_at,s.cut_at??Infinity);
  const valid=segments.filter(s=>end(s)>s.start_at).sort((a,b)=>a.start_at-b.start_at||a.id-b.id);
  const active=valid.filter(s=>time>=s.start_at&&time<end(s)).at(-1);
  if(active)return poseAt([active],time); // Retain original duration/speed before a cut.
  const previous=valid.filter(s=>end(s)<=time).sort((a,b)=>end(a)-end(b)||a.id-b.id).at(-1);
  if(previous){const pose=poseAt([previous],Math.max(previous.start_at,end(previous)-.001));return {...pose,pose:holdPoseName(pose.pose),hop:0,held:true};}
  return valid.length?poseAt([valid[0]],time):null;
}

export function replayEffectSegments(segments,time){
  return segments.filter(s=>s.cut_at==null||time<s.cut_at).map(s=>s.cut_at==null?s:{...s,cut_at:null});
}

export function replayObjectsAt(replay, metadata, time) {
  if (replay.truncated) throw new Error('Replay range is truncated. Choose a shorter range.');
  if (!Number.isFinite(time) || time < replay.from || time > replay.to) throw new RangeError('Time is outside the replay range.');
  const base = new Map((replay.objects || []).map(o => [o.id, {...o}]));
  const cards = new Map((metadata || []).map(o => [o.id, o]));
  for (const state of [...(replay.object_states || [])].sort((a,b)=>a.valid_from-b.valid_from||a.id-b.id)) {
    if (state.valid_from > time) break;
    const id=state.object_id;
    let object=base.get(id);
    if(!object){
      const card=cards.get(id)||{};
      const kind=typeof state.sprite==='string'&&state.sprite.startsWith('procedural:')?state.sprite.slice(11):(card.kind||'unknown');
      object={id,kind,levels:card.levels||[],placement:card.placement||'floor',size:card.size||'M'};
    }
    const next={...object};
    for(const key of ['x','y','z','footprint','rotation','status','state','sprite'])if(state[key]!==undefined)next[key]=state[key];
    if(typeof next.footprint==='string')next.footprint=JSON.parse(next.footprint);
    base.set(id,next);
  }
  return [...base.values()];
}
