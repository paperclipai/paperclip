# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import copy
import logging
import os
import tempfile
from enum import Enum
from pathlib import Path

import numpy
import onnx
from ml_dtypes import float8_e4m3fn, int4, uint4
from onnx import ModelProto, TensorProto, external_data_helper
from onnx import onnx_pb as onnx_proto
from onnx.helper import make_graph, make_model, make_node, make_tensor_value_info
from onnx.reference import ReferenceEvaluator

from onnxruntime import GraphOptimizationLevel, InferenceSession, SessionOptions

try:
    from onnx.reference.op_run import to_array_extended
except ImportError:
    # old version of onnx.
    to_array_extended = None


__producer__ = "onnx.quantize"
__version__ = "0.1.0"
onnx_domain = "ai.onnx"
ms_domain = "com.microsoft"
QUANT_OP_NAME = "QuantizeLinear"
QUANT_INPUT_SUFFIX = "_QuantizeLinear_Input"
DEQUANT_OP_NAME = "DequantizeLinear"
DEQUANT_OUTPUT_SUFFIX = "_DequantizeLinear_Output"
TENSOR_NAME_QUANT_SUFFIX = "_quantized"
MODEL_SIZE_THRESHOLD = 2147483648  # Quant model should use external data if >= 2GB

FLOAT8_DISTRIBUTIONS = {}

type_to_name = {getattr(TensorProto, k): k for k in dir(TensorProto) if isinstance(getattr(TensorProto, k), int)}

# Quantization mode
# IntegerOps: Use IntegerOps in quantized model. Only ConvInteger and MatMulInteger ops are supported now.
# QLinearOps: Use QLinearOps in quantized model. Only QLinearConv and QLinearMatMul ops are supported now.


class QuantizationMode(Enum):
    IntegerOps = 0
    QLinearOps = 1

    def __str__(self):
        return self.name

    @staticmethod
    def from_string(mode):
        try:
            return QuantizationMode[mode]
        except KeyError:
            raise ValueError()  # noqa: B904


class QuantizedValueType(Enum):
    Input = 0
    Initializer = 1

    def __str__(self):
        return self.name

    @staticmethod
    def from_string(v):
        try:
            return QuantizedValueType[v]
        except KeyError:
            raise ValueError()  # noqa: B904


class QuantType(Enum):
    QInt8 = 0
    QUInt8 = 1
    QFLOAT8E4M3FN = 2
    QInt16 = 3
    QUInt16 = 4
    QInt4 = 5
    QUInt4 = 6

    def __str__(self):
        return self.name

    @staticmethod
    def from_string(t):
        try:
            return QuantType[t]
        except KeyError:
            raise ValueError()  # noqa: B904

    @property
    def tensor_type(self):
        if self == QuantType.QInt8:
            return TensorProto.INT8
        if self == QuantType.QUInt8:
            return TensorProto.UINT8
        if self == QuantType.QUInt16:
            return TensorProto.UINT16
        if self == QuantType.QInt16:
            return TensorProto.INT16
        if self == QuantType.QFLOAT8E4M3FN:
            return TensorProto.FLOAT8E4M3FN
        if self == QuantType.QUInt4:
            return TensorProto.UINT4
        if self == QuantType.QInt4:
            return TensorProto.INT4
        raise ValueError(f"Unexpected value qtype={self!r}.")


class QuantFormat(Enum):
    QOperator = 0
    QDQ = 1

    def __str__(self):
        return self.name

    @staticmethod
    def from_string(format):
        try:
            return QuantFormat[format]
        except KeyError:
            raise ValueError()  # noqa: B904


ONNX_TYPE_TO_NP_TYPE = {
    onnx_proto.TensorProto.INT8: numpy.dtype("int8"),
    onnx_proto.TensorProto.UINT8: numpy.dtype("uint8"),
    onnx_proto.TensorProto.INT16: numpy.dtype("int16"),
    onnx_proto.TensorProto.UINT16: numpy.dtype("uint16"),
    onnx_proto.TensorProto.FLOAT8E4M3FN: float8_e4m3fn,
    onnx_proto.TensorProto.INT4: int4,
    onnx_proto.TensorProto.UINT4: uint4,
}

ONNX_INT_TYPE_RANGE = {
    onnx_proto.TensorProto.UINT8: (numpy.array(0, dtype=numpy.uint8), numpy.array(255, dtype=numpy.uint8)),
    onnx_proto.TensorProto.INT8: (numpy.array(-128, dtype=numpy.int8), numpy.array(127, dtype=numpy.int8)),
    onnx_proto.TensorProto.UINT16: (numpy.array(0, dtype=numpy.uint16), numpy.array(65535, dtype=numpy.uint16)),
    onnx_proto.TensorProto.INT16: (numpy.array(-32768, dtype=numpy.int16), numpy.array(32767, dtype=numpy.int16)),
    onnx_proto.TensorProto.UINT4: (numpy.array(0, dtype=uint4), numpy.array(15, dtype=uint4)),
    onnx_proto.TensorProto.INT4: (numpy.array(-8, dtype=int4), numpy.array(7, dtype=int4)),
}

