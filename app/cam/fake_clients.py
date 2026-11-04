"""Deterministic offline model clients for local e2e; never call the network."""
import copy
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageDraw

from .clients import SamBox

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT / "site/public"


def _understanding():
    from .clients import CONTRACT_VERSION
    card = copy.deepcopy(json.loads((PUBLIC / "cam/catalog.json").read_text())["entries"][0]["object"]["card"])
    card.pop("prop_poses", None)
    card.update(name="toy box", category="toy")
    card["hazards"] = []
    return {
        "contract_version": CONTRACT_VERSION,
        "initial_state": card["states"][0],
        "content_safety": {"ok": True, "reason": "ok"},
        "identifiable_person_present": False,
        "name": "toy box",
        "category": "toy",
        "size": "M",
        "object_card": card,
        "interactions": [{
            "verb": "approach",
            "sensations": {"shelter": 0.8},
            "approach": "front",
            "target_part": "inside",
            "contact": "none",
            "steps": [{"p": "move_to", "part": "inside"}, {"p": "wait", "ms": 1500}],
            "end_state": None,
            "cooldown_min": 10,
        }],
    }


def _fake_png():
    image = Image.new("RGB", (100, 100), "#ff00ff")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 30, 79, 69), fill=(180, 130, 80))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class FakeSpark:
    model = "fake-spark"
    cost_usd = 0.0
    cost_basis = "local"

    def __init__(self, raw_sink=None):
        self._raw_sink = raw_sink
        self.last_raw = None

    def understand(self, image_data_url, executor, wishes):
        if wishes != []:
            raise ValueError("wishes must be empty")
        raw = _understanding()
        self.last_raw = raw
        if self._raw_sink is not None:
            self._raw_sink.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        return raw


class FakeImage:
    model = "fake-image"
    cost_usd = 0.0
    cost_basis = "local"
    previous_response_id = None

    def __init__(self, png_sink=None):
        self._png_sink = png_sink

    def redraw(self, image_data_url, name, size, style_ref):
        self.previous_response_id = None
        png = _fake_png()
        if self._png_sink is not None:
            self._png_sink.write_bytes(png)
        return png

    def redraw_state(self, state):
        raise ValueError("state redraw not used in local e2e")


class FakeWonder:
    model = "fake-wonder"
    cost_usd = 0.01
    cost_basis = "estimate"

    def __init__(self, json_sink=None):
        self._json_sink = json_sink

    def wonder(self, context):
        event_ids = [e["id"] for e in context.get("events", []) if isinstance(e, dict) and isinstance(e.get("id"), str)]
        if not event_ids:
            raise ValueError("wonder context has no events")
        objects = context.get("objects") or []
        object_id = next((o["id"] for o in objects if isinstance(o, dict)
                          and re.fullmatch(r"o_[0-9a-f]{32}", str(o.get("id")))), None)
        object_id = object_id or next((o["id"] for o in objects if isinstance(o, dict)
                                      and isinstance(o.get("id"), str)), "o_box1")
        # Cite the actual settlement facts when available, so the local chain
        # can verify experience -> reflection causality instead of only schema.
        settled = [e["id"] for e in reversed(context.get("events", []))
                   if e.get("type") == "experience_settled" and (e.get("payload") or {}).get("target") == object_id]
        raw = {
            "reflection": {"summary": "She noticed the new toy box in the room.",
                           "event_ids": list(dict.fromkeys(settled[:1] + event_ids))[:3]},
            "tomorrow": {
                "action": "ignore",
                "window_minutes": 60,
                "reason_tag": "rest",
                "summary": "Rest quietly for a while.",
                "object_id": object_id,
            },
            "habit_candidate": None,
        }
        if self._json_sink is not None:
            self._json_sink.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        return raw


def fake_clients(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    muse_png = out_dir / "muse-image-raw.png"
    return (
        FakeSpark(out_dir / "spark-raw.json"),
        FakeImage(muse_png),
        SamBox(),
        FakeWonder(out_dir / "wonder-raw.json"),
    )
