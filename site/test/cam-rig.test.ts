import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSES } from '../public/cam-shared.js';

const rigUrl = new URL('../public/cam/rig.json', import.meta.url);
const spritesDirUrl = new URL('../public/room/sprites/', import.meta.url);
const rig = JSON.parse(readFileSync(rigUrl, 'utf8'));

const ALLOWED_PARTS = new Set(['head', 'body', 'tail', 'ear_l', 'ear_r', 'paw_fl', 'paw_fr']);

function pngDimensions(buf: Buffer): { w: number; h: number } {
  // PNG signature is 8 bytes, followed by IHDR chunk (length 4, 'IHDR' 4, width 4, height 4)
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  return { w, h };
}

describe('cam rig.json schema and geometry', () => {
  it('includes all 7 core cam poses plus generic section 4.3 poses', () => {
    for (const pose of POSES) {
      expect(rig).toHaveProperty(pose);
    }
    expect(Object.keys(rig).length).toBeGreaterThanOrEqual(7);
  });

  it('verifies every pose source file exists and its sha256 and dimensions match', () => {
    for (const [pose, entry] of Object.entries<any>(rig)) {
      expect(entry.source, `${pose} missing source`).toBeDefined();
      const file = entry.source.file;
      expect(typeof file).toBe('string');
      expect(file.endsWith('.png')).toBe(true);

      const fileUrl = new URL(file, spritesDirUrl);
      expect(existsSync(fileUrl), `${pose} source ${file} does not exist`).toBe(true);

      const bytes = readFileSync(fileUrl);
      const actualSha = createHash('sha256').update(bytes).digest('hex');
      expect(entry.source.sha256, `${pose} sha256 mismatch`).toBe(actualSha);

      const { w, h } = pngDimensions(bytes);
      if (typeof entry.source.w === 'number') {
        expect(entry.source.w, `${pose} width mismatch`).toBe(w);
      }
      if (typeof entry.source.h === 'number') {
        expect(entry.source.h, `${pose} height mismatch`).toBe(h);
      }
    }
  });

  it('keeps all part polygons (<= 16 points) inside source image bounds', () => {
    for (const [pose, entry] of Object.entries<any>(rig)) {
      const bytes = readFileSync(new URL(entry.source.file, spritesDirUrl));
      const { w, h } = pngDimensions(bytes);
      const parts = entry.parts;
      expect(parts && typeof parts === 'object', `${pose} missing parts`).toBe(true);
      expect(Object.keys(parts).length).toBeGreaterThanOrEqual(2);

      for (const [partName, part] of Object.entries<any>(parts)) {
        expect(ALLOWED_PARTS.has(partName), `${pose} has unknown part ${partName}`).toBe(true);
        expect(Array.isArray(part.polygon), `${pose}.${partName} polygon not array`).toBe(true);
        expect(part.polygon.length).toBeGreaterThanOrEqual(3);
        expect(part.polygon.length).toBeLessThanOrEqual(16);
        expect(typeof part.z).toBe('number');

        for (const pt of part.polygon) {
          expect(Array.isArray(pt) && pt.length === 2, `${pose}.${partName} invalid point`).toBe(true);
          const [x, y] = pt;
          expect(x, `${pose}.${partName} x=${x} out of 0..${w}`).toBeGreaterThanOrEqual(0);
          expect(x, `${pose}.${partName} x=${x} out of 0..${w}`).toBeLessThanOrEqual(w);
          expect(y, `${pose}.${partName} y=${y} out of 0..${h}`).toBeGreaterThanOrEqual(0);
          expect(y, `${pose}.${partName} y=${y} out of 0..${h}`).toBeLessThanOrEqual(h);
        }
      }
    }
  });

  it('places every part pivot inside its polygon bounding box', () => {
    for (const [pose, entry] of Object.entries<any>(rig)) {
      for (const [partName, part] of Object.entries<any>(entry.parts)) {
        expect(Array.isArray(part.pivot) && part.pivot.length === 2, `${pose}.${partName} invalid pivot`).toBe(true);
        const [px, py] = part.pivot;
        const xs = part.polygon.map((p: [number, number]) => p[0]);
        const ys = part.polygon.map((p: [number, number]) => p[1]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);

        expect(px, `${pose}.${partName} pivot x=${px} outside [${minX}, ${maxX}]`).toBeGreaterThanOrEqual(minX);
        expect(px, `${pose}.${partName} pivot x=${px} outside [${minX}, ${maxX}]`).toBeLessThanOrEqual(maxX);
        expect(py, `${pose}.${partName} pivot y=${py} outside [${minY}, ${maxY}]`).toBeGreaterThanOrEqual(minY);
        expect(py, `${pose}.${partName} pivot y=${py} outside [${minY}, ${maxY}]`).toBeLessThanOrEqual(maxY);
      }
    }
  });

  it('constrains rotation limits within 0..15 degrees and non-negative translation limits', () => {
    for (const [pose, entry] of Object.entries<any>(rig)) {
      for (const [partName, part] of Object.entries<any>(entry.parts)) {
        const lim = part.limits;
        expect(lim && typeof lim === 'object', `${pose}.${partName} missing limits`).toBe(true);
        expect(typeof lim.rot_deg_max).toBe('number');
        expect(lim.rot_deg_max, `${pose}.${partName} rot_deg_max < 0`).toBeGreaterThanOrEqual(0);
        expect(lim.rot_deg_max, `${pose}.${partName} rot_deg_max > 15`).toBeLessThanOrEqual(15);
        expect(typeof lim.dx_max).toBe('number');
        expect(lim.dx_max).toBeGreaterThanOrEqual(0);
        expect(typeof lim.dy_max).toBe('number');
        expect(lim.dy_max).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('defines two eye rectangles inside image bounds with a hex fur eyelid colour', () => {
    for (const [pose, entry] of Object.entries<any>(rig)) {
      const bytes = readFileSync(new URL(entry.source.file, spritesDirUrl));
      const { w, h } = pngDimensions(bytes);
      const eyes = entry.eyes;
      expect(eyes && typeof eyes === 'object', `${pose} missing eyes`).toBe(true);
      expect(eyes.color).toMatch(/^#[0-9a-fA-F]{6}$/);

      for (const side of ['left', 'right']) {
        const rect = eyes[side];
        expect(Array.isArray(rect) && rect.length === 4, `${pose}.eyes.${side} must be [x,y,w,h]`).toBe(true);
        const [ex, ey, ew, eh] = rect;
        expect(ew).toBeGreaterThan(0);
        expect(eh).toBeGreaterThan(0);
        expect(ex).toBeGreaterThanOrEqual(0);
        expect(ey).toBeGreaterThanOrEqual(0);
        expect(ex + ew).toBeLessThanOrEqual(w);
        expect(ey + eh).toBeLessThanOrEqual(h);
      }
    }
  });
});
