# Nori R40 observatory miniature room - original procedural build (Blender 4.4, headless).
# Usage: blender.exe -b --factory-startup --python build.py -- --tag r1 [--no-render] [--no-export]
# Units: metres. Blender Z-up; glTF export Y-up (gltf = (x, z, -y)).
import bpy, bmesh, math, json, hashlib, sys, os, random
import numpy as np
from mathutils import Vector, Matrix, Euler
from pathlib import Path

OUT = Path(__file__).resolve().parent
TEX = OUT / 'textures'; TEX.mkdir(parents=True, exist_ok=True)
argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
TAG = argv[argv.index('--tag') + 1] if '--tag' in argv else 'r1'
DO_RENDER = '--no-render' not in argv
DO_EXPORT = '--no-export' not in argv
CELL = 0.4; NX, NY = 12, 10; RW, RD, RH = NX * CELL, NY * CELL, 2.7
random.seed(40); RNG = np.random.default_rng(40)

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene

# ---------------------------------------------------------------- textures (numpy, sRGB values)
def vnoise(h, w, cy, cx, seed):
    g = np.random.default_rng(seed).random((cy + 1, cx + 1)); g[-1, :] = g[0, :]; g[:, -1] = g[:, 0]
    ys = np.linspace(0, cy, h, endpoint=False); xs = np.linspace(0, cx, w, endpoint=False)
    y0 = ys.astype(int); x0 = xs.astype(int)
    fy = (ys - y0)[:, None]; fx = (xs - x0)[None, :]
    fy = fy * fy * (3 - 2 * fy); fx = fx * fx * (3 - 2 * fx)
    a = g[y0][:, x0]; b = g[y0][:, x0 + 1]; c = g[y0 + 1][:, x0]; d = g[y0 + 1][:, x0 + 1]
    return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy

def fbm(h, w, cy, cx, seed, octs=4):
    s = np.zeros((h, w)); t = 0; amp = 1
    for i in range(octs):
        s += amp * vnoise(h, w, cy * 2 ** i, cx * 2 ** i, seed + i); t += amp; amp *= .5
    return s / t

IMAGES = {}
def save_img(name, rgb, alpha=None, noncolor=False):
    h, w = rgb.shape[:2]
    a = np.ones((h, w)) if alpha is None else alpha
    arr = np.dstack([np.clip(rgb, 0, 1), np.clip(a, 0, 1)])[::-1].astype(np.float32)
    img = bpy.data.images.new(name, w, h, alpha=True)
    if noncolor: img.colorspace_settings.name = 'Non-Color'
    img.pixels.foreach_set(arr.ravel())
    p = TEX / (name + '.png'); img.filepath_raw = str(p); img.file_format = 'PNG'; img.save()
    IMAGES[name] = img
    return img

