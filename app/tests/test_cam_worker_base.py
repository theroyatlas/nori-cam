"""Local HTTP worker base relaxation (opt-in only)."""
import os
import unittest

from app.cam.pipeline import run
from app.cam.worker_base import normalize_worker_base
from app.tests.test_cam_gift import GiftTests, Worker


class WorkerBaseTests(unittest.TestCase):
    def test_https_unchanged(self):
        self.assertEqual(normalize_worker_base("https://worker.example"), "https://worker.example")

    def test_http_loopback_requires_flag(self):
        with self.assertRaises(ValueError):
            normalize_worker_base("http://127.0.0.1:8788")
        os.environ["NORI_CAM_ALLOW_LOCAL_HTTP"] = "1"
        try:
            self.assertEqual(normalize_worker_base("http://127.0.0.1:8788"), "http://127.0.0.1:8788")
        finally:
            del os.environ["NORI_CAM_ALLOW_LOCAL_HTTP"]

    def test_pipeline_accepts_localhost_with_flag(self):
        os.environ["NORI_CAM_ALLOW_LOCAL_HTTP"] = "1"
        try:
            t = GiftTests()
            t.setUp()
            result = run("gift-local", "http://127.0.0.1:8788", "token", t.clients,
                         lambda: 0, http_fn=t.worker, sleep_fn=t.sleeps.append)
            self.assertEqual(result["type"], "gift_ready")
        finally:
            del os.environ["NORI_CAM_ALLOW_LOCAL_HTTP"]
