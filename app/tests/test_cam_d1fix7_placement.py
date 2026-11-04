"""D1fix7: stage_placement early stop with a fake Worker response. No network."""
import unittest

from app.cam import local_e2e


def _cam(*objects):
    return {"server_now": 1793707200000, "objects": list(objects)}


def _obj(object_id, status, x=3, y=4, placement="floor"):
    return {"id": object_id, "status": status, "x": x, "y": y, "placement": placement}


class StagePlacementTests(unittest.TestCase):
    def test_placed_gift_passes(self):
        cam = _cam(_obj("o_gift", "placed", 3, 4, "floor"))
        placement, ok, reasons = local_e2e._placement_check("o_gift", cam)
        self.assertTrue(ok)
        self.assertEqual(reasons, [])
        self.assertEqual(placement,
                         {"status": "placed", "x": 3, "y": 4, "placement": "floor"})

    def test_stored_gift_fails_with_status_reason(self):
        cam = _cam(_obj("o_gift", "stored", 0, 0, "floor"))
        placement, ok, reasons = local_e2e._placement_check("o_gift", cam)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["gift not placed: stored"])
        self.assertEqual(placement["status"], "stored")

    def test_missing_object_fails(self):
        cam = _cam(_obj("o_other", "placed"))
        placement, ok, reasons = local_e2e._placement_check("o_gift", cam)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["gift not placed: missing"])
        self.assertEqual(placement,
                         {"status": "missing", "x": None, "y": None, "placement": None})

    def test_unreachable_worker_fails(self):
        placement, ok, reasons = local_e2e._placement_check("o_gift", None)
        self.assertFalse(ok)
        self.assertEqual(reasons, ["gift not placed: missing"])


if __name__ == "__main__":
    unittest.main()