ONNX_INT_TYPE_SYMMETRIC_RANGE = {
    onnx_proto.TensorProto.INT8: (numpy.array(-127, dtype=numpy.int8), numpy.array(127, dtype=numpy.int8)),
    onnx_proto.TensorProto.INT16: (numpy.array(-32767, dtype=numpy.int16), numpy.array(32767, dtype=numpy.int16)),
}

ONNX_INT_TYPE_REDUCED_RANGE = {
    onnx_proto.TensorProto.UINT8: (numpy.array(0, dtype=numpy.uint8), numpy.array(127, dtype=numpy.uint8)),
    onnx_proto.TensorProto.INT8: (numpy.array(-64, dtype=numpy.int8), numpy.array(64, dtype=numpy.int8)),
    onnx_proto.TensorProto.UINT16: (numpy.array(0, dtype=numpy.uint16), numpy.array(32767, dtype=numpy.uint16)),
    onnx_proto.TensorProto.INT16: (numpy.array(-16384, dtype=numpy.int16), numpy.array(16384, dtype=numpy.int16)),
    onnx_proto.TensorProto.UINT4: (numpy.array(0, dtype=uint4), numpy.array(7, dtype=uint4)),
    onnx_proto.TensorProto.INT4: (numpy.array(-4, dtype=int4), numpy.array(3, dtype=int4)),
}


def _check_type(*args, zero_point_index=-1):
    new_args = []
    for i, a in enumerate(args):
        if numpy.issubdtype(type(a), numpy.number):
            new_args.append(numpy.array(a))
        elif isinstance(a, numpy.ndarray):
            new_args.append(a)
        else:
            raise TypeError(f"arg {i} is not an array: {a}")
        if i == zero_point_index:
            v = new_args[-1]
            if v.dtype == numpy.float32 or v.dtype == numpy.float16:
                raise TypeError(f"zero_point cannot be {v.dtype}")
    return tuple(new_args) if len(new_args) > 1 else new_args[0]


def quantize_nparray(qType, arr, scale, zero_point, low=None, high=None):
    assert qType in ONNX_TYPE_TO_NP_TYPE, (
        f"Unexpected data type {qType} requested. Only INT8, UINT8, INT16, and UINT16 are supported."
    )
    if qType in (
        onnx_proto.TensorProto.FLOAT8E4M3FN,
        onnx_proto.TensorProto.FLOAT8E4M3FNUZ,
        onnx_proto.TensorProto.FLOAT8E5M2,
        onnx_proto.TensorProto.FLOAT8E5M2FNUZ,
    ):
        if zero_point != 0:
            raise NotImplementedError(f"zero_point is expected to be null for float 8 not {zero_point!r}.")
        if arr.dtype == numpy.float32:
            onnx_type = TensorProto.FLOAT
        elif arr.dtype == numpy.float16:
            onnx_type = TensorProto.FLOAT16
        else:
            raise ValueError(f"Unexpected dtype {arr.dtype}.")
        onnx_model = make_model(
            make_graph(
                [
                    make_node(
                        "Constant", [], ["zero_point"], value=onnx.helper.make_tensor("zero_point", qType, [], [0])
                    ),
                    make_node("QuantizeLinear", ["X", "scale", "zero_point"], ["Y"]),
                ],
                "qu",
                [
                    make_tensor_value_info("X", onnx_type, None),
                    make_tensor_value_info("scale", onnx_type, None),
                ],
                [make_tensor_value_info("Y", qType, None)],
            )
        )
        ref = ReferenceEvaluator(onnx_model)
        return _check_type(ref.run(None, {"X": arr, "scale": scale})[0])
    else:
        # Quantizes data for all integer types.
        #
        # For int4 types, the quantized data is returned as either np.int8 or np.uint8,
        # which matches the python reference ONNX implementation of QuantizeLinear.
        # This data can be packed into 4-bit elements by using pack_bytes_to_4bit().
        dtype = ONNX_TYPE_TO_NP_TYPE[qType]
        qmin, qmax = get_qmin_qmax_for_qType(qType, reduce_range=False, symmetric=False)

        cliplow = max(qmin, low) if low is not None else qmin
        cliphigh = min(qmax, high) if high is not None else qmax
        arr_fp32 = numpy.asarray((arr.astype(numpy.float32) / scale).round() + zero_point)
        numpy.clip(arr_fp32, cliplow, cliphigh, out=arr_fp32)
        return _check_type(arr_fp32.astype(dtype))


