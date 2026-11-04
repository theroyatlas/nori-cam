import type {PropObject} from './cam-props.js';
interface CarrySegment {id:number;start_at:number;end_at:number;cut_at?:number|null;superseded_at?:number|null;primitive?:string|null;carrying?:string|null;target?:string|null}
export declare function carryPresentation<T extends PropObject>(objects: readonly T[],segments: readonly CarrySegment[],time:number): {carried:T|null;floorObjects:readonly T[]};
