import json
import unittest
from unittest.mock import patch

from app.cam import local_e2e


class FreshChainTimingTests(unittest.TestCase):
    def test_fresh_seed_resets_world_cursor_and_state_together(self):
        calls = []
        with patch.object(local_e2e, "_run_site", side_effect=calls.append):
            local_e2e._seed_local_db(fixed_start=True)
        sql = calls[-1][-1]
        self.assertIn(f"timeline_until={local_e2e.CHAIN_START_MS}", sql)
        state = json.loads(sql.split("state_json='", 1)[1].split("'", 1)[0])
        self.assertEqual(state["settled_through"], local_e2e.CHAIN_START_MS)
        self.assertEqual(state["habits"], {})
        self.assertFalse(state["nori"]["asleep"])

    def test_fake_failure_seed_keeps_existing_clock_behavior(self):
        calls = []
        with patch.object(local_e2e, "_run_site", side_effect=calls.append):
            local_e2e._seed_local_db()
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