def normal_from_height(name, hgt, strength=4.0):
    dx = (np.roll(hgt, -1, 1) - np.roll(hgt, 1, 1)) * strength
    dy = (np.roll(hgt, -1, 0) - np.roll(hgt, 1, 0)) * strength
    n = np.dstack([-dx, dy, np.ones_like(hgt)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    return save_img(name, n * .5 + .5, noncolor=True)

def tint(v, rgb): return v[..., None] * np.array(rgb)[None, None, :]

def wood_tex(name, base, planks, seed, seams=True, size=1024, contrast=1.0):
    h = w = size
    y = np.arange(h)[:, None] * np.ones((1, w)); x = np.ones((h, 1)) * np.arange(w)[None, :]
    warp = fbm(h, w, 3, 2, seed, 3)
    pid = (y * planks // h).astype(int)
    rings = .5 + .5 * np.sin(2 * np.pi * (y / h * planks * 5 + warp * 3.5 + pid * .37))
    streak = vnoise(h, w, h // 5, 6, seed + 9)
    mott = fbm(h, w, 6, 3, seed + 20, 3)
    rng = np.random.default_rng(seed)
    ptint = rng.uniform(.82, 1.12, planks + 1)[pid]
    v = (.72 + .16 * contrast * rings + .22 * contrast * (streak - .5) + .14 * (mott - .5)) * ptint
    if seams:
        fy = (y * planks / h) % 1.0
        v *= np.where((fy < .025) | (fy > .975), .45, 1.0)
        offs = rng.uniform(0, 1, planks + 1)[pid]
        fx = (x / w + offs) % 1.0
        v *= np.where(fx < .006, .5, 1.0)
    rgb = tint(v, base)
    rgb[..., 0] *= 1 + .08 * (rings - .5)  # warmer in dark rings
    hgt = v * .3
    return save_img(name, rgb), hgt

def build_textures():
    T = {}
    T['floor'], hf = wood_tex('wood_floor', (0.50, 0.28, 0.16), 10, 1, True, 1024, .55)
    T['floor_n'] = normal_from_height('wood_floor_n', np.where(hf < .16, 0, .3) + hf * .2, 6)
    T['wood'], _ = wood_tex('wood_warm', (0.60, 0.36, 0.21), 6, 2, False, 512, .6)
    T['wood_dark'], _ = wood_tex('wood_dark', (0.42, 0.24, 0.14), 5, 3, False, 512, .6)
    T['wood_light'], _ = wood_tex('wood_light', (0.74, 0.50, 0.30), 6, 4, False, 512, .8)
    # plaster wall, warm mauve cream
    n = fbm(512, 512, 8, 8, 30, 4)
    T['plaster'] = save_img('plaster', tint(.92 + .1 * (n - .5), (0.82, 0.72, 0.72)))
    # braided round rug: planar UV over the disc
    S = 1024; yy, xx = np.mgrid[0:S, 0:S]; cx = (xx - S / 2) / (S / 2); cy = (yy - S / 2) / (S / 2)
    r = np.sqrt(cx ** 2 + cy ** 2); th = np.arctan2(cy, cx)
    rings = 13; k = np.floor(r * rings); t = r * rings - k
    nper = np.maximum(12, (k + 1) * 14)
    ph = (th / (2 * np.pi) * nper + np.where(k % 2 == 0, t, -t) * 1.2) % 1.0
    braid = np.sin(np.pi * t) * (.65 + .35 * np.cos(2 * np.pi * ph))
    col = np.empty((S, S, 3)); col[:] = (0.88, 0.76, 0.66)
    purple = (k == 9) | (k == 3)
    col[purple] = (0.44, 0.33, 0.62)
    col[k == 12] = (0.80, 0.67, 0.58)
    shade = .62 + .38 * braid + .06 * (fbm(S, S, 32, 32, 31, 2) - .5)
    T['rug'] = save_img('rug_braid', col * shade[..., None])
    T['rug_n'] = normal_from_height('rug_braid_n', braid * .5, 5)
    # plaid
    P = 512; u = np.arange(P)
    def stripe(i):
        m = (i % 128)
        c = np.empty((len(i), 3)); c[:] = (0.36, 0.27, 0.55)
        c[(m >= 40) & (m < 52)] = (0.84, 0.58, 0.22)
        c[(m >= 90) & (m < 94)] = (0.20, 0.14, 0.32)
        c[(m >= 100) & (m < 104)] = (0.90, 0.80, 0.55)
        return c
    cu = stripe(u)[None, :, :] * np.ones((P, 1, 1)); cv = stripe(u)[:, None, :] * np.ones((1, P, 1))
    tw = (((yy[:P, :P] + xx[:P, :P]) // 2) % 2 == 0)[..., None]
    pl = np.where(tw, cu, cv) * (.9 + .1 * vnoise(P, P, 128, 128, 5))[..., None]
    T['plaid'] = save_img('plaid', pl)
    # knit (cat bed, steps)
    K = 512; ky, kx = np.mgrid[0:K, 0:K]
    knit = .5 + .5 * np.cos(2 * np.pi * (ky / 20.0 + np.abs((kx % 24) - 12) / 24.0))
    col_div = np.abs(((kx % 24) - 12) / 12.0)
    kh = knit * (1 - .4 * col_div ** 4)
    T['knit'] = save_img('knit', tint(.78 + .22 * kh, (0.92, 0.84, 0.76)))
    T['knit_n'] = normal_from_height('knit_n', kh * .6, 4)
    # basket weave
    cs = 32; inx = ((kx // cs + ky // cs) % 2 == 0)
    bump = np.where(inx, np.sin(np.pi * (ky % cs) / cs), np.sin(np.pi * (kx % cs) / cs))
    wv = (.55 + .45 * bump) * (.9 + .1 * vnoise(K, K, 64, 64, 8))
    T['weave'] = save_img('weave', tint(wv, (0.82, 0.62, 0.36)))
    T['weave_n'] = normal_from_height('weave_n', bump * .5, 4)
    # kilim small rug
    kil = np.empty((256, 512, 3)); kil[:] = (0.86, 0.74, 0.70)
    yk, xk = np.mgrid[0:256, 0:512]
    band = (np.abs(yk - 128) < 70)
    diam = (np.abs((xk % 64) - 32) + np.abs(yk - 128) * .9) < 30
    kil[band & diam] = (0.62, 0.30, 0.36); kil[(np.abs(yk - 128) < 12) & diam] = (0.40, 0.30, 0.55)
    kil[(np.abs(yk - 128) > 100)] = (0.70, 0.40, 0.42)
    T['kilim'] = save_img('kilim', kil)
    # monitor screen: saturn
    W, H = 512, 320; sy, sx = np.mgrid[0:H, 0:W]
    scr = np.empty((H, W, 3)); g = sy / H
    scr[:] = 0; scr += np.dstack([0.30 - .2 * g, 0.18 - .1 * g, 0.55 - .25 * g])
    st = np.random.default_rng(11).random((H, W)) > .996; scr[st] = (1, .95, .9)
    ex, ey = (sx - 256) / 46.0, (sy - 150) / 46.0; body = ex ** 2 + ey ** 2 < 1
    scr[body] = np.dstack([.95 - .1 * np.sin(sy * .3), .78 - .1 * np.sin(sy * .3), .55 + 0 * sy])[body]
    rx, ry = (sx - 256) / 110.0, (sy - 150 + (sx - 256) * .12) / 22.0; rr = rx ** 2 + ry ** 2
    ring = (rr < 1) & (rr > .55) & ~(body & (ry < 0))
    scr[ring] = (0.96, 0.85, 0.70)
    scr[sy < 14] = (0.22, 0.16, 0.36); scr[(sy < 14) & (sx > 470)] = (0.7, 0.5, 0.8)
    mtn = sy > (H - 40 - 18 * np.sin(sx / 40.0) - 10 * np.sin(sx / 13.0))
    scr[mtn] = (0.10, 0.08, 0.22)
    T['screen'] = save_img('screen_saturn', scr)
    # star chart
    C = 512; qy, qx = np.mgrid[0:C, 0:C]; d = np.sqrt((qx - 256) ** 2 + (qy - 256) ** 2); a = np.arctan2(qy - 256, qx - 256)
    ch = np.empty((C, C, 3)); ch[:] = (0.10, 0.12, 0.25)
    gold = (0.86, 0.70, 0.42)
    for R in (80, 150, 215): ch[np.abs(d - R) < 1.6] = gold
    ch[(np.abs(((a / (2 * np.pi) * 12) % 1) - .5) > .493) & (d < 215)] = gold
    ch[np.random.default_rng(12).random((C, C)) > .9975] = (1, 1, .9)
    T['starchart'] = save_img('starchart', ch)
    # moon print
    M = 512; my, mx = np.mgrid[0:M, 0:M]; md = np.sqrt((mx - 256) ** 2 + (my - 256) ** 2)
    mo = np.empty((M, M, 3)); mo[:] = (0.05, 0.05, 0.07)
    crat = fbm(M, M, 10, 10, 40, 4)
    lit = np.clip(.55 + .6 * (crat - .5) + .15 * (mx - 256) / 170.0, 0, 1)
    mo[md < 170] = tint(lit, (0.86, 0.84, 0.80))[md < 170]
    T['moon'] = save_img('moon_print', mo)
    # night city backdrop
    CW, CH = 1024, 640; cy_, cx_ = np.mgrid[0:CH, 0:CW]
    city = np.dstack([0.16 + .16 * cy_ / CH, 0.10 + .12 * cy_ / CH, 0.32 + .20 * cy_ / CH])
    city[np.random.default_rng(13).random((CH, CW)) > .997] = (.9, .9, 1)
    rng = np.random.default_rng(14); x = 0
    while x < CW:
        bw = rng.integers(70, 160); top = rng.integers(180, 420)
        m = (cx_ >= x) & (cx_ < x + bw) & (cy_ > top)
        city[m] = (0.13, 0.10, 0.25) if rng.random() < .5 else (0.18, 0.13, 0.32)
        for wy in range(top + 20, CH, 34):
            for wx in range(x + 10, x + bw - 14, 26):
                if rng.random() < .42:
                    city[wy:wy + 14, wx:wx + 10] = (1.0, 0.72, 0.36)
        x += bw + rng.integers(4, 20)
    T['city'] = save_img('night_city', city)
    # maple leaves card (RGBA)
    L = 512; ly, lx = np.mgrid[0:L, 0:L]; alpha = np.zeros((L, L)); leaf = np.zeros((L, L, 3))
    rng = np.random.default_rng(15)
    for i in range(22):
        px, py, s = rng.uniform(0, L), rng.uniform(0, L * .7), rng.uniform(22, 44)
        ang = np.arctan2(ly - py, lx - px) + rng.uniform(0, 6.28); dd = np.sqrt((lx - px) ** 2 + (ly - py) ** 2)
        shape = dd < s * (.55 + .45 * np.abs(np.cos(2.5 * ang)))
        alpha[shape] = 1; leaf[shape] = (0.95, 0.62 + rng.uniform(-.1, .1), 0.18)
    branch = (np.abs(ly - (lx * .35 + 40)) < 3) & (lx < 400); alpha[branch] = 1; leaf[branch] = (0.25, 0.14, 0.08)
    T['leaves'] = save_img('maple_leaves', leaf, alpha)
    # cardboard
    cb = fbm(512, 512, 64, 8, 50, 3)
    T['cardboard'] = save_img('cardboard', tint(.85 + .2 * (cb - .5), (0.80, 0.60, 0.38)))
    # nebula puzzle
    nb = fbm(256, 384, 4, 6, 60, 5)
    py_, px_ = np.mgrid[0:256, 0:384]
    neb = np.dstack([.35 + .6 * nb ** 2, .18 + .35 * nb ** 3, .55 + .4 * nb])
    neb[((px_ % 48) < 2) | ((py_ % 48) < 2)] *= .6
    T['nebula'] = save_img('nebula_puzzle', neb)
    return T

T = build_textures()

# ---------------------------------------------------------------- materials (glTF-portable Principled)
MATS = {}
def mat(name, color=(1, 1, 1), tex=None, rough=.6, metal=0.0, normal=None, nstr=.6,
        emit=None, emit_tex=None, estr=0.0, alpha=None, alpha_tex=False):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; b = nt.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough; b.inputs['Metallic'].default_value = metal
    if tex is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = tex; nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
        if alpha_tex:
            nt.links.new(t.outputs['Alpha'], b.inputs['Alpha'])
    if normal is not None:
        t = nt.nodes.new('ShaderNodeTexImage'); t.image = normal
        nm = nt.nodes.new('ShaderNodeNormalMap'); nm.inputs['Strength'].default_value = nstr
        nt.links.new(t.outputs['Color'], nm.inputs['Color']); nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    if emit is not None or emit_tex is not None:
        b.inputs['Emission Strength'].default_value = estr
        if emit_tex is not None:
            t = nt.nodes.new('ShaderNodeTexImage'); t.image = emit_tex; nt.links.new(t.outputs['Color'], b.inputs['Emission Color'])
        else:
            b.inputs['Emission Color'].default_value = (*emit, 1)
    if alpha is not None or alpha_tex:
        if alpha is not None: b.inputs['Alpha'].default_value = alpha
        try: m.surface_render_method = 'BLENDED'
        except Exception: m.blend_method = 'BLEND'
    MATS[name] = m
    return m

M = dict(
    floor=mat('Floor planks', tex=T['floor'], normal=T['floor_n'], rough=.55, nstr=.5),
    wood=mat('Warm wood', tex=T['wood'], rough=.5),
    wood_dark=mat('Dark wood', tex=T['wood_dark'], rough=.5),
    wood_light=mat('Light wood', tex=T['wood_light'], rough=.55),
    plaster=mat('Mauve plaster', tex=T['plaster'], rough=.9),
    wallcap=mat('Wall cut cap', color=(0.78, 0.70, 0.92), rough=.8),
    rug=mat('Braided rug', tex=T['rug'], normal=T['rug_n'], rough=.95, nstr=1.0),
    plaid=mat('Plaid wool', tex=T['plaid'], rough=.9),
    knit=mat('Cream knit', tex=T['knit'], normal=T['knit_n'], rough=.95, nstr=1.0),
    weave=mat('Basket weave', tex=T['weave'], normal=T['weave_n'], rough=.85, nstr=.8),
    kilim=mat('Kilim', tex=T['kilim'], rough=.95),
    screen=mat('Monitor screen', color=(0, 0, 0), emit_tex=T['screen'], estr=1.6, rough=.3),
    starchart=mat('Star chart', tex=T['starchart'], rough=.8, emit_tex=T['starchart'], estr=.05),
    moon=mat('Moon print', tex=T['moon'], rough=.8),
    city=mat('Night city', color=(0, 0, 0), emit_tex=T['city'], estr=1.0),
    leaves=mat('Maple leaves', tex=T['leaves'], alpha_tex=True, rough=.7),
    cardboard=mat('Cardboard', tex=T['cardboard'], rough=.85),
    nebula=mat('Nebula puzzle', tex=T['nebula'], rough=.5, emit_tex=T['nebula'], estr=.15),
    metal_dark=mat('Dark metal', color=(0.08, 0.07, 0.08), rough=.35, metal=1.0),
    brass=mat('Brass', color=(0.85, 0.62, 0.30), rough=.28, metal=1.0),
    black=mat('Bezel black', color=(0.03, 0.03, 0.035), rough=.4),
    glass=mat('Glass', color=(0.85, 0.85, 0.95), rough=.05, alpha=.18),
    glow_warm=mat('Warm glow', color=(1, .7, .4), emit=(1.0, 0.50, 0.16), estr=5.0),
    crystal=mat('Amethyst', color=(0.45, 0.25, 0.75), emit=(0.50, 0.22, 0.95), estr=0.45, rough=.15),
    cream=mat('Cream fabric', color=(0.90, 0.84, 0.76), rough=.9),
    grey_box=mat('Slate box', color=(0.33, 0.33, 0.38), rough=.8),
    cream_box=mat('Cream box', color=(0.86, 0.82, 0.76), rough=.8),
    paper=mat('Paper', color=(0.93, 0.91, 0.86), rough=.9),
    rope=mat('Sisal rope', tex=T['weave'], rough=.95),
    leaf=mat('Ivy', color=(0.36, 0.48, 0.20), rough=.7),
    pebble=mat('Pebble', color=(0.62, 0.55, 0.50), rough=.7),
    shell=mat('Ammonite', color=(0.86, 0.72, 0.52), rough=.6),
    fish=mat('Fish toy', color=(0.40, 0.52, 0.66), rough=.8),
    yarn=mat('Yarn pink', color=(0.82, 0.62, 0.66), rough=.95),
    candle=mat('Candle', color=(0.95, 0.85, 0.65), emit=(1, .7, .4), estr=.6, rough=.6),
)
BOOK_COLS = [(0.18, 0.22, 0.38), (0.36, 0.40, 0.50), (0.70, 0.52, 0.25), (0.42, 0.28, 0.45), (0.86, 0.80, 0.68), (0.28, 0.38, 0.40)]
BOOKM = [mat('Book %d' % i, color=c, rough=.7) for i, c in enumerate(BOOK_COLS)]

# ---------------------------------------------------------------- collections + mesh helpers
COLL = {}
for cname in ['Architecture', 'Outside', 'Furniture', 'Astronomy', 'Textiles', 'Decor', 'Lights', 'Anchors']:
    c = bpy.data.collections.new(cname); sc.collection.children.link(c); COLL[cname] = c

def link(o, coll):
    for c in list(o.users_collection): c.objects.unlink(o)
    COLL[coll].objects.link(o)

def boxuv(me, s=1.0, grain='x', off=Vector((0, 0, 0))):
    bm = bmesh.new(); bm.from_mesh(me); uv = bm.loops.layers.uv.verify()
    for f in bm.faces:
        n = f.normal; ax = max(range(3), key=lambda i: abs(n[i]))
        for l in f.loops:
            co = l.vert.co + off
            if ax == 2: u, v = (co.x, co.y) if grain != 'y' else (co.y, co.x)
            elif ax == 0: u, v = (co.y, co.z) if grain != 'z' else (co.z, co.y)
            else: u, v = (co.x, co.z) if grain != 'z' else (co.z, co.x)
            l[uv].uv = (u * s, v * s)
    bm.to_mesh(me); bm.free()

def finish(o, m, coll, bevel=0.0, uv='box', s=1.0, grain='x', smooth=False, props=None):
    if m is not None:
        o.data.materials.clear(); o.data.materials.append(m)
    if uv == 'box': boxuv(o.data, s, grain, o.location.copy())
    if bevel > 0:
        md = o.modifiers.new('Bevel', 'BEVEL'); md.width = bevel; md.segments = 2; md.limit_method = 'ANGLE'
    if smooth:
        for p in o.data.polygons: p.use_smooth = True
        try: o.data.set_sharp_from_angle(angle=math.radians(40))
        except Exception: pass
    if props:
        for k, v in props.items(): o[k] = v
    link(o, coll)
    return o

def box(name, mn, mx, m, coll='Furniture', bevel=0.012, s=1.0, grain='x', props=None):
    mn, mx = Vector(mn), Vector(mx); size = mx - mn
    me = bpy.data.meshes.new(name); bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts: v.co = Vector((v.co.x * size.x, v.co.y * size.y, (v.co.z + .5) * size.z))
    bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o)
    o.location = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
    return finish(o, m, coll, bevel, 'box', s, grain, False, props)

def prim(kind, name, m, coll='Decor', uv='box', s=1.0, smooth=True, bevel=0.0, props=None, **kw):
    getattr(bpy.ops.mesh, 'primitive_%s_add' % kind)(**kw)
    o = bpy.context.active_object; o.name = name; o.data.name = name
    return finish(o, m, coll, bevel, uv, s, 'x', smooth, props)

def cyl(name, c, z0, z1, r, m, coll='Decor', verts=32, **k):
    return prim('cylinder', name, m, coll, vertices=verts, radius=r, depth=z1 - z0, location=(c[0], c[1], (z0 + z1) / 2), **k)

def rod(name, p0, p1, r, m, coll='Decor', verts=10):
    p0, p1 = Vector(p0), Vector(p1); d = p1 - p0
    o = prim('cylinder', name, m, coll, uv='none', vertices=verts, radius=r, depth=d.length, location=(p0 + p1) / 2)
    o.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return o

def sphere(name, c, r, m, coll='Decor', seg=24, scale=(1, 1, 1), uv='none'):
    o = prim('uv_sphere', name, m, coll, uv=uv, segments=seg, ring_count=seg // 2, radius=r, location=c)
    o.scale = scale; return o

def card(name, c, w, h, axis, m, coll='Decor', flip=False):
    # flat quad with 0..1 UV; axis: '+x' faces +x (in YZ plane), '+y' faces +y, '+z' faces up
    me = bpy.data.meshes.new(name); bm = bmesh.new(); uvl = bm.loops.layers.uv.new()
    hw, hh = w / 2, h / 2
    if axis == '+x': pts = [(0, -hw, -hh), (0, hw, -hh), (0, hw, hh), (0, -hw, hh)]
    elif axis == '+y': pts = [(hw, 0, -hh), (-hw, 0, -hh), (-hw, 0, hh), (hw, 0, hh)]
    else: pts = [(-hw, -hh, 0), (hw, -hh, 0), (hw, hh, 0), (-hw, hh, 0)]
    vs = [bm.verts.new(p) for p in pts]; f = bm.faces.new(vs)
    for l, uvp in zip(f.loops, [(0, 0), (1, 0), (1, 1), (0, 1)]): l[uvl].uv = uvp
    bm.to_mesh(me); bm.free(); o = bpy.data.objects.new(name, me); sc.collection.objects.link(o); o.location = c
    return finish(o, m, coll, 0, 'none')

# ---------------------------------------------------------------- architecture
box('Base plinth', (-0.28, -0.28, -0.34), (RW + .12, RD + .12, -0.02), M['wood_dark'], 'Architecture', .03, grain='y')
box('Floor boards', (0, 0, -0.03), (RW, RD, 0.0), M['floor'], 'Architecture', .004, s=.5, grain='y',
    props={'role': 'floor', 'support_z': 0.0})
box('Plinth lip front', (RW, -0.28, -0.03), (RW + .12, RD + .12, 0.02), M['wood_dark'], 'Architecture', .01, grain='y')
box('Plinth lip right', (-0.28, RD, -0.03), (RW, RD + .12, 0.02), M['wood_dark'], 'Architecture', .01)
WT = 0.2
WX0, WX1, WZ0, WZ1 = 1.70, 3.75, 0.92, 2.30   # window opening on left wall (y=0)
def wall_y(n, x0, x1, z0, z1): box(n, (x0, -WT, z0), (x1, 0, z1), M['plaster'], 'Architecture', .006, s=.6)
wall_y('Wall left A', -WT, WX0, 0, RH); wall_y('Wall left B', WX1, RW, 0, RH)
wall_y('Wall left under window', WX0, WX1, 0, WZ0); wall_y('Wall left over window', WX0, WX1, WZ1, RH)
box('Wall right', (-WT, 0, 0), (0, RD, RH), M['plaster'], 'Architecture', .006, s=.6)
box('Wall cap left', (-WT - .01, -WT - .01, RH), (RW + .01, .01, RH + .05), M['wallcap'], 'Architecture', .01)
box('Wall cap right', (-WT - .01, -WT - .01, RH), (.01, RD + .01, RH + .05), M['wallcap'], 'Architecture', .01)
box('Wall end left', (RW, -WT - .01, -0.02), (RW + .015, .01, RH + .05), M['wallcap'], 'Architecture', 0)
box('Wall end right', (-WT - .01, RD, -0.02), (.01, RD + .015, RH + .05), M['wallcap'], 'Architecture', 0)
box('Baseboard left', (0, 0, 0), (RW, .025, .09), M['wood_dark'], 'Architecture', .004)
box('Baseboard right', (0, 0, 0), (.025, RD, .09), M['wood_dark'], 'Architecture', .004, grain='y')
# window: thick frame, mullions, sill, blind
FD = (-WT - .03, .07)
box('Window frame bottom', (WX0 - .1, FD[0], WZ0 - .1), (WX1 + .1, FD[1] + .05, WZ0), M['wood_dark'], 'Architecture', .012)
box('Window frame top', (WX0 - .1, FD[0], WZ1), (WX1 + .1, FD[1], WZ1 + .12), M['wood_dark'], 'Architecture', .012)
box('Window frame L', (WX0 - .1, FD[0], WZ0), (WX0, FD[1], WZ1), M['wood_dark'], 'Architecture', .012, grain='z')
box('Window frame R', (WX1, FD[0], WZ0), (WX1 + .1, FD[1], WZ1), M['wood_dark'], 'Architecture', .012, grain='z')
xm = (WX0 + WX1) / 2
box('Window mullion V', (xm - .035, -.12, WZ0), (xm + .035, -.04, WZ1), M['wood_dark'], 'Architecture', .008, grain='z')
box('Window mullion H', (WX0, -.12, 1.52), (WX1, -.04, 1.58), M['wood_dark'], 'Architecture', .008)
cyl('Window blind roll', (0, 0), 0, 1, .05, M['cream'], 'Architecture', 20).rotation_euler = (0, math.pi / 2, 0)
o = bpy.data.objects['Window blind roll']; o.scale = (1, 1, WX1 - WX0 + .1); o.location = (xm, .12, WZ1 + .02)
box('Window blind', (WX0 + .02, .08, WZ1 - .05), (WX1 - .02, .1, WZ1 + .02), M['cream'], 'Architecture', .004)
box('Wood panel lantern', (3.88, 0, .55), (4.55, .03, 2.55), M['wood'], 'Architecture', .006, grain='z')
# outside
card('Night city backdrop', (xm, -0.55, 1.36), 3.6, 2.0, '+y', M['city'], 'Outside')
card('Maple branch', (WX0 + .75, -0.16, 1.88), 1.6, 1.0, '+y', M['leaves'], 'Outside')

# ---------------------------------------------------------------- furniture
SUP = []  # support surfaces
def support(name, x0, y0, x1, y1, z, climb=True, note=''):
    SUP.append(dict(name=name, rect_xy=[round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)], z=round(z, 3), climbable=climb, note=note))

def collider(o, kind='solid', blocks_floor=True, top=None, climb=False):
    o['collider'] = kind; o['blocks_floor'] = blocks_floor; o['climbable'] = climb
    if top is not None: o['support_z'] = top
    return o

# Window seat bench A (long platform with cat cave + cubbies)
BZ = 0.55; BD = 0.56
bench = box('Window bench top', (1.56, 0, BZ - .06), (4.62, BD, BZ), M['wood'], 'Furniture', .015)
collider(bench, top=BZ, climb=True)
for xx in (1.58, 2.78, 3.58, 4.22, 4.56):
    box('Bench post %.2f' % xx, (xx, .02, 0), (xx + .05, BD - .02, BZ - .06), M['wood'], 'Furniture', .008, grain='z')
box('Bench kick', (1.56, .03, 0), (4.62, BD - .03, .03), M['wood_dark'], 'Furniture', .004)
box('Bench inner shelf', (1.6, .03, .26), (2.8, BD - .04, .29), M['wood'], 'Furniture', .006)
cave = box('Cat cave cube', (3.64, .05, .03), (4.2, BD - .03, .47), M['cream_box'], 'Furniture', .02)
o = cyl('Cat cave hole', (3.92, BD - .02), .14, .14, .14, M['black'], 'Furniture', 32)
o.rotation_euler = (math.pi / 2, 0, 0); o.scale = (1, 1, .02); o.location = (3.92, BD - .025, .24)
cyl('Cat cave cushion', (3.92, .30), .04, .09, .17, M['knit'], 'Textiles', 24)
for i in range(6): box('Bench cubby book %d' % i, (4.27 + i * .045, .08, .03), (4.31 + i * .045, .46, .26 + .04 * (i % 3)), BOOKM[i % 6], 'Decor', .004)
box('Bench basket A', (2.84, .06, .03), (3.18, .5, .28), M['weave'], 'Furniture', .02, s=3)
box('Bench basket B', (3.22, .06, .03), (3.54, .5, .25), M['cream_box'], 'Furniture', .02)
support('window_bench', 1.56, 0, 4.62, BD, BZ, True, 'long window seat; landing between x2.3-2.9')
# Corner cubby B (display shelf, terrarium)
CZ = 0.76
cub = box('Corner cubby top', (0.78, 0, CZ - .05), (1.56, .5, CZ), M['wood'], 'Furniture', .015)
collider(cub, top=CZ, climb=True)
box('Corner cubby side', (0.78, .02, 0), (0.83, .48, CZ - .05), M['wood'], 'Furniture', .008, grain='z')
box('Corner cubby mid', (0.83, .03, .36), (1.56, .46, .39), M['wood'], 'Furniture', .006)
box('Corner cubby box', (0.88, .06, .03), (1.30, .46, .34), M['cardboard'], 'Furniture', .015)
for i in range(5): box('Cubby book %d' % i, (0.88 + i * .05, .1, .39), (0.925 + i * .05, .42, .62 + .03 * (i % 2)), BOOKM[(i + 2) % 6], 'Decor', .004)
support('corner_cubby', 0.78, 0, 1.56, .5, CZ, True, 'reachable from window bench (+0.21)')
# Steps (upholstered cubes, climb to bench)
s1 = box('Step low', (2.32, 0.98, 0), (2.86, 1.36, .20), M['knit'], 'Furniture', .03, s=2)
s2 = box('Step high', (2.32, 0.58, 0), (2.86, 0.98, .38), M['knit'], 'Furniture', .03, s=2)
box('Step low base', (2.34, 1.0, 0), (2.84, 1.34, .04), M['wood_dark'], 'Furniture', .006)
box('Step high base', (2.34, 0.6, 0), (2.84, 0.96, .04), M['wood_dark'], 'Furniture', .006)
collider(s1, top=.20, climb=True); collider(s2, top=.38, climb=True)
support('step_low', 2.32, .98, 2.86, 1.36, .20, True, 'floor->0.20'); support('step_high', 2.32, .58, 2.86, .98, .38, True, '0.20->0.38->bench 0.55')
# L desk on right wall + front low bookcase
DZ = 0.74; DX = 0.76
desk = box('Desk top', (0, 0.02, DZ - .05), (DX, 3.30, DZ), M['wood'], 'Furniture', .015, grain='y')
collider(desk, top=DZ, climb=True)
for yy in (0.04, 1.45, 3.22):
    box('Desk panel %.2f' % yy, (.03, yy, 0), (DX - .02, yy + .05, DZ - .05), M['wood'], 'Furniture', .008, grain='z')
box('Desk under shelf', (.03, .09, .05), (DX - .03, 3.22, .08), M['wood'], 'Furniture', .006, grain='y')
box('Desk box A', (.08, 1.55, .08), (.62, 1.98, .40), M['cream_box'], 'Furniture', .02)
box('Desk box B', (.08, 2.05, .08), (.62, 2.50, .40), M['grey_box'], 'Furniture', .02)
box('Desk basket', (.08, 2.58, .08), (.62, 3.15, .36), M['weave'], 'Furniture', .02, s=3)
box('Desk box C', (.08, .15, .08), (.62, .62, .38), M['grey_box'], 'Furniture', .02)
riser = box('Monitor riser', (.02, 1.45, DZ), (.36, 2.65, DZ + .06), M['wood_dark'], 'Furniture', .01, grain='y')
support('desk_top', 0, .02, DX, 3.30, DZ, True, 'reached from bookcase (0.56) or cubby; front edge x=0.76')
bc = box('Front bookcase top', (0, 3.36, .52), (.48, 3.98, .56), M['wood'], 'Furniture', .012, grain='y')
collider(bc, top=.56, climb=True)
box('Front bookcase side', (0, 3.36, 0), (.48, 3.40, .52), M['wood'], 'Furniture', .006)
box('Front bookcase side2', (0, 3.94, 0), (.48, 3.98, .52), M['wood'], 'Furniture', .006)
box('Front bookcase shelf', (.02, 3.40, .25), (.46, 3.94, .28), M['wood'], 'Furniture', .006)
for i in range(10):
    box('Front book %d' % i, (.08, 3.42 + i * .05, .03 if i < 5 else .28), (.40, 3.465 + i * .05, .22 + .02 * (i % 3) if i < 5 else .47), BOOKM[i % 6], 'Decor', .004)
support('front_bookcase', 0, 3.36, .48, 3.98, .56, True, 'floor->0.56 is a jump; L return of desk (0.74)')
# Wall shelf above desk (decor, NOT climbable)
WSZ = 1.78
box('Wall shelf', (0, 0.08, WSZ - .04), (.30, 3.05, WSZ), M['wood'], 'Furniture', .01, grain='y')
for yy in (.3, 1.5, 2.8):
    box('Shelf bracket %.1f' % yy, (0, yy, WSZ - .2), (.2, yy + .03, WSZ - .04), M['metal_dark'], 'Furniture', .004)
support('wall_shelf_decor', 0, .08, .30, 3.05, WSZ, False, 'decor only - not a platform')
# Round coffee table
TC = (2.78, 2.45); TZ = 0.40
tt = cyl('Coffee table top', TC, TZ - .055, TZ, .56, M['wood'], 'Furniture', 48, s=1.0, bevel=.012)
collider(tt, kind='cylinder', top=TZ, climb=True)
for a in range(4):
    an = math.pi / 4 + a * math.pi / 2; fx, fy = TC[0] + .40 * math.cos(an), TC[1] + .40 * math.sin(an)
    rod('Table leg %d' % a, (TC[0] + .30 * math.cos(an), TC[1] + .30 * math.sin(an), TZ - .05), (fx, fy, 0), .035, M['wood_dark'], 'Furniture', 8)
support('coffee_table', TC[0] - .56, TC[1] - .56, TC[0] + .56, TC[1] + .56, TZ, True, 'round r=0.56')

# ---------------------------------------------------------------- textiles
rug = cyl('Braided rug', (2.82, 2.42), 0, .022, 1.32, M['rug'], 'Textiles', 72, uv='none')
bm = bmesh.new(); bm.from_mesh(rug.data); uvl = bm.loops.layers.uv.verify()
for f in bm.faces:
    for l in f.loops: l[uvl].uv = (l.vert.co.x / 2.64 + .5, l.vert.co.y / 2.64 + .5)
bm.to_mesh(rug.data); bm.free()
cush = box('Window seat cushion', (2.96, .05, BZ), (3.86, BD - .02, BZ + .09), M['plaid'], 'Textiles', .035, s=1.5)
box('Plaid throw drape', (3.10, BD - .02, .12), (3.55, BD + .02, BZ + .06), M['plaid'], 'Textiles', .01, s=1.5)
o = prim('torus', 'Cat bed ring', M['knit'], 'Textiles', uv='none', major_radius=.33, minor_radius=.14, major_segments=40, minor_segments=14, location=(3.98, 1.05, .12))
o.scale = (1, 1, .85); collider(o, kind='cylinder', top=.12, climb=True)
cyl('Cat bed cushion', (3.98, 1.05), 0, .1, .33, M['cream'], 'Textiles', 32)
box('Bed plaid fold', (3.80, 1.30, .02), (4.25, 1.52, .16), M['plaid'], 'Textiles', .03, s=1.5)
support('cat_bed', 3.65, .72, 4.31, 1.38, .12, True, 'soft sleep spot')
box('Small kilim', (0.86, 3.12, 0), (1.70, 3.92, .012), M['kilim'], 'Textiles', 0)
bm = bmesh.new(); me = bpy.data.objects['Small kilim'].data; bm.from_mesh(me); uvl = bm.loops.layers.uv.verify()
for f in bm.faces:
    for l in f.loops: l[uvl].uv = ((l.vert.co.y + .4) / .8, (l.vert.co.x + .42) / .84)
bm.to_mesh(me); bm.free()
# woven tunnel (half cylinder shell)
o = prim('cylinder', 'Woven tunnel', M['weave'], 'Furniture', uv='none', vertices=28, radius=.30, depth=.62, location=(0, 0, 0))
bm = bmesh.new(); bm.from_mesh(o.data)
bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.x < -0.001], context='VERTS')
uvl = bm.loops.layers.uv.verify()
for f in bm.faces:
    for l in f.loops:
        ang = math.atan2(l.vert.co.y, l.vert.co.x); l[uvl].uv = (ang * 1.5, l.vert.co.z * 3)
bm.to_mesh(o.data); bm.free()
sol = o.modifiers.new('Shell', 'SOLIDIFY'); sol.thickness = .045
o.rotation_euler = (0, -math.pi / 2, 0); o.location = (1.28, 3.52, 0.0)
collider(o, kind='tunnel_walkthrough', blocks_floor=False, top=.32, climb=False)

# ---------------------------------------------------------------- astronomy + focal props
# telescope on bench
tp = Vector((2.05, .28, BZ)); apex = tp + Vector((0, 0, .46))
for a in range(3):
    an = a * 2 * math.pi / 3 + .3
    rod('Tripod leg %d' % a, apex, tp + Vector((.16 * math.cos(an), .14 * math.sin(an), 0)), .012, M['wood_dark'], 'Astronomy', 6)
d = Vector((0.55, -0.55, 0.38)).normalized()
rod('Telescope tube', apex - d * .22, apex + d * .36, .068, M['brass'], 'Astronomy', 20)
rod('Telescope dew cap', apex + d * .36, apex + d * .46, .08, M['metal_dark'], 'Astronomy', 20)
rod('Telescope brass ring A', apex + d * .30, apex + d * .33, .062, M['brass'], 'Astronomy', 20)
rod('Telescope brass ring B', apex - d * .05, apex - d * .02, .062, M['brass'], 'Astronomy', 20)
rod('Telescope eyepiece', apex - d * .22, apex - d * .32, .022, M['brass'], 'Astronomy', 12)
sphere('Telescope mount', apex, .04, M['brass'], 'Astronomy', 12)
# lantern on wood panel
LP = Vector((4.18, .22, 1.55))
rod('Lantern bracket', (4.18, .03, 1.92), (4.18, .22, 1.92), .012, M['metal_dark'], 'Decor', 6)
rod('Lantern hook', (4.18, .22, 1.92), (4.18, .22, 1.80), .008, M['metal_dark'], 'Decor', 6)
box('Lantern glass', LP - Vector((.07, .07, .11)), LP + Vector((.07, .07, .11)), M['glow_warm'], 'Decor', .005)
for sx in (-1, 1):
    for sy in (-1, 1):
        box('Lantern post %d%d' % (sx, sy), LP + Vector((sx * .075 - .012, sy * .075 - .012, -.13)), LP + Vector((sx * .075 + .012, sy * .075 + .012, .13)), M['metal_dark'], 'Decor', .003)
box('Lantern base', LP - Vector((.095, .095, .15)), LP + Vector((.095, .095, -.11)), M['metal_dark'], 'Decor', .005)
prim('cone', 'Lantern roof', M['metal_dark'], 'Decor', uv='none', smooth=False, vertices=4, radius1=.13, radius2=.02, depth=.11, location=LP + Vector((0, 0, .185)), rotation=(0, 0, math.pi / 4))
# scratching post + crystal ball on books (bench)
box('Scratch post base', (4.26, .08, BZ), (4.58, .44, BZ + .05), M['cream'], 'Decor', .015)
cyl('Scratch post rope', (4.42, .26), BZ + .05, BZ + .42, .08, M['rope'], 'Decor', 20, s=4)
box('Scratch post top', (4.27, .10, BZ + .42), (4.57, .42, BZ + .47), M['cream'], 'Decor', .02)
for i, (w_, h_) in enumerate([(.30, .05), (.27, .045), (.24, .05)]):
    z0 = BZ + sum(hh for _, hh in [(.30, .05), (.27, .045), (.24, .05)][:i])
    box('Bench book %d' % i, (3.98 - w_ / 2, .14, z0), (3.98 + w_ / 2, .40, z0 + h_), BOOKM[(i + 1) % 6], 'Decor', .004)
cyl('Crystal ball stand', (3.98, .27), BZ + .145, BZ + .18, .06, M['brass'], 'Astronomy', 16)
sphere('Crystal ball', (3.98, .27, BZ + .27), .10, M['glass'], 'Astronomy', 24)
sphere('Crystal ball glow', (3.98, .27, BZ + .27), .05, M['glow_warm'], 'Astronomy', 12)
# terrarium on corner cubby
TCx = Vector((1.25, .25, CZ))
box('Terrarium glass', TCx + Vector((-.17, -.15, 0)), TCx + Vector((.17, .15, .36)), M['glass'], 'Astronomy', .004)
for sx in (-1, 1):
    for sy in (-1, 1):
        box('Terrarium edge %d%d' % (sx, sy), TCx + Vector((sx * .17 - .01, sy * .15 - .01, 0)), TCx + Vector((sx * .17 + .01, sy * .15 + .01, .36)), M['metal_dark'], 'Astronomy', .002)
box('Terrarium lid', TCx + Vector((-.18, -.16, .36)), TCx + Vector((.18, .16, .38)), M['metal_dark'], 'Astronomy', .003)
box('Terrarium pebbles', TCx + Vector((-.16, -.14, 0)), TCx + Vector((.16, .14, .06)), M['pebble'], 'Astronomy', .02)
for i, (ox, oy, hh, rr) in enumerate([(0, 0, .22, .045), (-.07, .04, .15, .035), (.06, -.04, .13, .03), (.08, .06, .1, .025), (-.04, -.06, .11, .028)]):
    prim('cone', 'Amethyst %d' % i, M['crystal'], 'Astronomy', uv='none', smooth=False, vertices=6, radius1=rr, radius2=0, depth=hh,
         location=TCx + Vector((ox, oy, .06 + hh / 2)), rotation=(ox * 3, oy * 3, 0))
sphere('Ammonite', (0.95, .30, CZ + .07), .07, M['shell'], 'Astronomy', 16, scale=(1, .45, 1))
box('Cubby top books', (0.86, .12, CZ), (1.04, .40, CZ + .08), BOOKM[0], 'Decor', .004)
# moon print + polaroids on left wall near corner
box('Moon frame', (0.70, .0, 1.30), (1.50, .04, 2.12), M['wood_dark'], 'Astronomy', .006)
box('Moon mat', (0.75, .04, 1.35), (1.45, .045, 2.07), M['paper'], 'Astronomy', 0)
card('Moon print', (1.10, .047, 1.71), .58, .58, '+y', M['moon'], 'Astronomy')
card('Polaroid A', (.38, .005, 1.62), .16, .19, '+y', M['nebula'], 'Decor')
card('Polaroid B', (.52, .005, 1.38), .16, .19, '+y', M['starchart'], 'Decor')
# star chart on right wall front
box('Star chart frame', (0, 3.02, 1.02), (.035, 3.72, 1.72), M['wood_dark'], 'Astronomy', .005)
card('Star chart', (.037, 3.37, 1.37), .64, .64, '+x', M['starchart'], 'Astronomy')
# monitor (faces +x)
MY0, MY1, MZ0, MZ1 = 1.52, 2.58, 0.96, 1.62
box('Monitor stand foot', (.08, 1.85, DZ + .06), (.30, 2.25, DZ + .08), M['metal_dark'], 'Astronomy', .005)
box('Monitor stand neck', (.10, 2.02, DZ + .08), (.14, 2.08, MZ0 + .05), M['metal_dark'], 'Astronomy', .004)
box('Monitor bezel', (.12, MY0, MZ0), (.17, MY1, MZ1), M['black'], 'Astronomy', .008)
card('Monitor screen', (.172, (MY0 + MY1) / 2, (MZ0 + MZ1) / 2 + .01), MY1 - MY0 - .06, MZ1 - MZ0 - .07, '+x', M['screen'], 'Astronomy')
box('Keyboard', (.40, 1.75, DZ), (.52, 2.30, DZ + .02), M['cream_box'], 'Astronomy', .004)
# desk lamp
LB = Vector((.18, .52, DZ))
cyl('Desk lamp base', (LB.x, LB.y), DZ, DZ + .03, .09, M['metal_dark'], 'Astronomy', 20)
elbow = LB + Vector((.06, .10, .42)); head = LB + Vector((.30, .30, .55))
rod('Desk lamp arm A', LB + Vector((0, 0, .03)), elbow, .012, M['brass'], 'Astronomy', 8)
rod('Desk lamp arm B', elbow, head, .012, M['brass'], 'Astronomy', 8)
sphere('Desk lamp joint', elbow, .025, M['brass'], 'Astronomy', 10)
o = prim('cone', 'Desk lamp shade', M['metal_dark'], 'Astronomy', uv='none', vertices=24, radius1=.15, radius2=.045, depth=.17, end_fill_type='NOTHING', location=head)
o.rotation_euler = (math.radians(-35), math.radians(20), 0)
sphere('Desk lamp bulb', head - Vector((0, 0, .04)), .035, M['glow_warm'], 'Astronomy', 12)
LAMP_HEAD = head - Vector((0, 0, .11))
# Nori desk perch cushion (character anchor, no cat)
box('Desk perch cushion', (.30, .95, DZ), (.72, 1.42, DZ + .07), M['cream'], 'Textiles', .03)
# candle + small box on desk front
cyl('Desk candle', (.60, 2.95), DZ, DZ + .08, .03, M['candle'], 'Decor', 12)
sphere('Candle flame', (.60, 2.95, DZ + .10), .012, M['glow_warm'], 'Decor', 8, scale=(1, 1, 1.8))
box('Desk tin', (.40, 3.0, DZ), (.52, 3.15, DZ + .06), M['brass'], 'Decor', .006)
# wall shelf props
y = .14
for i in range(9):
    th = .04 + .012 * (i % 3); hh = .20 + .03 * ((i * 7) % 4)
    box('Shelf book %d' % i, (.05, y, WSZ), (.26, y + th, WSZ + hh), BOOKM[(i * 5) % 6], 'Decor', .004); y += th + .004
box('Camera body', (.06, 1.05, WSZ), (.20, 1.27, WSZ + .12), M['black'], 'Decor', .01)
box('Camera top', (.06, 1.05, WSZ + .09), (.20, 1.27, WSZ + .12), M['paper'], 'Decor', .006)
o = cyl('Camera lens', (0, 0), 0, .07, .045, M['metal_dark'], 'Decor', 16); o.rotation_euler = (0, math.pi / 2, 0); o.location = (.20 + .035, 1.16, WSZ + .055)
AR = Vector((.15, 1.65, WSZ))
cyl('Armillary stand', (AR.x, AR.y), WSZ, WSZ + .03, .06, M['wood_dark'], 'Astronomy', 16)
rod('Armillary post', AR, AR + Vector((0, 0, .14)), .008, M['brass'], 'Astronomy', 6)
for i, rot in enumerate([(0, 0, 0), (math.pi / 2, 0, 0), (math.pi / 2, 0, math.pi / 2), (.4, .4, 0)]):
    prim('torus', 'Armillary ring %d' % i, M['brass'], 'Astronomy', uv='none', major_radius=.10, minor_radius=.006, major_segments=32, minor_segments=6,
         location=AR + Vector((0, 0, .24)), rotation=rot)
sphere('Armillary core', AR + Vector((0, 0, .24)), .03, M['brass'], 'Astronomy', 12)
DM = Vector((.15, 2.15, WSZ))
cyl('Dome base', (DM.x, DM.y), WSZ, WSZ + .04, .09, M['wood_dark'], 'Astronomy', 20)
sphere('Glass dome', DM + Vector((0, 0, .14)), .095, M['glass'], 'Astronomy', 20, scale=(1, 1, 1.15))
for i, (ox, hh) in enumerate([(0, .12), (-.03, .08), (.035, .07)]):
    prim('cone', 'Dome crystal %d' % i, M['crystal'], 'Astronomy', uv='none', smooth=False, vertices=6, radius1=.022, radius2=0, depth=hh, location=DM + Vector((0, ox, .04 + hh / 2)))
cyl('Jar glass', (.15, 2.62), WSZ, WSZ + .2, .075, M['glass'], 'Decor', 20)
cyl('Jar contents', (.15, 2.62), WSZ, WSZ + .12, .065, M['shell'], 'Decor', 20)
cyl('Jar lid', (.15, 2.62), WSZ + .2, WSZ + .23, .078, M['brass'], 'Decor', 20)
# ivy trailing from shelf end
for i in range(16):
    t = i / 15.0
    sphere('Ivy leaf %d' % i, (.27 + .04 * math.sin(i), 2.95 + .12 * math.sin(i * 1.7), WSZ - t * .8), .045, M['leaf'], 'Decor', 8, scale=(.5, 1, .8))
# coffee table props
o = card('Nebula puzzle', (TC[0] - .08, TC[1] + .06, TZ + .004), .48, .32, '+z', M['nebula'], 'Decor'); o.rotation_euler = (0, 0, .25)
box('Table book A', (TC[0] + .18, TC[1] - .32, TZ), (TC[0] + .40, TC[1] - .02, TZ + .04), BOOKM[0], 'Decor', .004)
box('Table book B', (TC[0] + .20, TC[1] - .30, TZ + .04), (TC[0] + .38, TC[1] - .04, TZ + .075), BOOKM[3], 'Decor', .004)
cyl('Snack bowl', (TC[0] + .10, TC[1] + .32), TZ, TZ + .06, .12, M['wood_light'], 'Decor', 24)
for i in range(4): sphere('Bowl ball %d' % i, (TC[0] + .10 + .05 * math.cos(i * 1.6), TC[1] + .32 + .05 * math.sin(i * 1.6), TZ + .065), .03, M['pebble'], 'Decor', 10)
# floor toys
sphere('Fish toy', (3.55, 2.95, .04), .045, M['fish'], 'Decor', 14, scale=(2.6, 1, 1)).rotation_euler = (0, 0, .6)
sphere('Wicker ball', (3.30, 1.25, .06), .06, M['weave'], 'Decor', 14, uv='box')
sphere('Yarn ball', (3.02, 3.62, .05), .05, M['yarn'], 'Decor', 14)
# cardboard box (open, front-left)
BXc = Vector((4.25, 1.92, 0)); hw = .22
box('Cardboard bottom', BXc + Vector((-hw, -hw, 0)), BXc + Vector((hw, hw, .01)), M['cardboard'], 'Decor', 0)
box('Cardboard side -x', BXc + Vector((-hw, -hw, 0)), BXc + Vector((-hw + .01, hw, .30)), M['cardboard'], 'Decor', 0)
box('Cardboard side +x', BXc + Vector((hw - .01, -hw, 0)), BXc + Vector((hw, hw, .30)), M['cardboard'], 'Decor', 0)
box('Cardboard side -y', BXc + Vector((-hw, -hw, 0)), BXc + Vector((hw, -hw + .01, .30)), M['cardboard'], 'Decor', 0)
box('Cardboard side +y', BXc + Vector((-hw, hw - .01, 0)), BXc + Vector((hw, hw, .30)), M['cardboard'], 'Decor', 0)
o = box('Cardboard flap', (0, -hw, 0), (.18, hw, .01), M['cardboard'], 'Decor', 0); o.location = BXc + Vector((hw, 0, .30)); o.rotation_euler = (0, math.radians(-50), 0)
box('Tissue paper', BXc + Vector((-hw + .03, -hw + .03, .01)), BXc + Vector((hw - .03, hw - .03, .20)), M['paper'], 'Decor', .05)
collider(bpy.data.objects['Cardboard side -x'], kind='box_group', top=.30)
# small crystals on floor near desk
for i, (x_, y_) in enumerate([(0.95, 1.0), (1.02, 1.06)]):
    prim('cone', 'Floor crystal %d' % i, M['crystal'], 'Astronomy', uv='none', smooth=False, vertices=6, radius1=.03, radius2=0, depth=.09, location=(x_, y_, .045))

# ---------------------------------------------------------------- lights
LIGHTS = []
def light(name, kind, loc, color, power, size=0.1, target=None, spot=None, contract_note=''):
    ld = bpy.data.lights.new(name, kind); ld.color = color; ld.energy = power
    if kind == 'AREA': ld.shape = 'RECTANGLE' if isinstance(size, tuple) else 'SQUARE'; ld.size = size[0] if isinstance(size, tuple) else size
    if kind == 'AREA' and isinstance(size, tuple): ld.size_y = size[1]
    if kind in ('POINT', 'SPOT'): ld.shadow_soft_size = size
    if kind == 'SPOT': ld.spot_size = math.radians(spot or 70); ld.spot_blend = .6
    o = bpy.data.objects.new(name, ld); COLL['Lights'].objects.link(o); o.location = loc
    if target is not None:
        o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    LIGHTS.append(dict(name=name, type=kind, position_blender=[round(v, 3) for v in loc],
                       target_blender=[round(v, 3) for v in target] if target else None,
                       color_linear=[round(c, 3) for c in color], blender_watts=power,
                       size=size, spot_angle_deg=spot, note=contract_note))
    return o

light('Lantern light', 'POINT', tuple(LP), (1.0, 0.50, 0.18), 320, .08, contract_note='warm key, left wall')
light('Desk lamp light', 'SPOT', tuple(LAMP_HEAD), (1.0, 0.55, 0.24), 480, .05, target=(.6, 1.35, DZ), spot=110, contract_note='warm pool on desk + perch')
light('Room warm fill', 'AREA', (3.0, 2.6, 3.4), (1.0, 0.60, 0.38), 70, (3.0, 2.6), target=(2.4, 2.0, 0), contract_note='broad warm ceiling wash')
light('Moon window light', 'AREA', (xm, -0.9, 2.2), (0.55, 0.48, 1.0), 220, (1.8, 1.0), target=(xm, 1.6, 0.3), contract_note='cool violet through window')
light('Monitor glow', 'AREA', (.32, 2.05, 1.28), (0.55, 0.45, 1.0), 6, (0.9, 0.5), target=(1.2, 2.05, 1.1), contract_note='screen spill')
light('Candle light', 'POINT', (.60, 2.95, DZ + .12), (1.0, 0.55, 0.25), 3, .02, contract_note='tiny warm accent')
light('Terrarium crystal light', 'POINT', tuple(TCx + Vector((0, 0, .15))), (0.6, 0.35, 1.0), 4, .05, contract_note='violet accent')
light('Crystal ball light', 'POINT', (3.98, .32, BZ + .27), (1.0, 0.6, 0.3), 6, .04, contract_note='warm accent')
light('Window seat warm spill', 'POINT', (3.3, .7, 1.05), (1.0, 0.55, 0.28), 70, .3, contract_note='fake lantern bounce on seat/steps')
light('Desk warm spill', 'POINT', (1.1, 1.6, 1.4), (1.0, 0.58, 0.30), 45, .3, contract_note='fake lamp bounce on desk wall')
light('Front cool rim', 'AREA', (6.5, 6.0, 4.0), (0.58, 0.48, 1.0), 340, 3.0, target=(1.5, 1.2, 0.8), contract_note='violet night fill from camera side')

sc.world = bpy.data.worlds.new('Violet night'); sc.world.use_nodes = True
bg = sc.world.node_tree.nodes['Background']; bg.inputs['Color'].default_value = (0.050, 0.028, 0.110, 1); bg.inputs['Strength'].default_value = 1.0
WORLD = dict(color_linear=[0.050, 0.028, 0.110], strength=1.0, note='background + ambient; use as clear colour + low hemisphere ambient')

# ---------------------------------------------------------------- anchors (empties -> glTF nodes with extras)
ANCH = {}
def anchor(name, loc, **props):
    e = bpy.data.objects.new(name, None); e.empty_display_type = 'ARROWS'; e.empty_display_size = .15; e.location = loc
    COLL['Anchors'].objects.link(e)
    for k, v in props.items(): e[k] = v
    ANCH[name] = dict(position_blender=[round(v, 3) for v in loc], **props)
GIFT = (3.92, 2.78, 4.62, 3.86)
anchor('ANCHOR_nori_spawn', (3.50, 3.30, 0.0), role='nori_spawn', facing_deg=225.0)
anchor('ANCHOR_gift_zone', ((GIFT[0] + GIFT[2]) / 2, (GIFT[1] + GIFT[3]) / 2, 0.0), role='gift_zone', rect_xy=list(GIFT))
anchor('ANCHOR_nori_desk_perch', (.51, 1.18, DZ + .07), role='perch', surface='desk_top')
anchor('ANCHOR_nori_bench_perch', (2.60, .30, BZ), role='perch', surface='window_bench')
anchor('ANCHOR_nori_bed', (3.98, 1.05, .12), role='sleep', surface='cat_bed')
anchor('ANCHOR_step_low', (2.59, 1.17, .20), role='climb_step', surface='step_low')
anchor('ANCHOR_step_high', (2.59, .78, .38), role='climb_step', surface='step_high')
anchor('ANCHOR_tunnel_mouth', (1.70, 3.52, 0), role='hide_entry', surface='floor')
anchor('ANCHOR_telescope_look', (2.05, .28, BZ + .46), role='focus_prop')
anchor('ANCHOR_monitor', (.18, 2.05, 1.30), role='focus_prop')

# ---------------------------------------------------------------- camera
TARGET = Vector((2.35, 2.0, 0.92)); AZ, EL = math.radians(52), math.radians(29)
DIRV = Vector((math.cos(EL) * math.cos(AZ), math.cos(EL) * math.sin(AZ), math.sin(EL)))
def make_cam(name, target, scale):
    cd = bpy.data.cameras.new(name); cd.type = 'ORTHO'; cd.ortho_scale = scale; cd.clip_start = .1; cd.clip_end = 60
    c = bpy.data.objects.new(name, cd); COLL['Anchors'].objects.link(c)
    c.location = target + DIRV * 20; c.rotation_euler = (target - c.location).to_track_quat('-Z', 'Y').to_euler()
    return c
CAM_FRONT = make_cam('Camera front', TARGET, 8.6)
CAM_CLOSE_T = Vector((1.55, 1.05, 0.95)); CAM_CLOSE = make_cam('Camera close', CAM_CLOSE_T, 3.6)
sc.camera = CAM_FRONT

# ---------------------------------------------------------------- render settings
sc.render.engine = 'BLENDER_EEVEE_NEXT'
sc.eevee.taa_render_samples = 48
for k, v in [('use_raytracing', True), ('ray_tracing_method', 'SCREEN'), ('use_shadows', True), ('shadow_ray_count', 2), ('shadow_step_count', 8),
             ('fast_gi_method', 'GLOBAL_ILLUMINATION'), ('use_fast_gi', True)]:
    try: setattr(sc.eevee, k, v)
    except Exception: pass
sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1280, 720, 100
sc.render.threads_mode = 'FIXED'; sc.render.threads = 4
sc.render.image_settings.file_format = 'PNG'; sc.render.image_settings.color_mode = 'RGB'
sc.view_settings.view_transform = 'AgX'
try: sc.view_settings.look = 'AgX - Medium High Contrast'
except Exception: pass
sc.view_settings.exposure = -0.1

# ---------------------------------------------------------------- contract
def world_bounds(o):
    dg = bpy.context.evaluated_depsgraph_get(); oe = o.evaluated_get(dg)
    pts = [oe.matrix_world @ Vector(c) for c in oe.bound_box]
    mn = [min(p[i] for p in pts) for i in range(3)]; mx = [max(p[i] for p in pts) for i in range(3)]
    return [round(v, 3) for v in mn], [round(v, 3) for v in mx]

def to_gltf(p): return [p[0], p[2], -p[1]]

def build_contract():
    bpy.context.view_layer.update()
    cols = []
    cardboard = [bpy.data.objects[n] for n in bpy.data.objects.keys() if n.startswith('Cardboard')]
    for o in bpy.data.objects:
        if o.get('collider'):
            if o.name == 'Cardboard side -x':
                bs = [world_bounds(x) for x in cardboard]
                mn = [min(b[0][i] for b in bs) for i in range(3)]; mx = [max(b[1][i] for b in bs) for i in range(3)]; nm = 'Cardboard box (group)'
            else:
                mn, mx = world_bounds(o); nm = o.name
            cols.append(dict(name=nm, kind=o['collider'], blocks_floor=bool(o['blocks_floor']), climbable=bool(o['climbable']),
                             support_z=o.get('support_z'), aabb_min_blender=mn, aabb_max_blender=mx))
    # walk grid (12x10 cells of 0.4 m) from floor-blocking colliders' footprints
    grid = [['.' for _ in range(NX)] for _ in range(NY)]
    for c in cols:
        if not c['blocks_floor']: continue
        x0, y0 = c['aabb_min_blender'][:2]; x1, y1 = c['aabb_max_blender'][:2]
        for j in range(NY):
            for i in range(NX):
                cx0, cy0 = i * CELL, j * CELL
                ox = max(0, min(x1, cx0 + CELL) - max(x0, cx0)); oy = max(0, min(y1, cy0 + CELL) - max(y0, cy0))
                if ox * oy > .3 * CELL * CELL: grid[j][i] = '#'
    gx0, gy0, gx1, gy1 = GIFT
    for j in range(NY):
        for i in range(NX):
            cx, cy = (i + .5) * CELL, (j + .5) * CELL
            if gx0 <= cx <= gx1 and gy0 <= cy <= gy1: grid[j][i] = 'G' if grid[j][i] == '.' else 'X'
    sp = ANCH['ANCHOR_nori_spawn']['position_blender']; si, sj = int(sp[0] / CELL), int(sp[1] / CELL)
    seen = {(si, sj)}; q = [(si, sj)]
    while q:
        i, j = q.pop()
        for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            a, b = i + di, j + dj
            if 0 <= a < NX and 0 <= b < NY and (a, b) not in seen and grid[b][a] in '.G': seen.add((a, b)); q.append((a, b))
    free = sum(1 for j in range(NY) for i in range(NX) if grid[j][i] in '.G')
    gift_cells = [(i, j) for j in range(NY) for i in range(NX) if grid[j][i] == 'G']
    def adj_reach(c):  # floor cell next to a collider footprint reachable?
        x0, y0 = c['aabb_min_blender'][:2]; x1, y1 = c['aabb_max_blender'][:2]
        for (i, j) in seen:
            cx, cy = (i + .5) * CELL, (j + .5) * CELL
            if x0 - CELL <= cx <= x1 + CELL and y0 - CELL <= cy <= y1 + CELL: return True
        return False
    cam = lambda c, t: dict(position_blender=[round(v, 3) for v in c.location], target_blender=[round(v, 3) for v in t],
                            position_gltf=[round(v, 3) for v in to_gltf(c.location)], target_gltf=[round(v, 3) for v in to_gltf(t)],
                            type='orthographic', orthographic_scale=c.data.ortho_scale, ortho_scale_meaning='Blender: full width of view in metres (16:9 -> height = scale*9/16)',
                            azimuth_deg=52, elevation_deg=29, aspect=1280 / 720)
    contract = dict(
        schema='nori-r40-observatory-room-contract/1', status='candidate layout - not the Live world, physics not verified in Three.js',
        units='metres', up_axis=dict(blender='Z-up (x right-along-window-wall, y along desk wall, z up)', gltf='Y-up; gltf = (x_b, z_b, -y_b); exporter export_yup=True'),
        floor=dict(rect_xy_blender=[0, 0, RW, RD], z=0.0, grid=dict(cell_m=CELL, nx=NX, ny=NY, origin='back corner (0,0) where walls meet'),
                   walls=dict(left_window_wall='plane y=0 (thickness to y=-0.2)', right_desk_wall='plane x=0 (thickness to x=-0.2)', height=RH),
                   open_edges='x=4.8 (front-left) and y=4.0 (front-right) are open, plinth lip to +0.12'),
        cameras=dict(front=cam(CAM_FRONT, TARGET), close=cam(CAM_CLOSE, CAM_CLOSE_T)),
        lights=LIGHTS, world=WORLD, lights_note='AREA lights are not exported by glTF (KHR_lights_punctual has point/spot/directional only); rebuild them in Three.js (RectAreaLight) from this list. Blender watts are not Three.js candela - calibrate visually.',
        support_surfaces=SUP, colliders=cols, anchors=ANCH,
        nori_spawn=ANCH['ANCHOR_nori_spawn'], gift_zone=dict(rect_xy_blender=list(GIFT), z=0.0, cells=gift_cells, clear=all(grid[j][i] == 'G' for i, j in gift_cells) and len(gift_cells) > 0),
        walk_grid=dict(legend="row j=0 is y 0-0.4 (back, window wall side); col i=0 is x 0-0.4 (desk wall side). '.' free, '#' blocked footprint, 'G' gift zone free, 'X' gift zone blocked",
                       rows=[''.join(r) for r in grid], free_cells=free, reachable_from_spawn=len(seen),
                       all_free_reachable=len(seen) == free, gift_reachable=all(c in seen for c in gift_cells),
                       climb_entries_reachable={c['name']: adj_reach(c) for c in cols if c['climbable']}),
        climb_graph=[['floor', 'step_low'], ['step_low', 'step_high'], ['step_high', 'window_bench'], ['window_bench', 'corner_cubby'],
                     ['floor', 'front_bookcase'], ['front_bookcase', 'desk_top'], ['floor', 'cat_bed'], ['floor', 'coffee_table']],
        not_climbable=['wall_shelf_decor', 'window sill/frame', 'monitor', 'terrarium', 'scratch post top (decor)'],
        nori_note='No cat in this asset; parent attaches the existing canonical Nori at anchors. Suggested Nori shoulder ~0.25 m.',
    )
    return contract

# emitters and glass must not cast shadows, otherwise they occlude the lights placed inside them
for o in bpy.data.objects:
    if o.type == 'MESH' and o.active_material and o.active_material.name in ('Warm glow', 'Glass', 'Amethyst', 'Candle'):
        o.visible_shadow = False; o['casts_shadow'] = False
contract = build_contract()
(OUT / 'room-contract.json').write_text(json.dumps(contract, indent=1), encoding='utf-8')
print('WALK', '\n'.join(contract['walk_grid']['rows'][::-1]), contract['walk_grid']['reachable_from_spawn'], contract['walk_grid']['free_cells'])

bpy.ops.wm.save_as_mainfile(filepath=str(OUT / 'scene.blend'))

if DO_EXPORT:
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.export_scene.gltf(filepath=str(OUT / 'room.glb'), export_format='GLB', export_apply=True, export_extras=True,
                              export_lights=True, export_cameras=True, export_yup=True, export_image_format='AUTO')

if DO_RENDER:
    for nm, c in [('front', CAM_FRONT), ('close', CAM_CLOSE)]:
        sc.camera = c; sc.render.filepath = str(OUT / ('render-%s-%s.png' % (nm, TAG))); bpy.ops.render.render(write_still=True)
print('DONE', TAG)
