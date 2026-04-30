# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import copy
import logging
from pathlib import Path
from typing import Any

import numpy as np
import onnx

from ...calibrate import CalibrationDataReader, CalibrationMethod
from ...quant_utils import QuantType
from ...quantize import StaticQuantConfig
from ...tensor_quant_overrides import TensorQuantOverridesHelper
from .mixed_precision_overrides_utils import MixedPrecisionTensorQuantOverridesFixer

Q16_TYPES = {QuantType.QInt16, QuantType.QUInt16}
Q8_TYPES = {QuantType.QInt8, QuantType.QUInt8}
Q4_TYPES = {QuantType.QInt4, QuantType.QUInt4}
OP_TYPES_TO_EXCLUDE = {"Cast"}
MODEL_SIZE_THRESHOLD = 2147483648  # Quant model should use external data if >= 2GB


def warn_unable_to_override(
    node: onnx.NodeProto,
    what_str: str,
    tensor_name: str,
    io_kind: str,
):
    logging.warning(
        f"Unable to override {what_str} for {node.op_type} node's {io_kind} "
        "because it has already been overridden! Check the initial quantization overrides provided "
        "to get_qnn_qdq_config() if the generated QDQ model does not run on QNN EP. "
        f"Node name: {node.name}, {io_kind} name: {tensor_name}"
    )


