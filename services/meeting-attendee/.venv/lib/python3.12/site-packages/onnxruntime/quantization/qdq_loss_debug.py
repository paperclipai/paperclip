# --------------------------------------------------------------------------
# Copyright (c) Microsoft, Intel Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

"""Utilities to run a given ONNX model, while saving input/output tensors of
eligible operator nodes.

A use case is to debug quantization induced accuracy drop. An AI engineer can
run the original float32 model and the quantized model with the same inputs,
then compare the corresponding activations between the two models to find
where the divergence is.

Example Usage:

```python
    class ExampleDataReader(CalibrationDataReader):
        def __init__(self):
            ...
        def get_next(self):
            ...

    input_data_reader = ExampleDataReader()

    augmented_model_path = str(Path(self._tmp_model_dir.name).joinpath("augmented_model.onnx"))
    modify_model_output_intermediate_tensors (path_to_onnx_model, augmented_model_path)

    tensor_dict = collect_activations(augmented_model_path, input_data_reader)
```

`tensor_dict` points to a dictionary where the keys are tensor names and each value
is a list of tensors, one from each model run

"""

import logging
import math
import time
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy
import onnx
from onnx import helper, numpy_helper

import onnxruntime

from .calibrate import CalibraterBase, CalibrationDataReader
from .onnx_model import ONNXModel
from .quant_utils import (
    DEQUANT_OP_NAME,
    DEQUANT_OUTPUT_SUFFIX,
    QUANT_INPUT_SUFFIX,
    TENSOR_NAME_QUANT_SUFFIX,
    find_by_name,
    load_model_with_shape_infer,
)

_TENSOR_SAVE_POSTFIX = "_ReshapedSavedOutput"
_TENSOR_SAVE_POSTFIX_LEN = len(_TENSOR_SAVE_POSTFIX)


def modify_model_output_intermediate_tensors(
    input_model_path: str | Path,
    output_model_path: str | Path,
    op_types_for_saving: Sequence[str] | None = None,
    save_as_external_data: bool = False,
) -> None:
    """Augment a given ONNX model to save node input/output tensors.

    Add all input/output tensors of operator nodes to model outputs
    so that their values can be retrieved for debugging purposes.

    Args:
        input_model: the path to load the model.
        op_types_for_saving: Operator types for which the
                input/output should be saved. By default, saving all the
                float32/float16 tensors.

    Returns:
        The augmented ONNX model
    """

    if op_types_for_saving is None:
        op_types_for_saving = []
    saver = CalibraterBase(input_model_path, op_types_to_calibrate=op_types_for_saving)
    model_to_augment = saver.model
    tensors, value_infos = saver.select_tensors_to_calibrate(model_to_augment)
    reshape_shape_name = "LinearReshape_" + str(time.time())
    reshape_shape = numpy_helper.from_array(numpy.array([-1], dtype=numpy.int64), reshape_shape_name)
    model_to_augment.graph.initializer.append(reshape_shape)

    for tensor_name in tensors:
        reshape_output = tensor_name + _TENSOR_SAVE_POSTFIX
        reshape_node = onnx.helper.make_node(
            "Reshape",
            inputs=[tensor_name, reshape_shape_name],
            outputs=[reshape_output],
            name=reshape_output,
        )
        model_to_augment.graph.node.append(reshape_node)
        reshape_output_value_info = helper.make_tensor_value_info(
            reshape_output, value_infos[tensor_name].type.tensor_type.elem_type, [-1]
        )
        model_to_augment.graph.output.append(reshape_output_value_info)

    onnx.save(
        model_to_augment,
        output_model_path,
        save_as_external_data=save_as_external_data,
    )