def compute_scale_zp(rmin, rmax, qmin, qmax, symmetric=False, min_real_range=None):
    """Calculate the scale s and zero point z for the quantization relation
    r = s(q-z), where r are the original values and q are the corresponding
    quantized values.

    r and z are calculated such that every value within [rmin,rmax] has an
    approximate representation within [qmin,qmax]. In addition, qmin <= z <=
    qmax is enforced. If the symmetric flag is set to True, the interval
    [rmin,rmax] is symmetrized to [-absmax, +absmax], where
    absmax = max(abs(rmin), abs(rmax)).

    :parameter rmin: minimum value of r
    :parameter rmax: maximum value of r
    :parameter qmin: minimum value representable by the target quantization data type
    :parameter qmax: maximum value representable by the target quantization data type
    :parameter symmetric: True if the floating-point range should be made symmetric. Defaults to False.
    :parameter min_real_range: Minimum floating-point range (i.e., rmax - rmin) to enforce. Defaults to None.
    :return: zero and scale [z, s]

    """
    if qmin > 0 or qmax < 0:
        raise ValueError(f"qmin and qmax must meet requirement: qmin <= 0 <= qmax while qmin:{qmin}, qmmax:{qmax}")

    # Adjust rmin and rmax such that 0 is included in the range. This is
    # required to make sure zero can be represented by the quantization data
    # type (i.e. to make sure qmin <= zero_point <= qmax)
    rmin = numpy.minimum(rmin, numpy.array(0, dtype=rmin.dtype))
    rmax = numpy.maximum(rmax, numpy.array(0, dtype=rmax.dtype))

    # Ensure a minimum float-point range if specified.
    if min_real_range is not None:
        rmax = max(rmax, rmin + numpy.asarray(min_real_range, dtype=rmin.dtype))

    if symmetric:
        absmax = numpy.maximum(numpy.abs(rmin), numpy.abs(rmax))
        rmin = -absmax
        rmax = +absmax

    assert qmin <= qmax, f"qmin={rmin} > qmax={rmax}"
    dr = numpy.array(rmax - rmin, dtype=numpy.float64)
    dq = numpy.array(qmax, dtype=numpy.float64) - numpy.array(qmin, dtype=numpy.float64)
    scale = numpy.array(dr / dq)
    assert scale >= 0, "scale issue"
    if scale < numpy.finfo(rmax.dtype).tiny:
        scale = numpy.array(1.0, dtype=rmax.dtype)
        zero_point = numpy.array(0, dtype=qmin.dtype)
    else:
        if symmetric:
            # When symmetric (i.e., rmax == -rmin), the zero_point formula reduces to round((qmax + qmin) / 2.0).
            # This simpler formula doesn't depend on scale and guarantees that the zero point values
            # for int8, uint8, int16, and uint16 are always 0, 128, 0, and 32768, respectively.
            # This is important for per-channel/symmetric QLinearConv on CPU EP, which requires all channels to have
            # the exact same zero_point values.
            zero_point = numpy.array(
                numpy.round((qmin + qmax) / numpy.array(2.0, dtype=numpy.float64)), dtype=qmin.dtype
            )
        else:
            zero_point = numpy.array(numpy.round(qmin - rmin / scale), dtype=qmin.dtype)
        scale = scale.astype(rmax.dtype)

    return [zero_point, scale]


def compute_scale_zp_float8(element_type, std):
    """Calculate the scale s for a float8 type (E4M3FN).
    The function assumes the coefficient distribution and the float 8
    distribution are similar to two gaussian laws.

    :return: zero and scale [z, s]

    More details in notebook `quantization_fp8.ipynb
    <https://github.com/microsoft/onnxruntime/blob/main/docs/python/notebooks/quantization_fp8.ipynb>`_.
    """
    zp_dtype = None
    if element_type not in FLOAT8_DISTRIBUTIONS:
        if element_type == TensorProto.FLOAT8E4M3FN:
            from ml_dtypes import float8_e4m3fn  # noqa: PLC0415

            zp_dtype = float8_e4m3fn
            all_values = [float(i) for i in range(256)]
            values = numpy.array(
                [f for f in all_values if not numpy.isnan(f) and not numpy.isinf(f)], dtype=numpy.float32
            )
        else:
            raise ValueError(f"Quantization to element_type={element_type} not implemented.")
        FLOAT8_DISTRIBUTIONS[element_type] = values
    elif element_type == TensorProto.FLOAT8E4M3FN:
        from ml_dtypes import float8_e4m3fn  # noqa: PLC0415

        zp_dtype = float8_e4m3fn

    if zp_dtype is None:
        raise TypeError(f"Unexpected element_type {element_type}.")
    std_f8 = numpy.std(FLOAT8_DISTRIBUTIONS[element_type])
    zero = numpy.array(0, dtype=zp_dtype)
    scale = numpy.array(std / std_f8, dtype=std.dtype)
    return [zero, scale]