def get_qnn_qdq_config(
    model_input: str | Path | onnx.ModelProto,
    calibration_data_reader: CalibrationDataReader,
    calibrate_method: CalibrationMethod = CalibrationMethod.MinMax,
    activation_type: QuantType = QuantType.QUInt8,
    weight_type: QuantType = QuantType.QUInt8,
    per_channel: bool = False,
    init_overrides: dict[str, list[dict[str, Any]]] | None = None,
    add_qtype_converts: bool = True,
    activation_symmetric: bool = False,
    weight_symmetric: bool | None = None,
    keep_removable_activations: bool = False,
    stride: int | None = None,
    calibration_providers: list[str] | None = None,
    op_types_to_quantize: list[str] | None = None,
    nodes_to_exclude: list[str] | None = None,
) -> StaticQuantConfig:
    """
    Returns a static quantization configuration suitable for running QDQ models on QNN EP.
    This is done primarily by setting tensor-level quantization overrides.

    Params:
        model_input: Path to the input model file or ModelProto.
        calibration_data_reader: Calibration data reader.
        calibrate_methode: The calibration method. Defaults to MinMax.
        activation_type: The default activation quantization type. Defaults to QUInt8.
        weight_type: The default weight quantization type. Defaults to QUInt8.
        per_channel: Global option that determines if a fixed set of operator types should be quantized per-channel.
            Defaults to false. Alternatively, use the tensor-level `init_overrides` to select individual operators
            and their quantization axes.

            If set, the quantization tool uses per-channel quantization for the following operator types and inputs:
                - Conv:
                    - input[1] on axis 0
                    - input[2] (bias) on axis 0
                - ConvTranspose:
                    - input[1] on axis 1
                    - input[2] (bias) on axis 0
        init_overrides: Initial tensor-level quantization overrides. Defaults to None. This function updates of a copy
            of these overrides with any necessary adjustments and includes them in the returned
            configuration object (i.e., config.extra_options['TensorQuantOverrides']).

            The key is a tensor name and the value is a list of dictionaries. For per-tensor quantization, the list
            contains a single dictionary. For per-channel quantization, the list contains either a dictionary for
            each channel in the tensor or a single dictionary that is assumed to apply to all channels. An 'axis'
            key must be present in the first dictionary for per-channel quantization.

            Each dictionary contains optional overrides with the following keys and values.
                'quant_type' = QuantType : The tensor's quantization data type.
                'axis' = Int             : The per-channel axis. Must be present for per-channel weights.
                'scale' =  Float         : The scale value to use. Must also specify `zero_point` if set.
                'zero_point' = Int       : The zero-point value to use. Must also specify `scale` is set.
                'symmetric' = Bool       : If the tensor should use symmetric quantization. Invalid if also
                                            set `scale` or `zero_point`.
                'reduce_range' = Bool    : If the quantization range should be reduced. Invalid if also
                                            set `scale` or `zero_point`. Only valid for initializers.
                'rmax' = Float           : Override the maximum real tensor value in calibration data.
                                            Invalid if also set `scale` or `zero_point`.
                'rmin' = Float           : Override the minimum real tensor value in calibration data.
                                            Invalid if also set `scale` or `zero_point`.
                'convert' = Dict         : A nested dictionary with the same keys for an activation
                                           tensor that should be converted to another quantization type.
                'convert["recv_nodes"] = Set : Set of node names that consume the converted activation,
                                               other nodes get the original type. If not specified,
                                               assume all consumer nodes get the converted type.
        add_qtype_converts: True if this function should automatically add "convert" entries to the provided
            `init_overrides` to ensure that operators use valid input/output types (activations only).
            Ex: if you override the output of an Add to 16-bit, this option ensures that the activation inputs
            of the Add are also up-converted to 16-bit and that data types for surrounding ops are converted
            appropriately. Refer to the documentation in mixed_precision_overrides_utils.py for additional details.
        activation_symmetric: True if activations should be quantized symmetrically (i.e, rmax == -rmin) by default.
            Defaults to false. For int8 and int16, this results in zero-point values of 0. For uint8 and uin16,
            the zero-point values are 128 and 32,768, respectively.
        weight_symmetric: True if weights should be quantized symmetrically (i.e., rmax == -rmin) by default.
            Defaults to None. If set to None, weight_symmetric is assumed true if the weight_type is a signed int.
        keep_removable_activations: Defaults to false. If true, "removable" activations (e.g., Clip or Relu) will not
                        be removed, and will be explicitly represented in the QDQ model. If false, these activations
                        are automatically removed if activations are asymmetrically quantized. Keeping these activations
                        is necessary if optimizations or EP transformations will later remove
                        QuantizeLinear/DequantizeLinear operators from the model.
        calibration_providers: Execution providers to run the session during calibration. Default is None which uses
            [ "CPUExecutionProvider" ].
        op_types_to_quantize: If set to None, all operator types will be quantized except for OP_TYPES_TO_EXCLUDE
        nodes_to_exclude: List of nodes names to exclude from quantization. The nodes in this list will be excluded from
            quantization when it is not None.

    Returns:
        A StaticQuantConfig object
    """
    if weight_symmetric is None:
        weight_symmetric = weight_type in {QuantType.QInt8, QuantType.QInt16}

    model = (
        model_input
        if isinstance(model_input, onnx.ModelProto)
        else onnx.load_model(model_input, load_external_data=False)
    )

    op_types = set()
    model_has_external_data = False
    name_to_initializer = {}

    # Build map of initializers (name -> initializer) and
    # check if the model has external data.
    for initializer in model.graph.initializer:
        name_to_initializer[initializer.name] = initializer
        if onnx.external_data_helper.uses_external_data(initializer):
            model_has_external_data = True

    overrides_helper = TensorQuantOverridesHelper(copy.deepcopy(init_overrides) if init_overrides else {})

    if not overrides_helper.empty() and add_qtype_converts:
        # Fix mixed-precision overrides.
        overrides_fixer = MixedPrecisionTensorQuantOverridesFixer.create_from_model(
            overrides_helper, model, activation_type
        )
        overrides_fixer.apply(activation_type, activation_symmetric)

    # Setup quantization overrides for specific operator types to ensure compatibility with QNN EP.
    qnn_compat = QnnCompatibilityOverrides(
        activation_type,
        weight_type,
        activation_symmetric,
        weight_symmetric,
        per_channel,
        overrides_helper,
        name_to_initializer,
    )

    op_types_to_quantize_set = set(op_types_to_quantize) if op_types_to_quantize else None
    nodes_to_exclude_set = set(nodes_to_exclude) if nodes_to_exclude else None

    for node in model.graph.node:
        if op_types_to_quantize_set and node.op_type not in op_types_to_quantize_set:
            continue
        if nodes_to_exclude_set and node.name in nodes_to_exclude_set:
            continue
        op_types.add(node.op_type)
        qnn_compat.process_node(node)

    extra_options = {
        "MinimumRealRange": 0.0001,
        "DedicatedQDQPair": False,  # Let ORT optimizer duplicate DQ nodes
        "QDQKeepRemovableActivations": keep_removable_activations,
        "TensorQuantOverrides": overrides_helper.get_dict(),
        "ActivationSymmetric": activation_symmetric,
        "WeightSymmetric": weight_symmetric,
        "CalibStridedMinMax": stride,
    }

    # ONNX opset < 21 does not support 16-bit quantization, so must use 'com.microsoft' domain
    # on Q/DQ operators if using 16-bit or 4-bit quantization.
    onnx_opset = next(x for x in model.opset_import if x.domain == "" or x.domain == "ai.onnx")
    if onnx_opset.version < 21:
        opset21_types = Q16_TYPES.union(Q4_TYPES)
        overrides_have_opset21_types = any(t in opset21_types for t in overrides_helper.get_quant_types())
        if activation_type in opset21_types or weight_type in opset21_types or overrides_have_opset21_types:
            extra_options["UseQDQContribOps"] = True

    return StaticQuantConfig(
        calibration_data_reader,
        calibrate_method=calibrate_method,
        activation_type=activation_type,
        weight_type=weight_type,
        op_types_to_quantize=(
            op_types_to_quantize if op_types_to_quantize else list(op_types.difference(OP_TYPES_TO_EXCLUDE))
        ),
        nodes_to_exclude=nodes_to_exclude,
        per_channel=per_channel,
        use_external_data_format=(model_has_external_data or model.ByteSize() >= MODEL_SIZE_THRESHOLD),
        calibration_providers=calibration_providers,
        extra_options=extra_options,
    )


