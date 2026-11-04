"""Deterministic Pillow-only sprite processing."""
import colorsys
import io
from PIL import Image, ImageFilter

SIZES = {"S": 16, "M": 28, "L": 44}
OUTLINE = (55, 39, 35)


def room_palette(reference):
    """Freeze a 31-colour room quantization plus the outline colour."""
    image = Image.open(io.BytesIO(reference)).convert("RGB")
    image.thumbnail((256, 256))
    quantized = image.quantize(colors=31, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()
    return tuple(dict.fromkeys([OUTLINE] + [tuple(palette[i*3:i*3+3])
                     for _, i in quantized.getcolors()]))


def hue_key(image):
    result = image.convert("RGBA").copy()
    pixels = []
    for r, g, b, a in result.getdata():
        h, s, v = colorsys.rgb_to_hsv(r/255, g/255, b/255)
        pixels.append((0, 0, 0, 0) if .76 <= h <= .93 and s > .35 and v > .25
                      else (r, g, b, 255 if a >= 128 else 0))
    result.putdata(pixels)
    return result


def palette_map(image, palette):
    def nearest(rgb):
        return min(palette, key=lambda c: sum((c[i]-rgb[i])**2 for i in range(3)))
    cache = {}
    result = image.convert("RGBA").copy()
    result.putdata([(*cache.setdefault(p[:3], nearest(p[:3])), 255) if p[3]
                    else (0, 0, 0, 0) for p in result.getdata()])
    return result


def outline(image):
    alpha = image.getchannel("A")
    expanded = alpha.filter(ImageFilter.MaxFilter(3))
    result = Image.new("RGBA", image.size, (*OUTLINE, 0))
    result.putalpha(expanded)
    result.alpha_composite(image)
    return result


def check(image, size, palette, max_distance=0):
    n = SIZES[size]
    if image.size != (n, n):
        raise ValueError("sprite canvas class")
    opaque = [p for p in image.convert("RGBA").getdata() if p[3]]
    if not .15 <= len(opaque)/(n*n) <= .85:
        raise ValueError("opaque fraction")
    box = image.getchannel("A").getbbox()
    if not box or max(box[2]-box[0], box[3]-box[1]) != n-2:
        raise ValueError("sprite bounding box class")
    if any(p[3] != 255 for p in opaque):
        raise ValueError("partial alpha")
    if any(min(sum((p[i]-c[i])**2 for i in range(3)) for c in palette)
           > max_distance**2 for p in opaque):
        raise ValueError("palette distance")
    return {"opaque_fraction": len(opaque)/(n*n), "bbox": list(box)}


def pixelize(data, size, palette):
    with Image.open(io.BytesIO(data)) as source:
        if source.format != "PNG" or source.width*source.height > 4_000_000:
            raise ValueError("redraw must be a bounded PNG")
        image = hue_key(source)
    box = image.getchannel("A").getbbox()
    if not box:
        raise ValueError("empty foreground")
    image = image.crop(box)
    n = SIZES[size]
    scale = (n-4)/max(image.size)
    image = image.resize(tuple(max(1, round(v*scale)) for v in image.size),
                         Image.Resampling.NEAREST)
    image = palette_map(image, palette)
    canvas = Image.new("RGBA", (n, n))
    canvas.alpha_composite(image, ((n-image.width)//2, (n-image.height)//2))
    canvas = outline(canvas)
    check(canvas, size, palette)
    output = io.BytesIO()
    canvas.save(output, format="PNG")
    return output.getvalue()
