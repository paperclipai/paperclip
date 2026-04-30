# Lint as: python3
# Copyright 2020 Google Inc. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Implementation of FlexBuffers binary format.

For more info check https://google.github.io/flatbuffers/flexbuffers.html and
corresponding C++ implementation at
https://github.com/google/flatbuffers/blob/master/include/flatbuffers/flexbuffers.h
"""

# pylint: disable=invalid-name
# TODO(dkovalev): Add type hints everywhere, so tools like pytypes could work.

import array
import contextlib
import enum
import struct

__all__ = ('Type', 'Builder', 'GetRoot', 'Dumps', 'Loads')


class BitWidth(enum.IntEnum):
  """Supported bit widths of value types.

  These are used in the lower 2 bits of a type field to determine the size of
  the elements (and or size field) of the item pointed to (e.g. vector).
  """

  W8 = 0  # 2^0 = 1 byte
  W16 = 1  # 2^1 = 2 bytes
  W32 = 2  # 2^2 = 4 bytes
  W64 = 3  # 2^3 = 8 bytes

  @staticmethod
  def U(value):
    """Returns the minimum `BitWidth` to encode unsigned integer value."""
    assert value >= 0

    if value < (1 << 8):
      return BitWidth.W8
    elif value < (1 << 16):
      return BitWidth.W16
    elif value < (1 << 32):
      return BitWidth.W32
    elif value < (1 << 64):
      return BitWidth.W64
    else:
      raise ValueError('value is too big to encode: %s' % value)

  @staticmethod
  def I(value):
    """Returns the minimum `BitWidth` to encode signed integer value."""
    # -2^(n-1) <=     value < 2^(n-1)
    # -2^n     <= 2 * value < 2^n
    # 2 * value < 2^n, when value >= 0 or 2 * (-value) <= 2^n, when value < 0
    # 2 * value < 2^n, when value >= 0 or 2 * (-value) - 1 < 2^n, when value < 0
    #
    # if value >= 0:
    #   return BitWidth.U(2 * value)
    # else:
    #   return BitWidth.U(2 * (-value) - 1)  # ~x = -x - 1
    value *= 2
    return BitWidth.U(value if value >= 0 else ~value)

  @staticmethod
  def F(value):
    """Returns the `BitWidth` to encode floating point value."""
    if struct.unpack('<f', struct.pack('<f', value))[0] == value:
      return BitWidth.W32
    return BitWidth.W64

  @staticmethod
  def B(byte_width):
    return {1: BitWidth.W8, 2: BitWidth.W16, 4: BitWidth.W32, 8: BitWidth.W64}[
        byte_width
    ]


I = {1: 'b', 2: 'h', 4: 'i', 8: 'q'}  # Integer formats
U = {1: 'B', 2: 'H', 4: 'I', 8: 'Q'}  # Unsigned integer formats
F = {4: 'f', 8: 'd'}  # Floating point formats


def _Unpack(fmt, buf):
  return struct.unpack('<%s' % fmt[len(buf)], buf)[0]


def _UnpackVector(fmt, buf, length):
  byte_width = len(buf) // length
  return struct.unpack('<%d%s' % (length, fmt[byte_width]), buf)


def _Pack(fmt, value, byte_width):
  return struct.pack('<%s' % fmt[byte_width], value)


def _PackVector(fmt, values, byte_width):
  return struct.pack('<%d%s' % (len(values), fmt[byte_width]), *values)


def _Mutate(fmt, buf, value, byte_width, value_bit_width):
  if (1 << value_bit_width) <= byte_width:
    buf[:byte_width] = _Pack(fmt, value, byte_width)
    return True
  return False


# Computes how many bytes you'd have to pad to be able to write an
# "scalar_size" scalar if the buffer had grown to "buf_size",
# "scalar_size" is a power of two.
def _PaddingBytes(buf_size, scalar_size):
  # ((buf_size + (scalar_size - 1)) // scalar_size) * scalar_size - buf_size
  return -buf_size & (scalar_size - 1)


def _ShiftSlice(s, offset, length):
  start = offset + (0 if s.start is None else s.start)
  stop = offset + (length if s.stop is None else s.stop)
  return slice(start, stop, s.step)


# https://en.cppreference.com/w/cpp/algorithm/lower_bound
def _LowerBound(values, value, pred):
  """Implementation of C++ std::lower_bound() algorithm."""
  first, last = 0, len(values)
  count = last - first
  while count > 0:
    i = first
    step = count // 2
    i += step
    if pred(values[i], value):
      i += 1
      first = i
      count -= step + 1
    else:
      count = step
  return first


# https://en.cppreference.com/w/cpp/algorithm/binary_search
def _BinarySearch(values, value, pred=lambda x, y: x < y):
  """Implementation of C++ std::binary_search() algorithm."""
  index = _LowerBound(values, value, pred)
  if index != len(values) and not pred(value, values[index]):
    return index
  return -1


class Type(enum.IntEnum):
  """Supported types of encoded data.

  These are used as the upper 6 bits of a type field to indicate the actual
  type.
  """

  NULL = 0
  INT = 1
  UINT = 2
  FLOAT = 3
  # Types above stored inline, types below store an offset.
  KEY = 4
  STRING = 5
  INDIRECT_INT = 6
  INDIRECT_UINT = 7
  INDIRECT_FLOAT = 8
  MAP = 9
  VECTOR = 10  # Untyped.

  VECTOR_INT = 11  # Typed any size (stores no type table).
  VECTOR_UINT = 12
  VECTOR_FLOAT = 13
  VECTOR_KEY = 14
  # DEPRECATED, use VECTOR or VECTOR_KEY instead.
  # Read test.cpp/FlexBuffersDeprecatedTest() for details on why.
  VECTOR_STRING_DEPRECATED = 15

  VECTOR_INT2 = 16  # Typed tuple (no type table, no size field).
  VECTOR_UINT2 = 17
  VECTOR_FLOAT2 = 18
  VECTOR_INT3 = 19  # Typed triple (no type table, no size field).
  VECTOR_UINT3 = 20
  VECTOR_FLOAT3 = 21
  VECTOR_INT4 = 22  # Typed quad (no type table, no size field).
  VECTOR_UINT4 = 23
  VECTOR_FLOAT4 = 24

  BLOB = 25
  BOOL = 26
  VECTOR_BOOL = 36  # To do the same type of conversion of type to vector type

  @staticmethod
  def Pack(type_, bit_width):
    return (int(type_) << 2) | bit_width

  @staticmethod
  def Unpack(packed_type):
    return 1 << (packed_type & 0b11), Type(packed_type >> 2)

  @staticmethod
  def IsInline(type_):
    return type_ <= Type.FLOAT or type_ == Type.BOOL

  @staticmethod
  def IsTypedVector(type_):
    return (
        Type.VECTOR_INT <= type_ <= Type.VECTOR_STRING_DEPRECATED
        or type_ == Type.VECTOR_BOOL
    )

  @staticmethod
  def IsTypedVectorElementType(type_):
    return Type.INT <= type_ <= Type.STRING or type_ == Type.BOOL

  @staticmethod
  def ToTypedVectorElementType(type_):
    if not Type.IsTypedVector(type_):
      raise ValueError('must be typed vector type')

    return Type(type_ - Type.VECTOR_INT + Type.INT)

  @staticmethod
  def IsFixedTypedVector(type_):
    return Type.VECTOR_INT2 <= type_ <= Type.VECTOR_FLOAT4

  @staticmethod
  def IsFixedTypedVectorElementType(type_):
    return Type.INT <= type_ <= Type.FLOAT

  @staticmethod
  def ToFixedTypedVectorElementType(type_):
    if not Type.IsFixedTypedVector(type_):
      raise ValueError('must be fixed typed vector type')

    # 3 types each, starting from length 2.
    fixed_type = type_ - Type.VECTOR_INT2
    return Type(fixed_type % 3 + Type.INT), fixed_type // 3 + 2

  @staticmethod
  def ToTypedVector(element_type, fixed_len=0):
    """Converts element type to corresponding vector type.

    Args:
      element_type: vector element type
      fixed_len: number of elements: 0 for typed vector; 2, 3, or 4 for fixed
        typed vector.

    Returns:
      Typed vector type or fixed typed vector type.
    """
    if fixed_len == 0:
      if not Type.IsTypedVectorElementType(element_type):
        raise ValueError('must be typed vector element type')
    else:
      if not Type.IsFixedTypedVectorElementType(element_type):
        raise ValueError('must be fixed typed vector element type')

    offset = element_type - Type.INT
    if fixed_len == 0:
      return Type(offset + Type.VECTOR_INT)  # TypedVector
    elif fixed_len == 2:
      return Type(offset + Type.VECTOR_INT2)  # FixedTypedVector
    elif fixed_len == 3:
      return Type(offset + Type.VECTOR_INT3)  # FixedTypedVector
    elif fixed_len == 4:
      return Type(offset + Type.VECTOR_INT4)  # FixedTypedVector
    else:
      raise ValueError('unsupported fixed_len: %s' % fixed_len)


class Buf:
  """Class to access underlying buffer object starting from the given offset."""

  def __init__(self, buf, offset):
    self._buf = buf
    self._offset = offset if offset >= 0 else len(buf) + offset
    self._length = len(buf) - self._offset

  def __getitem__(self, key):
    if isinstance(key, slice):
      return self._buf[_ShiftSlice(key, self._offset, self._length)]
    elif isinstance(key, int):
      return self._buf[self._offset + key]
    else:
      raise TypeError('invalid key type')

  def __setitem__(self, key, value):
    if isinstance(key, slice):
      self._buf[_ShiftSlice(key, self._offset, self._length)] = value
    elif isinstance(key, int):
      self._buf[self._offset + key] = key
    else:
      raise TypeError('invalid key type')

  def __repr__(self):
    return 'buf[%d:]' % self._offset

  def Find(self, sub):
    """Returns the lowest index where the sub subsequence is found."""
    return self._buf[self._offset :].find(sub)

  def Slice(self, offset):
    """Returns new `Buf` which starts from the given offset."""
    return Buf(self._buf, self._offset + offset)

  def Indirect(self, offset, byte_width):
    """Return new `Buf` based on the encoded offset (indirect encoding)."""
    return self.Slice(offset - _Unpack(U, self[offset : offset + byte_width]))


class Object:
  """Base class for all non-trivial data accessors."""

  __slots__ = '_buf', '_byte_width'

  def __init__(self, buf, byte_width):
    self._buf = buf
    self._byte_width = byte_width

  @property
  def ByteWidth(self):
    return self._byte_width


class Sized(Object):
  """Base class for all data accessors which need to read encoded size."""

  __slots__ = ('_size',)

  def __init__(self, buf, byte_width, size=0):
    super().__init__(buf, byte_width)
    if size == 0:
      self._size = _Unpack(U, self.SizeBytes)
    else:
      self._size = size

  @property
  def SizeBytes(self):
    return self._buf[-self._byte_width : 0]

  def __len__(self):
    return self._size


class Blob(Sized):
  """Data accessor for the encoded blob bytes."""

  __slots__ = ()

  @property
  def Bytes(self):
    return self._buf[0 : len(self)]

  def __repr__(self):
    return 'Blob(%s, size=%d)' % (self._buf, len(self))


class String(Sized):
  """Data accessor for the encoded string bytes."""

  __slots__ = ()

  @property
  def Bytes(self):
    return self._buf[0 : len(self)]

  def Mutate(self, value):
    """Mutates underlying string bytes in place.

    Args:
      value: New string to replace the existing one. New string must have less
        or equal UTF-8-encoded bytes than the existing one to successfully
        mutate underlying byte buffer.

    Returns:
      Whether the value was mutated or not.
    """
    encoded = value.encode('utf-8')
    n = len(encoded)
    if n <= len(self):
      self._buf[-self._byte_width : 0] = _Pack(U, n, self._byte_width)
      self._buf[0:n] = encoded
      self._buf[n : len(self)] = bytearray(len(self) - n)
      return True
    return False

  def __str__(self):
    return self.Bytes.decode('utf-8')

  def __repr__(self):
    return 'String(%s, size=%d)' % (self._buf, len(self))


class Key(Object):
  """Data accessor for the encoded key bytes."""

  __slots__ = ()

  def __init__(self, buf, byte_width):
    assert byte_width == 1
    super().__init__(buf, byte_width)

  @property
  def Bytes(self):
    return self._buf[0 : len(self)]

  def __len__(self):
    return self._buf.Find(0)

  def __str__(self):
    return self.Bytes.decode('ascii')

  def __repr__(self):
    return 'Key(%s, size=%d)' % (self._buf, len(self))


class Vector(Sized):
  """Data accessor for the encoded vector bytes."""

  __slots__ = ()

  def __getitem__(self, index):
    if index < 0 or index >= len(self):
      raise IndexError(
          'vector index %s is out of [0, %d) range' % (index, len(self))
      )

    packed_type = self._buf[len(self) * self._byte_width + index]
    buf = self._buf.Slice(index * self._byte_width)
    return Ref.PackedType(buf, self._byte_width, packed_type)

  @property
  def Value(self):
    """Returns the underlying encoded data as a list object."""
    return [e.Value for e in self]

  def __repr__(self):
    return 'Vector(%s, byte_width=%d, size=%d)' % (
        self._buf,
        self._byte_width,
        self._size,
    )


class TypedVector(Sized):
  """Data accessor for the encoded typed vector or fixed typed vector bytes."""

  __slots__ = '_element_type', '_size'

  def __init__(self, buf, byte_width, element_type, size=0):
    super().__init__(buf, byte_width, size)

    if element_type == Type.STRING:
      # These can't be accessed as strings, since we don't know the bit-width
      # of the size field, see the declaration of
      # FBT_VECTOR_STRING_DEPRECATED above for details.
      # We change the type here to be keys, which are a subtype of strings,
      # and will ignore the size field. This will truncate strings with
      # embedded nulls.
      element_type = Type.KEY

    self._element_type = element_type

  @property
  def Bytes(self):
    return self._buf[: self._byte_width * len(self)]

  @property
  def ElementType(self):
    return self._element_type

  def __getitem__(self, index):
    if index < 0 or index >= len(self):
      raise IndexError(
          'vector index %s is out of [0, %d) range' % (index, len(self))
      )

    buf = self._buf.Slice(index * self._byte_width)
    return Ref(buf, self._byte_width, 1, self._element_type)

  @property
  def Value(self):
    """Returns underlying data as list object."""
    if not self:
      return []

    if self._element_type is Type.BOOL:
      return [bool(e) for e in _UnpackVector(U, self.Bytes, len(self))]
    elif self._element_type is Type.INT:
      return list(_UnpackVector(I, self.Bytes, len(self)))
    elif self._element_type is Type.UINT:
      return list(_UnpackVector(U, self.Bytes, len(self)))
    elif self._element_type is Type.FLOAT:
      return list(_UnpackVector(F, self.Bytes, len(self)))
    elif self._element_type is Type.KEY:
      return [e.AsKey for e in self]
    elif self._element_type is Type.STRING:
      return [e.AsString for e in self]
    else:
      raise TypeError('unsupported element_type: %s' % self._element_type)

  def __repr__(self):
    return 'TypedVector(%s, byte_width=%d, element_type=%s, size=%d)' % (
        self._buf,
        self._byte_width,
        self._element_type,
        self._size,
    )


class Map(Vector):
  """Data accessor for the encoded map bytes."""

  @staticmethod
  def CompareKeys(a, b):
    if isinstance(a, Ref):
      a = a.AsKeyBytes
    if isinstance(b, Ref):
      b = b.AsKeyBytes
    return a < b

  def __getitem__(self, key):
    if isinstance(key, int):
      return super().__getitem__(key)

    index = _BinarySearch(self.Keys, key.encode('ascii'), self.CompareKeys)
    if index != -1:
      return super().__getitem__(index)

    raise KeyError(key)

  @property
  def Keys(self):
    byte_width = _Unpack(
        U, self._buf[-2 * self._byte_width : -self._byte_width]
    )
    buf = self._buf.Indirect(-3 * self._byte_width, self._byte_width)
    return TypedVector(buf, byte_width, Type.KEY)

  @property
  def Values(self):
    return Vector(self._buf, self._byte_width)

  @property
  def Value(self):
    return {k.Value: v.Value for k, v in zip(self.Keys, self.Values)}

  def __repr__(self):
    return 'Map(%s, size=%d)' % (self._buf, len(self))


class Ref:
  """Data accessor for the encoded data bytes."""

  __slots__ = '_buf', '_parent_width', '_byte_width', '_type'

  @staticmethod
  def PackedType(buf, parent_width, packed_type):
    byte_width, type_ = Type.Unpack(packed_type)
    return Ref(buf, parent_width, byte_width, type_)

  def __init__(self, buf, parent_width, byte_width, type_):
    self._buf = buf
    self._parent_width = parent_width
    self._byte_width = byte_width
    self._type = type_

  def __repr__(self):
    return 'Ref(%s, parent_width=%d, byte_width=%d, type_=%s)' % (
        self._buf,
        self._parent_width,
        self._byte_width,
        self._type,
    )

  @property
  def _Bytes(self):
    return self._buf[: self._parent_width]

  def _ConvertError(self, target_type):
    raise TypeError('cannot convert %s to %s' % (self._type, target_type))

  def _Indirect(self):
    return self._buf.Indirect(0, self._parent_width)

  @property
  def IsNull(self):
    return self._type is Type.NULL

  @property
  def IsBool(self):
    return self._type is Type.BOOL

  @property
  def AsBool(self):
    if self._type is Type.BOOL:
      return bool(_Unpack(U, self._Bytes))
    else:
      return self.AsInt != 0

  def MutateBool(self, value):
    """Mutates underlying boolean value bytes in place.

    Args:
      value: New boolean value.

    Returns:
      Whether the value was mutated or not.
    """
    return self.IsBool and _Mutate(
        U, self._buf, value, self._parent_width, BitWidth.W8
    )

  @property
  def IsNumeric(self):
    return self.IsInt or self.IsFloat

  @property
  def IsInt(self):
    return self._type in (
        Type.INT,
        Type.INDIRECT_INT,
        Type.UINT,
        Type.INDIRECT_UINT,
    )

  @property
  def AsInt(self):
    """Returns current reference as integer value."""
    if self.IsNull:
      return 0
    elif self.IsBool:
      return int(self.AsBool)
    elif self._type is Type.INT:
      return _Unpack(I, self._Bytes)
    elif self._type is Type.INDIRECT_INT:
      return _Unpack(I, self._Indirect()[: self._byte_width])
    if self._type is Type.UINT:
      return _Unpack(U, self._Bytes)
    elif self._type is Type.INDIRECT_UINT:
      return _Unpack(U, self._Indirect()[: self._byte_width])
    elif self.IsString:
      return len(self.AsString)
    elif self.IsKey:
      return len(self.AsKey)
    elif self.IsBlob:
      return len(self.AsBlob)
    elif self.IsVector:
      return len(self.AsVector)
    elif self.IsTypedVector:
      return len(self.AsTypedVector)
    elif self.IsFixedTypedVector:
      return len(self.AsFixedTypedVector)
    else:
      raise self._ConvertError(Type.INT)

  def MutateInt(self, value):
    """Mutates underlying integer value bytes in place.

    Args:
      value: New integer value. It must fit to the byte size of the existing
        encoded value.

    Returns:
      Whether the value was mutated or not.
    """
    if self._type is Type.INT:
      return _Mutate(I, self._buf, value, self._parent_width, BitWidth.I(value))
    elif self._type is Type.INDIRECT_INT:
      return _Mutate(
          I, self._Indirect(), value, self._byte_width, BitWidth.I(value)
      )
    elif self._type is Type.UINT:
      return _Mutate(U, self._buf, value, self._parent_width, BitWidth.U(value))
    elif self._type is Type.INDIRECT_UINT:
      return _Mutate(
          U, self._Indirect(), value, self._byte_width, BitWidth.U(value)
      )
    else:
      return False

  @property
  def IsFloat(self):
    return self._type in (Type.FLOAT, Type.INDIRECT_FLOAT)

  @property
  def AsFloat(self):
    """Returns current reference as floating point value."""
    if self.IsNull:
      return 0.0
    elif self.IsBool:
      return float(self.AsBool)
    elif self.IsInt:
      return float(self.AsInt)
    elif self._type is Type.FLOAT:
      return _Unpack(F, self._Bytes)
    elif self._type is Type.INDIRECT_FLOAT:
      return _Unpack(F, self._Indirect()[: self._byte_width])
    elif self.IsString:
      return float(self.AsString)
    elif self.IsVector:
      return float(len(self.AsVector))
    elif self.IsTypedVector():
      return float(len(self.AsTypedVector))
    elif self.IsFixedTypedVector():
      return float(len(self.FixedTypedVector))
    else:
      raise self._ConvertError(Type.FLOAT)

  def MutateFloat(self, value):
    """Mutates underlying floating point value bytes in place.

    Args:
      value: New float value. It must fit to the byte size of the existing
        encoded value.

    Returns:
      Whether the value was mutated or not.
    """
    if self._type is Type.FLOAT:
      return _Mutate(
          F,
          self._buf,
          value,
          self._parent_width,
          BitWidth.B(self._parent_width),
      )
    elif self._type is Type.INDIRECT_FLOAT:
      return _Mutate(
          F,
          self._Indirect(),
          value,
          self._byte_width,
          BitWidth.B(self._byte_width),
      )
    else:
      return False

  @property
  def IsKey(self):
    return self._type is Type.KEY

  @property
  def AsKeyBytes(self):
    if self.IsKey:
      return Key(self._Indirect(), self._byte_width).Bytes
    else:
      raise self._ConvertError(Type.KEY)

  @property
  def AsKey(self):
    if self.IsKey:
      return str(Key(self._Indirect(), self._byte_width))
    else:
      raise self._ConvertError(Type.KEY)

  @property
  def IsString(self):
    return self._type is Type.STRING

  @property
  def AsStringBytes(self):
    if self.IsString:
      return String(self._Indirect(), self._byte_width).Bytes
    elif self.IsKey:
      return self.AsKeyBytes
    else:
      raise self._ConvertError(Type.STRING)

  @property
  def AsString(self):
    if self.IsString:
      return str(String(self._Indirect(), self._byte_width))
    elif self.IsKey:
      return self.AsKey
    else:
      raise self._ConvertError(Type.STRING)

  def MutateString(self, value):
    return String(self._Indirect(), self._byte_width).Mutate(value)

  @property
  def IsBlob(self):
    return self._type is Type.BLOB

  @property
  def AsBlob(self):
    if self.IsBlob:
      return Blob(self._Indirect(), self._byte_width).Bytes
    else:
      raise self._ConvertError(Type.BLOB)

  @property
  def IsAnyVector(self):
    return self.IsVector or self.IsTypedVector or self.IsFixedTypedVector()

  @property
  def IsVector(self):
    return self._type in (Type.VECTOR, Type.MAP)

  @property
  def AsVector(self):
    if self.IsVector:
      return Vector(self._Indirect(), self._byte_width)
    else:
      raise self._ConvertError(Type.VECTOR)

  @property
  def IsTypedVector(self):
    return Type.IsTypedVector(self._type)

  @property
  def AsTypedVector(self):
    if self.IsTypedVector:
      return TypedVector(
          self._Indirect(),
          self._byte_width,
          Type.ToTypedVectorElementType(self._type),
      )
    else:
      raise self._ConvertError('TYPED_VECTOR')

  @property
  def IsFixedTypedVector(self):
    return Type.IsFixedTypedVector(self._type)

  @property
  def AsFixedTypedVector(self):
    if self.IsFixedTypedVector:
      element_type, size = Type.ToFixedTypedVectorElementType(self._type)
      return TypedVector(self._Indirect(), self._byte_width, element_type, size)
    else:
      raise self._ConvertError('FIXED_TYPED_VECTOR')

  @property
  def IsMap(self):
    return self._type is Type.MAP

  @property
  def AsMap(self):
    if self.IsMap:
      return Map(self._Indirect(), self._byte_width)
    else:
      raise self._ConvertError(Type.MAP)

  @property
  def Value(self):
    """Converts current reference to value of corresponding type.

    This is equivalent to calling `AsInt` for integer values, `AsFloat` for
    floating point values, etc.

    Returns:
      Value of corresponding type.
    """
    if self.IsNull:
      return None
    elif self.IsBool:
      return self.AsBool
    elif self.IsInt:
      return self.AsInt
    elif self.IsFloat:
      return self.AsFloat
    elif self.IsString:
      return self.AsString
    elif self.IsKey:
      return self.AsKey
    elif self.IsBlob:
      return self.AsBlob
    elif self.IsMap:
      return self.AsMap.Value
    elif self.IsVector:
      return self.AsVector.Value
    elif self.IsTypedVector:
      return self.AsTypedVector.Value
    elif self.IsFixedTypedVector:
      return self.AsFixedTypedVector.Value
    else:
      raise TypeError('cannot convert %r to value' % self)


def _IsIterable(obj):
  try:
    iter(obj)
    return True
  except TypeError:
    return False


class Value:
  """Class to represent given value during the encoding process."""

  @staticmethod
  def Null():
    return Value(0, Type.NULL, BitWidth.W8)

  @staticmethod
  def Bool(value):
    return Value(value, Type.BOOL, BitWidth.W8)

  @staticmethod
  def Int(value, bit_width):
    return Value(value, Type.INT, bit_width)

  @staticmethod
  def UInt(value, bit_width):
    return Value(value, Type.UINT, bit_width)

  @staticmethod
  def Float(value, bit_width):
    return Value(value, Type.FLOAT, bit_width)

  @staticmethod
  def Key(offset):
    return Value(offset, Type.KEY, BitWidth.W8)

  def __init__(self, value, type_, min_bit_width):
    self._value = value
    self._type = type_

    # For scalars: of itself, for vector: of its elements, for string: length.
    self._min_bit_width = min_bit_width

  @property
  def Value(self):
    return self._value

  @property
  def Type(self):
    return self._type

  @property
  def MinBitWidth(self):
    return self._min_bit_width

  def StoredPackedType(self, parent_bit_width=BitWidth.W8):
    return Type.Pack(self._type, self.StoredWidth(parent_bit_width))

  # We have an absolute offset, but want to store a relative offset
  # elem_index elements beyond the current buffer end. Since whether
  # the relative offset fits in a certain byte_width depends on
  # the size of the elements before it (and their alignment), we have
  # to test for each size in turn.
  def ElemWidth(self, buf_size, elem_index=0):
    if Type.IsInline(self._type):
      return self._min_bit_width
    for byte_width in 1, 2, 4, 8:
      offset_loc = (
          buf_size
          + _PaddingBytes(buf_size, byte_width)
          + elem_index * byte_width
      )
      bit_width = BitWidth.U(offset_loc - self._value)
      if byte_width == (1 << bit_width):
        return bit_width
    raise ValueError('relative offset is too big')

  def StoredWidth(self, parent_bit_width=BitWidth.W8):
    if Type.IsInline(self._type):
      return max(self._min_bit_width, parent_bit_width)
    return self._min_bit_width

  def __repr__(self):
    return 'Value(%s, %s, %s)' % (self._value, self._type, self._min_bit_width)

  def __str__(self):
    return str(self._value)


def InMap(func):
  def wrapper(self, *args, **kwargs):
    if isinstance(args[0], str):
      self.Key(args[0])
      func(self, *args[1:], **kwargs)
    else:
      func(self, *args, **kwargs)

  return wrapper


def InMapForString(func):
  def wrapper(self, *args):
    if len(args) == 1:
      func(self, args[0])
    elif len(args) == 2:
      self.Key(args[0])
      func(self, args[1])
    else:
      raise ValueError('invalid number of arguments')

  return wrapper


class Pool:
  """Collection of (data, offset) pairs sorted by data for quick access."""

  def __init__(self):
    self._pool = []  # sorted list of (data, offset) tuples

  def FindOrInsert(self, data, offset):
    do = data, offset
    index = _BinarySearch(self._pool, do, lambda a, b: a[0] < b[0])
    if index != -1:
      _, offset = self._pool[index]
      return offset
    self._pool.insert(index, do)
    return None

  def Clear(self):
    self._pool = []

  @property
  def Elements(self):
    return [data for data, _ in self._pool]


class Builder:
  """Helper class to encode structural data into flexbuffers format."""

  def __init__(
      self,
      share_strings=False,
      share_keys=True,
      force_min_bit_width=BitWidth.W8,
  ):
    self._share_strings = share_strings
    self._share_keys = share_keys
    self._force_min_bit_width = force_min_bit_width

    self._string_pool = Pool()
    self._key_pool = Pool()

    self._finished = False
    self._buf = bytearray()
    self._stack = []

  def __len__(self):
    return len(self._buf)

  @property
  def StringPool(self):
    return self._string_pool

  @property
  def KeyPool(self):
    return self._key_pool

  def Clear(self):
    self._string_pool.Clear()
    self._key_pool.Clear()
    self._finished = False
    self._buf = bytearray()
    self._stack = []

  def Finish(self):
    """Finishes encoding process and returns underlying buffer."""
    if self._finished:
      raise RuntimeError('builder has been already finished')

    # If you hit this exception, you likely have objects that were never
    # included in a parent. You need to have exactly one root to finish a
    # buffer. Check your Start/End calls are matched, and all objects are inside
    # some other object.
    if len(self._stack) != 1:
      raise RuntimeError('internal stack size must be one')

    value = self._stack[0]
    byte_width = self._Align(value.ElemWidth(len(self._buf)))
    self._WriteAny(value, byte_width=byte_width)  # Root value
    self._Write(U, value.StoredPackedType(), byte_width=1)  # Root type
    self._Write(U, byte_width, byte_width=1)  # Root size

    self.finished = True
    return self._buf

  def _ReadKey(self, offset):
    key = self._buf[offset:]
    return key[: key.find(0)]

  def _Align(self, alignment):
    byte_width = 1 << alignment
    self._buf.extend(b'\x00' * _PaddingBytes(len(self._buf), byte_width))
    return byte_width

  def _Write(self, fmt, value, byte_width):
    self._buf.extend(_Pack(fmt, value, byte_width))

  def _WriteVector(self, fmt, values, byte_width):
    self._buf.extend(_PackVector(fmt, values, byte_width))

  def _WriteOffset(self, offset, byte_width):
    relative_offset = len(self._buf) - offset
    assert byte_width == 8 or relative_offset < (1 << (8 * byte_width))
    self._Write(U, relative_offset, byte_width)

  def _WriteAny(self, value, byte_width):
    fmt = {
        Type.NULL: U,
        Type.BOOL: U,
        Type.INT: I,
        Type.UINT: U,
        Type.FLOAT: F,
    }.get(value.Type)
    if fmt:
      self._Write(fmt, value.Value, byte_width)
    else:
      self._WriteOffset(value.Value, byte_width)

  def _WriteBlob(self, data, append_zero, type_):
    bit_width = BitWidth.U(len(data))
    byte_width = self._Align(bit_width)
    self._Write(U, len(data), byte_width)
    loc = len(self._buf)
    self._buf.extend(data)
    if append_zero:
      self._buf.append(0)
    self._stack.append(Value(loc, type_, bit_width))
    return loc

  def _WriteScalarVector(self, element_type, byte_width, elements, fixed):
    """Writes scalar vector elements to the underlying buffer."""
    bit_width = BitWidth.B(byte_width)
    # If you get this exception, you're trying to write a vector with a size
    # field that is bigger than the scalars you're trying to write (e.g. a
    # byte vector > 255 elements). For such types, write a "blob" instead.
    if BitWidth.U(len(elements)) > bit_width:
      raise ValueError('too many elements for the given byte_width')

    self._Align(bit_width)
    if not fixed:
      self._Write(U, len(elements), byte_width)

    loc = len(self._buf)

    fmt = {Type.INT: I, Type.UINT: U, Type.FLOAT: F}.get(element_type)
    if not fmt:
      raise TypeError('unsupported element_type')
    self._WriteVector(fmt, elements, byte_width)

    type_ = Type.ToTypedVector(element_type, len(elements) if fixed else 0)
    self._stack.append(Value(loc, type_, bit_width))
    return loc

  def _CreateVector(self, elements, typed, fixed, keys=None):
    """Writes vector elements to the underlying buffer."""
    length = len(elements)

    if fixed and not typed:
      raise ValueError('fixed vector must be typed')

    # Figure out smallest bit width we can store this vector with.
    bit_width = max(self._force_min_bit_width, BitWidth.U(length))
    prefix_elems = 1  # Vector size
    if keys:
      bit_width = max(bit_width, keys.ElemWidth(len(self._buf)))
      prefix_elems += 2  # Offset to the keys vector and its byte width.

    vector_type = Type.KEY
    # Check bit widths and types for all elements.
    for i, e in enumerate(elements):
      bit_width = max(bit_width, e.ElemWidth(len(self._buf), prefix_elems + i))

      if typed:
        if i == 0:
          vector_type = e.Type
        else:
          if vector_type != e.Type:
            raise RuntimeError('typed vector elements must be of the same type')

    if fixed and not Type.IsFixedTypedVectorElementType(vector_type):
      raise RuntimeError('must be fixed typed vector element type')

    byte_width = self._Align(bit_width)
    # Write vector. First the keys width/offset if available, and size.
    if keys:
      self._WriteOffset(keys.Value, byte_width)
      self._Write(U, 1 << keys.MinBitWidth, byte_width)

    if not fixed:
      self._Write(U, length, byte_width)

    # Then the actual data.
    loc = len(self._buf)
    for e in elements:
      self._WriteAny(e, byte_width)

    # Then the types.
    if not typed:
      for e in elements:
        self._buf.append(e.StoredPackedType(bit_width))

    if keys:
      type_ = Type.MAP
    else:
      if typed:
        type_ = Type.ToTypedVector(vector_type, length if fixed else 0)
      else:
        type_ = Type.VECTOR

    return Value(loc, type_, bit_width)

  def _PushIndirect(self, value, type_, bit_width):
    byte_width = self._Align(bit_width)
    loc = len(self._buf)
    fmt = {Type.INDIRECT_INT: I, Type.INDIRECT_UINT: U, Type.INDIRECT_FLOAT: F}[
        type_
    ]
    self._Write(fmt, value, byte_width)
    self._stack.append(Value(loc, type_, bit_width))

  @InMapForString
  def String(self, value):
    """Encodes string value."""
    reset_to = len(self._buf)
    encoded = value.encode('utf-8')
    loc = self._WriteBlob(encoded, append_zero=True, type_=Type.STRING)
    if self._share_strings:
      prev_loc = self._string_pool.FindOrInsert(encoded, loc)
      if prev_loc is not None:
        del self._buf[reset_to:]
        self._stack[-1]._value = loc = prev_loc  # pylint: disable=protected-access

    return loc

  @InMap
  def Blob(self, value):
    """Encodes binary blob value.

    Args:
      value: A byte/bytearray value to encode

    Returns:
      Offset of the encoded value in underlying the byte buffer.
    """
    return self._WriteBlob(value, append_zero=False, type_=Type.BLOB)

  def Key(self, value):
    """Encodes key value.

    Args:
      value: A byte/bytearray/str value to encode. Byte object must not contain
        zero bytes. String object must be convertible to ASCII.

    Returns:
      Offset of the encoded value in the underlying byte buffer.
    """
    if isinstance(value, (bytes, bytearray)):
      encoded = value
    else:
      encoded = value.encode('ascii')

    if 0 in encoded:
      raise ValueError('key contains zero byte')

    loc = len(self._buf)
    self._buf.extend(encoded)
    self._buf.append(0)
    if self._share_keys:
      prev_loc = self._key_pool.FindOrInsert(encoded, loc)
      if prev_loc is not None:
        del self._buf[loc:]
        loc = prev_loc

    self._stack.append(Value.Key(loc))
    return loc

  def Null(self, key=None):
    """Encodes None value."""
    if key:
      self.Key(key)
    self._stack.append(Value.Null())

  @InMap
  def Bool(self, value):
    """Encodes boolean value.

    Args:
      value: A boolean value.
    """
    self._stack.append(Value.Bool(value))

  @InMap
  def Int(self, value, byte_width=0):
    """Encodes signed integer value.

    Args:
      value: A signed integer value.
      byte_width: Number of bytes to use: 1, 2, 4, or 8.
    """
    bit_width = BitWidth.I(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._stack.append(Value.Int(value, bit_width))

  @InMap
  def IndirectInt(self, value, byte_width=0):
    """Encodes signed integer value indirectly.

    Args:
      value: A signed integer value.
      byte_width: Number of bytes to use: 1, 2, 4, or 8.
    """
    bit_width = BitWidth.I(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._PushIndirect(value, Type.INDIRECT_INT, bit_width)

  @InMap
  def UInt(self, value, byte_width=0):
    """Encodes unsigned integer value.

    Args:
      value: An unsigned integer value.
      byte_width: Number of bytes to use: 1, 2, 4, or 8.
    """
    bit_width = BitWidth.U(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._stack.append(Value.UInt(value, bit_width))

  @InMap
  def IndirectUInt(self, value, byte_width=0):
    """Encodes unsigned integer value indirectly.

    Args:
      value: An unsigned integer value.
      byte_width: Number of bytes to use: 1, 2, 4, or 8.
    """
    bit_width = BitWidth.U(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._PushIndirect(value, Type.INDIRECT_UINT, bit_width)

  @InMap
  def Float(self, value, byte_width=0):
    """Encodes floating point value.

    Args:
      value: A floating point value.
      byte_width: Number of bytes to use: 4 or 8.
    """
    bit_width = BitWidth.F(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._stack.append(Value.Float(value, bit_width))

  @InMap
  def IndirectFloat(self, value, byte_width=0):
    """Encodes floating point value indirectly.

    Args:
      value: A floating point value.
      byte_width: Number of bytes to use: 4 or 8.
    """
    bit_width = BitWidth.F(value) if byte_width == 0 else BitWidth.B(byte_width)
    self._PushIndirect(value, Type.INDIRECT_FLOAT, bit_width)

  def _StartVector(self):
    """Starts vector construction."""
    return len(self._stack)

  def _EndVector(self, start, typed, fixed):
    """Finishes vector construction by encodung its elements."""
    vec = self._CreateVector(self._stack[start:], typed, fixed)
    del self._stack[start:]
    self._stack.append(vec)
    return vec.Value

  @contextlib.contextmanager
  def Vector(self, key=None):
    if key:
      self.Key(key)

    try:
      start = self._StartVector()
      yield self
    finally:
      self._EndVector(start, typed=False, fixed=False)

  @InMap
  def VectorFromElements(self, elements):
    """Encodes sequence of any elements as a vector.

    Args:
      elements: sequence of elements, they may have different types.
    """
    with self.Vector():
      for e in elements:
        self.Add(e)

  @contextlib.contextmanager
  def TypedVector(self, key=None):
    if key:
      self.Key(key)

    try:
      start = self._StartVector()
      yield self
    finally:
      self._EndVector(start, typed=True, fixed=False)

  @InMap
  def TypedVectorFromElements(self, elements, element_type=None):
    """Encodes sequence of elements of the same type as typed vector.

    Args:
      elements: Sequence of elements, they must be of the same type.
      element_type: Suggested element type. Setting it to None means determining
        correct value automatically based on the given elements.
    """
    if isinstance(elements, array.array):
      if elements.typecode == 'f':
        self._WriteScalarVector(Type.FLOAT, 4, elements, fixed=False)
      elif elements.typecode == 'd':
        self._WriteScalarVector(Type.FLOAT, 8, elements, fixed=False)
      elif elements.typecode in ('b', 'h', 'i', 'l', 'q'):
        self._WriteScalarVector(
            Type.INT, elements.itemsize, elements, fixed=False
        )
      elif elements.typecode in ('B', 'H', 'I', 'L', 'Q'):
        self._WriteScalarVector(
            Type.UINT, elements.itemsize, elements, fixed=False
        )
      else:
        raise ValueError('unsupported array typecode: %s' % elements.typecode)
    else:
      add = self.Add if element_type is None else self.Adder(element_type)
      with self.TypedVector():
        for e in elements:
          add(e)

  @InMap
  def FixedTypedVectorFromElements(
      self, elements, element_type=None, byte_width=0
  ):
    """Encodes sequence of elements of the same type as fixed typed vector.

    Args:
      elements: Sequence of elements, they must be of the same type. Allowed
        types are `Type.INT`, `Type.UINT`, `Type.FLOAT`. Allowed number of
        elements are 2, 3, or 4.
      element_type: Suggested element type. Setting it to None means determining
        correct value automatically based on the given elements.
      byte_width: Number of bytes to use per element. For `Type.INT` and
        `Type.UINT`: 1, 2, 4, or 8. For `Type.FLOAT`: 4 or 8. Setting it to 0
        means determining correct value automatically based on the given
        elements.
    """
    if not 2 <= len(elements) <= 4:
      raise ValueError('only 2, 3, or 4 elements are supported')

    types = {type(e) for e in elements}
    if len(types) != 1:
      raise TypeError('all elements must be of the same type')

    (type_,) = types

    if element_type is None:
      element_type = {int: Type.INT, float: Type.FLOAT}.get(type_)
      if not element_type:
        raise TypeError('unsupported element_type: %s' % type_)

    if byte_width == 0:
      width = {
          Type.UINT: BitWidth.U,
          Type.INT: BitWidth.I,
          Type.FLOAT: BitWidth.F,
      }[element_type]
      byte_width = 1 << max(width(e) for e in elements)

    self._WriteScalarVector(element_type, byte_width, elements, fixed=True)

  def _StartMap(self):
    """Starts map construction."""
    return len(self._stack)

  def _EndMap(self, start):
    """Finishes map construction by encodung its elements."""
    # Interleaved keys and values on the stack.
    stack = self._stack[start:]

    if len(stack) % 2 != 0:
      raise RuntimeError('must be even number of keys and values')

    for key in stack[::2]:
      if key.Type is not Type.KEY:
        raise RuntimeError('all map keys must be of %s type' % Type.KEY)

    pairs = zip(stack[::2], stack[1::2])  # [(key, value), ...]
    pairs = sorted(pairs, key=lambda pair: self._ReadKey(pair[0].Value))

    del self._stack[start:]
    for pair in pairs:
      self._stack.extend(pair)

    keys = self._CreateVector(self._stack[start::2], typed=True, fixed=False)
    values = self._CreateVector(
        self._stack[start + 1 :: 2], typed=False, fixed=False, keys=keys
    )

    del self._stack[start:]
    self._stack.append(values)
    return values.Value

  @contextlib.contextmanager
  def Map(self, key=None):
    if key:
      self.Key(key)

    try:
      start = self._StartMap()
      yield self
    finally:
      self._EndMap(start)

  def MapFromElements(self, elements):
    start = self._StartMap()
    for k, v in elements.items():
      self.Key(k)
      self.Add(v)
    self._EndMap(start)

  def Adder(self, type_):
    return {
        Type.BOOL: self.Bool,
        Type.INT: self.Int,
        Type.INDIRECT_INT: self.IndirectInt,
        Type.UINT: self.UInt,
        Type.INDIRECT_UINT: self.IndirectUInt,
        Type.FLOAT: self.Float,
        Type.INDIRECT_FLOAT: self.IndirectFloat,
        Type.KEY: self.Key,
        Type.BLOB: self.Blob,
        Type.STRING: self.String,
    }[type_]

  @InMapForString
  def Add(self, value):
    """Encodes value of any supported type."""
    if value is None:
      self.Null()
    elif isinstance(value, bool):
      self.Bool(value)
    elif isinstance(value, int):
      self.Int(value)
    elif isinstance(value, float):
      self.Float(value)
    elif isinstance(value, str):
      self.String(value)
    elif isinstance(value, (bytes, bytearray)):
      self.Blob(value)
    elif isinstance(value, dict):
      with self.Map():
        for k, v in value.items():
          self.Key(k)
          self.Add(v)
    elif isinstance(value, array.array):
      self.TypedVectorFromElements(value)
    elif _IsIterable(value):
      self.VectorFromElements(value)
    else:
      raise TypeError('unsupported python type: %s' % type(value))

  @property
  def LastValue(self):
    return self._stack[-1]

  @InMap
  def ReuseValue(self, value):
    self._stack.append(value)


def GetRoot(buf):
  """Returns root `Ref` object for the given buffer."""
  if len(buf) < 3:
    raise ValueError('buffer is too small')
  byte_width = buf[-1]
  return Ref.PackedType(
      Buf(buf, -(2 + byte_width)), byte_width, packed_type=buf[-2]
  )


def Dumps(obj):
  """Returns bytearray with the encoded python object."""
  fbb = Builder()
  fbb.Add(obj)
  return fbb.Finish()


def Loads(buf):
  """Returns python object decoded from the buffer."""
  return GetRoot(buf).Value