class QnnCompatibilityOverrides:
    """
    Helper that processes nodes to generate quantization overrides that make the resulting QDQ model
    compatible with QNN EP.
    """

    def __init__(
        self,
        default_activation_qtype: QuantType,
        default_weight_qtype: QuantType,
        activation_symmetric: bool,
        weight_symmetric: bool,
        per_channel: bool,
        overrides: TensorQuantOverridesHelper,
        initializers: dict[str, onnx.TensorProto],
    ):
        self.default_activation_qtype = default_activation_qtype
        self.default_weight_qtype = default_weight_qtype
        self.activation_symmetric = activation_symmetric
        self.weight_symmetric = weight_symmetric
        self.per_channel = per_channel
        self.overrides = overrides
        self.initializers = initializers

        self.process_fns = {
            "MatMul": self._process_matmul,
            "LayerNormalization": self._process_layernorm,
            "Sigmoid": self._process_sigmoid,
            "Tanh": self._process_tanh,
        }

    def process_node(self, node: onnx.NodeProto):
        process_fn = self.process_fns.get(node.op_type)

        if process_fn is not None:
            process_fn(node)

    def _make_static_inputs_use_default_weight_type(self, node: onnx.NodeProto):
        """
        Overrides initializer input(s) to use the default weight type if:
        - The default weight type is 8-bit
        - One of the inputs is a 16-bit activation
        - The other input is an initializer (per-tensor quantized)

        This is necessary because the quantization tool does not assign MatMul or LayerNorm initializer
        inputs the default weight type. Instead, it assigns the default activation type.
        """
        if self.default_weight_qtype not in Q8_TYPES:
            return

        input_16bit_act_name = None
        input_weight_name = None

        # Loop through first 2 inputs to find a 16-bit activation and a (per-tensor) weight.
        for i in range(2):
            input_name = node.input[i]
            if not input_name:
                continue

            is_weight = input_name in self.initializers
            qtype_info = self.overrides.get_node_input_qtype_info(
                input_name,
                node.name,
                default_qtype=None if is_weight else self.default_activation_qtype,
            )

            if qtype_info.axis is not None:
                return  # Don't process MatMul with a per-channel quantized input.

            if (
                is_weight
                and qtype_info.quant_type == self.default_weight_qtype
                and qtype_info.symmetric == self.weight_symmetric
            ):
                return  # Return. Weight is already overridden to use the desired weight type.

            if is_weight:
                input_weight_name = input_name
            elif qtype_info.quant_type in Q16_TYPES:
                input_16bit_act_name = input_name

        # Override initializer input to use the default weight type.
        if input_16bit_act_name and input_weight_name:
            did_update = self.overrides.update_tensor_overrides(
                input_weight_name,
                {"quant_type": self.default_weight_qtype, "symmetric": self.weight_symmetric},
                overwrite=False,
            )

            if not did_update:
                warn_unable_to_override(node, "quant_type/symmetric", input_weight_name, "input weight")

    def _process_matmul(self, node: onnx.NodeProto):
        assert node.op_type == "MatMul", f"Expected MatMul, but got {node.op_type}"

        if not self.per_channel:
            self._make_static_inputs_use_default_weight_type(node)
            return

        # QNN does not support per-channel MatMul. However, the ORT quantization tool attempts to use per-channel
        # quantization for MatMul by default *if* the global per_channel setting is enabled. So, we need to
        # provide explicit per-tensor quantization overrides for MatMul if per_channel is enabled and
        # the user did not provide any other overrides.
        for input_name in node.input:
            is_weight_no_overrides = input_name in self.initializers and input_name not in self.overrides
            if is_weight_no_overrides:
                self.overrides.update_tensor_overrides(
                    input_name,
                    {"quant_type": self.default_weight_qtype, "symmetric": self.weight_symmetric},
                )

    def _process_layernorm(self, node: onnx.NodeProto):
        assert node.op_type == "LayerNormalization", f"Expected LayerNormalization, but got {node.op_type}"

        if not self.per_channel:
            self._make_static_inputs_use_default_weight_type(node)

    def _process_sigmoid(self, node: onnx.NodeProto):
        """
        Overrides 16-bit Sigmoid's output scale and zero-point as per QNN requirements.
        """
        assert node.op_type == "Sigmoid", f"Expected Sigmoid, but got {node.op_type}"
        output_type = self.overrides.get_node_output_qtype_info(
            node.output[0], self.default_activation_qtype
        ).quant_type

        if output_type == QuantType.QUInt16:
            self.overrides.update_tensor_overrides(
                node.output[0],
                {
                    "quant_type": output_type,
                    "scale": np.array(1.0 / 65536.0, dtype=np.float32),
                    "zero_point": np.array(0, dtype=np.uint16),
                },
            )
        elif output_type == QuantType.QInt16:
            self.overrides.update_tensor_overrides(
                node.output[0],
                {
                    "quant_type": output_type,
                    "scale": np.array(1.0 / 32768.0, dtype=np.float32),
                    "zero_point": np.array(0, dtype=np.int16),
                },
            )

    def _process_tanh(self, node: onnx.NodeProto):
        """
        Overrides 16-bit Tanh's output scale and zero-point as per QNN requirements.
        """
        assert node.op_type == "Tanh", f"Expected Tanh, but got {node.op_type}"
        output_type = self.overrides.get_node_output_qtype_info(
            node.output[0], self.default_activation_qtype
        ).quant_type

        if output_type == QuantType.QUInt16:
            self.overrides.update_tensor_overrides(
                node.output[0],
                {
                    "quant_type": output_type,
                    "scale": np.array(1.0 / 32768.0, dtype=np.float32),
                    "zero_point": np.array(32768, dtype=np.uint16),
                },
            )
        elif output_type == QuantType.QInt16:
            self.overrides.update_tensor_overrides(
                node.output[0],
                {
                    "quant_type": output_type,
                    "scale": np.array(1.0 / 32768.0, dtype=np.float32),
                    "zero_point": np.array(0, dtype=np.int16),
                },
            )