def compute_data_quant_params(
    data: numpy.ndarray,
    quant_type: onnx.TensorProto.DataType,
    symmetric: bool,
    reduce_range: bool = False,
    min_real_range: float | None = None,
    rmin_override: float | None = None,
    rmax_override: float | None = None,
) -> tuple[numpy.ndarray, numpy.ndarray]:
    """
    Returns the zero_point and scale for the given data.

    :param data: The data for which to compute quantization parameters.
    :param quant_type: The quantization data type.
    :param symmetric: whether symmetric quantization is used or not.
    :parameter reduce_range: True if the quantization range should be reduced. Defaults to False.
    :parameter min_real_range: Minimum floating-point range (i.e., rmax - rmin) to enforce. Defaults to None.
    :parameter rmin_override: The value of rmin to use if not None. Otherwise, uses min(data).
    :parameter rmax_override: The value of rmax to use if not None. Otherwise, uses max(data).
    :return: zero point and scale
    """
    if not isinstance(data, numpy.ndarray):
        raise TypeError(f"Weight must be given as an array not {type(data)}.")
    if rmin_override is not None:
        rmin = rmin_override
    else:
        rmin = data.min() if len(data) else 0.0

    if rmax_override is not None:
        rmax = rmax_override
    else:
        rmax = data.max() if len(data) else 0.0

    rmin = numpy.array(rmin, dtype=data.dtype)
    rmax = numpy.array(rmax, dtype=data.dtype)
    scale = numpy.array(1.0, dtype=data.dtype)

    if quant_type == TensorProto.FLOAT8E4M3FN:
        if reduce_range:
            raise RuntimeError("Unsupported option reduce_range=True for float 8.")
        std = numpy.std(data)
        zero_point, scale = compute_scale_zp_float8(quant_type, std)
        return _check_type(zero_point, scale, zero_point_index=0)

    if quant_type in (
        TensorProto.INT8,
        TensorProto.UINT8,
        TensorProto.INT16,
        TensorProto.UINT16,
        TensorProto.INT4,
        TensorProto.UINT4,
    ):
        qmin, qmax = get_qmin_qmax_for_qType(quant_type, reduce_range, symmetric=symmetric)
        if len(data):
            zero_point, scale = compute_scale_zp(rmin, rmax, qmin, qmax, symmetric, min_real_range)
        else:
            zero_point = numpy.array(0, dtype=qmin.dtype)
        return _check_type(zero_point, scale, zero_point_index=0)

    raise ValueError(f"Unexpected value for quant_type={quant_type}.")


def quantize_data(
    data, qType, symmetric, reduce_range=False, min_real_range=None, rmin_override=None, rmax_override=None
) -> tuple[numpy.ndarray, numpy.ndarray, numpy.ndarray]:
    """
    :param data: data to quantize
    :param qType: data type to quantize to.
    :param symmetric: whether symmetric quantization is used or not.
    :parameter reduce_range: True if the quantization range should be reduced. Defaults to False.
    :parameter min_real_range: Minimum floating-point range (i.e., rmax - rmin) to enforce. Defaults to None.
    :parameter rmin_override: The value of rmin to use if not None. Otherwise, uses min(data).
    :parameter rmax_override: The value of rmax to use if not None. Otherwise, uses max(data).
    :return: minimum, maximum, zero point, scale, and quantized weights

    To pack weights, we compute a linear transformation

    - when data `type == uint8` mode, from `[rmin, rmax]` -> :math:`[0, 2^{b-1}]` and
    - when data `type == int8`, from `[-m , m]` -> :math:`[-(2^{b-1}-1), 2^{b-1}-1]` where
        `m = max(abs(rmin), abs(rmax))`

    and add necessary intermediate nodes to transform quantized weight to full weight using the equation

    :math:`r = S(q-z)`, where

    - *r*: real original value
    - *q*: quantized value
    - *S*: scale
    - *z*: zero point
    """
    zero_point, scale = compute_data_quant_params(
        data,
        qType,
        symmetric,
        reduce_range,
        min_real_range,
        rmin_override,
        rmax_override,
    )
    if qType == TensorProto.FLOAT8E4M3FN:
        quantized_data = quantize_nparray(qType, data, scale, zero_point)
        if any((quantized_data.view(numpy.uint8).ravel() & 127) == 127):
            np_data = numpy.asarray(data)
            raise RuntimeError(
                f"One of the quantized value is NaN data in [{np_data.min()}, {np_data.max()}], "
                f"quantized_data in [{quantized_data.min()}, {quantized_data.max()}]."
            )
        return zero_point, scale, quantized_data

    if qType in (
        TensorProto.INT8,
        TensorProto.UINT8,
        TensorProto.INT16,
        TensorProto.UINT16,
        TensorProto.INT4,
        TensorProto.UINT4,
    ):
        quantized_data = quantize_nparray(qType, data, scale, zero_point)
        return zero_point, scale, quantized_data

    raise ValueError(f"Unexpected value for qType={qType}.")


