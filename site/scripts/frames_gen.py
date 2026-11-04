#!/usr/bin/env python3
"""Offline multi-frame candidate generator for Nori Cam (E3).

Uses muse-image-1.0 via the Meta Responses API when run by the manager.
Key from MODEL_API_KEY only; never printed. --dry-run and --selftest do not call the network.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import tempfile
import time
from pathlib import Path

from openai import OpenAI
from PIL import Image

SITE = Path(__file__).resolve().parents[1]
REPO = SITE.parent
CAM_SPRITES = SITE / "public" / "cam" / "sprites"
MANIFEST_PATH = SITE / "public" / "cam" / "manifest.json"
DEFAULT_PLAN = Path(__file__).resolve().parent / "frames_plan.json"
SHEET_SCALE = 6
GIF_MS = 150
ALPHA_THRESH = 128


def load_manifest() -> dict:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def alpha_bbox(img: Image.Image):
    a = img.getchannel("A")
    mask = a.point(lambda v: 255 if v >= ALPHA_THRESH else 0)
    return mask.getbbox()


def largest_component_bbox(img: Image.Image):
    w, h = img.size
    px = img.load()
    seen = bytearray(w * h)
    best = None
    best_n = -1
    for sy in range(h):
        for sx in range(w):
            i = sy * w + sx
            if seen[i] or px[sx, sy][3] < ALPHA_THRESH:
                continue
            stack = [(sx, sy)]
            seen[i] = 1
            n = 0
            minx = maxx = sx
            miny = maxy = sy
            while stack:
                cx, cy = stack.pop()
                n += 1
                minx = min(minx, cx)
                maxx = max(maxx, cx)
                miny = min(miny, cy)
                maxy = max(maxy, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h:
                        j = ny * w + nx
                        if not seen[j] and px[nx, ny][3] >= ALPHA_THRESH:
                            seen[j] = 1
                            stack.append((nx, ny))
            if n > best_n:
                best_n = n
                best = (minx, miny, maxx + 1, maxy + 1)
    return best


def hue_chroma_key(data: bytes) -> tuple[Image.Image, dict]:
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    px = im.load()
    w, h = im.size
    n = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if r > 170 and b > 170 and g < 110:
                px[x, y] = (0, 0, 0, 0)
                n += 1
    bb = im.getbbox()
    cropped = im.crop(bb) if bb else im
    meta = {
        "size": [w, h],
        "keyed_fraction": round(n / (w * h), 3) if w * h else 0,
        "bbox": list(bb) if bb else None,
    }
    return cropped, meta


def extract_palette(path: Path) -> list[tuple[int, int, int]]:
    im = Image.open(path).convert("RGBA")
    px = im.load()
    colors: set[tuple[int, int, int]] = set()
    for y in range(im.size[1]):
        for x in range(im.size[0]):
            r, g, b, a = px[x, y]
            if a >= ALPHA_THRESH:
                colors.add((r, g, b))
    return sorted(colors)


def nearest_rgb(r: int, g: int, b: int, palette: list[tuple[int, int, int]]) -> tuple[int, int, int]:
    best = palette[0]
    best_d = 1e9
    for pr, pg, pb in palette:
        d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if d < best_d:
            best_d = d
            best = (pr, pg, pb)
    return best


def apply_alpha_threshold(img: Image.Image) -> Image.Image:
    out = img.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, 255) if a >= ALPHA_THRESH else (0, 0, 0, 0)
    return out


def quantize_to_palette(img: Image.Image, palette: list[tuple[int, int, int]]) -> Image.Image:
    out = img.copy()
    px = out.load()
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a >= ALPHA_THRESH:
                px[x, y] = (*nearest_rgb(r, g, b, palette), 255)
            else:
                px[x, y] = (0, 0, 0, 0)
    return out


def foot_point(img: Image.Image, pose: str) -> tuple[float, float]:
    if pose == "jump":
        bb = largest_component_bbox(img)
    else:
        bb = alpha_bbox(img)
    if not bb:
        w, h = img.size
        return w / 2, h - 1
    fx = (bb[0] + bb[2] - 1) / 2
    fy = bb[3] - 1
    return fx, fy


def pixelize_frame(
    keyed: Image.Image,
    target_pose: str,
    manifest: dict,
    palette: list[tuple[int, int, int]],
) -> Image.Image:
    info = manifest[target_pose]
    target_body_h = info["body_h"]
    canvas_w, canvas_h = info["w"], info["h"]
    target_fx, target_fy = info["foot"]

    bb = alpha_bbox(keyed)
    if not bb:
        return Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    body_h = bb[3] - bb[1]
    scale = target_body_h / body_h if body_h else 1.0
    nw = max(1, round(keyed.size[0] * scale))
    nh = max(1, round(keyed.size[1] * scale))
    scaled = keyed.resize((nw, nh), Image.LANCZOS)
    scaled = apply_alpha_threshold(scaled)
    scaled = quantize_to_palette(scaled, palette)

    src_fx, src_fy = foot_point(scaled, target_pose)
    paste_x = int(round(target_fx - src_fx))
    paste_y = int(round(target_fy - src_fy))

    canvas = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    canvas.paste(scaled, (paste_x, paste_y), scaled)
    return canvas


def upscale_nearest(im: Image.Image, factor: int) -> Image.Image:
    w, h = im.size
    return im.resize((w * factor, h * factor), Image.NEAREST)


def build_sheet(
    plan: dict,
    manifest: dict,
    out_dir: Path,
    set_names: list[str],
) -> None:
    rows: list[Image.Image] = []
    pad = 4 * SHEET_SCALE
    for set_name in set_names:
        spec = plan["sets"][set_name]
        pose = spec["target_pose"]
        canonical = Image.open(CAM_SPRITES / f"{pose}.png").convert("RGBA")
        frames_dir = out_dir / set_name
        pix_frames: list[Image.Image] = [canonical]
        for i, fr in enumerate(spec["frames"]):
            fid = fr["id"]
            pix_path = frames_dir / f"{i:02d}_{fid}" / "pix.png"
            if pix_path.is_file():
                pix_frames.append(Image.open(pix_path).convert("RGBA"))
        gif_frames = [f for f in pix_frames]
        if len(gif_frames) > 1:
            gif_path = out_dir / f"{set_name}.gif"
            gif_frames[0].save(
                gif_path,
                save_all=True,
                append_images=gif_frames[1:],
                duration=GIF_MS,
                loop=0,
                disposal=2,
            )

        cell_h = max(im.size[1] for im in pix_frames)
        row_w = pad
        row_cells: list[Image.Image] = []
        for im in pix_frames:
            up = upscale_nearest(im, SHEET_SCALE)
            row_cells.append(up)
            row_w += up.size[0] + pad
        row = Image.new("RGBA", (row_w, cell_h * SHEET_SCALE + pad), (32, 32, 40, 255))
        x = pad
        for up in row_cells:
            y = pad + (cell_h * SHEET_SCALE - up.size[1]) // 2
            row.paste(up, (x, y), up)
            x += up.size[0] + pad
        rows.append(row)

    if not rows:
        return
    total_h = sum(r.size[1] for r in rows) + pad * (len(rows) + 1)
    max_w = max(r.size[0] for r in rows)
    sheet = Image.new("RGBA", (max_w, total_h), (32, 32, 40, 255))
    y = pad
    for row in rows:
        sheet.paste(row, (0, y))
        y += row.size[1] + pad
    sheet.save(out_dir / "sheet.png")


def resolve_ref(path_str: str) -> Path:
    p = Path(path_str)
    if not p.is_absolute():
        p = REPO / p
    return p


def full_prompt(frame_prompt: str, style_suffix: str) -> str:
    return f"{frame_prompt.strip()} {style_suffix.strip()}"


def plan_calls(plan: dict, only: str | None) -> list[dict]:
    calls: list[dict] = []
    for set_name, spec in plan["sets"].items():
        if only and set_name != only:
            continue
        refs = [resolve_ref(r) for r in spec["references"]]
        prev = None
        for i, fr in enumerate(spec["frames"]):
            calls.append(
                {
                    "set": set_name,
                    "frame_index": i,
                    "frame_id": fr["id"],
                    "target_pose": spec["target_pose"],
                    "references": refs,
                    "prompt": full_prompt(fr["prompt"], plan.get("style_suffix", "")),
                    "previous_response_id": prev,
                    "use_prev": i > 0,
                }
            )
    return calls


def muse_call(client: OpenAI, prompt: str, ref_bytes: list[bytes], prev: str | None):
    inp = [
        {
            "role": "user",
            "content": [{"type": "input_text", "text": prompt}]
            + [
                {
                    "type": "input_image",
                    "image_url": "data:image/png;base64," + base64.b64encode(b).decode(),
                }
                for b in ref_bytes
            ],
        }
    ]
    kw = {"model": "muse-image-1.0", "input": inp, "store": True}
    if prev:
        kw["previous_response_id"] = prev
    t = time.time()
    try:
        r = client.responses.create(**kw)
    except Exception as e:
        err = type(e).__name__ + ": " + str(getattr(e, "status_code", "")) + " " + str(e)
        return None, None, round(time.time() - t, 1), err
    item = next(
        (
            i
            for i in r.output
            if getattr(i, "type", "") == "image_generation_call" and getattr(i, "result", None)
        ),
        None,
    )
    if not item:
        return None, getattr(r, "id", None), round(time.time() - t, 1), "no image"
    data = base64.b64decode(item.result)
    return data, r.id, round(time.time() - t, 1), None


def run_generation(
    plan_path: Path,
    out_dir: Path,
    dry_run: bool,
    max_calls: int,
    only: str | None,
) -> int:
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    manifest = load_manifest()
    calls = plan_calls(plan, only)

    if dry_run:
        for n, c in enumerate(calls[:max_calls], 1):
            prev_note = " prev=previous_response_id" if c["use_prev"] else " prev=None"
            print(
                f"{n}. {c['set']}/{c['frame_id']} pose={c['target_pose']} refs="
                f"{len(c['references'])}{prev_note}"
            )
            print(f"   prompt: {c['prompt'][:120]}...")
        if len(calls) > max_calls:
            print(f"(planned {len(calls)} calls; --max-calls {max_calls} would stop early)")
        return 0

    key = os.environ.get("MODEL_API_KEY")
    if not key:
        print("MODEL_API_KEY is not set; export it or use --dry-run.", file=sys.stderr)
        return 1

    client = OpenAI(api_key=key, base_url="https://api.meta.ai/v1", max_retries=1, timeout=240)
    out_dir.mkdir(parents=True, exist_ok=True)
    log: dict = {}
    call_count = 0
    prev_by_set: dict[str, str | None] = {}

    for c in calls:
        if call_count >= max_calls:
            print(f"Stopped at --max-calls {max_calls}", file=sys.stderr)
            break
        set_name = c["set"]
        prev = prev_by_set.get(set_name) if c["use_prev"] else None
        ref_bytes = [p.read_bytes() for p in c["references"]]
        data, rid, sec, err = muse_call(client, c["prompt"], ref_bytes, prev)
        call_count += 1
        key_id = f"{set_name}/{c['frame_id']}"
        entry = {"seconds": sec, "error": err, "response_id": rid}
        frame_dir = out_dir / set_name / f"{c['frame_index']:02d}_{c['frame_id']}"
        frame_dir.mkdir(parents=True, exist_ok=True)

        if data:
            (frame_dir / "raw.png").write_bytes(data)
            keyed, kmeta = hue_chroma_key(data)
            keyed.save(frame_dir / "keyed.png")
            entry["bbox"] = kmeta.get("bbox")
            palette = extract_palette(CAM_SPRITES / f"{c['target_pose']}.png")
            pix = pixelize_frame(keyed, c["target_pose"], manifest, palette)
            pix.save(frame_dir / "pix.png")
            if rid:
                prev_by_set[set_name] = rid
        log[key_id] = entry
        print(key_id, json.dumps(entry), flush=True)

    (out_dir / "log.json").write_text(json.dumps(log, indent=1), encoding="utf-8")
    set_names = sorted({c["set"] for c in calls if c["set"] in plan["sets"]})
    if only:
        set_names = [only] if only in set_names else set_names
    build_sheet(plan, manifest, out_dir, set_names)
    return 0


def run_selftest() -> int:
    manifest = load_manifest()
    plan = json.loads(DEFAULT_PLAN.read_text(encoding="utf-8"))
    room = REPO / "site" / "public" / "room" / "sprites"
    stems = {
        "walk": "nori-walk",
        "sleepy": "nori-sleepy",
        "sit": "nori-sit",
        "alert_loaf": "nori-alert-loaf",
    }
    errors: list[str] = []

    with tempfile.TemporaryDirectory(prefix="frames_gen_selftest_") as tmp:
        out = Path(tmp)
        for pose, stem in stems.items():
            src_path = room / f"{stem}.png"
            raw = src_path.read_bytes()
            keyed, _ = hue_chroma_key(raw)
            palette = extract_palette(CAM_SPRITES / f"{pose}.png")
            pix = pixelize_frame(keyed, pose, manifest, palette)
            info = manifest[pose]
            if pix.size != (info["w"], info["h"]):
                errors.append(f"{pose}: size {pix.size} != manifest {info['w']}x{info['h']}")
            px = pix.load()
            pal_set = set(palette)
            for y in range(pix.size[1]):
                for x in range(pix.size[0]):
                    r, g, b, a = px[x, y]
                    if a >= ALPHA_THRESH and (r, g, b) not in pal_set:
                        errors.append(f"{pose}: colour ({r},{g},{b}) not in palette")
                        break
                else:
                    continue
                break
        smoke_plan: dict = {"style_suffix": plan.get("style_suffix", ""), "sets": {}}
        smoke_names: list[str] = []
        for pose in stems:
            set_name = f"smoke_{pose}"
            smoke_names.append(set_name)
            smoke_plan["sets"][set_name] = {
                "target_pose": pose,
                "references": [],
                "frames": [{"id": "canonical", "prompt": ""}],
            }
            frame_dir = out / set_name / "00_canonical"
            frame_dir.mkdir(parents=True)
            Image.open(CAM_SPRITES / f"{pose}.png").convert("RGBA").save(frame_dir / "pix.png")
        build_sheet(smoke_plan, manifest, out, smoke_names)

        sheet = out / "sheet.png"
        if not sheet.is_file():
            errors.append("sheet.png not written")
        else:
            print(f"selftest sheet: {sheet} size={Image.open(sheet).size}")

    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print("selftest OK: pixel sizes match manifest; opaque colours subset of canonical palettes")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate offline Muse animation frame candidates.")
    ap.add_argument("--plan", type=Path, default=DEFAULT_PLAN, help="JSON plan path")
    ap.add_argument("--out", type=Path, help="Output directory (required unless --selftest)")
    ap.add_argument("--dry-run", action="store_true", help="Print planned API calls only")
    ap.add_argument("--max-calls", type=int, default=12, help="Max API calls (default 12)")
    ap.add_argument("--only", type=str, default=None, help="Run a single set name from the plan")
    ap.add_argument("--selftest", action="store_true", help="Offline pixel/sheet self-test")
    args = ap.parse_args()

    if args.selftest:
        return run_selftest()
    if not args.out:
        print("--out is required unless --selftest", file=sys.stderr)
        return 1
    return run_generation(args.plan, args.out, args.dry_run, args.max_calls, args.only)


if __name__ == "__main__":
    sys.exit(main())
