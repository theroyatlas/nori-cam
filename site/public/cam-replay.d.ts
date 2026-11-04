export interface ReplayData { from:number;to:number;truncated?:boolean;objects?:any[];object_states?:any[];[key:string]:unknown }
export function replayObjectsAt(replay:ReplayData,metadata:any[],time:number):any[];
export function replayPoseAt(segments:any[],time:number):any;
export function replayEffectSegments(segments:any[],time:number):any[];