def quantize_onnx_initializer(
    weight: onnx.TensorProto,
    quant_type: onnx.TensorProto.DataType,
    zero_point: numpy.ndarray,
    scale: numpy.ndarray,
    axis: int | None = None,
    quant_weight_name: str | None = None,
) -> onnx.TensorProto:
    """
    Returns a quantized version of the given ONNX initializer.

    :param weight: The ONNX initializer to quantize.
    :param quant_type: The final quantized data type.
    :param zero_point: The zero-point value to use for quantization.
    :param scale: The scale value to use for quantization.
    :param axis: The quantization axis if quantizing per-channel. Defaults to None.
    :param quant_weight_name: The name of the quantized initializer.
                              If not specified, the quantized name is generated.
    :return: The quantized ONNX initializer.
    """
    weight_data = tensor_proto_to_array(weight)
    q_weight_data: numpy.ndarray | None = None

    if axis is None:  # Per-tensor quantization
        q_weight_data = quantize_nparray(quant_type, weight_data.ravel(), scale, zero_point)
    else:  # Per-channel quantization
        channel_count = weight_data.shape[axis]
        channel_dims = list(weight_data.shape)  # deep copy
        channel_dims[axis] = 1  # only one per channel for reshape
        quantized_channel_data_list = []

        for i in range(channel_count):
            channel_data = weight_data.take(i, axis)
            channel_scale = scale[i]
            channel_zero_point = zero_point[i]
            quantized_channel_data = quantize_nparray(
                quant_type, channel_data.ravel(), channel_scale, channel_zero_point
            )
            quantized_channel_data_list.append(numpy.asarray(quantized_channel_data).reshape(channel_dims))

        q_weight_data = numpy.concatenate(quantized_channel_data_list, axis)

    q_weight_name = quant_weight_name if quant_weight_name else f"{weight.name}{TENSOR_NAME_QUANT_SUFFIX}"

    if quant_type == onnx.TensorProto.FLOAT8E4M3FN:
        q_weight_initializer = onnx.TensorProto()
        q_weight_initializer.data_type = quant_type
        q_weight_initializer.dims.extend(weight.dims)
        q_weight_initializer.name = q_weight_name
        # Do not remove .flatten().copy() numpy is not clear about data persistence.
        q_weight_initializer.raw_data = q_weight_data.flatten().copy().tobytes()
        if to_array_extended is not None:
            # This test should not be needed but it helped catch some issues
            # with data persistence and tobytes.
            check = to_array_extended(q_weight_initializer)
            if check.shape != weight_data.shape or check.tobytes() != q_weight_data.tobytes():
                raise RuntimeError(
                    f"The initializer of shape {weight_data.shape} could not be created, expecting "
                    f"{q_weight_data.tobytes()[:10]}, got {check.tobytes()[:10]} and shape={weight.shape}"
                    f"\nraw={str(q_weight_initializer)[:200]}."
                )
    elif quant_type in (onnx.TensorProto.INT4, onnx.TensorProto.UINT4):
        if q_weight_data.dtype not in (int4, uint4):
            raise RuntimeError(f"Quantized weights for {q_weight_name} must be 8-bit before packing as 4-bit values.")

        # We do not use onnx.helper.pack_float32_to_4bit() due to performance.
        # This can be the difference between a large model taking 30 minutes to quantize vs 5 minutes.
        packed_data = bytes(pack_bytes_to_4bit(q_weight_data.tobytes()))

        # We only use onnx.helper.make_tensor with raw data due to bug: https://github.com/onnx/onnx/pull/6161
        q_weight_initializer = onnx.helper.make_tensor(q_weight_name, quant_type, weight.dims, packed_data, raw=True)
    else:
        quant_np_dtype = onnx.helper.tensor_dtype_to_np_dtype(quant_type)
        q_weight_data = numpy.asarray(q_weight_data, dtype=quant_np_dtype).reshape(weight.dims)
        q_weight_initializer = onnx.numpy_helper.from_array(q_weight_data, q_weight_name)

    return q_weight_initializer


def get_qmin_qmax_for_qType(qType, reduce_range=False, symmetric=False):  # noqa: N802
    """
    Return qmin and qmax, the minimum and maximum value representable by the given qType
    :parameter qType: onnx.onnx_pb.TensorProto.UINT8 or onnx.onnx_pb.TensorProto.UINT8
    :return: qmin, qmax
    """
    if qType == onnx_proto.TensorProto.FLOAT8E4M3FN:
        raise NotImplementedError("This function is not implemented for float 8 as not needed.")

    qrange = None

    if reduce_range:
        qrange = ONNX_INT_TYPE_REDUCED_RANGE.get(qType)
    elif symmetric and qType in ONNX_INT_TYPE_SYMMETRIC_RANGE:
        qrange = ONNX_INT_TYPE_SYMMETRIC_RANGE[qType]
    else:
        qrange = ONNX_INT_TYPE_RANGE.get(qType)

    if not qrange:
        raise ValueError(f"Unexpected data type {qType} requested. Only INT8, UINT8, INT16, and UINT16 are supported.")

    qmin, qmax = qrange
    if qmin > 0 or qmax < 0:
        raise ValueError(
            f"qmin and qmax must meet requirement: qmin <= 0 <= qmax while "
            f"qmin:{qmin}, qmmax:{qmax}, dtype={qmin.dtype}, reduce_range={reduce_range}, "
            f"symmetric={symmetric}, qType={qType}"
        )

    return qrange


def get_qrange_for_qType(qType, reduce_range=False, symmetric=False):  # noqa: N802
    """
    Helper function to get the quantization range for a type.
        parameter qType: quantization type.
        return: quantization range.
    """
    qmin, qmax = get_qmin_qmax_for_qType(qType, reduce_range, symmetric=symmetric)
    return qmax - qmin


def normalize_axis(axis: int, rank: int) -> tuple[bool, int]:
    """
    Helper function that tries to return a normalized axis in the range [0, rank - 1].
    :parameter axis: The axis to normalize.
    :parameter rank: The tensor rank (number of dimensions).
    :return (is_valid, axis_norm)
    """
    axis_norm = axis + rank if axis < 0 else axis
    is_valid = axis_norm >= 0 and axis_norm < rank
    return is_valid, axis_norm


