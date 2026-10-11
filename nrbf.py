"""Decode DisplayLink files (.NET BinaryFormatter / MS-NRBF) and print them as JSON.

Usage:
    python3 nrbf.py "Welcome.tpl"

Works on .tpl templates, .seq sequences and lib.cache folder indexes. Byte
arrays (embedded images) are shown as "<N bytes>" and .NET colours as hex.
"""

import json
import struct
import sys

# PrimitiveTypeEnumeration -> struct format (special cases handled in _primitive)
PRIMITIVE_FORMATS = {
    1: "?",  # Boolean
    2: "B",  # Byte
    6: "d",  # Double
    7: "h",  # Int16
    8: "i",  # Int32
    9: "q",  # Int64
    10: "b",  # SByte
    11: "f",  # Single
    12: "q",  # TimeSpan
    14: "H",  # UInt16
    15: "I",  # UInt32
    16: "Q",  # UInt64
}
PRIMITIVE_STRING_TYPES = (5, 18)  # Decimal and String are length-prefixed strings
PRIMITIVE_CHAR = 3
PRIMITIVE_DATETIME = 13
PRIMITIVE_BYTE = 2

# BinaryTypeEnumeration values that carry extra type info
BINARY_PRIMITIVE = (0, 7)
BINARY_SYSTEM_CLASS = 3
BINARY_CLASS = 4

# BinaryArrayTypeEnumeration values that carry lower bounds
ARRAY_TYPES_WITH_OFFSET = (3, 4, 5)

DATETIME_TICKS_MASK = 0x3FFFFFFFFFFFFFFF


class Reader:
    """Little-endian cursor over a byte buffer."""

    def __init__(self, data):
        self.data = data
        self.pos = 0

    def at_end(self):
        """True once every byte has been consumed."""
        return self.pos >= len(self.data)

    def byte(self):
        """Read one unsigned byte."""
        if self.at_end():
            raise ValueError(f"unexpected end of NRBF stream at {self.pos}")
        value = self.data[self.pos]
        self.pos += 1
        return value

    def unpack(self, fmt):
        """Read one value with a struct format code."""
        return struct.unpack("<" + fmt, self.raw(struct.calcsize(fmt)))[0]

    def int32(self):
        """Read a signed 32-bit integer."""
        return self.unpack("i")

    def raw(self, count):
        """Read `count` raw bytes."""
        if count < 0 or count > len(self.data) - self.pos:
            raise ValueError(f"invalid or truncated NRBF byte range at {self.pos}")
        value = self.data[self.pos : self.pos + count]
        self.pos += count
        return value

    def char(self):
        """Read one UTF-8 encoded character (1 to 4 bytes)."""
        lead = self.data[self.pos] if not self.at_end() else 0
        length = 1 if lead < 0x80 else 2 if lead < 0xE0 else 3 if lead < 0xF0 else 4
        return self.raw(length).decode("utf-8")

    def string(self):
        """Read a 7-bit length-prefixed UTF-8 string."""
        length = shift = 0
        while shift < 35:
            chunk = self.byte()
            length |= (chunk & 0x7F) << shift
            shift += 7
            if not chunk & 0x80:
                if length > 0x7FFFFFFF:
                    raise ValueError("invalid NRBF string length")
                return self.raw(length).decode("utf-8")
        raise ValueError("invalid NRBF string length prefix")


class Ref:  # pylint: disable=too-few-public-methods
    """Placeholder for a MemberReference, resolved after parsing."""

    def __init__(self, object_id):
        self.object_id = object_id


class NullRun:  # pylint: disable=too-few-public-methods
    """A run of consecutive nulls inside an array."""

    def __init__(self, count):
        self.count = count


END = object()


