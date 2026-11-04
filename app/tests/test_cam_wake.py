"""Offline cam wake contract tests. No network."""
import io
import json
import re
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace

from app.cam.pipeline import Response
from app.cam import wake

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github/workflows/nori-wake.yml"
SECRET = "test-ingest-token-do-not-leak"


class Worker:
    def __init__(self, ingest_statuses=(200,), retry_after="5"):
        self.ingest_statuses = list(ingest_statuses)
        self.retry_after = retry_after
        self.requests = []
        self.ingest_bodies = []
        self.upload_bodies = []
        self.context = {"events": [{"id": "context-event-id", "summary": "data"}]}

    def __call__(self, method, url, headers, body=None):
        self.requests.append((method, url, headers, body))
        if method == "GET" and "/api/brain/context" in url:
            return Response(200, json.dumps(self.context).encode())
        if method == "PUT" and "/media/" in url:
            self.upload_bodies.append(body)
            return Response(200)
        if method == "POST" and url.endswith("/api/ingest"):
            status = self.ingest_statuses.pop(0) if self.ingest_statuses else 200
            headers_out = {"Retry-After": self.retry_after} if status == 409 else {}
            if body and 200 <= status < 300:
                self.ingest_bodies.append(json.loads(body))
            return Response(status, b"", headers_out)
        return Response(404)


def valid_wonder():
    return {
        "reflection": {"summary": "A short reflection.", "event_ids": ["context-event-id"]},
        "tomorrow": {
            "action": "sniff",
            "object_id": "o_slipper",
            "window_minutes": 1200,
            "reason_tag": "revisit_soft_object",
            "summary": "Try the familiar object again.",
        },
        "habit_candidate": "soft",
    }


class WakeTests(unittest.TestCase):
    def setUp(self):
        self.worker = Worker()
        self.sleeps = []

    def test_invalid_reason_no_http(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()) as err:
            code = wake.main(["--reason", "routine", "--intent-id", "seg:1"])
        self.assertEqual(code, 2)
        self.assertEqual(self.worker.requests, [])

    def test_invalid_intent_no_http(self):
        code = wake.main(["--reason", "computer", "--intent-id", "bad"])
        self.assertEqual(code, 2)

    def test_reflect_body_exact(self):
        wonder = SimpleNamespace(model="fake-wonder", cost_usd=0.04, cost_basis="usage",
                                 wonder=lambda ctx: valid_wonder())
        payload = wake.run_reflect("seg:998", "https://worker.invalid", SECRET, wonder,
                                   http_fn=self.worker, sleep_fn=self.sleeps.append)
        self.assertEqual(payload, {
            "type": "wonder_result",
            "intent_id": "seg:998",
            "cost_usd": 0.04,
            "result": valid_wonder(),
        })
        self.assertEqual(self.worker.ingest_bodies, [payload])
        self.assertEqual([r[0] for r in self.worker.requests], ["GET", "POST"])
        self.assertTrue(all(r[2]["Authorization"] == "Bearer " + SECRET for r in self.worker.requests))

    def test_invalid_wonder_not_sent(self):
        wonder = SimpleNamespace(model="fake", cost_usd=0.01,
                                 wonder=lambda ctx: {**valid_wonder(),
                                 "reflection": {"summary": "x", "event_ids": ["missing-id"]}})
        with self.assertRaises(RuntimeError):
            wake.run_reflect("seg:1", "https://worker.invalid", SECRET, wonder, http_fn=self.worker)
        self.assertEqual(self.worker.ingest_bodies, [])

    def test_browse_body_exact(self):
        pages = [{"url": "https://example.org/read", "title": "Read page title", "read_at": 1793620799900}]
        drawer = SimpleNamespace(model="fake-image", cost_usd=0.12, draw=lambda prompt: b"jpeg-bytes")
        payload = wake.run_computer("seg:999", "https://worker.invalid", SECRET, drawer,
                                    http_fn=self.worker, sleep_fn=self.sleeps.append,
                                    seed_pages=pages)
        self.assertEqual(payload, {
            "type": "browse_result",
            "intent_id": "seg:999",
            "pages": pages,
            "drawing": "/media/browse-seg-999.jpg",
            "cost_usd": 0.12,
        })
        self.assertEqual(self.worker.ingest_bodies, [payload])
        self.assertEqual(self.worker.upload_bodies, [b"jpeg-bytes"])
        self.assertEqual([r[0] for r in self.worker.requests], ["PUT", "POST"])

    def test_receipts_ignore_model_page_claims(self):
        pages = [{"url": "https://a.test/one", "title": "One", "read_at": 1000}]
        extra = {"url": "https://fake/invented", "title": "Never fetched", "read_at": 2000}

        class LiarDrawer:
            model = "fake"
            cost_usd = 0.01

            def draw(self, prompt):
                self.claimed_pages = [pages[0], extra]
                return b"img"

        drawer = LiarDrawer()
        payload = wake.run_computer("seg:5", "https://worker.invalid", SECRET, drawer,
                                    http_fn=self.worker, seed_pages=pages)
        self.assertEqual(payload["pages"], pages)
        self.assertEqual(len(drawer.claimed_pages), 2)

    def test_409_retry_then_success(self):
        self.worker = Worker([409, 409, 200])
        wonder = SimpleNamespace(model="fake", cost_usd=0.04, wonder=lambda ctx: valid_wonder())
        wake.run_reflect("seg:998", "https://worker.invalid", SECRET, wonder,
                         http_fn=self.worker, sleep_fn=self.sleeps.append)
        self.assertEqual(self.sleeps, [5.0, 5.0])
        self.assertEqual(len(self.worker.ingest_bodies), 1)

    def test_409_without_retry_stops(self):
        self.worker = Worker([409])
        self.worker.retry_after = None
        wonder = SimpleNamespace(model="fake", cost_usd=0.04, wonder=lambda ctx: valid_wonder())
        with self.assertRaises(RuntimeError):
            wake.run_reflect("seg:998", "https://worker.invalid", SECRET, wonder, http_fn=self.worker)
        self.assertEqual(self.sleeps, [])

    def test_other_409_stops(self):
        self.worker = Worker([409, 409])
        self.worker.retry_after = "nope"
        wonder = SimpleNamespace(model="fake", cost_usd=0.04, wonder=lambda ctx: valid_wonder())
        with self.assertRaises(RuntimeError):
            wake.run_reflect("seg:998", "https://worker.invalid", SECRET, wonder,
                               http_fn=self.worker, sleep_fn=self.sleeps.append)
        self.assertEqual(len(self.worker.ingest_bodies), 0)

    def test_no_secret_in_output(self):
        out = io.StringIO()
        err = io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = wake.main(["--reason", "reflect", "--intent-id", "seg:1"])
        self.assertEqual(code, 1)
        combined = out.getvalue() + err.getvalue()
        self.assertNotIn(SECRET, combined)
        self.assertNotIn("Traceback", combined)

    def test_validate_wonder_event_membership(self):
        self.assertFalse(wake.validate_wonder(valid_wonder(), ["other-id"]))




if __name__ == "__main__":
    unittest.main()
