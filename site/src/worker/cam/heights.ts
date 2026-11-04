import catalog from '../../../public/cam/catalog.json' with { type: 'json' };
import { operationCells, walkable } from '../../../public/cam-shared.js';
import type { CamObject, Cell, Level, Segment } from './types.ts';
// Prefab geometry is trusted catalog data, never a model-supplied height.
export function levels(o: CamObject): Level[] {
    if (o.origin?.type !== 'prefab')
        return [];
    const entry = catalog.entries.find(e => e.object.kind === o.kind);
    return (entry?.object as unknown as CamObject)?.levels || [];
}
export function enrichObject(o: CamObject): CamObject {
    return {
        ...o, levels: levels(o), ...(o.kind === 'wall_shelf' ? { wall_side: 'window' } : {})
    };
}
export function accessObject(o: CamObject, objects: CamObject[]): CamObject | undefined {
    const required = levels(o).at(-1)?.requires;
    return required ? objects.find(t => t.kind === required.kind && t.status === 'placed' &&
        Math.abs(t.x - o.x) + Math.abs(t.y - o.y) <= 1 && levels(t).some(l => l.id === required.level)) : o;
}
export function climbRoute(o: CamObject, objects: CamObject[]): {
    object: CamObject;
    level: Level;
}[] {
    const access = accessObject(o, objects);
    if (!access)
        return [];
    const chain = access.id === o.id ? [] : climbRoute(access, objects);
    return [...chain, ...levels(o).map(level => ({ object: o, level }))];
}
export function supports(objects: CamObject[], cell: Cell, z: number) {
    return z === 0 || objects.some(o => o.status === 'placed' && o.x === cell[0] && o.y === cell[1] &&
        levels(o).some(l => l.z === z));
}
export function descent(objects: CamObject[], cell: Cell, z: number) {
    const floorDrop = () => {
        if (z <= 0)
            return [];
        const floor = walkable({ objects }).sort((a, b) => Math.abs(a[0] - cell[0]) + Math.abs(a[1] - cell[1]) -
            Math.abs(b[0] - cell[0]) - Math.abs(b[1] - cell[1]))[0];
        return floor ? [{ cell: floor, z: 0, target: 'floor', part: 'floor' }] : [];
    };
    const o = objects.find(o => o.status === 'placed' && o.x === cell[0] && o.y === cell[1] &&
        levels(o).some(l => l.z === z));
    if (!o)
        return floorDrop();
    const route = climbRoute(o, objects);
    const index = route.findIndex(r => r.object.id === o.id && r.level.z === z);
    const access = accessObject(o, objects);
    if (!access || index < 0)
        return floorDrop();
    const floor = operationCells(access, 'top', { objects })[0];
    if (!floor)
        return [];
    return [
        ...route.slice(0, index).reverse().map(r => ({
            cell: [r.object.x, r.object.y] as Cell, z: r.level.z, target: r.object.id, part: r.level.part,
        })), { cell: floor, z: 0, target: access.id, part: 'floor' }
    ];
}
// Height metadata travels in effects, preserving the existing database schema.
export function heightSegment(s: Segment, from: number, to: number): Segment {
    return {
        ...s, z: to, z_from: from, z_to: to,
        effects: [
            ...s.effects.filter(e => e.e !== 'height'), { e: 'height', z_from: from, z_to: to }
        ]
    };
}
export function decodeHeight(s: Segment): Segment {
    const h = s.effects.find(e => e.e === 'height');
    return h ? { ...s, z_from: h.z_from, z_to: h.z_to } : s;
}
export async function heightResponse(response: Response) {
    if (response.status !== 200)
        return response;
    const data = await response.json() as {
        objects: CamObject[];
        segments: Segment[];
    };
    data.objects = data.objects.map(o => {
        const prefab = catalog.entries.find(e => e.object.id === o.id && e.object.kind === o.kind)?.object;
        return {
            ...o, levels: prefab ? levels({ ...o, origin: { type: 'prefab' } }) : [], parts: prefab?.card.parts || []
        };
    });
    for (const o of data.objects)
        if (o.kind === 'wall_shelf')
            o.wall_side = 'window';
    data.segments = data.segments.map(decodeHeight);
    return new Response(JSON.stringify(data), { status: response.status, headers: response.headers });
}
