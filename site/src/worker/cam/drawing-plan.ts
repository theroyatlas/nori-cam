import { bfsPath, operationCells } from '../../../public/cam-shared.js';
import { safeSegment } from './timeline.ts';
import type { CamObject, Cell, Segment } from './types.ts';

// Existing primitives only: move_to and hold_pose. No new renderer action or prop pose.
export function canDrawingSequence(objects: CamObject[], position: Cell): boolean {
  for (const kind of ['computer_desk', 'drawing_wall']) {
    const target = objects.find(o => o.kind === kind && o.status === 'placed');
    if (!target) return false;
    const routes = operationCells(target, undefined, { objects }).map(c => bfsPath({ objects }, position, c))
      .filter((p): p is Cell[] => !!p);
    if (!routes.length) return false;
  }
  return true;
}
export function drawingSequence(objects: CamObject[], position: Cell, at: number, id: number, version: number, source: string) {
  const segments: Segment[] = [];
  for (const kind of ['computer_desk', 'drawing_wall']) {
    const target = objects.find(o => o.kind === kind && o.status === 'placed');
    if (!target) throw new Error('drawing_target_unavailable');
    const routes = operationCells(target, undefined, { objects }).map(c => bfsPath({ objects }, position, c))
      .filter((p): p is Cell[] => !!p).sort((a, b) => a.length - b.length);
    if (!routes.length) throw new Error('drawing_route_unavailable');
    const route = routes[0];
    if (route.length > 1) {
      const walk = safeSegment(at, at + (route.length - 1) * 667, id++, version, position, source);
      walk.path = route;
      walk.action = 'walk';
      walk.primitive = 'move_to';
      walk.pose = 'walk';
      walk.target = target.id;
      segments.push(walk);
      at = walk.end_at;
      position = route.at(-1)!;
    }
    const hold = safeSegment(at, at + 3000, id++, version, position, source);
    hold.action = kind === 'computer_desk' ? 'sketch' : 'pin_drawing';
    hold.target = target.id;
    hold.pose = 'look_up';
    segments.push(hold);
    at = hold.end_at;
  }
  return segments;
}