def collect_activations(
    augmented_model: str,
    input_reader: CalibrationDataReader,
    session_options=None,
    execution_providers: Sequence[str] | None = None,
) -> dict[str, list[numpy.ndarray]]:
    """Run augmented model and collect activations tensors.

    Args:
        augmented_model: Path to augmented model created by modify_model_output_intermediate_tensors ()
        input_reader: Logic for reading input for the model, augmented model have the same
            input with the original model.
        session_options: Optional OnnxRuntime session options for controlling model run.
            By default graph optimization is turned off
        execution_providers: Collection of execution providers for running the model.
            Only CPU EP is used by default.

    Returns:
        A dictionary where the key is tensor name and values are list of tensors from each batch
    """

    if session_options is None:
        session_options = onnxruntime.SessionOptions()
        session_options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_DISABLE_ALL
    if execution_providers is None:
        execution_providers = ["CPUExecutionProvider"]

    inference_session = onnxruntime.InferenceSession(
        augmented_model,
        sess_options=session_options,
        providers=execution_providers,
    )

    intermediate_outputs = []
    for input_d in input_reader:
        intermediate_outputs.append(inference_session.run(None, input_d))
    if not intermediate_outputs:
        raise RuntimeError("No data is collected while running augmented model!")

    output_dict = {}
    output_info = inference_session.get_outputs()
    for batch in intermediate_outputs:
        for output, output_data in zip(output_info, batch, strict=False):
            if output.name.endswith(_TENSOR_SAVE_POSTFIX):
                output_name = output.name[:-_TENSOR_SAVE_POSTFIX_LEN]
                output_dict.setdefault(output_name, []).append(output_data)

    return output_dict


_POST_QDQ_POSTFIX1 = DEQUANT_OUTPUT_SUFFIX + "_1"


def _add_pre_post_qdq_pair(
    qdq_cmp: dict[str, dict[str, Sequence[numpy.ndarray]]],
    activation_name: str,
    pre_qdq_tensors: Sequence[numpy.ndarray] | None,
    post_qdq_tensors: Sequence[numpy.ndarray] | None,
) -> None:
    if post_qdq_tensors is not None and pre_qdq_tensors is not None:
        qdq_cmp[activation_name] = {}
        qdq_cmp[activation_name]["pre_qdq"] = pre_qdq_tensors
        qdq_cmp[activation_name]["post_qdq"] = post_qdq_tensors


def create_activation_matching(
    qdq_activations: dict[str, Sequence[numpy.ndarray]],
    float_activations: dict[str, Sequence[numpy.ndarray]] | None = None,
) -> dict[str, dict[str, Sequence[numpy.ndarray]]]:
    """Comparing activation values to help debugging accuracy loss due to quantization.

    This functions takes saved activations from the QDQ model and (optionally) the
    float point model, and provides a data structure for comparing:
        * from the qdq model, activation values before and after QDQ operation
        * across both models, activations from the orignal model vs the corresponding
          activations in the QDQ model

    Arg:
        qdq_activations: Output of `collect_activations`. This must be from a quantized
            model with QDQ format.
        float_activations: Output of `collect_activations`. This must be from the float
            point model.

    Returns:
        Dict for comparing pre and post quantized activation tensors. E.g.
        ```
        qdq_cmp = cmp_qdq_input_output(qdq_activations)
        print(qdq_cmp['activation1']['pre_qdq'][0])
        print(qdq_cmp['activation1'][`post_qdq'][0])


        qdq_cmp = cmp_qdq_input_output(qdq_activations, float_activations)
        print(qdq_cmp['activation1']['float'][0])
        print(qdq_cmp['activation1']['pre_qdq'][0])
        print(qdq_cmp['activation1'][`post_qdq'][0])
        ```
    """

    qdq_cmp: dict[str, dict[str, Sequence[numpy.ndarray]]] = {}
    for tensor_name, tensors in qdq_activations.items():
        if tensor_name.endswith(QUANT_INPUT_SUFFIX):
            pre_name = tensor_name[: -len(QUANT_INPUT_SUFFIX)]
            post_qdq_tensors = qdq_activations.get(pre_name)
            pre_qdq_tensors = tensors
            _add_pre_post_qdq_pair(qdq_cmp, pre_name, pre_qdq_tensors, post_qdq_tensors)
        elif tensor_name.endswith(DEQUANT_OUTPUT_SUFFIX):
            pre_name = tensor_name[: -len(DEQUANT_OUTPUT_SUFFIX)]
            pre_qdq_tensors = qdq_activations.get(pre_name)
            post_qdq_tensors = tensors
            _add_pre_post_qdq_pair(qdq_cmp, pre_name, pre_qdq_tensors, post_qdq_tensors)
        elif tensor_name.endswith(_POST_QDQ_POSTFIX1):
            pre_name = tensor_name[: -len(_POST_QDQ_POSTFIX1)]
            pre_qdq_tensors = qdq_activations.get(pre_name)
            post_qdq_tensors = tensors
            _add_pre_post_qdq_pair(qdq_cmp, pre_name, pre_qdq_tensors, post_qdq_tensors)

    if not float_activations:
        return qdq_cmp

    for act_name, act_values in qdq_cmp.items():
        float_acts = float_activations.get(act_name)
        if float_acts is not None:
            act_values["float"] = float_acts

    return qdq_cmp


