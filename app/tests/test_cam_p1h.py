"""P1h: live gate, live reflect client/cost, pre-reflect spend guard. No network."""
import json
import os
import unittest
from unittest import mock

from app.cam import local_e2e
from app.cam.pipeline import Response


def _worker_http(event_ids=("context-event-id",), ingest_status=200):
    calls = []

    def http_fn(method, url, headers, body=None):
        calls.append((method, url))
        if method == "GET" and "/api/brain/context" in url:
            context = {"events": [{"id": i} for i in event_ids],
                       "objects": [{"id": "o_box1"}]}
            return Response(200, json.dumps(context).encode())
        if method == "POST" and url.endswith("/api/ingest"):
            return Response(ingest_status)
        return Response(404)

    return http_fn, calls


def _valid_wonder(event_id="context-event-id"):
    return {
        "reflection": {"summary": "A short reflection.", "event_ids": [event_id]},
        "tomorrow": {
            "action": "sniff",
            "object_id": "o_box1",
            "window_minutes": 120,
            "reason_tag": "revisit",
            "summary": "Try the familiar object again.",
        },
        "habit_candidate": None,
    }


class CountingWonder:
    model = "stub-wonder"
    cost_basis = "usage"

    def __init__(self, cost=0.037):
        self.cost_usd = cost
        self.calls = 0

    def wonder(self, context):
        self.calls += 1
        return _valid_wonder()


class GateTests(unittest.TestCase):
    def test_live_refused_without_approval(self):
        env = {k: v for k, v in os.environ.items()
               if k != local_e2e.LIVE_APPROVAL_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            with self.assertRaises(SystemExit) as ctx:
                local_e2e.main(["--photo", "x", "--out", "y", "--live"])
        self.assertIn(local_e2e.LIVE_APPROVAL_ENV, str(ctx.exception))

    def test_live_refused_when_approval_not_one(self):
        with mock.patch.dict(os.environ, {local_e2e.LIVE_APPROVAL_ENV: "yes"}):
            with self.assertRaises(SystemExit) as ctx:
                local_e2e.main(["--photo", "x", "--out", "y", "--live"])
        self.assertIn("refusing --live", str(ctx.exception))

    def test_live_passes_gate_with_approval(self):
        with mock.patch.dict(os.environ, {local_e2e.LIVE_APPROVAL_ENV: "1"}):
            self.assertTrue(local_e2e._live_approved())
            # Gate passes, so the run proceeds to the photo check (no network).
            with self.assertRaises(SystemExit) as ctx:
                local_e2e.main(["--photo", r"C:\Temp\nori-p1h-no-such-photo.png",
                                "--out", r"C:\Temp\nori-p1h-out", "--live"])
        self.assertIn("photo path missing", str(ctx.exception))

    def test_fake_mode_needs_no_approval(self):
        env = {k: v for k, v in os.environ.items()
               if k != local_e2e.LIVE_APPROVAL_ENV}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertFalse(local_e2e._live_approved())
            with self.assertRaises(SystemExit) as ctx:
                local_e2e.main(["--photo", r"C:\Temp\nori-p1h-no-such-photo.png",
                                "--out", r"C:\Temp\nori-p1h-out"])
        self.assertIn("photo path missing", str(ctx.exception))


class ReflectStepTests(unittest.TestCase):
    def test_fake_reflect_uses_given_client_once(self):
        wonder = CountingWonder(cost=0.01)
        http_fn, calls = _worker_http()
        client, payload = local_e2e._run_reflect_step(
            "seg:1", "https://worker.invalid", "tok", wonder,
            live=False, max_usd=1.0, http_fn=http_fn,
            sleep_fn=lambda s: None)
        self.assertIs(client, wonder)
        self.assertEqual(wonder.calls, 1)
        self.assertEqual(payload["type"], "wonder_result")
        self.assertEqual(payload["cost_usd"], 0.01)
        self.assertEqual(local_e2e._client_cost_usd(client, 0.0), 0.01)
        self.assertEqual(local_e2e._client_cost_basis(client, "local"), "usage")
        self.assertEqual([m for m, _ in calls], ["GET", "POST"])

    def test_live_reflect_uses_meta_wonder_once_and_records_cost(self):
        stub = CountingWonder(cost=0.037)
        created = []

        class FakeMetaWonder:
            model = "muse-wonder-1.0"

            def __new__(cls):
                created.append(1)
                return stub

        http_fn, _ = _worker_http()
        with mock.patch("app.cam.wake.MetaWonder", FakeMetaWonder):
            with mock.patch.object(local_e2e, "_budget_spend_usd", return_value=0.0):
                client, payload = local_e2e._run_reflect_step(
                    "seg:1", "https://worker.invalid", "tok", None,
                    live=True, max_usd=1.0, http_fn=http_fn,
                    sleep_fn=lambda s: None)
        self.assertEqual(len(created), 1)
        self.assertEqual(stub.calls, 1)
        self.assertEqual(payload["cost_usd"], 0.037)
        self.assertEqual(local_e2e._client_cost_usd(client, 0.0), 0.037)
        self.assertEqual(local_e2e._client_cost_basis(client, "x"), "usage")

    def test_spend_guard_stops_before_reflect(self):
        stub = CountingWonder()
        created = []

        class FakeMetaWonder:
            def __new__(cls):
                created.append(1)
                return stub

        http_fn, _ = _worker_http()
        with mock.patch("app.cam.wake.MetaWonder", FakeMetaWonder):
            with mock.patch.object(local_e2e, "_budget_spend_usd", return_value=5.0):
                with self.assertRaises(local_e2e._SpendGuardStop):
                    local_e2e._run_reflect_step(
                        "seg:1", "https://worker.invalid", "tok", None,
                        live=True, max_usd=1.0, http_fn=http_fn,
                        sleep_fn=lambda s: None)
        self.assertEqual(stub.calls, 0)

    def test_spend_guard_allows_reflect_under_cap(self):
        stub = CountingWonder()
        http_fn, _ = _worker_http()
        with mock.patch("app.cam.wake.MetaWonder", lambda: stub):
            with mock.patch.object(local_e2e, "_budget_spend_usd", return_value=0.0):
                _, payload = local_e2e._run_reflect_step(
                    "seg:1", "https://worker.invalid", "tok", None,
                    live=True, max_usd=1.0, http_fn=http_fn,
                    sleep_fn=lambda s: None)
        self.assertEqual(stub.calls, 1)
        self.assertEqual(payload["type"], "wonder_result")

    def test_pipeline_cost_basis(self):
        self.assertEqual(local_e2e._pipeline_cost_basis({"pipeline": []}, False), "local")
        result = {"pipeline": [
            {"cost_basis": "usage"}, {"cost_basis": "configured_per_image"},
            {"cost_basis": "usage"},
        ]}
        self.assertEqual(
            local_e2e._pipeline_cost_basis(result, True),
            "usage,configured_per_image")
        self.assertEqual(local_e2e._pipeline_cost_basis({}, True), "estimate")


if __name__ == "__main__":
    unittest.main()
