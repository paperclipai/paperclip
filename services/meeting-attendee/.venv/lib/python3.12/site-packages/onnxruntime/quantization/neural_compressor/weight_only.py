#
#  The implementation of this file is based on:
# https://github.com/intel/neural-compressor/tree/master/neural_compressor
#
# Copyright (c) 2023 Intel Corporation
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#    http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Modifications:
# Add k-quant quantization method.
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

"""WeightOnly for onnxrt adaptor."""

import copy
import logging
import os
import sys

import numpy as np
import onnx
from onnx import numpy_helper
from onnx.helper import np_dtype_to_tensor_dtype

import onnxruntime as ort

from .onnx_model import ONNXModel
from .util import simple_progress_bar

logger = logging.getLogger("neural_compressor")


def make_matmul_weight_only_node(
    node,
    weight_shape,
    num_bits,
    group_size,
    k_blocks,
    q_weight,
    scale,
    zero_point,
    accuracy_level=0,
):  # pragma: no cover
    """Build MatMulNBits node.

    Args:
        node: original matmul node
        weight_shape: original weight shape
        num_bits (int): num_bits
        group_size (int): how many elements share one scale/zp
        k_blocks (int): block number
        q_weight (array): quantized weight
        scale (array): scale
        zero_point (array): zero point
        accuracy_level (int): accuracy level. Support 0 (unset), 1(fp32), 2(fp16), 3(bf16), or 4(int8).

    Returns:
        matmul_weight_only_node: MatMulNBits node
        new_inits: initializers of the new node
    """
    blob_size = group_size * num_bits // 8
    packed = np.zeros((q_weight.shape[0], blob_size), dtype="uint8")
    q_weight_name = node.input[1] + f"_Q{num_bits!s}G{group_size!s}"
    input_names = [node.input[0], q_weight_name]
    new_inits = []
    kwargs = {}

    op_type = "MatMulNBits"

    # pack quantized weight
    if num_bits == 4:
        q_weight_pairs = q_weight[:, ::2] | q_weight[:, 1::2] << 4
        packed[:, :] = q_weight_pairs[:, :blob_size]
    elif num_bits == 8:
        packed = q_weight
    else:
        logger.error(f"MatMulNBits does not have kernel support for num_bits = {num_bits}.")

    packed = np.reshape(packed, (-1, k_blocks, blob_size))

    # build scale tensor
    scale = np.reshape(scale, (-1, k_blocks))
    assert scale.dtype == np.float32 or scale.dtype == np.float16
    scale_tensor = onnx.helper.make_tensor(
        name=node.input[1] + "_scale",
        data_type=np_dtype_to_tensor_dtype(scale.dtype),
        dims=scale.shape,
        vals=scale.tobytes(),
        raw=True,
    )
    input_names.append(scale_tensor.name)
    new_inits.append(scale_tensor)

    # build zero_point tensor
    if zero_point is not None:
        if num_bits == 8:
            packed_zp = zero_point.astype("uint8")
        elif num_bits == 4:
            # For 4-bit case, the default zeros is 0x8. So it is 0x88 = 136 if we fill lower/higher 4 bits with 0x8.
            packed_zp = np.full((zero_point.shape[0] + 1) // 2, 136, dtype="uint8")
            # create an index array
            idx = np.arange(zero_point.shape[0] // k_blocks * k_blocks).reshape(-1)
            # separate odd and even indices
            even_idx = idx[::2]
            odd_idx = idx[1::2]
            # vectorized operation for even and odd indices
            packed_zp[even_idx // 2] = (packed_zp[even_idx // 2] & 0xF0) | zero_point[even_idx].ravel()
            packed_zp[odd_idx // 2] = (packed_zp[odd_idx // 2] & 0x0F) | (zero_point[odd_idx].ravel() << 4)
        else:
            raise ValueError(f"MatMulNBits does not have kernel support for num_bits = {num_bits}.")

        packed_zp = np.reshape(packed_zp, (weight_shape[1], -1))
        zp_tensor = onnx.helper.make_tensor(
            name=node.input[1] + "_zp", data_type=2, dims=packed_zp.shape, vals=packed_zp.tobytes(), raw=True
        )
        input_names.append(zp_tensor.name)
        new_inits.append(zp_tensor)

    # set kwargs
    kwargs["K"] = weight_shape[0]
    kwargs["N"] = weight_shape[1]
    kwargs["bits"] = num_bits
    kwargs["block_size"] = group_size
    if accuracy_level > 0:
        # require onnxruntime > 1.16.3
        kwargs["accuracy_level"] = accuracy_level

    q_weight_tensor = onnx.helper.make_tensor(
        name=q_weight_name,
        data_type=2,
        dims=packed.shape,
        vals=packed.tobytes(),
        raw=True,
    )
    new_inits.append(q_weight_tensor)

    matmul_weight_only_node = onnx.helper.make_node(
        op_type,
        inputs=input_names,
        outputs=node.output,
        name=node.name + "_Q" + str(num_bits) if node.name else "_Q" + str(num_bits),
        domain="com.microsoft",
        **kwargs,
    )
    return matmul_weight_only_node, new_inits


def quant_tensor(data, num_bits=4, group_size=32, scheme="asym", dtype="int", ratio=1.0):
    """Quantize tensor per group.

    Args:
        data : input weight
        num_bits (int, optional): num_bits. Defaults to 4.
        group_size (int, optional): how many elements share one scale/zp. Defaults to 4.
        scheme (str, optional): quantization scheme. Defaults to "asym".
        dtype (str, optional): data type. Defaults to "int".
        ratio (float, optional): percentile of clip. Defaults to 1.0.

    Returns:
        output: quantized weight
        scale: scale
        zero_point: zero point
    """
    data = np.reshape(data, (-1, group_size))
    if scheme == "asym" or dtype == "uint":
        maxq = 2**num_bits - 1
        minq = 0
    elif scheme == "sym":
        maxq = 2 ** (num_bits - 1) - 1 if num_bits != 1 else 0
        minq = -(2 ** (num_bits - 1)) if num_bits != 1 else -1

    rmin = np.min(data, axis=1, keepdims=True) * ratio
    rmax = np.max(data, axis=1, keepdims=True) * ratio
    if scheme == "sym":
        max_range = np.maximum(np.abs(rmin), np.abs(rmax))
        scale = np.ones(rmax.shape)
        mask = max_range > 0
        scale[mask] = (max_range[mask] * 2.0).astype(np.float64) / (maxq - minq)
        zero_point = (
            np.zeros(scale.shape) if dtype == "int" else np.ones(rmax.shape, dtype="uint8") * (1 << (num_bits - 1))
        )
    else:
        scale = np.ones(rmax.shape)
        scale[rmin != rmax] = np.array(
            [float(i) / (maxq - minq) for i in (rmax - rmin)[rmin != rmax].flatten().tolist()]
        )
        zero_point = (
            ((np.zeros(scale.shape) - rmin) / scale).round()
            if dtype == "int"
            else np.maximum(0, np.minimum(maxq, ((np.zeros(scale.shape) - rmin) / scale).round())).astype("uint8")
        )

    q_weight = np.empty_like(data, dtype=scale.dtype)
    np.divide(data, scale, out=q_weight)
    np.add(q_weight, zero_point, out=q_weight)
    np.round(q_weight, out=q_weight)
    np.clip(q_weight, minq, maxq, out=q_weight)

    return q_weight, scale, zero_point


def quant_tensor_k_quant_cpu(data, num_bits=4, group_size=32):
    """Quantize tensor per group based on k quant.

    Ref: https://github.com/ggml-org/llama.cpp/blob/64eda5deb9859e87a020e56bab5d2f9ca956f1de/ggml/src/ggml-quants.c

    Args:
        data : input weight
        num_bits (int, optional): num_bits. Defaults to 4.
        group_size (int, optional): how many elements share one scale/zp. Defaults to 32.

    Returns:
        output: quantized weight
        scale: scale
        zero_point: zero point
    """
    data = np.reshape(data, (-1, group_size)).astype(np.float32)  # nb = data.shape[0], (nb, group_size)
    maxq = 2**num_bits - 1
    minq = 0
    sum_x2 = np.sum(data**2, axis=1, keepdims=True)  # (nb, 1)
    av_x = np.sqrt(sum_x2 / group_size)  # (nb, 1)
    weights = np.add(av_x, np.abs(data))  # (nb, group_size)
    rmin = np.min(data, axis=1, keepdims=True)  # (nb, 1)
    rmax = np.max(data, axis=1, keepdims=True)  # (nb, 1)
    sum_w = np.sum(weights, axis=1, keepdims=True)  # (nb, 1)
    sum_x = np.sum(weights * data, axis=1, keepdims=True)  # (nb, group_size)
    iscale = np.ones(rmax.shape, dtype=data.dtype)  # (nb, 1)
    mask = rmin != rmax
    iscale[mask] = (maxq - minq) / (rmax[mask] - rmin[mask])
    scale = 1 / iscale
    quant_data = np.clip(np.round(iscale * (data - rmin)), minq, maxq)  # (nb, group_size)
    diff = scale * quant_data + rmin - data  # (nb, group_size)
    best_mad = np.sum(weights * diff**2, axis=1, keepdims=True)  # (nb, 1)
    nstep = 20
    rdelta = 0.1
    # nstep * rdelta = -2 * rrmin, maxq - minq = 2**num_bits - 1
    rrmin = -1
    for is_ in range(nstep):
        iscale_new = np.ones(rmax.shape, dtype=data.dtype)  # (nb, 1)
        factor = np.array([rrmin + rdelta * is_ + maxq - minq]).astype(data.dtype)[0]
        mask = rmin != rmax
        iscale_new[mask] = factor / (rmax[mask] - rmin[mask])
        quant_data_new = np.clip(np.round(iscale_new * (data - rmin)), minq, maxq)  # (nb, group_size)
        mul_weights_quant_data_new = weights * quant_data_new
        sum_l = np.sum(mul_weights_quant_data_new, axis=1, keepdims=True)  # (nb, 1)
        sum_l2 = np.sum(mul_weights_quant_data_new * quant_data_new, axis=1, keepdims=True)  # (nb, 1)
        sum_xl = np.sum(mul_weights_quant_data_new * data, axis=1, keepdims=True)  # (nb, 1)
        D = np.subtract(sum_w * sum_l2, sum_l**2)  # noqa: N806

        this_scale = (sum_w * sum_xl - sum_x * sum_l) / D  # (nb, 1)
        this_min = (sum_l2 * sum_x - sum_l * sum_xl) / D  # (nb, 1)

        diff = this_scale * quant_data_new + this_min - data  # (nb, group_size)
        mad = np.sum(weights * diff**2, axis=1, keepdims=True)  # (nb, 1)

        mad_1 = np.array(mad)
        best_mad_1 = np.array(best_mad)
        idx_to_replace = np.where(mad_1 < best_mad_1)[0]
        quant_data[idx_to_replace, :] = quant_data_new[idx_to_replace, :]
        best_mad[idx_to_replace] = mad[idx_to_replace]
        scale[idx_to_replace] = this_scale[idx_to_replace]
        rmin[idx_to_replace] = this_min[idx_to_replace]

    zero_point = np.clip(((-rmin) / scale).round(), 0, maxq).astype("uint8")
    scale = scale.astype(np.float64)
    q_weight = np.empty_like(data, dtype=scale.dtype)
    np.divide(data, scale, out=q_weight)
    np.add(q_weight, zero_point, out=q_weight)
    np.round(q_weight, out=q_weight)
    np.clip(q_weight, minq, maxq, out=q_weight)

    return q_weight, scale, zero_point


def quant_tensor_k_quant_cuda(data, num_bits=4, group_size=32):
    """Quantize tensor per group based on k quant.

    Ref: https://github.com/ggml-org/llama.cpp/blob/64eda5deb9859e87a020e56bab5d2f9ca956f1de/ggml/src/ggml-quants.c

    Args:
        data : input weight
        num_bits (int, optional): num_bits. Defaults to 4.
        group_size (int, optional): how many elements share one scale/zp. Defaults to 4.

    Returns:
        output: quantized weight
        scale: scale
        zero_point: zero point
    """
    try:
        import cupy as cp  # noqa: PLC0415
        import torch  # noqa: PLC0415

        if torch.cuda.is_available():
            data = cp.asarray(data)
            data = data.reshape((-1, group_size)).astype(cp.float32)  # nb = data.shape[0], (nb, group_size)
            maxq = 2**num_bits - 1
            minq = 0
            sum_x2 = cp.sum(data**2, axis=1, keepdims=True)  # (nb, 1)
            av_x = cp.sqrt(sum_x2 / group_size)  # (nb, 1)
            weights = cp.add(av_x, cp.abs(data))  # (nb, group_size)
            rmin = cp.min(data, axis=1, keepdims=True)  # (nb, 1)
            rmax = cp.max(data, axis=1, keepdims=True)  # (nb, 1)
            sum_w = cp.sum(weights, axis=1, keepdims=True)  # (nb, 1)
            sum_x = cp.sum(weights * data, axis=1, keepdims=True)  # (nb, group_size)
            iscale = cp.ones(rmax.shape, dtype=data.dtype)  # (nb, 1)
            mask = rmin != rmax
            iscale[mask] = (maxq - minq) / (rmax[mask] - rmin[mask])
            scale = 1 / iscale
            quant_data = cp.clip(cp.round(iscale * (data - rmin)), minq, maxq)  # (nb, group_size)
            diff = scale * quant_data + rmin - data  # (nb, group_size)
            best_mad = cp.sum(weights * diff**2, axis=1, keepdims=True)  # (nb, 1)
            nstep = 20
            rdelta = 0.1
            rrmin = -1
            for is_ in range(nstep):
                iscale_new = cp.ones(rmax.shape, dtype=data.dtype)  # (nb, 1)
                factor = cp.array([rrmin + rdelta * is_ + maxq - minq]).astype(data.dtype)[0]
                mask = rmin != rmax
                iscale_new[mask] = factor / (rmax[mask] - rmin[mask])
                quant_data_new = cp.clip(cp.round(iscale_new * (data - rmin)), minq, maxq)  # (nb, group_size)
                mul_weights_quant_data_new = weights * quant_data_new
                sum_l = cp.sum(mul_weights_quant_data_new, axis=1, keepdims=True)  # (nb, 1)
                sum_l2 = cp.sum(mul_weights_quant_data_new * quant_data_new, axis=1, keepdims=True)  # (nb, 1)
                sum_xl = cp.sum(mul_weights_quant_data_new * data, axis=1, keepdims=True)  # (nb, 1)
                D = cp.subtract(sum_w * sum_l2, sum_l**2)  # noqa: N806

                this_scale = (sum_w * sum_xl - sum_x * sum_l) / D  # (nb, 1)
                this_min = (sum_l2 * sum_x - sum_l * sum_xl) / D  # (nb, 1)

                diff = this_scale * quant_data_new + this_min - data  # (nb, group_size)
                mad = cp.sum(weights * diff**2, axis=1, keepdims=True)  # (nb, 1)

                mad_1 = cp.array(mad)
                best_mad_1 = cp.array(best_mad)
                idx_to_replace = cp.where(mad_1 < best_mad_1)[0]
                quant_data[idx_to_replace, :] = quant_data_new[idx_to_replace, :]
                best_mad[idx_to_replace] = mad[idx_to_replace]
                scale[idx_to_replace] = this_scale[idx_to_replace]
                rmin[idx_to_replace] = this_min[idx_to_replace]

            zero_point = cp.clip(((-rmin) / scale).round(), 0, maxq).astype("uint8")
            scale = scale.astype(cp.float64)
            q_weight = cp.empty_like(data, dtype=scale.dtype)
            cp.divide(data, scale, out=q_weight)
            cp.add(q_weight, zero_point, out=q_weight)
            cp.round(q_weight, out=q_weight)
            cp.clip(q_weight, minq, maxq, out=q_weight)

            return q_weight.get(), scale.get(), zero_point.get()
        else:
            logger.warning(
                "Try to use k-quant quantization on CUDA. However, CUDA is not available."
                "Fall back to k-quant quantization on CPU."
            )
            return quant_tensor_k_quant_cpu(data, num_bits, group_size)
    except ImportError:
        logger.info(
            "Now we are using k-quant quantization on cpu, which is time consuming."
            "Please consider install cupy to speed up on CUDA. See https://cupy.dev/"
            "Please also install torch to check CUDA availability."
        )
        return quant_tensor_k_quant_cpu(data, num_bits, group_size)


def qdq_tensor(data, num_bits=4, group_size=32, scheme="asym", dtype="int", ratio=1.0):
    """Quant dequant tensor per group.

    Args:
        data : input weight
        num_bits (int, optional): num_bits. Defaults to 4.
        group_size (int, optional): how many elements share one scale/zp. Defaults to 4.
        scheme (str, optional): quantization scheme. Defaults to "asym".
        dtype (str, optional): data type. Defaults to "int".
        ratio (float, optional): percentile of clip. Defaults to 1.0.

    Returns:
        output: quant-dequant weight
    """
    org_shape = data.shape
    weight, scale, zp = quant_tensor(data, num_bits, group_size, scheme, dtype, ratio)
    return np.reshape(scale * (weight - zp), org_shape)


def pad_tensor(weight, group_size, k_blocks):
    """Pad tensor rowi so that it can be is divisible by group_size.

    Args:
        weight (array): weight
        group_size (int): how many elements share one scale/zp
        k_blocks (int): the number of block

    Returns:
        weight: paded weight
    """
    if group_size == -1:
        return weight

    org_w_shape = weight.shape
    padded_rows = k_blocks * group_size
    pad_len = padded_rows - org_w_shape[0]

    if pad_len > 0:
        weight = np.pad(weight, ((0, pad_len), (0, 0)), "constant")

    return weight


def rtn_quantize(
    model,
    weight_config={},  # noqa: B006
    num_bits=4,
    group_size=32,
    scheme="asym",
    ratios={},  # noqa: B006
    accuracy_level=0,
    providers=["CPUExecutionProvider"],  # noqa: B006
    algorithm="k_quant",
):
    """Quant the model with round to nearst method.

    Args:
        model (ModelProto or ONNXModel): onnx model
        weight_config (dict): quantization config
                For example,
                weight_config = {
                    'fc2':
                        {
                            'bits': 4,
                            'group_size': 32,
                            'scheme': 'sym',
                            'algorithm': 'RTN'
                        }
                }
        num_bits (int, optional): num_bits. Default is 4.
        group_size (int, optional): how many elements share one scale/zp. Default is 32.
        scheme (str, optional): sym or asym. Defaults to "asym".
        ratios (dict, optional): percentile of clip. Defaults to {}.
        accuracy_level (int): accuracy level. Support 0 (unset),1(fp32), 2(fp16), 3(bf16), or 4(int8).
        providers (list): providers to use

    Returns:
        model: fake quantized ONNXModel
    """
    model = ONNXModel(model)
    base_dir = os.path.dirname(model.model_path) if model.model_path is not None else ""
    new_nodes = []
    remove_nodes = []
    total_num = len([i for i in model.nodes() if i.op_type in ["MatMul"]])
    curr_id = 0
    for node in model.nodes():
        if node.op_type in ["MatMul"]:
            curr_id += 1
            simple_progress_bar(total_num, curr_id)
        if (
            node.op_type in ["MatMul"]
            and model.get_initializer(node.input[1]) is not None
            and weight_config.get(node.name, {}) != "fp32"
        ):
            weight_tensor = model.get_initializer(node.input[1])
            weight = numpy_helper.to_array(weight_tensor, base_dir=base_dir).copy()
            if len(weight.shape) != 2:
                continue

            dtype = weight.dtype

            if node.name in weight_config:
                num_bits = weight_config[node.name]["bits"]
                group_size = weight_config[node.name]["group_size"]
                scheme = weight_config[node.name]["scheme"]

            org_w_shape = weight.shape  # ic, oc
            group_size = group_size if group_size != -1 else org_w_shape[0]

            k_blocks = (org_w_shape[0] - 1) // group_size + 1
            init_share_num = model.get_initializer_share_num(node.input[1])

            weight = pad_tensor(weight, group_size, k_blocks)

            satisfy_MatMulNBits_condition = num_bits == 4 or num_bits == 8  # noqa: N806

            if satisfy_MatMulNBits_condition:  # pragma: no cover
                if algorithm == "k_quant":
                    q_weight, scale, zp = quant_tensor_k_quant_cuda(weight.T, num_bits, group_size)
                else:
                    q_weight, scale, zp = quant_tensor(
                        weight.T, num_bits, group_size, scheme, "uint", ratios.get(node.input[1], 1)
                    )

                q_matmul_node, new_inits = make_matmul_weight_only_node(
                    node=node,
                    weight_shape=org_w_shape,
                    num_bits=num_bits,
                    group_size=group_size,
                    k_blocks=k_blocks,
                    q_weight=q_weight.astype("uint8"),
                    scale=scale.astype(dtype),
                    zero_point=zp if scheme == "asym" or algorithm == "k_quant" else None,
                    accuracy_level=accuracy_level,
                )

                model.add_initializers(new_inits)
                remove_nodes.append(node)
                new_nodes.append(q_matmul_node)
            else:
                q_weight = qdq_tensor(weight.T, num_bits, group_size, scheme, "int", ratios.get(node.input[1], 1))
                q_weight = np.reshape(q_weight, (org_w_shape[1], -1))
                q_weight = np.transpose(q_weight)
                q_weight = q_weight[: org_w_shape[0], :].astype(dtype)
                q_weight_tensor = onnx.helper.make_tensor(
                    name=node.input[1] + f"_Q{num_bits!s}G{group_size!s}",
                    data_type=np_dtype_to_tensor_dtype(dtype),
                    dims=weight.shape,
                    vals=q_weight.tobytes(),
                    raw=True,
                )
                model.add_initializer(q_weight_tensor)
                node.input[1] = q_weight_tensor.name
            if init_share_num == 1:
                model.remove_initializer(weight_tensor)

    model.add_nodes(new_nodes)
    model.remove_nodes(remove_nodes)
    model.topological_sort()
    return model


def get_weight_scale(weight, group_size):
    """Get the scale of weight."""
    org_shape = weight.shape
    weight = np.reshape(weight, (-1, group_size)) if group_size != -1 else weight
    scale = np.mean(np.reshape(np.abs(weight) / np.max(np.abs(weight), axis=1, keepdims=True), org_shape), axis=0)
    return scale


def prepare_inputs(model, n_samples, dataloader, providers):
    """Prepare inputs for weight only quantization.

    Args:
        model (ModelProto or ONNXModel): onnx model
        n_samples (int, optional): calibration sample number. -1 means all samples.
        dataloader (object): dataloader for calibration.
        providers (list): providers to use

    Returns:
        inputs: prepared inputs.
        so: session options
    """
    from importlib.util import find_spec  # noqa: PLC0415

    from .util import to_numpy  # noqa: PLC0415

    so = ort.SessionOptions()
    if sys.version_info < (3, 11) and find_spec("onnxruntime_extensions"):  # pragma: no cover
        from onnxruntime_extensions import get_library_path  # noqa: PLC0415

        so.register_custom_ops_library(get_library_path())
    if model.is_large_model:
        onnx.save_model(
            model.model,
            model.model_path + "_augment.onnx",
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            convert_attribute=False,
        )

    session = (
        ort.InferenceSession(model.model.SerializeToString(), so, providers=providers)
        if not model.is_large_model
        else ort.InferenceSession(model.model_path + "_augment.onnx", so, providers=providers)
    )
    inputs_names = [i.name for i in session.get_inputs()]
    del session

    inputs = []
    for i, data in enumerate(dataloader):
        if n_samples != -1 and ((i + 1) * dataloader.batch_size) > n_samples:
            break
        if len(inputs_names) != 1 or isinstance(data[0], dict):
            assert len(data[0]) == len(inputs_names), (
                f"Input number mismatch, require {len(inputs_names)} but get {len(data[0])}"
            )

        if isinstance(data[0], dict):
            inputs.append(dict([(name, to_numpy(inp_data)) for name, inp_data in data[0].items()]))  # noqa: C404
        elif isinstance(data[0], np.ndarray):  # pragma: no cover
            inputs.append(dict([(name, inp) for name, inp in zip(inputs_names, [data[0]], strict=False)]))  # noqa: C404
        else:  # pragma: no cover
            inputs.append(dict([(name, to_numpy(inp)) for name, inp in zip(inputs_names, data[0], strict=False)]))  # noqa: C404
    return inputs, so


def gptq(
    W,
    H,
    num_bits=4,
    group_size=32,
    scheme="asym",
    blocksize=128,
    percdamp=0.01,
    actorder=False,
    mse=False,
    perchannel=True,
):
    """Quant the weight with GPTQ method.

    Args:
        W (array): weight.
        H (array): Hessian matrix.
        num_bits (int, optional): num_bits. Default is 4.
        group_size (int, optional): how many elements share one scale/zp. Default is 32.
        scheme (str, optional): sym or asym. Defaults to "asym".
        blocksize (int, optional): blocksize to quantize weight.
        percdamp (float, optional): percent of the average Hessian diagonal to use for dampening.
        actorder (bool, optional): whether rearrange Hessian matrix considering the diag's value.
        mse (bool, optional): whether get scale and zero point with mse error.
        perchannel (bool, optional): whether quantize weight per-channel.

    Returns:
        Q: fake quantized weight
    """
    maxq = 2**num_bits - 1
    grid = 100
    maxshrink = 0.8
    norm = 2.4

    def find_params(weight):
        org_shape = weight.shape
        # find zp, scale
        if not perchannel:
            weight = np.expand_dims(weight.flatten(), axis=1)
        tmp = np.zeros(weight.shape[1])
        xmin = np.minimum(np.min(weight, axis=0), tmp)
        xmax = np.maximum(np.max(weight, axis=0), tmp)
        if scheme == "sym":
            xmax = np.maximum(np.abs(xmin), xmax)
            tmp = xmin < 0
            if np.any(tmp):
                xmin[tmp] = -xmax[tmp]
        tmp = (xmin == 0) & (xmax == 0)
        xmin[tmp] = -1
        xmax[tmp] = +1

        scale = (xmax - xmin) / maxq
        if scheme == "sym":
            zero = np.ones(scale.shape) * (maxq + 1) / 2
        else:
            zero = np.round(-xmin / scale)
        if mse:
            best = np.ones([weight.shape[1]]) * float("inf")
            for i in range(int(maxshrink * grid)):
                p = 1 - i / grid
                xmin1 = p * xmin
                xmax1 = p * xmax
                scale1 = (xmax1 - xmin1) / maxq
                zero1 = np.round(-xmin1 / scale1) if scheme != "sym" else zero
                q = np.clip(np.round(weight / scale1) + zero1, 0, maxq)
                q -= weight
                q = np.power(np.abs(q), norm)
                err = np.sum(q, 0)
                tmp = err < best
                if np.any(tmp):
                    best[tmp] = err[tmp]
                    scale[tmp] = scale1[tmp]
                    zero[tmp] = zero1[tmp]
        if not perchannel:
            tmp = org_shape[1]
            scale = np.repeat(scale, tmp)
            zero = np.repeat(zero, tmp)
        shape = [-1] + [1] * (len(org_shape) - 1)
        scale = np.reshape(scale, shape)
        zero = np.reshape(zero, shape)
        return scale, zero

    shape = W.shape
    scale, zp = find_params(W)
    dead = np.diag(H) == 0
    H[dead, dead] = 1
    W[dead, :] = 0  # such channel makes no contribution to quantization computation

    # rearrange considering the diag's value
    if actorder:
        perm = np.argsort(np.diag(H))[::-1]
        W = W[perm, :]  # noqa: N806
        H = H[perm, :][:, perm]  # noqa: N806
    Losses = np.zeros_like(W)  # noqa: N806
    Q = np.zeros_like(W)  # noqa: N806
    damp = percdamp * np.mean(np.diag(H))
    diag = np.arange(shape[0])
    H[diag, diag] += damp  # add a average value of
    H = np.linalg.cholesky(np.linalg.inv(H)).T  # noqa: N806
    Hinv = H  # noqa: N806
    for i1 in range(0, shape[0], blocksize):
        i2 = min(i1 + blocksize, shape[0])
        count = i2 - i1

        W1 = copy.deepcopy(W[i1:i2, :])  # noqa: N806
        Q1 = np.zeros_like(W1)  # noqa: N806
        Err1 = np.zeros_like(W1)  # noqa: N806
        Losses1 = np.zeros_like(W1)  # noqa: N806
        Hinv1 = Hinv[i1:i2, i1:i2]  # noqa: N806

        for i in range(count):  # within a block, channel wise
            w = W1[i, :]
            d = Hinv1[i, i]

            if group_size != -1:
                if (i1 + i) % group_size == 0:
                    scale, zp = find_params(W[(i1 + i) : (i1 + i + group_size), :])

            q = (scale * (np.clip(np.round(w[:, np.newaxis] / scale) + zp, 0, maxq) - zp)).flatten()
            Q1[i, :] = q
            Losses1[i, :] = (w - q) ** 2 / d**2

            err1 = (w - q) / d
            W1[i:, :] -= np.matmul(np.expand_dims(Hinv1[i:, i], axis=1), np.expand_dims(err1, axis=0))
            Err1[i, :] = err1

        Q[i1:i2, :] = Q1
        Losses[i1:i2, :] = Losses1 / 2

        W[i2:, :] -= np.matmul(Hinv[i2:, i1:i2], Err1)

    if actorder:
        invperm = np.argsort(perm)
        Q = Q[invperm, :]  # noqa: N806

    Q = np.reshape(Q, W.shape)  # noqa: N806
    del W
    return Q


def gptq_quantize(
    model,
    dataloader,
    weight_config={},  # noqa: B006
    num_bits=4,
    group_size=32,
    scheme="asym",
    n_samples=128,
    percdamp=0.01,
    blocksize=128,
    actorder=False,
    mse=False,
    perchannel=True,
    accuracy_level=0,
    providers=["CPUExecutionProvider"],  # noqa: B006
):
    """Quant the model with GPTQ method.

    Args:
        model (ModelProto or ONNXModel): onnx model
        dataloader (object): dataloader for calibration.
        weight_config (dict): quantization config
                For example,
                weight_config = {
                    'fc2':
                        {
                            'bits': 4,
                            'group_size': 32,
                            'scheme': 'sym',
                            'algorithm': 'GPTQ'
                        }
                }
        num_bits (int, optional): num_bits. Default is 4.
        group_size (int, optional): how many elements share one scale/zp. Default is 32.
        scheme (str, optional): sym or asym. Defaults to "asym".
        n_samples (int, optional): calibration sample number.
        percdamp (float, optional): percent of the average Hessian diagonal to use for dampening.
        blocksize (int, optional): blocksize to quantize weight.
        actorder (bool, optional): whether rearrange Hessian matrix considering the diag's value.
        mse (bool, optional): whether get scale and zero point with mse error.
        perchannel (bool, optional): whether quantize weight per-channel.
        accuracy_level (int): accuracy level. Support 0 (unset), 1(fp32), 2(fp16), 3(bf16), or 4(int8).
        providers (list): providers to use

    Returns:
        model: fake quantized ONNXModel
    """
    model = ONNXModel(model)
    base_dir = os.path.dirname(model.model_path) if model.model_path is not None else ""

    inputs, so = prepare_inputs(model, n_samples, dataloader, providers)
    del dataloader
    org_output = copy.deepcopy(model.model.graph.output)
    model.remove_tensors_from_outputs([i.name for i in org_output])
    output_names = []
    for node in model.nodes():
        if (
            node.op_type in ["MatMul"]
            and weight_config.get(node.name, {}) != "fp32"
            and weight_config.get(node.name, {}).get("algorithm", "GPTQ") == "GPTQ"
        ):
            output_names.append(node.input[0])
    output_names = list(set(output_names))
    model.add_tensors_to_outputs(output_names)
    if model.is_large_model:
        onnx.save_model(
            model.model,
            model.model_path + "_augment.onnx",
            save_as_external_data=True,
            all_tensors_to_one_file=True,
            convert_attribute=False,
        )

    session = (
        ort.InferenceSession(model.model.SerializeToString(), so, providers=providers)
        if not model.is_large_model
        else ort.InferenceSession(model.model_path + "_augment.onnx", so, providers=providers)
    )

    for idx, input_name in enumerate(output_names):
        simple_progress_bar(len(output_names), idx + 1)
        node_list = []
        weights = []

        for node in model.input_name_to_nodes[input_name]:
            if (
                node.op_type in ["MatMul"]
                and weight_config.get(node.name, {}) != "fp32"
                and weight_config.get(node.name, {}).get("algorithm", "GPTQ") == "GPTQ"
                and model.get_initializer(node.input[1]) is not None
            ):
                weight = numpy_helper.to_array(
                    model.get_initializer(model.get_node(node.name).input[1]), base_dir
                ).copy()
                if len(weight.shape) != 2:
                    continue

                weights.append(weight)
                node_list.append(model.get_node(node.name))

        if len(weights) == 0:
            continue

        Hs = [np.zeros((i.shape[0], i.shape[0])) for i in weights]  # noqa: N806
        nsamples = 0
        for data in inputs:
            inp = session.run([input_name], data)[0]
            tmp = inp.shape[0]
            inp = np.reshape(inp, (-1, inp.shape[-1]))
            Hs = [i * (nsamples / (nsamples + tmp)) for i in Hs]  # noqa: N806
            nsamples += tmp
            inp = np.sqrt(2 / nsamples) * inp
            Hs = [i + np.matmul(inp.T, inp) for i in Hs]  # noqa: N806

        for (
            node,
            weight,
            H,  # noqa: N806
        ) in zip(node_list, weights, Hs, strict=False):
            if node.name in weight_config:
                num_bits = weight_config[node.name]["bits"]
                group_size = weight_config[node.name]["group_size"]
                scheme = weight_config[node.name]["scheme"]
            group_size = group_size if group_size != -1 else weight.shape[0]
            dtype = weight.dtype

            q_weight = gptq(
                weight,
                H,
                num_bits=num_bits,
                group_size=group_size,
                scheme=scheme,
                blocksize=blocksize,
                percdamp=percdamp,
                actorder=actorder,
                mse=mse,
                perchannel=perchannel,
            )

            weight_tensor = model.get_initializer(node.input[1])
            init_share_num = model.get_initializer_share_num(node.input[1])

            satisfy_MatMulNBits_condition = num_bits == 4  # noqa: N806

            if satisfy_MatMulNBits_condition:  # pragma: no cover
                org_shape = weight.shape
                k_blocks = (org_shape[0] + group_size - 1) // group_size
                q_weight = pad_tensor(q_weight, group_size, k_blocks)
                q_weight, scale, zp = quant_tensor(q_weight.T, num_bits, group_size, scheme, "uint")
                q_matmul_node, new_inits = make_matmul_weight_only_node(
                    node=node,
                    weight_shape=org_shape,
                    num_bits=num_bits,
                    group_size=group_size,
                    k_blocks=k_blocks,
                    q_weight=q_weight.astype("uint8"),
                    scale=scale.astype(dtype),
                    zero_point=zp if scheme == "asym" else None,
                    accuracy_level=accuracy_level,
                )

                model.add_initializers(new_inits)
                model.remove_node(node)
                model.add_node(q_matmul_node)
            else:
                q_weight_tensor = onnx.helper.make_tensor(
                    name=node.input[1] + f"_Q{num_bits!s}G{group_size!s}",
                    data_type=np_dtype_to_tensor_dtype(dtype),
                    dims=q_weight.shape,
                    vals=q_weight.astype(dtype).tobytes(),
                    raw=True,
                )
                model.add_initializer(q_weight_tensor)
                node.input[1] = q_weight_tensor.name
            if init_share_num == 1:
                model.remove_initializer(weight_tensor)

    model.remove_tensors_from_outputs(output_names)
    model.model.graph.output.MergeFrom(org_output)

    model.topological_sort()

    # reload external data to prevent external data file path errors
    if model.is_large_model:
        from onnx.external_data_helper import load_external_data_for_model  # noqa: PLC0415

        load_external_data_for_model(model.model, os.path.split(model.model_path)[0])

    return model
