"""Regression checks for complete NRBF streams and explicit truncation errors."""

import struct
import unittest

from nrbf import Parser


def header(root=1):
    return b"\x00" + struct.pack("<iiii", root, -1, 1, 0)


def string(object_id, text):
    encoded = text.encode()
    return b"\x06" + struct.pack("<i", object_id) + bytes([len(encoded)]) + encoded


VALID = header() + string(1, "hello") + b"\x0b"


class ParserTests(unittest.TestCase):
    def test_complete_stream(self):
        self.assertEqual(Parser(VALID).parse(), "hello")

    def test_multibyte_char_keeps_stream_aligned(self):
        chars = "\u00e9A".encode()  # 2-byte UTF-8 char, then ASCII
        data = header() + b"\x0f" + struct.pack("<ii", 1, 2) + b"\x03" + chars + b"\x0b"
        self.assertEqual(Parser(data).parse(), ["\u00e9", "A"])

    def test_root_id(self):
        data = header(2) + string(1, "first") + string(2, "root") + b"\x0b"
        self.assertEqual(Parser(data).parse(), "root")

    def test_every_premature_eof(self):
        for length in range(len(VALID)):
            with self.subTest(length=length):
                with self.assertRaises(ValueError):
                    Parser(VALID[:length]).parse()

    def test_required_header(self):
        with self.assertRaisesRegex(ValueError, "header"):
            Parser(VALID[17:]).parse()

    def test_supported_version(self):
        data = bytearray(VALID)
        struct.pack_into("<i", data, 9, 2)
        with self.assertRaisesRegex(ValueError, "version"):
            Parser(data).parse()

    def test_missing_root(self):
        with self.assertRaisesRegex(ValueError, "root"):
            Parser(header(2) + string(1, "first") + b"\x0b").parse()

    def test_stale_cache_tail(self):
        self.assertEqual(Parser(VALID + b"\x00\x00\x00\x0b").parse(), "hello")

    def test_premature_member_end(self):
        obj = bytes([4, 1, 0, 0, 0, 1, 84, 1, 0, 0, 0, 1, 120, 2, 11])
        with self.assertRaisesRegex(ValueError, "inside a value"):
            Parser(header() + obj).parse()

    def test_truncated_byte_array(self):
        array = bytes([15, 1, 0, 0, 0, 10, 0, 0, 0, 2, 1, 2, 11])
        with self.assertRaisesRegex(ValueError, "truncated"):
            Parser(header() + array).parse()

    def test_oversized_length_prefix(self):
        prefix = bytes([6, 1, 0, 0, 0, 128, 128, 128, 128, 128, 0])
        with self.assertRaisesRegex(ValueError, "length prefix"):
            Parser(header() + prefix).parse()

    def test_missing_reference(self):
        array = bytes([16, 1, 0, 0, 0, 1, 0, 0, 0, 9, 2, 0, 0, 0, 11])
        with self.assertRaisesRegex(ValueError, "reference 2"):
            Parser(header() + array).parse()


if __name__ == "__main__":
    unittest.main()
