"""UI supervisor boundaries: actual payload evidence and frozen controls."""
import hashlib
import unittest
from unittest.mock import patch
from app.cam import ui_local_e2e
from app.cam.ui_local_e2e import multipart_evidence, frozen_fixture
from app.cam.pipeline import schema_check
import json
from pathlib import Path


class UiControlTests(unittest.TestCase):
    def test_default_future_live_plan_starts_no_process(self):
        with patch.object(ui_local_e2e.subprocess, "Popen") as process, patch("builtins.print"):
            self.assertEqual(ui_local_e2e.main([]), 0)
            self.assertEqual(ui_local_e2e.main(["--plan"]), 0)
        process.assert_not_called()

    def test_binary_multipart_file_and_idempotency_are_distinguished(self):
        photo = b"\x89PNG\r\n\x1a\n\x00\xff"
        body = (b'--r31\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\n'
                b'Content-Type: image/png\r\n\r\n' + photo + b'\r\n--r31\r\n'
                b'Content-Disposition: form-data; name="idem"\r\n\r\nunique\r\n--r31--\r\n')
        evidence = multipart_evidence("multipart/form-data; boundary=r31", body)
        self.assertTrue(evidence["multipart"])
        self.assertEqual(evidence["fields"]["file"]["sha256"], hashlib.sha256(photo).hexdigest())
        self.assertEqual(evidence["fields"]["file"]["mime"], "image/png")
        self.assertEqual(set(evidence["fields"]), {"file", "idem"})







if __name__ == "__main__":
    unittest.main()
