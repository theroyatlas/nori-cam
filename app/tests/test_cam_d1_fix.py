"""D1 fixes (2026-11-03): real Spark model id, tolerant JSON, safe failure notes, live evidence recorder.

Fake clients only; no network.
"""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from app.cam.clients import MetaSpark, json_from_text
from app.cam.local_e2e import _EvidenceRecorder
from app.cam.pipeline import safe_error
from app.cam.wake import MetaWonder

LISTED_MODELS = {"muse-image-1.0", "muse-spark-1.1", "muse-spark-1.2", "muse-spark-1.3",
                 "muse-wonder-1.0"}  # GET /v1/models on 2026-11-03 (non-contributor ids)


class _FakeResponses:
    def __init__(self, text):
        self.text = text
        self.calls = []

    def create(self, **kw):
        self.calls.append(kw)
        return SimpleNamespace(output_text=self.text,
                               usage=SimpleNamespace(input_tokens=1000, output_tokens=200))


class ModelIdTests(unittest.TestCase):
    def test_live_model_ids_exist(self):
        from app.cam.clients import MetaImage
        self.assertIn(MetaSpark.model, LISTED_MODELS)
        self.assertEqual(MetaSpark.model, "muse-spark-1.3")
        self.assertIn(MetaImage.model, LISTED_MODELS)
        self.assertIn(MetaWonder.model, LISTED_MODELS)

    def test_spark_sends_listed_model_and_parses_fenced_json(self):
        fake = SimpleNamespace(responses=_FakeResponses('```json\n{"name": "mug", "size": "S"}\n```'))
        spark = MetaSpark(client=fake)
        out = spark.understand("data:image/png;base64,AA==", {"primitives": []}, [])
        self.assertEqual(out["name"], "mug")
        self.assertEqual(fake.responses.calls[0]["model"], "muse-spark-1.3")
        self.assertEqual(spark.cost_basis, "usage")
        self.assertAlmostEqual(spark.cost_usd, (1000 * 1.25 + 200 * 4.25) / 1_000_000)

    def test_wonder_parses_fenced_json(self):
        fake = SimpleNamespace(responses=_FakeResponses('```\n{"reflection": {"summary": "x"}}\n```'))
        out = MetaWonder(client=fake).wonder({"events": []})
        self.assertEqual(out["reflection"]["summary"], "x")


class JsonFromTextTests(unittest.TestCase):
    def test_plain_fenced_and_wrapped(self):
        self.assertEqual(json_from_text('{"a": 1}'), {"a": 1})
        self.assertEqual(json_from_text('```json\n{"a": 2}\n```'), {"a": 2})
        self.assertEqual(json_from_text('Here it is: {"a": 3} done'), {"a": 3})

    def test_no_object_raises(self):
        with self.assertRaises(json.JSONDecodeError):
            json_from_text("no json here")


class SafeErrorTests(unittest.TestCase):
    def test_status_and_no_message(self):
        class NotFoundError(Exception):
            status_code = 404
        note = safe_error(NotFoundError("model muse-spark-1.0 not found; key=sk-secret"))
        self.assertEqual(note, "NotFoundError 404")
        self.assertNotIn("secret", note)
        self.assertEqual(safe_error(ValueError("photo text")), "ValueError")


class EvidenceRecorderTests(unittest.TestCase):
    def test_saves_outputs_and_delegates_live_cost(self):
        class Inner:
            model = "muse-image-1.0"
            cost_usd = 0.01
            cost_basis = "configured_per_image"

            def understand(self, *a):
                self.cost_usd, self.cost_basis = 0.002, "usage"
                return {"name": "mug"}

            def redraw(self, *a):
                return b"\x89PNG\r\n\x1a\nraw"

            def redraw_state(self, *a):
                return b"\x89PNG\r\n\x1a\nstate"

        with tempfile.TemporaryDirectory() as d:
            rec = _EvidenceRecorder(Inner(), d)
            self.assertEqual(rec.model, "muse-image-1.0")
            self.assertEqual(rec.understand("photo"), {"name": "mug"})
            self.assertEqual((rec.cost_usd, rec.cost_basis), (0.002, "usage"))
            rec.redraw("photo")
            rec.redraw_state({"open": True})
            out = Path(d)
            self.assertEqual(json.loads((out / "spark-raw.json").read_text(encoding="utf-8")), {"name": "mug"})
            self.assertTrue((out / "muse-image-raw.png").read_bytes().endswith(b"raw"))
            self.assertTrue((out / "muse-image-state-1.png").read_bytes().endswith(b"state"))
            self.assertEqual(sorted(p.name for p in out.iterdir()),
                             ["muse-image-raw.png", "muse-image-state-1.png", "spark-raw.json"])


if __name__ == "__main__":
    unittest.main()
