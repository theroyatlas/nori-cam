#!/usr/bin/env python3
"""Pixelize canonical Nori sprites for the Cam renderer.

Deterministic, no network. One global scale set so the sitting cat's
alpha bbox is 40 px tall, with small per-pose overrides for close-up
art that would otherwise dwarf the room.
"""
from pathlib import Path
from PIL import Image

SITE = Path(__file__).resolve().parents[1]
SRC_DIR = SITE / "public" / "room" / "sprites"
DST_DIR = SITE / "public" / "cam" / "sprites"
MANIFEST = SITE / "public" / "cam" / "manifest.json"

# pose -> (source stem, native_facing). Facing checked per source image:
# walk and stretch face screen-left; the rest face front or screen-right.
POSES = {
    "sit": ("nori-sit", 1),
    "stretch": ("nori-stretch", -1),
    "walk": ("nori-walk", -1),
    "look_up": ("nori-look-up", 1),
    "jump": ("nori-jump", 1),
    "alert_loaf": ("nori-alert-loaf", 1),
    "sleepy": ("nori-sleepy", 1),
}

TARGET_SIT_H = 40
# Poses whose source art is a close-up: give them a target bbox height
# (in output px) instead of the global scale so the cat stays room-sized.
OVERRIDE_H = {"alert_loaf": 24, "sleepy": 28}


def alpha_bbox(img):
    a = img.getchannel("A")
    mask = a.point(lambda v: 255 if v >= 128 else 0)
    return mask.getbbox()


def largest_component_bbox(img):
    """BBox of the largest 4-connected opaque component (threshold 128)."""
    w, h = img.size
    px = img.load()
    seen = bytearray(w * h)
    best = None
    best_n = -1
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or px[sx, sy][3] < 128:
                continue
            stack = [(sx, sy)]
            seen[i] = 1
            n = 0
            minx = maxx = sx
            miny = maxy = sy
            while stack:
                cx, cy = stack.pop()
                n += 1
                minx = min(minx, cx); maxx = max(maxx, cx)
                miny = min(miny, cy); maxy = max(maxy, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny][3] >= 128:
                            seen[j] = 1
                            stack.append((nx, ny))
            if n > best_n:
                best_n = n
                best = (minx, miny, maxx + 1, maxy + 1)
    return best


def pixelize(src_img, scale):
    w = max(1, round(src_img.size[0] * scale))
    h = max(1, round(src_img.size[1] * scale))
    img = src_img.resize((w, h), Image.LANCZOS)
    # Alpha threshold 128, keep transparency.
    px = img.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255) if a >= 128 else (0, 0, 0, 0)
    # Quantize opaque colours to <=31 so total distinct RGBA <= 32.
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    quant = rgb.quantize(colors=31, method=Image.Quantize.MEDIANCUT, dither=Image.NONE)
    out = quant.convert("RGB").convert("RGBA")
    out.putalpha(alpha)
    # Ensure fully transparent pixels carry no colour.
    opx = out.load()
    for y in range(h):
        for x in range(w):
            if opx[x, y][3] == 0:
                opx[x, y] = (0, 0, 0, 0)
    return out


def main():
    sit = Image.open(SRC_DIR / "nori-sit.png").convert("RGBA")
    sit_bbox = alpha_bbox(sit)
    sit_h = sit_bbox[3] - sit_bbox[1]
    global_scale = TARGET_SIT_H / sit_h
    print(f"global scale {global_scale:.6f} (sit bbox h {sit_h} -> {TARGET_SIT_H})")

    DST_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for pose in sorted(POSES):
        stem, facing = POSES[pose]
        src = Image.open(SRC_DIR / f"{stem}.png").convert("RGBA")
        bbox = alpha_bbox(src)
        bh = bbox[3] - bbox[1]
        if pose in OVERRIDE_H:
            scale = OVERRIDE_H[pose] / bh
            print(f"{pose}: override scale {scale:.6f} (target h {OVERRIDE_H[pose]})")
        else:
            scale = global_scale
        out = pixelize(src, scale)
        out_path = DST_DIR / f"{pose}.png"
        out.save(out_path, format="PNG", optimize=False)

        if pose == "jump":
            foot_bbox = largest_component_bbox(out)
        else:
            foot_bbox = alpha_bbox(out)
        fx = (foot_bbox[0] + foot_bbox[2] - 1) / 2
        fy = foot_bbox[3] - 1
        body_h = foot_bbox[3] - foot_bbox[1]
        manifest[pose] = {
            "file": f"sprites/{pose}.png",
            "w": out.size[0],
            "h": out.size[1],
            "foot": [round(fx, 1), fy],
            "native_facing": facing,
            "body_h": body_h,
            "generic": True,
            "fallback": "sit",
        }
        print(f"{pose}: {out.size[0]}x{out.size[1]} foot={manifest[pose]['foot']} body_h={body_h} facing={facing}")

    import json
    MANIFEST.write_text(json.dumps(manifest, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {MANIFEST}")


if __name__ == "__main__":
    main()
