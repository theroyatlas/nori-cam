"""Keyless regressions for the local chain's acceptance boundary."""
import json
import os
import unittest
from unittest.mock import patch

from app.cam import local_e2e as runner
from app.cam import live_candidate


class TimingTests(unittest.TestCase):
    def test_late_stage_gets_time_on_entry_and_respects_overall_cap(self):
        with patch.object(runner.time, "monotonic", return_value=1300):
            self.assertEqual(runner._stage_deadline(10, "reflect_wait", 1600), 1372)
            self.assertEqual(runner._stage_deadline(10, "plan", 1350), 1350)

    def test_clock_visits_sleep_start_before_end(self):
        cam = {"server_now": 100, "segments": [{"start_at": 200, "end_at": 500}]}
        self.assertEqual(runner._next_boundary(cam), 200)
        cam["server_now"] = 200
        self.assertEqual(runner._next_boundary(cam), 500)

    def test_polling_does_not_call_shared_legacy_cron(self):
        clock = unittest.mock.Mock()
        with patch.object(runner.time, "monotonic", return_value=0), \
             patch.object(runner, "_fetch_cam", return_value={"server_now": 1, "segments": []}), \
             patch.object(runner, "_json_request"), patch.object(runner, "_trigger_scheduled") as cron:
            runner._poll_stage("test", unittest.mock.Mock(side_effect=[None, {"ok": 1}]),
                               10, [], clock, "http://127.0.0.1:1", "local", "local")
        cron.assert_not_called()


class ReflectionTests(unittest.TestCase):
    def check(self, row=None, cited=None, exp="exp:1"):
        row = row or {"id": "ingest:seg:7:wonder_result", "ok": 1,
                      "budget_settled": 1, "intent_persisted": 1}
        row["payload"] = json.dumps({"reflection": {"event_ids": cited or ["settled:1"]}})
        events = [{"id": "settled:1", "payload": json.dumps({"experience": "exp:1"})}]
        with patch.object(runner, "_d1_rows", side_effect=[[row], events]) as query:
            result = runner._reflection_evidence("seg:7", exp)
        self.assertIn("e.id='ingest:seg:7:wonder_result'", query.call_args_list[0].args[0])
        return result

    def test_requires_exact_experience_event_not_experience_id(self):
        self.assertEqual(self.check()[1], [])
        self.assertIn("cites_experience", self.check(cited=["exp:1"])[1])
        self.assertIn("cites_experience", self.check(exp="exp:10")[1])

    def test_missing_persistence_components_fail(self):
        for key in ("ok", "budget_settled", "intent_persisted"):
            row = {"id": "ingest:seg:7:wonder_result", "ok": 1,
                   "budget_settled": 1, "intent_persisted": 1, key: 0}
            self.assertTrue(self.check(row=row)[1], key)

    def test_old_unrelated_reflection_cannot_pass(self):
        with patch.object(runner, "_d1_rows", return_value=[]):
            self.assertEqual(runner._reflection_evidence("seg:7", "exp:1")[1],
                             ["matching reflection not persisted"])


class ExecutionTests(unittest.TestCase):
    def test_settled_execution_survives_public_window_expiry(self):
        row = {"segment_id": 7, "experience_id": "exp:1", "event_id": "interaction_done:8:0"}
        with patch.object(runner, "_d1_rows", return_value=[row]) as query, \
             patch.object(runner, "_fetch_cam", return_value={"segments": []}) as cam:
            evidence = runner._act_evidence("http://127.0.0.1:1", "local", "gift", 7)
        self.assertEqual(evidence["experience_id"], "exp:1")
        self.assertIn("json_each(x.segment_ids)", query.call_args.args[0])
        self.assertIn("s.cut_at IS NULL", query.call_args.args[0])
        cam.assert_not_called()


class M2Tests(unittest.TestCase):
    def report(self):
        return {"m2": {"verdict": "pass"}, "stage_verdicts": [
            {"stage": i, "verdict": "pass"} for i in range(1, 7)]}

    def test_presence_is_not_acceptance(self):
        self.assertFalse(runner._m2_accepted({"m2": {"verdict": "fail"}}))
        self.assertFalse(runner._m2_accepted(None))
        self.assertTrue(runner._m2_accepted(self.report()))

    def test_world_change_failure_and_degraded_or_missing_stage_fail(self):
        for verdict in ("fail", "degraded_pass", "manager_check"):
            report = self.report()
            report["stage_verdicts"][4]["verdict"] = verdict
            self.assertFalse(runner._m2_accepted(report))
        report = self.report()
        report["stage_verdicts"].pop()
        self.assertFalse(runner._m2_accepted(report))


class IsolationTests(unittest.TestCase):
    def test_queries_use_same_explicit_config_and_persist_directory(self):
        proc = unittest.mock.Mock(returncode=0, stdout='[{"results": []}]')
        with patch.dict(os.environ, {"NORI_CAM_LOCAL_CONFIG": "C:/Temp/r30/config.json",
                                     "NORI_CAM_LOCAL_PERSIST": "C:/Temp/r30/state"}), \
             patch.object(runner.subprocess, "run", return_value=proc) as run:
            runner._d1_rows("SELECT 1")
            runner._run_site(["npm", "run", "db:local"])
        for call in run.call_args_list:
            self.assertIn("--local", call.args[0])
            self.assertIn("C:/Temp/r30/config.json", call.args[0])
            self.assertIn("C:/Temp/r30/state", call.args[0])


class LiveCandidateTests(unittest.TestCase):
    def test_default_plan_never_constructs_provider_client(self):
        with patch.object(live_candidate.clients, "meta_client") as client, patch("builtins.print"):
            self.assertEqual(live_candidate.main([]), 0)
        client.assert_not_called()

    def test_failed_call_consumes_cap_and_has_token_timeout_limits(self):
        inner = unittest.mock.Mock()
        inner.create.side_effect = RuntimeError("uncertain transport")
        with patch.object(live_candidate.time, "monotonic", return_value=100):
            guard = live_candidate.BoundedResponses(inner, 150)
            with self.assertRaises(RuntimeError):
                guard.create(model="muse-wonder-1.0", store=False)
            self.assertEqual(inner.create.call_args.kwargs["max_output_tokens"], 2048)
            self.assertEqual(inner.create.call_args.kwargs["timeout"], 50)
            with self.assertRaisesRegex(RuntimeError, "call-count cap"):
                guard.create(model="muse-wonder-1.0")
            self.assertEqual(inner.create.call_count, 1)

    def test_expired_candidate_calls_no_provider(self):
        inner = unittest.mock.Mock()
        with patch.object(live_candidate.time, "monotonic", return_value=101):
            guard = live_candidate.BoundedResponses(inner, 100)
            with self.assertRaisesRegex(RuntimeError, "overall deadline"):
                guard.create(model="muse-spark-1.3")
        inner.create.assert_not_called()


if __name__ == "__main__":
    unittest.main()
