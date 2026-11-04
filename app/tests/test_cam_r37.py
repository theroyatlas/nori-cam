import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from app.cam.r37_observer import Observer


class FakePage:
    def __init__(self):
        self.listeners = {}

    def on(self, name, callback):
        self.listeners[name] = callback

    def route(self, pattern, callback):
        self.listeners["route"] = callback


class R37ObserverTests(unittest.TestCase):
    def test_unknown_before_listener_installation(self):
        with tempfile.TemporaryDirectory() as temp:
            observer = Observer(Path(temp))
            data = json.loads((Path(temp) / "observer.json").read_text())
            self.assertIsNone(data["page_errors"])
            self.assertIsNone(data["external_requests"])
            self.assertFalse(any(data["listener_installed"].values()))

    def test_error_external_attempt_and_timeout_survive_finalization(self):
        with tempfile.TemporaryDirectory() as temp:
            observer = Observer(Path(temp)); page = FakePage()
            observer.attach(page, "http://127.0.0.1:12345")
            page.listeners["pageerror"](ValueError("real page failure"))
            class Route:
                request = type("Request", (), {"url": "https://outside.invalid/photo"})()
                aborted = False
                def abort(self): self.aborted = True
            route = Route(); page.listeners["route"](route)
            observer.failure = "TimeoutError: reflected dispatch absent"
            observer.cleanup = {"browser_closed": True, "worker_stopped": True}
            observer.flush()
            data = json.loads((Path(temp) / "observer.json").read_text())
            self.assertTrue(route.aborted)
            self.assertEqual(data["page_errors"], ["real page failure"])
            self.assertEqual(data["external_requests"], ["https://outside.invalid/photo"])
            self.assertIn("TimeoutError", data["failure"])
            self.assertTrue(all(data["listener_installed"].values()))

    def test_default_entry_is_plan_only(self):
        from app.cam import r37_ui
        with patch("subprocess.Popen") as process, contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(r37_ui.main([]), 0)
        process.assert_not_called()
        self.assertIsNone(json.loads(output.getvalue())["execute_command"])


if __name__ == "__main__": unittest.main()
