export interface MiniObject { id?:string; x:number; y:number; z?:number; footprint?:number[][]; sprite?:string; kind?:string; status?:string; levels?:{z:number;id?:string}[]; [key:string]:unknown }
export interface MiniPose { x:number; y:number; z:number; facing?:number; pose?:string }
export function objectBounds(object:MiniObject):{minX:number;maxX:number;minY:number;maxY:number;x:number;y:number;width:number;depth:number;z:number};
export function objectVisualKind(object:MiniObject):string;
export function contactPlane(pose:MiniPose,objects:MiniObject[]):number;
export function canonicalPose(name:string,manifest:Record<string,unknown>):string;
export function walkFootTargets(segments:any[],pose:MiniPose,time:number):Record<string,{x:number;y:number;z:number;stance:boolean}>;