def _run_dequantize_linear(
    weight_tensor: numpy.ndarray, weight_scale: numpy.ndarray, weight_zp: numpy.ndarray, channel_axis: int
) -> numpy.ndarray | None:
    assert weight_scale.shape == weight_zp.shape
    if weight_zp.size == 1:
        return (weight_tensor - weight_zp) * weight_scale

    assert weight_zp.ndim == 1
    reshape_dims = list(weight_tensor.shape)  # deep copy
    reshape_dims[channel_axis] = 1  # only one per channel for reshape
    channel_count = weight_tensor.shape[channel_axis]
    dequantized_weights = None
    for i in range(channel_count):
        per_channel_data = weight_tensor.take(i, channel_axis)
        dequantized_per_channel_data = (per_channel_data - weight_zp[i]) * weight_scale[i]
        if i == 0:
            dequantized_weights = numpy.asarray(dequantized_per_channel_data).reshape(reshape_dims)
        else:
            channel_weights = numpy.asarray(dequantized_per_channel_data).reshape(reshape_dims)
            dequantized_weights = numpy.concatenate((dequantized_weights, channel_weights), channel_axis)

    if dequantized_weights is None:
        return None

    dequantized_weights.reshape(weight_tensor.shape)
    return dequantized_weights


def create_weight_matching(float_model_path: str, qdq_model_path: str) -> dict[str, dict[str, numpy.ndarray]]:
    """Comparing weight values to help debugging accuracy loss due to quantization.

    This functions takes the float model and the qdq model, and provides a data structure for comparing
    their corresponding weights to locate quantization errors

    Arg:
        float_model_path: Path points to the float point model.
        qdq_model_path: Path points to the qdq model.

    Returns:
        Dict for comparing weight tensors. E.g.
        ```
        qdq_weight_cmp = create_weight_matching(float_model, qdq_model)
        print(qdq_weight_cmp['activation1']['float'])
        print(qdq_weight_cmp['activation1']['dequantized'])
        ```
    """
    float_onnx_model = ONNXModel(load_model_with_shape_infer(Path(float_model_path)))
    qdq_onnx_model = ONNXModel(load_model_with_shape_infer(Path(qdq_model_path)))

    matched_weights: dict[str, dict[str, numpy.ndarray]] = {}
    initializers = qdq_onnx_model.initializer()
    for node in qdq_onnx_model.nodes():
        if node.op_type != DEQUANT_OP_NAME:
            continue  # Only care about DQ node
        weight_name: str = node.input[0]
        weight_values = find_by_name(weight_name, initializers)
        if not weight_values:
            continue  # Only care about DQ node with const inputs
        if not weight_name.endswith(TENSOR_NAME_QUANT_SUFFIX):
            logging.error(f"Model Error in '{qdq_model_path}': Dequantized tensor name '{weight_name}' not recognized!")
            continue

        axis = -1
        for attr in node.attribute:
            if attr.name == "axis":
                axis = attr.i

        weight_tensor = numpy_helper.to_array(weight_values)
        weight_scale = numpy_helper.to_array(find_by_name(node.input[1], initializers))
        if len(node.input) > 2:
            weight_zp = numpy_helper.to_array(find_by_name(node.input[2], initializers))
        else:
            weight_zp = numpy.zeros(weight_scale.shape, dtype=numpy.int32)

        # Perform dequantization:
        if weight_scale.size == weight_zp.size == 1:
            # Avoids the confusion between a scaler and a tensor of one element.
            weight_scale = weight_scale.reshape(())
            weight_zp = weight_zp.reshape(())
        if weight_scale.shape != weight_zp.shape:
            raise RuntimeError(
                f"scale and zero_point must have the same shape but {weight_scale.shape} != {weight_zp.shape}"
            )
        weight_quant = _run_dequantize_linear(weight_tensor, weight_scale, weight_zp, channel_axis=axis)
        weight_name = weight_name[: -len(TENSOR_NAME_QUANT_SUFFIX)]
        if weight_quant is None:
            logging.error(f"Model Error in '{qdq_model_path}': '{weight_name}' per-channel quantization on 0 channel")
            continue

        float_values = find_by_name(weight_name, float_onnx_model.initializer())
        if not float_values:
            logging.error(f"Model Error in '{float_model_path}': weight tensor '{weight_name}' not found!")
            continue
        weight_float = numpy_helper.to_array(float_values)
        matched_weights[weight_name] = {"float": weight_float, "dequantized": weight_quant}

    return matched_weights