class Parser:
    """Parse an MS-NRBF stream into dicts, lists and primitives."""

    def __init__(self, data):
        self.reader = Reader(data)
        self.objects = {}
        self.classes = {}
        self.handlers = {
            1: self._class_with_id,
            4: self._class_with_members_and_types,
            5: self._class_with_members_and_types,
            6: self._object_string,
            7: self._binary_array,
            8: self._member_primitive,
            9: lambda: Ref(self.reader.int32()),
            10: lambda: None,
            11: lambda: END,
            13: lambda: NullRun(self.reader.byte()),
            14: lambda: NullRun(self.reader.int32()),
            15: self._array_of_primitives,
            16: self._array_of_objects,
            17: self._array_of_objects,
        }

    # ---- primitives and type info ----

    def _primitive(self, type_code):
        reader = self.reader
        if type_code in PRIMITIVE_STRING_TYPES:
            return reader.string()
        if type_code == PRIMITIVE_CHAR:
            return reader.char()
        if type_code == PRIMITIVE_DATETIME:
            return {"DateTime_ticks": reader.unpack("Q") & DATETIME_TICKS_MASK}
        return reader.unpack(PRIMITIVE_FORMATS[type_code])

    def _type_extra(self, binary_type):
        if binary_type in BINARY_PRIMITIVE:
            return self.reader.byte()
        if binary_type == BINARY_SYSTEM_CLASS:
            return self.reader.string()
        if binary_type == BINARY_CLASS:
            return (self.reader.string(), self.reader.int32())
        return None

    def _read_members(self, class_info):
        name, members, types = class_info
        obj = {"$type": name}
        for member, (binary_type, extra) in zip(members, types):
            if binary_type == 0:
                obj[member] = self._primitive(extra)
            else:
                obj[member] = self.record()
        return obj

    def _fill(self, count):
        items = []
        while len(items) < count:
            value = self.record()
            if isinstance(value, NullRun):
                items.extend([None] * value.count)
            else:
                items.append(value)
        return items

    # ---- record handlers ----

    def _library(self, allow_end=False):
        self.reader.int32()
        self.reader.string()
        return self.record(allow_end)

    def _class_with_members_and_types(self, with_library):
        reader = self.reader
        object_id = reader.int32()
        name = reader.string()
        members = [reader.string() for _ in range(reader.int32())]
        binary_types = [reader.byte() for _ in members]
        types = [(bt, self._type_extra(bt)) for bt in binary_types]
        if with_library:
            reader.int32()
        self.classes[object_id] = (name, members, types)
        obj = self._read_members(self.classes[object_id])
        self.objects[object_id] = obj
        return obj

    def _class_with_id(self):
        object_id = self.reader.int32()
        obj = self._read_members(self.classes[self.reader.int32()])
        self.objects[object_id] = obj
        return obj

    def _object_string(self):
        object_id = self.reader.int32()
        value = self.reader.string()
        self.objects[object_id] = value
        return value

    def _member_primitive(self):
        return self._primitive(self.reader.byte())

    def _array_of_primitives(self):
        reader = self.reader
        object_id, count, type_code = reader.int32(), reader.int32(), reader.byte()
        if type_code == PRIMITIVE_BYTE:
            value = {"$bytes": count, "_data": reader.raw(count)}
        else:
            value = [self._primitive(type_code) for _ in range(count)]
        self.objects[object_id] = value
        return value

    def _array_of_objects(self):
        object_id, count = self.reader.int32(), self.reader.int32()
        value = self._fill(count)
        self.objects[object_id] = value
        return value

    def _binary_array(self):
        reader = self.reader
        object_id, array_type, rank = reader.int32(), reader.byte(), reader.int32()
        lengths = [reader.int32() for _ in range(rank)]
        if array_type in ARRAY_TYPES_WITH_OFFSET:
            for _ in range(rank):
                reader.int32()
        binary_type = reader.byte()
        extra = self._type_extra(binary_type)
        total = 1
        for length in lengths:
            total *= length
        if binary_type == 0:
            value = [self._primitive(extra) for _ in range(total)]
        else:
            value = self._fill(total)
        self.objects[object_id] = value
        return value

    # ---- driver ----

    def record(self, allow_end=False):
        """Read the next record and return its value."""
        record_type = self.reader.byte()
        if record_type == 0:
            raise ValueError("unexpected NRBF serialization header")
        if record_type == 11 and not allow_end:
            raise ValueError("unexpected NRBF MessageEnd inside a value")
        if record_type == 12:
            return self._library(allow_end)
        if record_type in (4, 5):
            return self._class_with_members_and_types(record_type == 5)
        handler = self.handlers.get(record_type)
        if handler is None:
            raise ValueError(
                f"record type {record_type} at offset {self.reader.pos - 1}"
            )
        return handler()

    def parse(self):
        """Parse the whole stream and return the root object with refs resolved."""
        if self.reader.byte() != 0:
            raise ValueError("missing NRBF serialization header")
        root_id = self.reader.int32()
        self.reader.int32()  # header ID
        if (self.reader.int32(), self.reader.int32()) != (1, 0):
            raise ValueError("unsupported NRBF version")
        while True:
            if self.reader.at_end():
                raise ValueError("missing NRBF MessageEnd")
            if self.record(allow_end=True) is END:
                break
        # lib.cache can retain stale bytes after its first complete stream.
        if root_id not in self.objects:
            raise ValueError(f"missing NRBF root object {root_id}")
        return self._resolve(self.objects[root_id], frozenset())

    def _resolve(self, value, seen):
        if isinstance(value, Ref):
            if value.object_id in seen:
                return f"<ref {value.object_id}>"
            if value.object_id not in self.objects:
                raise ValueError(f"missing NRBF object reference {value.object_id}")
            target = self.objects[value.object_id]
            return self._resolve(target, seen | {value.object_id})
        if isinstance(value, dict):
            return {key: self._resolve(item, seen) for key, item in value.items()}
        if isinstance(value, list):
            return [self._resolve(item, seen) for item in value]
        return value


def _simplify_color(value):
    if value.get("name"):
        return value["name"]
    if value.get("state") == 0 and value.get("value", 0) == 0:
        return None
    if value.get("knownColor"):
        return f"known:{value['knownColor']}"
    return f"#{value['value'] & 0xFFFFFFFF:08X}"


def simplify(value):
    """Collapse .NET framework plumbing into readable JSON values."""
    if isinstance(value, list):
        return [simplify(item) for item in value]
    if not isinstance(value, dict):
        return value
    type_name = value.get("$type", "")
    if type_name == "System.Drawing.Color":
        return _simplify_color(value)
    if "_data" in value:
        return f"<{value['$bytes']} bytes>"
    if type_name.startswith("System.Collections.Generic.List"):
        return [simplify(item) for item in (value["_items"] or [])[: value["_size"]]]
    if type_name in ("System.Drawing.Point", "System.Drawing.Size"):
        return {key: item for key, item in value.items() if key != "$type"}
    if "value__" in value and len(value) == 2:
        return f"{type_name.split('.')[-1]}={value['value__']}"
    return {
        key.replace("k__BackingField", "").strip("<>"): simplify(item)
        for key, item in value.items()
    }


def main():
    """Print each file given on the command line as JSON."""
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for path in sys.argv[1:]:
        with open(path, "rb") as handle:
            tree = Parser(handle.read()).parse()
        print(json.dumps(simplify(tree), indent=1, default=str))


if __name__ == "__main__":
    main()
