"""D1fix6: photo-gift pipeline accepts muse-image WebP/JPEG output.

Fake Responses clients only; no network. Covers MetaImage format
detection/conversion, the pipeline redraw diagnosis note, the live evidence
recorder raw bytes, and the too-large refusal.
"""
import base64
import copy
import io
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageDraw

from app.cam.clients import ImageFormatError, MetaImage
from app.cam.local_e2e import _EvidenceRecorder
from app.cam.pipeline import PUBLIC, Response, run
from app.cam.pixel import pixelize, room_palette


def _magenta_mug(width=120, height=120):
    """Solid #FF00FF background with a dark mug-like shape."""
    image = Image.new("RGB", (width, height), "#ff00ff")
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 35, 89, 84), fill=(180, 130, 80))
    draw.rectangle((45, 20, 74, 34), fill=(40, 25, 18))
    return image


def _encode(image, fmt, **kw):
    output = io.BytesIO()
    image.save(output, format=fmt, **kw)
    return output.getvalue()


def _png():
    return _encode(_magenta_mug(), "PNG")


def _webp(quality=90):
    return _encode(_magenta_mug(), "WEBP", quality=quality)


def _jpeg(quality=92):
    return _encode(_magenta_mug(), "JPEG", quality=quality)


class _FakeResponses:
    """Mimics client.responses.create returning one image_generation_call."""

    def __init__(self, raw_bytes):
        self.result = base64.b64encode(raw_bytes).decode("ascii")

    def create(self, **kwargs):
        return SimpleNamespace(
            id="resp-1",
            output=[SimpleNamespace(type="image_generation_call",
                                    result=self.result)])


def _meta(raw_bytes):
    return MetaImage(SimpleNamespace(responses=_FakeResponses(raw_bytes)))


def _room_palette_s():
    return room_palette((PUBLIC / "room/bg-day.jpg").read_bytes())


def _understanding():
    from app.cam.clients import CONTRACT_VERSION
    card = copy.deepcopy(
        json.loads((PUBLIC / "cam/catalog.json").read_text())["entries"][0]["object"]["card"])
    card.pop("prop_poses", None)
    card.update(name="toy box", category="toy", size="S")
    card["hazards"] = []
    return {"contract_version": CONTRACT_VERSION,
            "initial_state": card["states"][0],
            "content_safety": {"ok": True, "reason": "ok"},
            "identifiable_person_present": False,
            "name": "toy box", "category": "toy",
            "size": "S", "object_card": card,
            "interactions": [{"verb": "approach", "sensations": {"shelter": .8},
                              "approach": "front", "target_part": "inside", "contact": "none",
                              "steps": [{"p": "move_to", "part": "inside"},
                                        {"p": "wait", "ms": 1500}],
                              "end_state": None, "cooldown_min": 10}]}


class _Worker:
    def __init__(self, source):
        self.requests = []
        self.source = source
        self.sprite = None

    def __call__(self, method, url, headers, body=None):
        self.requests.append((method, url))
        if method == "GET":
            return Response(200, self.source, {})
        if method == "PUT":
            self.sprite = body
            return Response(200)
        return Response(200)