def pack_bytes_to_4bit(src_8bit: bytes) -> bytearray:
    """
    Copies a source array of 8-bit values into a destination bytearray of packed 4-bit values.
    Assumes that the source values are already in the appropriate int4 range.
    :parameter src_8bit: The 8-bit element values to pack.
    :return A bytearray with every two 8-bit src elements packed into a single byte.
    """
    num_elems = len(src_8bit)
    if num_elems == 0:
        return bytearray()

    dst_size = (num_elems + 1) // 2  # Ex: 5 8-bit elems packed into 3 bytes
    dst = bytearray(dst_size)

    src_i: int = 0
    dst_i: int = 0

    # Pack two 8-bit elements into a single byte in each iteration.
    while src_i < num_elems - 1:
        dst[dst_i] = ((src_8bit[src_i + 1] & 0xF) << 4) | (src_8bit[src_i] & 0xF)
        dst_i += 1
        src_i += 2

    if src_i < num_elems:
        # Odd number of elements.
        dst[dst_i] = src_8bit[src_i] & 0xF

    return dst


class QuantizedInitializer:
    """
    Represents a linearly quantized weight input from ONNX operators
    """

    def __init__(
        self,
        name,
        initializer,
        rmins,
        rmaxs,
        zero_points,
        scales,
        data=[],  # noqa: B006
        quantized_data=[],  # noqa: B006
        axis=None,
    ):
        self.name = name
        self.initializer = initializer  # TensorProto initializer in ONNX graph
        self.rmins = rmins  # List of minimum range for each axis
        self.rmaxs = rmaxs  # List of maximum range for each axis
        # 1D tensor of zero points computed for each axis. scalar if axis is empty
        self.zero_points = zero_points
        self.scales = scales  # 1D tensor of scales computed for each axis. scalar if axis is empty
        self.data = data  # original data from initializer TensorProto
        self.quantized_data = quantized_data  # weight-packed data from data
        # Scalar to specify which dimension in the initializer to weight pack.
        self.axis = axis
        # If empty, single zero point and scales computed from a single rmin and rmax


class QuantizedValue:
    """
    Represents a linearly quantized value (input\\output\\intializer)
    """

    def __init__(
        self,
        name,
        new_quantized_name,
        scale_name,
        zero_point_name,
        quantized_value_type,
        axis=None,
        node_type=None,
        node_qtype=None,
        scale_type=None,
    ):
        self.original_name = name
        self.q_name = new_quantized_name
        self.scale_name = scale_name
        self.zp_name = zero_point_name
        self.value_type = quantized_value_type
        self.axis = axis
        self.node_type = node_type
        self.node_qtype = node_qtype
        self.scale_type = scale_type


class BiasToQuantize:
    """
    Represents a bias to be quantized
    """

    def __init__(self, bias_name, input_name, weight_name):
        self.bias_name = bias_name
        self.input_name = input_name
        self.weight_name = weight_name


def attribute_to_kwarg(attribute):
    """
    Convert attribute to kwarg format for use with onnx.helper.make_node.
        :parameter attribute: attribute in AttributeProto format.
        :return: attribute in {key: value} format.
    """
    if attribute.type == 0:
        raise ValueError(f"attribute {attribute.name} does not have type specified.")

    # Based on attribute type definitions from AttributeProto
    # definition in https://github.com/onnx/onnx/blob/main/onnx/onnx.proto
    if attribute.type == 1:
        value = attribute.f
    elif attribute.type == 2:
        value = attribute.i
    elif attribute.type == 3:
        value = attribute.s
    elif attribute.type == 4:
        value = attribute.t
    elif attribute.type == 5:
        value = attribute.g
    elif attribute.type == 6:
        value = attribute.floats
    elif attribute.type == 7:
        value = attribute.ints
    elif attribute.type == 8:
        value = attribute.strings
    elif attribute.type == 9:
        value = attribute.tensors
    elif attribute.type == 10:
        value = attribute.graphs
    else:
        raise ValueError(f"attribute {attribute.name} has unsupported type {attribute.type}.")

    return {attribute.name: value}


def find_by_name(item_name, item_list):
    """
    Helper function to find item by name in a list.
        parameter item_name: name of the item.
        parameter item_list: list of items.
        return: item if found. None otherwise.
    """
    items = [item for item in item_list if item.name == item_name]
    return items[0] if len(items) > 0 else None


def get_elem_index(elem_name, elem_list):
    """
    Helper function to return index of an item in a node list
    """
    elem_idx = -1
    for i in range(len(elem_list)):
        if elem_list[i] == elem_name:
            elem_idx = i
    return elem_idx


def get_mul_node(inputs, output, name):
    """
    Helper function to create a Mul node.
        parameter inputs: list of input names.
        parameter output: output name.
        parameter name: name of the node.
        return: Mul node in NodeProto format.
    """
    return onnx.helper.make_node("Mul", inputs, [output], name)


def generate_identified_filename(filename: Path, identifier: str) -> Path:
    """
    Helper function to generate a identifiable filepath by concatenating the given identifier as a suffix.
    """
    return filename.parent.joinpath(filename.stem + identifier + filename.suffix)


def apply_plot(hist, hist_edges):
    import sys  # noqa: PLC0415

    import matplotlib.pyplot as plt  # noqa: PLC0415
    import numpy  # noqa: PLC0415

    numpy.set_printoptions(threshold=sys.maxsize)
    print("Histogram:")
    print(hist)
    print("Histogram Edges:")
    print(hist_edges)
    plt.stairs(hist, hist_edges, fill=True)
    plt.xlabel("Tensor value")
    plt.ylabel("Counts")
    plt.title("Tensor value V.S. Counts")
    plt.show()


