"""D1fix contract tests: split content safety from interaction safety.

Fake clients only; no network. Covers the Python pipeline gate; the Worker
half of each case lives in site/test/cam-d1fix.test.ts.
"""
import copy
import io
import json
import unittest
from pathlib import Path
from types import SimpleNamespace

from PIL import Image, ImageDraw

from app.cam.clients import CONTRACT_VERSION
from app.cam.pipeline import Response, run, PUBLIC


def photo():
    image = Image.new("RGB", (100, 100), "#ff00ff")
    draw = ImageDraw.Draw(image)
    draw.rectangle((20, 30, 79, 69), fill=(180, 130, 80))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def toy_answer():
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


def mug_answer():
    """Hot-mug style object: the D1 Spark shape plus the new contract fields."""
    card = {
        "name": "Black Textured Mug",
        "category": "household",
        "size": "S",
        "height": "mid",
        "tags": ["portable"],
        "sensations": {"warm": 0.9},
        "parts": [
            {"kind": "opening", "label": "mug opening", "side": "top", "height": "mid"},
            {"kind": "handle", "label": "mug handle", "side": "right", "height": "mid"},
        ],
        "states": ["empty", "steaming hot"],
        "hazards": [{"kind": "hot", "parts": ["opening"], "states": ["steaming hot"]}],
        "space": {"cm": {"w": 12, "d": 10, "h": 11}, "blocks": False,
                  "placement": "floor",
                  "movable": {"push": True, "rotate": True, "stack": False},
                  "state_cm": {}},
        "affordances": [],
        "beyond_executor": ["drinking liquid", "pouring liquid"],
        "summary": "Black textured mug holding hot steaming drink.",
    }
    sniff = {
        "verb": "sniff steam",
        "sensations": {"warm": 0.8},
        "approach": "front",
        "target_part": "opening",
        "contact": "none",
        "steps": [{"p": "move_to", "approach": "front", "gait": "walk", "ms": 3000},
                  {"p": "hold_pose", "pose": "look-up", "ms": 2000}],
        "end_state": "steaming hot",
        "cooldown_min": 5,
    }
    touch = {
        "verb": "touch mug gently",
        "sensations": {"warm": 0.6},
        "approach": "front",
        "target_part": "opening",
        "contact": "touch",
        "steps": [{"p": "move_to", "approach": "front", "gait": "walk", "ms": 2500},
                  {"p": "touch", "part": "opening", "pose": "wave", "ms": 1000},
                  {"p": "wait", "pose": "sit", "ms": 2000}],
        "end_state": "steaming hot",
        "cooldown_min": 10,
    }
    return {
        "contract_version": CONTRACT_VERSION,
        "initial_state": "steaming hot",
        "content_safety": {"ok": True, "reason": "ok"},
        "identifiable_person_present": False,
        "name": "Black Textured Mug",
        "category": "household",
        "size": "S",
        "object_card": card,
        "interactions": [sniff, touch],
    }


def legacy_d1_answer():
    """The old real D1 Spark output shape: no version, safe=false, no hazards."""
    card = {
        "name": "Black Textured Mug",
        "category": "household",
        "size": "S",
        "height": "mid",
        "tags": ["portable"],
        "sensations": {"warm": 0.9},
        "parts": [
            {"kind": "opening", "label": "mug opening", "side": "top", "height": "mid"},
            {"kind": "handle", "label": "mug handle", "side": "right", "height": "mid"},
        ],
        "states": ["empty", "steaming hot"],
        "space": {"cm": {"w": 12, "d": 10, "h": 11}, "blocks": False,
                  "placement": "surface",
                  "movable": {"push": True, "rotate": True, "stack": False},
                  "state_cm": {}},
        "affordances": [],
        "beyond_executor": ["drinking liquid"],
        "summary": "Black textured mug holding hot steaming drink.",
    }
    return {
        "name": "Black Textured Mug",
        "category": "household",
        "safe": False,
        "person_present": False,
        "size": "S",
        "object_card": card,
        "interactions": [{
            "verb": "sniff steam",
            "sensations": {"warm": 0.8},
            "steps": [{"p": "move_to", "part": "front", "gait": "walk", "ms": 3000},
                      {"p": "hold_pose", "pose": "look-up", "ms": 2000}],
            "end_state": "steaming hot",
            "cooldown_min": 5,
        }],
    }


class Worker:
    def __init__(self):
        self.requests = []
        self.payloads = []
        self.source = photo()

    def __call__(self, method, url, headers, body=None):
        self.requests.append((method, url, headers, body))
        if method == "GET":
            return Response(200, self.source, {})
        if method == "PUT":
            return Response(200)
        self.payloads.append(json.loads(body))
        return Response(200)


