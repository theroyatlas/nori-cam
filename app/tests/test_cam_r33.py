import unittest
import json
from unittest.mock import patch
from app.cam import ui_local_e2e as ui

class RepeatableControlTests(unittest.TestCase):


    def test_first_effect_is_bound_to_experience_even_after_return(self):
        expected={"initial_cell":[0,6],"final_cell":[0,5]}
        self.assertTrue(ui.first_effect_matches({"x":0,"y":6},{"x":0,"y":5},expected))
        self.assertFalse(ui.first_effect_matches({"x":0,"y":6},None,expected))
        self.assertFalse(ui.first_effect_matches({"x":0,"y":6},{"x":0,"y":6},expected))

    def test_r33_plan_reports_current_failure_without_execution(self):
        with patch.object(ui.subprocess,"Popen") as process,patch("builtins.print") as output:
            self.assertEqual(ui.main(["--episode","r33","--plan"]),0)
            plan=json.loads(output.call_args.args[0])
        process.assert_not_called()
        self.assertEqual(plan["status"],"blocked_stage6_total_probability_shift")
        self.assertIsNone(plan["execute_command"])

if __name__=="__main__":unittest.main()