def write_calibration_table(calibration_cache, dir="."):
    """
    Helper function to write calibration table to files.
    """

    import json  # noqa: PLC0415

    import flatbuffers  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415

    import onnxruntime.quantization.CalTableFlatBuffers.KeyValue as KeyValue  # noqa: PLC0415
    import onnxruntime.quantization.CalTableFlatBuffers.TrtTable as TrtTable  # noqa: PLC0415
    from onnxruntime.quantization.calibrate import CalibrationMethod, TensorData, TensorsData  # noqa: PLC0415

    logging.info(f"calibration cache: {calibration_cache}")

    class MyEncoder(json.JSONEncoder):
        def default(self, obj):
            if isinstance(obj, (TensorData, TensorsData)):
                return obj.to_dict()
            if isinstance(obj, np.ndarray):
                return {"data": obj.tolist(), "dtype": str(obj.dtype), "CLS": "numpy.array"}
            if isinstance(obj, CalibrationMethod):
                return {"CLS": obj.__class__.__name__, "value": str(obj)}
            return json.JSONEncoder.default(self, obj)

    json_data = json.dumps(calibration_cache, cls=MyEncoder)

    with open(os.path.join(dir, "calibration.json"), "w") as file:
        file.write(json_data)  # use `json.loads` to do the reverse

    # Serialize data using FlatBuffers
    zero = np.array(0)
    builder = flatbuffers.Builder(1024)
    key_value_list = []
    for key in sorted(calibration_cache.keys()):
        values = calibration_cache[key]
        d_values = values.to_dict()
        floats = [
            float(d_values.get("highest", zero).item()),
            float(d_values.get("lowest", zero).item()),
        ]
        value = str(max(floats))

        flat_key = builder.CreateString(key)
        flat_value = builder.CreateString(value)

        KeyValue.KeyValueStart(builder)
        KeyValue.KeyValueAddKey(builder, flat_key)
        KeyValue.KeyValueAddValue(builder, flat_value)
        key_value = KeyValue.KeyValueEnd(builder)

        key_value_list.append(key_value)

    TrtTable.TrtTableStartDictVector(builder, len(key_value_list))
    for key_value in key_value_list:
        builder.PrependUOffsetTRelative(key_value)
    main_dict = builder.EndVector()

    TrtTable.TrtTableStart(builder)
    TrtTable.TrtTableAddDict(builder, main_dict)
    cal_table = TrtTable.TrtTableEnd(builder)

    builder.Finish(cal_table)
    buf = builder.Output()

    with open(os.path.join(dir, "calibration.flatbuffers"), "wb") as file:
        file.write(buf)

    # Deserialize data (for validation)
    if os.environ.get("QUANTIZATION_DEBUG", "0") in (1, "1"):
        cal_table = TrtTable.TrtTable.GetRootAsTrtTable(buf, 0)
        dict_len = cal_table.DictLength()
        for i in range(dict_len):
            key_value = cal_table.Dict(i)
            logging.info(key_value.Key())
            logging.info(key_value.Value())

    # write plain text
    with open(os.path.join(dir, "calibration.cache"), "w") as file:
        for key in sorted(calibration_cache.keys()):
            values = calibration_cache[key]
            d_values = values.to_dict()
            floats = [
                float(d_values.get("highest", zero).item()),
                float(d_values.get("lowest", zero).item()),
            ]
            value = key + " " + str(max(floats))
            file.write(value)
            file.write("\n")


def smooth_distribution(p, eps=0.0001):
    """Given a discrete distribution (may have not been normalized to 1),
    smooth it by replacing zeros with eps multiplied by a scaling factor
    and taking the corresponding amount off the non-zero values.
    Ref: http://web.engr.illinois.edu/~hanj/cs412/bk3/KL-divergence.pdf
         https://github.com//apache/incubator-mxnet/blob/master/python/mxnet/contrib/quantization.py
    """
    is_zeros = (p == 0).astype(numpy.float32)
    is_nonzeros = (p != 0).astype(numpy.float32)
    n_zeros = is_zeros.sum()
    n_nonzeros = p.size - n_zeros

    if not n_nonzeros:
        # raise ValueError('The discrete probability distribution is malformed. All entries are 0.')
        return None
    eps1 = eps * float(n_zeros) / float(n_nonzeros)
    assert eps1 < 1.0, f"n_zeros={n_zeros}, n_nonzeros={n_nonzeros}, eps1={eps1}"

    hist = p.astype(numpy.float32)
    hist += eps * is_zeros + (-eps1) * is_nonzeros
    assert (hist <= 0).sum() == 0

    return hist


def model_has_external_data(model_path: Path):
    model = onnx.load(model_path.as_posix(), load_external_data=False)
    return any(external_data_helper.uses_external_data(intializer) for intializer in model.graph.initializer)


