import { describe, it, expect, vi } from 'vitest';
import { isGiftSpriteURL, giftSpriteImage, giftAnchor, drawProp } from '../public/cam-props.js';
import { project } from '../public/cam-shared.js';
function context() { const ops: string[] = []; const ctx: any = new Proxy({}, {get: (_, k) => k === 'ops' ? ops : (..._a: any[]) => ops.push(String(k)), set: () => true}); return ctx; }
describe('gift sprites', () => {
 it('accepts only local media paths', () => {
  expect(isGiftSpriteURL('/media/gift-abc_123.png')).toBe(true);
  for (const u of ['https://other.example/media/a.png', '//other.example/media/a.png', '/media/../a.png', '/media/a.png?x=1', '/other/a.png']) expect(isGiftSpriteURL(u)).toBe(false);
 });
 it('loads once and draws parcel until ready and on failure', () => {
  const instances: any[] = []; vi.stubGlobal('Image', class { naturalWidth = 16; naturalHeight = 16; onload: any; onerror: any; src = ''; constructor() { instances.push(this); } });
  const obj = {kind:'household', sprite:'/media/gift-cache.png', x:1,y:2,z:0,status:'placed'};
  let c = context(); drawProp(c,obj); expect(c.ops).not.toContain('drawImage');
  expect(giftSpriteImage(obj.sprite)).toBe(giftSpriteImage(obj.sprite)); expect(instances).toHaveLength(1);
  instances[0].onload(); c = context(); drawProp(c,obj); expect(c.ops).toContain('drawImage');
  const failed = {...obj,sprite:'/media/gift-fail.png'}; c = context(); drawProp(c,failed); instances[1].onerror(); c = context(); drawProp(c,failed); expect(c.ops).not.toContain('drawImage'); expect(c.ops).toContain('fill');
  vi.unstubAllGlobals();
 });
 it('anchors at the footprint centre', () => {
  expect(giftAnchor({x:2,y:3,z:1,footprint:[[0,0]]})).toEqual(project(2,3,1));
  expect(giftAnchor({x:2,y:3,z:0,footprint:[[0,0],[1,0],[0,1],[1,1]]})).toEqual(project(2.5,3.5,0));
 });
});