def compute_signal_to_quantization_noice_ratio(
    x: Sequence[numpy.ndarray] | numpy.ndarray, y: Sequence[numpy.ndarray] | numpy.ndarray
) -> float:
    if isinstance(x, numpy.ndarray):
        xlist = [x]
    else:
        xlist = x
    if isinstance(y, numpy.ndarray):
        ylist = [y]
    else:
        ylist = y
    if len(xlist) != len(ylist):
        raise RuntimeError("Unequal number of tensors to compare!")

    left = numpy.concatenate(xlist).flatten()
    right = numpy.concatenate(ylist).flatten()

    epsilon = numpy.finfo("float").eps
    tensor_norm = max(numpy.linalg.norm(left), epsilon)
    diff_norm = max(numpy.linalg.norm(left - right), epsilon)
    res = tensor_norm / diff_norm
    return 20 * math.log10(res)


def compute_weight_error(
    weights_match: dict[str, dict[str, numpy.ndarray]],
    err_func: Callable[[numpy.ndarray, numpy.ndarray], float] = compute_signal_to_quantization_noice_ratio,
) -> dict[str, float]:
    result: dict[str, float] = {}
    for weight_name, weight_match in weights_match.items():
        result[weight_name] = err_func(weight_match["float"], weight_match["dequantized"])
    return result


def compute_activation_error(
    activations_match: dict[str, dict[str, Sequence[numpy.ndarray]]],
    err_func: Callable[
        [Sequence[numpy.ndarray], Sequence[numpy.ndarray]], float
    ] = compute_signal_to_quantization_noice_ratio,
) -> dict[str, dict[str, float]]:
    result: dict[str, dict[str, float]] = {}
    for name, match in activations_match.items():
        err_result: dict[str, float] = {}
        err_result["qdq_err"] = err_func(match["pre_qdq"], match["post_qdq"])
        float_activation = match["float"]
        if float_activation:
            err_result["xmodel_err"] = err_func(float_activation, match["post_qdq"])
        result[name] = err_result
    return result