def optimize_model(model_path: Path, opt_model_path: Path):
    """
        Generate model that applies graph optimization (constant folding, etc.)
        parameter model_path: path to the original onnx model
        parameter opt_model_path: path to the optimized onnx model
    :return: optimized onnx model
    """
    sess_option = SessionOptions()
    sess_option.optimized_model_filepath = opt_model_path.as_posix()
    sess_option.graph_optimization_level = GraphOptimizationLevel.ORT_ENABLE_BASIC
    kwargs = {}
    # This will rename constant initializer names, disable it to make test pass.
    kwargs["disabled_optimizers"] = ["ConstantSharing"]
    _ = InferenceSession(model_path.as_posix(), sess_option, providers=["CPUExecutionProvider"], **kwargs)


def add_pre_process_metadata(model: ModelProto):
    """Tag the model that it went through quantization pre-processing"""
    metadata_props = {"onnx.quant.pre_process": "onnxruntime.quant"}
    if model.metadata_props:
        for prop in model.metadata_props:
            metadata_props.update({prop.key: prop.value})
    onnx.helper.set_model_props(model, metadata_props)


def model_has_pre_process_metadata(model: ModelProto) -> bool:
    """Check the model whether it went through quantization pre-processing"""
    if model.metadata_props:
        for prop in model.metadata_props:
            if prop.key == "onnx.quant.pre_process" and prop.value == "onnxruntime.quant":
                return True
    return False


def add_infer_metadata(model: ModelProto):
    metadata_props = {"onnx.infer": "onnxruntime.quant"}
    if model.metadata_props:
        for p in model.metadata_props:
            metadata_props.update({p.key: p.value})
    onnx.helper.set_model_props(model, metadata_props)


def model_has_infer_metadata(model: ModelProto) -> bool:
    if model.metadata_props:
        for p in model.metadata_props:
            if p.key == "onnx.infer" and p.value == "onnxruntime.quant":
                return True
    return False


def get_opset_version(model: ModelProto) -> int:
    ai_onnx_domain = [opset for opset in model.opset_import if not opset.domain or opset.domain == "ai.onnx"]
    if len(ai_onnx_domain) != 1:
        raise ValueError("Failed to find proper ai.onnx domain")
    opset_version = ai_onnx_domain[0].version

    return opset_version


def update_opset_version(model: ModelProto, weight_type: QuantType) -> ModelProto:
    opset_version = get_opset_version(model)
    target_opset_version = opset_version
    weight_quant_type = getattr(weight_type, "tensor_type", weight_type)

    if opset_version < 19 and weight_quant_type == onnx.TensorProto.FLOAT8E4M3FN:
        logging.warning(
            f"The original model opset version is {opset_version}, which does not support quantization to float 8. "
            "Please update the model to opset >= 19. Automatically update the model to opset 19. "
            "Please verify the quantized model."
        )
        target_opset_version = 19

    elif opset_version == 10:
        logging.warning(
            f"The original model opset version is {opset_version}, which does not support node fusions. "
            "Please update the model to opset >= 11 for better performance."
        )

    elif opset_version < 10:
        logging.warning(
            f"The original model opset version is {opset_version}, which does not support quantization. "
            "Please update the model to opset >= 11. Automatically update the model to opset 11. "
            "Please verify the quantized model."
        )
        target_opset_version = 11

    if target_opset_version != opset_version:
        model = onnx.version_converter.convert_version(model, target_opset_version)
        # Additional nodes may be added to the model during the opset version conversion. Run shape inference
        # to ensure all nodes are included in model.graph.value_info.
        model = save_and_reload_model_with_shape_infer(model)

    return model


def load_model_with_shape_infer(model_path: Path) -> ModelProto:
    inferred_model_path = generate_identified_filename(model_path, "-inferred")
    onnx.shape_inference.infer_shapes_path(str(model_path), str(inferred_model_path))
    model = onnx.load(inferred_model_path.as_posix())
    add_infer_metadata(model)
    inferred_model_path.unlink()
    return model


def save_and_reload_model_with_shape_infer(model: ModelProto) -> ModelProto:
    with tempfile.TemporaryDirectory(prefix="ort.quant.") as quant_tmp_dir:
        model_copy = copy.deepcopy(model)
        model_path = Path(quant_tmp_dir).joinpath("model.onnx")
        onnx.save_model(model_copy, model_path.as_posix(), save_as_external_data=True)
        return load_model_with_shape_infer(model_path)


def tensor_proto_to_array(initializer: TensorProto) -> numpy.ndarray:
    if initializer.data_type in (onnx_proto.TensorProto.FLOAT, onnx_proto.TensorProto.FLOAT16):
        return onnx.numpy_helper.to_array(initializer)

    raise ValueError(
        f"Only float type is supported. Weights {initializer.name} is {type_to_name[initializer.data_type]}"
    )


def add_quant_suffix(tensor_name: str) -> str:
    return tensor_name + "_QuantizeLinear"


def add_quant_input_suffix(tensor_name: str) -> str:
    return tensor_name + QUANT_INPUT_SUFFIX


def add_quant_output_suffix(tensor_name) -> str:
    return tensor_name + "_QuantizeLinear_Output"


def add_dequant_suffix(tensor_name) -> str:
    return tensor_name + "_DequantizeLinear"


def add_dequant_input_suffix(tensor_name) -> str:
    return tensor_name + "_DequantizeLinear_Input"


def add_dequant_output_suffix(tensor_name) -> str:
    return tensor_name + DEQUANT_OUTPUT_SUFFIX