class D1FixGateTests(unittest.TestCase):
    def setUp(self):
        self.worker = Worker()
        self.sleeps = []
        self.answer = toy_answer()
        self.clients = SimpleNamespace(
            spark=SimpleNamespace(model="fake-spark", cost_usd=0, understand=lambda *a: self.answer),
            image=SimpleNamespace(model="fake-image", cost_usd=0, redraw=lambda *a: photo()),
            box=SimpleNamespace(model="fake-box", cost_usd=0, box=lambda *a: None))

    def run_gift(self):
        return run("test-gift", "https://worker.invalid", "test-token", self.clients,
                   lambda: 0, http_fn=self.worker, sleep_fn=self.sleeps.append)

    def test_harmless_object_accepted_with_legal_contact(self):
        touch = {"verb": "touch box", "sensations": {"shelter": 0.5},
                 "approach": "front", "target_part": "inside", "contact": "touch",
                 "steps": [{"p": "move_to", "part": "inside"},
                           {"p": "touch", "part": "inside", "ms": 1000}],
                 "end_state": None, "cooldown_min": 10}
        self.answer["interactions"].append(touch)
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_ready")
        self.assertEqual(len(result["interactions"]), 2)
        self.assertEqual(result["contract_version"], CONTRACT_VERSION)

    def test_hot_mug_object_accepted_at_gate(self):
        # Hazard-vs-state refusal belongs to the Worker (it has world state);
        # the gate forwards both candidates, including the hot contact one.
        self.answer = mug_answer()
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_ready")
        self.assertEqual(len(result["interactions"]), 2)
        self.assertEqual(result["object_card"]["hazards"],
                         [{"kind": "hot", "parts": ["opening"], "states": ["steaming hot"]}])
        self.assertEqual(result["initial_state"], "steaming hot")

    def test_content_safety_refusal(self):
        self.answer["content_safety"] = {"ok": False, "reason": "nudity"}
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("ContentSafetyRefusal", json.dumps(result["pipeline"]))

    def test_uncertain_content_safety_refused_fail_closed(self):
        for content in (None, {}, {"reason": "ok"}, {"ok": "yes", "reason": "ok"}):
            with self.subTest(content=content):
                self.answer = {**toy_answer(), "content_safety": content}
                self.worker = Worker()
                result = self.run_gift()
                self.assertEqual(result["type"], "gift_failed")
                self.assertEqual(result["step"], "understand")

    def test_person_rule_refusal(self):
        for value in (True, None, "no"):
            with self.subTest(value=value):
                self.answer = {**toy_answer(), "identifiable_person_present": value}
                self.worker = Worker()
                result = self.run_gift()
                self.assertEqual(result["type"], "gift_failed")
                self.assertEqual(result["step"], "understand")
                self.assertIn("PersonRuleRefusal", json.dumps(result["pipeline"]))

    def test_undeclared_part_refused(self):
        self.answer["interactions"][0]["steps"] = [{"p": "touch", "part": "viewport", "ms": 1000}]
        self.answer["interactions"][0]["contact"] = "touch"
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("InteractionContractError", json.dumps(result["pipeline"]))

    def test_unknown_primitive_never_compiled(self):
        self.answer["interactions"][0]["steps"] = [{"p": "teleport", "part": "inside", "ms": 500}]
        self.answer["interactions"][0]["contact"] = "touch"
        self.answer["object_card"]["beyond_executor"] = ["teleport"]
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")

    def test_missing_hazards_refused(self):
        del self.answer["object_card"]["hazards"]
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("HazardSpecError", json.dumps(result["pipeline"]))

    def test_missing_initial_state_refused(self):
        del self.answer["initial_state"]
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("InteractionContractError", json.dumps(result["pipeline"]))

    def test_non_card_initial_state_refused(self):
        for bad in ("lava", None, 0):
            with self.subTest(bad=bad):
                self.answer = {**toy_answer(), "initial_state": bad}
                self.worker = Worker()
                result = self.run_gift()
                self.assertEqual(result["type"], "gift_failed")
                self.assertEqual(result["step"], "understand")

    def test_legacy_d1_output_refused_not_crash(self):
        self.answer = legacy_d1_answer()
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("LegacyContractRefusal", json.dumps(result["pipeline"]))
        self.assertFalse(any(r[0] == "PUT" for r in self.worker.requests))

    def test_mixed_contract_legacy_fields_refused_fail_closed(self):
        """F1: any answer carrying safe/person_present is refused, whatever the value."""
        for field, value in [("safe", False), ("safe", True),
                             ("person_present", False), ("person_present", True)]:
            with self.subTest(field=field, value=value):
                self.answer = {**toy_answer(), field: value}
                self.worker = Worker()
                result = self.run_gift()
                self.assertEqual(result["type"], "gift_failed")
                self.assertEqual(result["step"], "understand")
                self.assertIn("LegacyContractRefusal", json.dumps(result["pipeline"]))
                self.assertFalse(any(r[0] == "PUT" for r in self.worker.requests))

    def test_mixed_contract_nested_legacy_field_refused(self):
        self.answer = {**toy_answer()}
        self.answer["object_card"] = {**self.answer["object_card"], "safe": True}
        result = self.run_gift()
        self.assertEqual(result["type"], "gift_failed")
        self.assertEqual(result["step"], "understand")
        self.assertIn("LegacyContractRefusal", json.dumps(result["pipeline"]))


if __name__ == "__main__":
    unittest.main()