class FormatTests(unittest.TestCase):
    def test_png_returned_unchanged(self):
        raw = _png()
        client = _meta(raw)
        out = client.redraw("data:image/png;base64,x", "toy box", "S",
                            "data:image/jpeg;base64,x")
        self.assertEqual(out, raw)
        self.assertEqual(client.last_source_format, "png")

    def test_webp_converted_to_png_and_pixelizes(self):
        raw = _webp()
        self.assertTrue(raw.startswith(b"RIFF") and raw[8:12] == b"WEBP")
        client = _meta(raw)
        out = client.redraw("data:image/png;base64,x", "toy box", "S",
                            "data:image/jpeg;base64,x")
        self.assertEqual(client.last_source_format, "webp")
        self.assertTrue(out.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(image.format, "PNG")
        # hue_key must still strip the lossy magenta background; a failure
        # here is reported, never fixed by loosening safety checks.
        sprite = pixelize(out, "S", _room_palette_s())
        with Image.open(io.BytesIO(sprite)) as sprite_image:
            self.assertEqual(sprite_image.size, (16, 16))

    def test_jpeg_converted_to_png_and_pixelizes(self):
        raw = _jpeg()
        self.assertTrue(raw.startswith(b"\xff\xd8\xff"))
        client = _meta(raw)
        out = client.redraw("data:image/png;base64,x", "toy box", "S",
                            "data:image/jpeg;base64,x")
        self.assertEqual(client.last_source_format, "jpeg")
        self.assertTrue(out.startswith(b"\x89PNG\r\n\x1a\n"))
        with Image.open(io.BytesIO(out)) as image:
            self.assertEqual(image.format, "PNG")
        sprite = pixelize(out, "S", _room_palette_s())
        with Image.open(io.BytesIO(sprite)) as sprite_image:
            self.assertEqual(sprite_image.size, (16, 16))

    def test_garbage_raises_fixed_format_error(self):
        client = _meta(b"not an image at all")
        with self.assertRaises(ImageFormatError) as ctx:
            client.redraw("data:image/png;base64,x", "toy box", "S",
                          "data:image/jpeg;base64,x")
        self.assertEqual(str(ctx.exception),
                         "unsupported redraw image format: unknown")

    def test_too_large_image_refused(self):
        raw = _encode(_magenta_mug(2500, 2000), "JPEG", quality=75)
        with Image.open(io.BytesIO(raw)) as probe:
            self.assertGreater(probe.width * probe.height, 4_000_000)
        client = _meta(raw)
        with self.assertRaises(ImageFormatError) as ctx:
            client.redraw("data:image/png;base64,x", "toy box", "S",
                          "data:image/jpeg;base64,x")
        self.assertEqual(str(ctx.exception), "redraw image too large")


class PipelineNoteTests(unittest.TestCase):
    def test_redraw_step_note_contains_fixed_message(self):
        worker = _Worker(_png())
        clients = SimpleNamespace(
            spark=SimpleNamespace(model="fake-spark", cost_usd=0,
                                  understand=lambda *a: _understanding()),
            image=_meta(b"not an image at all"),
            box=SimpleNamespace(model="fake-box", cost_usd=0,
                                box=lambda *a: None))
        result = run("test-gift", "https://worker.invalid", "test-token",
                     clients, lambda: 0, http_fn=worker,
                     sleep_fn=lambda s: None)
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "redraw")
        redraw = next(s for s in result["pipeline"] if s["step"] == "redraw")
        self.assertIn("ImageFormatError", redraw["note"])
        self.assertIn("unsupported redraw image format: unknown",
                      redraw["note"])
        self.assertNotIn("bwgld", json.dumps(result))

    def test_converted_redraw_records_source_format(self):
        worker = _Worker(_png())
        clients = SimpleNamespace(
            spark=SimpleNamespace(model="fake-spark", cost_usd=0,
                                  understand=lambda *a: _understanding()),
            image=_meta(_webp()),
            box=SimpleNamespace(model="fake-box", cost_usd=0,
                                box=lambda *a: None))
        result = run("test-gift", "https://worker.invalid", "test-token",
                     clients, lambda: 0, http_fn=worker,
                     sleep_fn=lambda s: None)
        self.assertEqual(result["type"], "gift_ready")
        redraw = next(s for s in result["pipeline"] if s["step"] == "redraw")
        self.assertEqual(redraw.get("note"), "source webp converted to png")

    def test_png_redraw_keeps_bare_record(self):
        worker = _Worker(_png())
        clients = SimpleNamespace(
            spark=SimpleNamespace(model="fake-spark", cost_usd=0,
                                  understand=lambda *a: _understanding()),
            image=_meta(_png()),
            box=SimpleNamespace(model="fake-box", cost_usd=0,
                                box=lambda *a: None))
        result = run("test-gift", "https://worker.invalid", "test-token",
                     clients, lambda: 0, http_fn=worker,
                     sleep_fn=lambda s: None)
        self.assertEqual(result["type"], "gift_ready")
        redraw = next(s for s in result["pipeline"] if s["step"] == "redraw")
        self.assertNotIn("note", redraw)


class EvidenceRecorderTests(unittest.TestCase):
    def test_converted_redraw_keeps_raw_bytes(self):
        raw = _webp()
        with tempfile.TemporaryDirectory() as tmp:
            rec = _EvidenceRecorder(_meta(raw), tmp)
            out = rec.redraw("data:image/png;base64,x", "toy box", "S",
                             "data:image/jpeg;base64,x")
            names = sorted(p.name for p in Path(tmp).iterdir())
            self.assertIn("muse-image-raw.png", names)
            self.assertIn("muse-image-raw.webp", names)
            self.assertEqual((Path(tmp) / "muse-image-raw.png").read_bytes(), out)
            self.assertEqual((Path(tmp) / "muse-image-raw.webp").read_bytes(), raw)

    def test_png_redraw_keeps_single_file(self):
        raw = _png()
        with tempfile.TemporaryDirectory() as tmp:
            rec = _EvidenceRecorder(_meta(raw), tmp)
            rec.redraw("data:image/png;base64,x", "toy box", "S",
                       "data:image/jpeg;base64,x")
            names = sorted(p.name for p in Path(tmp).iterdir())
            self.assertEqual(names, ["muse-image-raw.png"])


if __name__ == "__main__":
    unittest.main()
