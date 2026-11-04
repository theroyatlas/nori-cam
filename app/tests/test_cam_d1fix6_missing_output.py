"""Manager follow-up to D1fix6: a response without an image names only the API item types in the error."""
import types
import unittest

from app.cam.clients import ImageFormatError, MetaImage


class _Responses:
    def __init__(self, output):
        self._output = output

    def create(self, **_):
        return types.SimpleNamespace(id="resp_test", output=self._output)


def _client(output):
    return MetaImage(client=types.SimpleNamespace(responses=_Responses(output)))


class MissingImageOutputTest(unittest.TestCase):
    def test_lists_item_types_only(self):
        output = [types.SimpleNamespace(type="reasoning", summary="secret words"),
                  types.SimpleNamespace(type="message", content="model text must not leak")]
        with self.assertRaises(ImageFormatError) as ctx:
            _client(output).redraw("data:image/png;base64,AA==", "mug", "S", "data:image/jpeg;base64,AA==")
        msg = str(ctx.exception)
        self.assertEqual(msg, "missing image output; output types: message,reasoning")
        self.assertNotIn("secret", msg)
        self.assertNotIn("leak", msg)

    def test_empty_output_and_odd_type_names(self):
        output = [types.SimpleNamespace(type="weird type!"), types.SimpleNamespace(type="")]
        with self.assertRaises(ImageFormatError) as ctx:
            _client(output).redraw("data:image/png;base64,AA==", "mug", "S", "data:image/jpeg;base64,AA==")
        self.assertEqual(str(ctx.exception), "missing image output; output types: none")
        with self.assertRaises(ImageFormatError):
            _client([]).redraw("data:image/png;base64,AA==", "mug", "S", "data:image/jpeg;base64,AA==")

    def test_still_a_value_error(self):
        self.assertTrue(issubclass(ImageFormatError, ValueError))


if __name__ == "__main__":
    unittest.main()
