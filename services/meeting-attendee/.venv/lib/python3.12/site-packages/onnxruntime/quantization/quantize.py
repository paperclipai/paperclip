# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import copy
import logging
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

import onnx

from .calibrate import CalibrationDataReader, CalibrationMethod, TensorsData, create_calibrator
from .onnx_quantizer import ONNXQuantizer
from .qdq_quantizer import QDQQuantizer
from .quant_utils import (
    MODEL_SIZE_THRESHOLD,
    QuantFormat,
    QuantizationMode,
    QuantType,
    load_model_with_shape_infer,
    model_has_pre_process_metadata,
    save_and_reload_model_with_shape_infer,
    update_opset_version,
)
from .registry import IntegerOpsRegistry, QDQRegistry, QLinearOpsRegistry
from .tensor_quant_overrides import TensorQuantOverridesHelper


class QuantConfig:
    def __init__(
        self,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=None,
        nodes_to_quantize=None,
        nodes_to_exclude=None,
        per_channel=False,
        reduce_range=False,
        use_external_data_format=False,
    ):
        """
        This is the Base class for both Static and Dynamic Quantize Configuration
        Args:
            activation_type:
                quantization data type of activation. Please refer to
                https://onnxruntime.ai/docs/performance/quantization.html for more details on data type selection
            weight_type:
                quantization data type of weight. Please refer to
                https://onnxruntime.ai/docs/performance/quantization.html for more details on data type selection
            op_types_to_quantize:
                specify the types of operators to quantize, like ['Conv'] to quantize Conv only.
                It quantizes all supported operators by default.
            nodes_to_quantize:
                List of nodes names to quantize. When this list is not None only the nodes in this list
                are quantized.
                example:
                [
                    'Conv__224',
                    'Conv__252'
                ]
            nodes_to_exclude:
                List of nodes names to exclude. The nodes in this list will be excluded from quantization
                when it is not None.
            per_channel: quantize weights per channel
            reduce_range:
                quantize weights with 7-bits. It may improve the accuracy for some models running on non-VNNI machine,
                especially for per-channel mode
            use_external_data_format: option used for large size (>2GB) model. Set to False by default.
        """

        nodes_to_exclude = nodes_to_exclude or []
        nodes_to_quantize = nodes_to_quantize or []
        op_types_to_quantize = op_types_to_quantize or []
        self.op_types_to_quantize = op_types_to_quantize
        self.per_channel = per_channel
        self.reduce_range = reduce_range
        self.weight_type = weight_type
        self.activation_type = activation_type
        self.nodes_to_quantize = nodes_to_quantize
        self.nodes_to_exclude = nodes_to_exclude
        self.use_external_data_format = use_external_data_format


class StaticQuantConfig(QuantConfig):
    def __init__(
        self,
        calibration_data_reader: CalibrationDataReader,
        calibrate_method=CalibrationMethod.MinMax,
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=None,
        nodes_to_quantize=None,
        nodes_to_exclude=None,
        per_channel=False,
        reduce_range=False,
        use_external_data_format=False,
        calibration_providers=None,
        extra_options=None,
    ):
        """
        This is the derived class for static Quantize Configuration

        Args:
            calibration_data_reader:
                a calibration data reader. It enumerates calibration data and generates inputs for the original model.
            calibrate_method:
                Current calibration methods supported are MinMax, Entropy and Percentile.
            quant_format: QuantFormat{QOperator, QDQ}.
                QOperator format quantizes the model with quantized operators directly.
                QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
            calibration_providers: Execution providers to run the session during calibration. Default is None which uses
                [ "CPUExecutionProvider" ].
            extra_options:
                key value pair dictionary for various options in different case. Current used:
                    extra.Sigmoid.nnapi = True/False  (Default is False)
                    ActivationSymmetric = True/False: symmetrize calibration data for activations (default is False).
                    WeightSymmetric = True/False: symmetrize calibration data for weights (default is True).
                    EnableSubgraph = True/False : Default is False. If enabled, subgraph will be quantized.
                                                  Dyanmic mode currently is supported. Will support more in future.
                    ForceQuantizeNoInputCheck = True/False :
                        By default, some latent operators like maxpool, transpose, do not quantize if their input is not
                        quantized already. Setting to True to force such operator always quantize input and so generate
                        quantized output. Also the True behavior could be disabled per node using the nodes_to_exclude.
                    MatMulConstBOnly = True/False:
                        Default is False for static mode. If enabled, only MatMul with const B will be quantized.
                    AddQDQPairToWeight = True/False :
                        Default is False which quantizes floating-point weight and feeds it to solely inserted
                        DeQuantizeLinear node. If True, it remains floating-point weight and inserts both
                        QuantizeLinear/DeQuantizeLinear nodes to weight.
                    OpTypesToExcludeOutputQuantization = list of op type :
                        Default is []. If any op type is specified, it won't quantize the output of ops with this
                        specific op types.
                    DedicatedQDQPair = True/False :
                        Default is False. When inserting QDQ pair, multiple nodes can share a single QDQ pair as their
                        inputs. If True, it will create identical and dedicated QDQ pair for each node.
                    QDQOpTypePerChannelSupportToAxis = dictionary :
                        Default is {}. Set channel axis for specific op type, for example: {'MatMul': 1}, and it's
                        effective only when per channel quantization is supported and per_channel is True. If specific
                        op type supports per channel quantization but not explicitly specified with channel axis,
                        default channel axis will be used.
                    CalibTensorRangeSymmetric = True/False :
                        Default is False. If enabled, the final range of tensor during calibration will be explicitly
                        set to symmetric to central point "0".
                    CalibMovingAverage = True/False :
                        Default is False. If enabled, the moving average of the minimum and maximum values will be
                        computed when the calibration method selected is MinMax.
                    CalibMovingAverageConstant = float :
                        Default is 0.01. Constant smoothing factor to use when computing the moving average of the
                        minimum and maximum values. Effective only when the calibration method selected is MinMax and
                        when CalibMovingAverage is set to True.
                    QuantizeBias = True/False :
                        Default is True which quantizes floating-point biases and it solely inserts
                        a DeQuantizeLinear node. If False, it remains floating-point bias and does not insert
                        any quantization nodes associated with biases.
                        This extra option is only effective when quant_format is QuantFormat.QDQ.
                    SmoothQuant = True/False :
                        Default is False. If enabled, SmoothQuant algorithm will be applied before quantization to do
                        fake input channel quantization.
                    SmoothQuantAlpha = float :
                        Default is 0.5. It only works if SmoothQuant is True. It controls the difficulty of weight
                        and activation quantization. A larger alpha value could be used on models with more significant
                        activation outliers to migrate more quantization difficulty to weights.
                    SmoothQuantFolding = True/False :
                        Default is True. It only works if SmoothQuant is True. If enabled, inserted Mul ops during
                        SmoothQuant will be folded into the previous op if the previous op is foldable.
                    UseQDQContribOps = True/False :
                        Default is False. If enabled, the inserted QuantizeLinear and DequantizeLinear ops will have the
                        `com.microsoft` domain, which forces use of ONNX Runtime's QuantizeLinear and DequantizeLinear
                        contrib op implementations. The contrib op implementations may support features not standardized
                        into the ONNX specification (e.g., 16-bit quantization types).
                    MinimumRealRange = float|None :
                        Default is None. If set to a floating-point value, the calculation of the quantization parameters
                        (i.e., scale and zero point) will enforce a minimum range between rmin and rmax. If (rmax-rmin)
                        is less than the specified minimum range, rmax will be set to rmin + MinimumRealRange. This is
                        necessary for EPs like QNN that require a minimum floating-point range when determining
                        quantization parameters.
                    TensorQuantOverrides = dictionary :
                        Default is {}. Set tensor quantization overrides. The key is a tensor name and the value is a
                        list of dictionaries. For per-tensor quantization, the list contains a single dictionary. For
                        per-channel quantization, the list contains a dictionary for each channel in the tensor.
                        Each dictionary contains optional overrides with the following keys and values.
                            'quant_type' = QuantType : The tensor's quantization data type.
                            'scale' =  Float         : The scale value to use. Must also specify `zero_point` if set.
                            'zero_point' = Int       : The zero-point value to use. Must also specify `scale` is set.
                            'symmetric' = Bool       : If the tensor should use symmetric quantization. Invalid if also
                                                       set `scale` or `zero_point`.
                            'reduce_range' = Bool    : If the quantization range should be reduced. Invalid if also
                                                       set `scale` or `zero_point`.
                            'rmax' = Float           : Override the maximum real tensor value in calibration data.
                                                       Invalid if also set `scale` or `zero_point`.
                            'rmin' = Float           : Override the minimum real tensor value in calibration data.
                                                       Invalid if also set `scale` or `zero_point`.
                    QDQKeepRemovableActivations = True/False:
                        Default is False. If true, "removable" activations (e.g., Clip or Relu) will not be removed, and
                        will be explicitly represented in the QDQ model. If false, these activations are automatically
                        removed if activations are asymmetrically quantized. Keeping these activations is necessary if
                        optimizations or EP transformations will later remove QuantizeLinear/DequantizeLinear
                        operators from the model.
                    QDQDisableWeightAdjustForInt32Bias = True/False:
                        Default is False. If true, QDQ quantizer will not adjust the weight's scale when the bias
                        has a scale (input_scale * weight_scale) that is too small.
            execution_provider : A enum indicates the Execution Provider such as: CPU, TRT, NNAPI, SNE, etc.
        Raises:
            ValueError: Raise ValueError if execution provider is unknown
        """

        super().__init__(
            activation_type=activation_type,
            weight_type=weight_type,
            op_types_to_quantize=op_types_to_quantize,
            nodes_to_quantize=nodes_to_quantize,
            nodes_to_exclude=nodes_to_exclude,
            per_channel=per_channel,
            reduce_range=reduce_range,
            use_external_data_format=use_external_data_format,
        )
        self.calibration_data_reader = calibration_data_reader
        self.calibrate_method = calibrate_method
        self.quant_format = quant_format
        self.calibration_providers = calibration_providers
        self.extra_options = extra_options or {}


def get_qdq_config(
    model_input: str | Path | onnx.ModelProto,
    calibration_data_reader: CalibrationDataReader,
    calibrate_method=CalibrationMethod.MinMax,
    calibrate_args: dict[str, Any] | None = None,
    activation_type=QuantType.QUInt8,
    weight_type=QuantType.QInt8,
    activation_symmetric: bool = False,
    weight_symmetric: bool | None = None,
    per_channel: bool = False,
    reduce_range: bool = False,
    keep_removable_activations: bool = False,
    min_real_range: float | None = None,
    tensor_quant_overrides: dict[str, list[dict[str, Any]]] | None = None,
    calibration_providers: list[str] | None = None,
    op_types_to_quantize: list[str] | None = None,
    nodes_to_exclude: list[str] | Callable[[onnx.ModelProto, onnx.NodeProto], bool] | None = None,
    extra_options: dict | None = None,
) -> StaticQuantConfig:
    """
    Returns a configuration suitable that quantizes the entire model to integer precision.

    Params:
        model_input: Path to the input model file or ModelProto.
        calibration_data_reader: Calibration data reader.
        calibrate_methode: The calibration method. Defaults to MinMax.
        activation_type: The default activation quantization type. Defaults to QUInt8.
        weight_type: The default weight quantization type. Defaults to QInt8.
        activation_symmetric: True if activations should be quantized symmetrically (i.e, rmax == -rmin) by default.
            Defaults to false. For int8 and int16, this results in zero-point values of 0. For uint8 and uint16,
            the zero-point values are 127 and 32,767, respectively.
        weight_symmetric: True if weights should be quantized symmetrically (i.e., rmax == -rmin) by default.
            Defaults to None. If set to None, weight_symmetric is assumed true if a weight's quant type is a signed int.
        per_channel: Global option that determines if a fixed set of operator types should be quantized per-channel.
            Defaults to false. Alternatively, use the tensor-level `tensor_quant_overrides` to select individual operators
            and their quantization axes.
        reduce_range: quantize weights with 1 less bit of precision (e.g., 7 bits for QInt8). Defaults to false.
            May improve the accuracy for some models running on non-VNNI machine, especially for per-channel mode.
        keep_removable_activations: Defaults to false. If true, "removable" activations (e.g., Clip or Relu) will not
                        be removed, and will be explicitly represented in the QDQ model. If false, these activations
                        are automatically removed if activations are asymmetrically quantized. Keeping these activations
                        is necessary if optimizations or EP transformations will later remove
                        QuantizeLinear/DequantizeLinear operators from the model.
        min_real_range: Default is None. If set to a floating-point value, the calculation of the quantization parameters
            (i.e., scale and zero point) will enforce a minimum range between rmin and rmax. If (rmax - rmin)
            is less than the specified minimum range, rmax will be set to rmin + min_real_range.
        tensor_quant_overrides: tensor-level quantization overrides. Defaults to None.
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
        calibration_providers: Execution providers to run the session during calibration. Default is None which uses
            [ "CPUExecutionProvider" ].
        op_types_to_quantize: List of operator types to quantize. If None, all operators other than Cast, DequantizeLinear,
            and QuantizeLinear are quantized.
        nodes_to_exclude: List of nodes names to exclude from quantization. Alternatively, can provide a function that
            accepts an onnx.ModelProto and onnx.NodeProto as arguments and returns true if the give onnx.NodeProto
            should be excluded from quantization.
        extra_options: Additional options specified as string key/value pairs. Refer to the documentation for
            `quantize_static` for valid keys and values.

    Returns:
        A StaticQuantConfig object
    """
    q16_types = {QuantType.QInt16, QuantType.QUInt16}
    q4_types = {QuantType.QInt4, QuantType.QUInt4}
    op_types_to_exclude = {"Cast", "DequantizeLinear", "QuantizeLinear"}

    model = (
        model_input
        if isinstance(model_input, onnx.ModelProto)
        else onnx.load_model(model_input, load_external_data=False)
    )

    op_types = set()
    model_has_external_data = False
    overrides_helper = TensorQuantOverridesHelper(
        copy.deepcopy(tensor_quant_overrides) if tensor_quant_overrides else {}
    )

    # check if the model has external data.
    for initializer in model.graph.initializer:
        if onnx.external_data_helper.uses_external_data(initializer):
            model_has_external_data = True

    op_types_to_quantize_set = set(op_types_to_quantize) if op_types_to_quantize else None
    nodes_to_exclude_set = set(nodes_to_exclude) if isinstance(nodes_to_exclude, list) else set()

    # Iterate through nodes to get all operator types in the model and
    # call user's function to filter out nodes from quantization.
    for node in model.graph.node:
        if op_types_to_quantize_set and node.op_type not in op_types_to_quantize_set:
            continue
        if node.name in nodes_to_exclude_set:
            continue
        if callable(nodes_to_exclude) and nodes_to_exclude(model, node):
            nodes_to_exclude_set.add(node.name)
        else:
            op_types.add(node.op_type)

    final_extra_options = {
        "MinimumRealRange": min_real_range,
        "QDQKeepRemovableActivations": keep_removable_activations,
        "ActivationSymmetric": activation_symmetric,
        "WeightSymmetric": weight_symmetric,
        "ForceQuantizeNoInputCheck": True,
        "TensorQuantOverrides": overrides_helper.get_dict(),
    }

    # Pass along known calibration options
    if calibrate_args:
        calib_extra_options_keys = [
            ("symmetric", "CalibTensorRangeSymmetric"),
            ("moving_average", "CalibMovingAverage"),
            ("averaging_constant", "CalibMovingAverageConstant"),
            ("max_intermediate_outputs", "CalibMaxIntermediateOutputs"),
            ("percentile", "CalibPercentile"),
        ]
        calib_extra_options = {
            key: calibrate_args.get(name) for (name, key) in calib_extra_options_keys if name in calibrate_args
        }
        final_extra_options.update(calib_extra_options)

    # ONNX opset < 21 does not support 16-bit quantization, so must use 'com.microsoft' domain
    # on Q/DQ operators if using 16-bit or 4-bit quantization.
    onnx_opset = next(x for x in model.opset_import if x.domain == "" or x.domain == "ai.onnx")
    if onnx_opset.version < 21:
        opset21_types = q16_types.union(q4_types)
        overrides_have_opset21_types = any(t in opset21_types for t in overrides_helper.get_quant_types())
        if activation_type in opset21_types or weight_type in opset21_types or overrides_have_opset21_types:
            final_extra_options["UseQDQContribOps"] = True

    # Allow user's extra_options to override our final_extra_options.
    if extra_options:
        final_extra_options.update(extra_options)

    return StaticQuantConfig(
        calibration_data_reader,
        calibrate_method=calibrate_method,
        quant_format=QuantFormat.QDQ,
        activation_type=activation_type,
        weight_type=weight_type,
        op_types_to_quantize=(
            op_types_to_quantize if op_types_to_quantize else list(op_types.difference(op_types_to_exclude))
        ),
        nodes_to_exclude=list(nodes_to_exclude_set),
        per_channel=per_channel,
        reduce_range=reduce_range,
        use_external_data_format=(model_has_external_data or model.ByteSize() >= MODEL_SIZE_THRESHOLD),
        calibration_providers=calibration_providers,
        extra_options=final_extra_options,
    )


class DynamicQuantConfig(QuantConfig):
    def __init__(
        self,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=None,
        nodes_to_quantize=None,
        nodes_to_exclude=None,
        per_channel=False,
        reduce_range=False,
        use_external_data_format=False,
        extra_options=None,
    ):
        """
        This is a class for dynamic Quant Configuration

        Args:
            extra_options: key value pair dictionary for various options in different case. Current used:
                extra.Sigmoid.nnapi = True/False  (Default is False)
                ActivationSymmetric = True/False: symmetrize calibration data for activations (default is False).
                WeightSymmetric = True/False: symmetrize calibration data for weights (default is True).
                EnableSubgraph = True/False :
                    Default is False. If enabled, subgraph will be quantized. Dynamic mode currently is supported. Will
                    support more in the future.
                ForceQuantizeNoInputCheck = True/False :
                    By default, some latent operators like maxpool, transpose, do not quantize if their input is not
                    quantized already. Setting to True to force such operator always quantize input and so generate
                    quantized output. Also the True behavior could be disabled per node using the nodes_to_exclude.
                MatMulConstBOnly = True/False:
                    Default is True for dynamic mode. If enabled, only MatMul with const B will be quantized.
            execution_provider : A enum indicates the Execution Provider such as: CPU, TRT, NNAPI, SNE, etc.

        Raises:
            ValueError: Raise ValueError if execution provider is unknown
        """
        super().__init__(
            op_types_to_quantize=op_types_to_quantize,
            per_channel=per_channel,
            reduce_range=reduce_range,
            weight_type=weight_type,
            nodes_to_quantize=nodes_to_quantize,
            nodes_to_exclude=nodes_to_exclude,
            use_external_data_format=use_external_data_format,
        )
        self.extra_options = extra_options or {}


def check_static_quant_arguments(quant_format: QuantFormat, activation_type: QuantType, weight_type: QuantType):
    if activation_type == QuantType.QInt8 and weight_type == QuantType.QUInt8:
        raise ValueError(
            "ONNXRuntime quantization doesn't support data format:"
            "activation_type=QuantType.QInt8, weight_type=QuantType.QUInt8"
        )
    if activation_type != QuantType.QFLOAT8E4M3FN and weight_type == QuantType.QFLOAT8E4M3FN:
        raise ValueError(
            f"ONNXRuntime quantization doesn't support data format: activation_type={activation_type} "
            "!=QuantType.QFLOAT8E4M3FN, weight_type=QuantType.QFLOAT8E4M3FN."
        )

    if activation_type == QuantType.QFLOAT8E4M3FN and weight_type != QuantType.QFLOAT8E4M3FN:
        raise ValueError(
            "ONNXRuntime quantization doesn't support data format: activation_type=QuantType.QFLOAT8E4M3FN, "
            f"weight_type={weight_type}!=QuantType.QFLOAT8E4M3FN"
        )

    q16_types = [QuantType.QInt16, QuantType.QUInt16]

    if (activation_type in q16_types or weight_type in q16_types) and quant_format != QuantFormat.QDQ:
        raise ValueError("Only QuantFormat.QDQ supports 16-bit quantization types.")

    if activation_type == QuantType.QInt8 and weight_type == QuantType.QInt8 and quant_format != QuantFormat.QDQ:
        logging.warning(
            "Please use QuantFormat.QDQ for activation type QInt8 and weight type QInt8. "
            "Or it will lead to bad performance on x64."
        )


def quantize_static(
    model_input: str | Path | onnx.ModelProto,
    model_output: str | Path,
    calibration_data_reader: CalibrationDataReader,
    quant_format=QuantFormat.QDQ,
    op_types_to_quantize=None,
    per_channel=False,
    reduce_range=False,
    activation_type=QuantType.QInt8,
    weight_type=QuantType.QInt8,
    nodes_to_quantize=None,
    nodes_to_exclude=None,
    use_external_data_format=False,
    calibrate_method=CalibrationMethod.MinMax,
    calibration_providers=None,
    extra_options=None,
):
    """
    Given an onnx model and calibration data reader, create a quantized onnx model and save it into a file
    It is recommended to use QuantFormat.QDQ format from 1.11 with activation_type = QuantType.QInt8 and weight_type
    = QuantType.QInt8. If model is targeted to GPU/TRT, symmetric activation and weight are required. If model is
    targeted to CPU, asymmetric activation and symmetric weight are recommended for balance of performance and
    accuracy.

    Args:

        model_input: file path of model or ModelProto to quantize
        model_output: file path of quantized model
        calibration_data_reader: a calibration data reader. It
            enumerates calibration data and generates inputs for the
            original model.
        quant_format: QuantFormat{QOperator, QDQ}.
            QOperator format quantizes the model with quantized operators directly.
            QDQ format quantize the model by inserting QuantizeLinear/DeQuantizeLinear on the tensor.
        activation_type:
            quantization data type of activation. Please refer to
            https://onnxruntime.ai/docs/performance/quantization.html for more details on data type selection
        calibrate_method:
            Current calibration methods supported are MinMax and Entropy.
                Please use CalibrationMethod.MinMax or CalibrationMethod.Entropy as options.
        op_types_to_quantize:
                specify the types of operators to quantize, like ['Conv'] to quantize Conv only.
                It quantizes all supported operators by default.
        per_channel: quantize weights per channel
        reduce_range:
            quantize weights with 7-bits. It may improve the accuracy for some models running on non-VNNI machine,
            especially for per-channel mode
        weight_type:
            quantization data type of weight. Please refer to
            https://onnxruntime.ai/docs/performance/quantization.html for more details on data type selection
        nodes_to_quantize:
            List of nodes names to quantize. When this list is not None only the nodes in this list
            are quantized.
            example:
            [
                'Conv__224',
                'Conv__252'
            ]
        nodes_to_exclude:
            List of nodes names to exclude. The nodes in this list will be excluded from quantization
            when it is not None.
        use_external_data_format: option used for large size (>2GB) model. Set to False by default.
        calibration_providers: Execution providers to run the session during calibration. Default is None which uses
            [ "CPUExecutionProvider" ]
        extra_options:
            key value pair dictionary for various options in different case. Current used:
                extra.Sigmoid.nnapi = True/False  (Default is False)
                ActivationSymmetric = True/False: symmetrize calibration data for activations (default is False).
                WeightSymmetric = True/False: symmetrize calibration data for weights (default is True).
                EnableSubgraph = True/False : Default is False. If enabled, subgraph will be quantized.
                                              Dyanmic mode currently is supported. Will support more in the future.
                ForceQuantizeNoInputCheck = True/False :
                    By default, some latent operators like maxpool, transpose, do not quantize if their input is not
                    quantized already. Setting to True to force such operator always quantize input and so generate
                    quantized output. Also, the True behavior could be disabled per node using the nodes_to_exclude.
                MatMulConstBOnly = True/False:
                    Default is False for static mode. If enabled, only MatMul with const B will be quantized.
                AddQDQPairToWeight = True/False :
                    Default is False which quantizes floating-point weight and feeds it to solely inserted
                    DeQuantizeLinear node. If True, it remains floating-point weight and inserts both
                    QuantizeLinear/DeQuantizeLinear nodes to weight.
                OpTypesToExcludeOutputQuantization = list of op type :
                    Default is []. If any op type is specified, it won't quantize the output of ops with this
                    specific op types.
                DedicatedQDQPair = True/False :
                    Default is False. When inserting QDQ pair, multiple nodes can share a single QDQ pair as their
                    inputs. If True, it will create identical and dedicated QDQ pair for each node.
                QDQOpTypePerChannelSupportToAxis = dictionary :
                    Default is {}. Set channel axis for specific op type, for example: {'MatMul': 1}, and it's
                    effective only when per channel quantization is supported and per_channel is True. If specific
                    op type supports per channel quantization but not explicitly specified with channel axis,
                    default channel axis will be used.
                CalibTensorRangeSymmetric = True/False :
                    Default is False. If enabled, the final range of tensor during calibration will be explicitly
                    set to symmetric to central point "0".
                CalibStridedMinMax = Optional[int] :
                    Default is None. If set to an integer, during calculation of the min-max, only stride amount of
                    data will be used and then all results will be merged in the end.
                CalibMovingAverage = True/False :
                    Default is False. If enabled, the moving average of the minimum and maximum values will be
                    computed when the calibration method selected is MinMax.
                CalibMovingAverageConstant = float :
                    Default is 0.01. Constant smoothing factor to use when computing the moving average of the
                    minimum and maximum values. Effective only when the calibration method selected is MinMax and
                    when CalibMovingAverage is set to True.
                CalibMaxIntermediateOutputs = Optional[int] :
                    Default is None. If set to an integer, during calculation of the min-max range of the tensors
                    it will load at max value number of outputs before computing and merging the range. This will
                    produce the same result as all computing with None, but is more memory efficient.
                SmoothQuant = True/False :
                    Default is False. If enabled, SmoothQuant algorithm will be applied before quantization to do
                    fake input channel quantization.
                SmoothQuantAlpha = float :
                    Default is 0.5. It only works if SmoothQuant is True. It controls the difficulty of weight
                    and activation quantization. A larger alpha value could be used on models with more significant
                    activation outliers to migrate more quantization difficulty to weights.
                SmoothQuantFolding = True/False :
                    Default is True. It only works if SmoothQuant is True. If enabled, inserted Mul ops during
                    SmoothQuant will be folded into the previous op if the previous op is foldable.
                UseQDQContribOps = True/False :
                    Default is False. If enabled, the inserted QuantizeLinear and DequantizeLinear ops will have the
                    `com.microsoft` domain, which forces use of ONNX Runtime's QuantizeLinear and DequantizeLinear
                    contrib op implementations. The contrib op implementations may support features not standardized
                    into the ONNX specification (e.g., 16-bit quantization types).
                MinimumRealRange = float|None :
                    Default is None. If set to a floating-point value, the calculation of the quantization parameters
                    (i.e., scale and zero point) will enforce a minimum range between rmin and rmax. If (rmax - rmin)
                    is less than the specified minimum range, rmax will be set to rmin + MinimumRealRange. This is
                    necessary for EPs like QNN that require a minimum floating-point range when determining
                    quantization parameters.
                TensorQuantOverrides = dictionary :
                    Default is {}. Set tensor quantization overrides. The key is a tensor name and the value is a
                    list of dictionaries. For per-tensor quantization, the list contains a single dictionary. For
                    per-channel quantization, the list contains a dictionary for each channel in the tensor.
                    Each dictionary contains optional overrides with the following keys and values.
                        'quant_type' = QuantType : The tensor's quantization data type.
                        'scale' =  Float         : The scale value to use. Must also specify `zero_point` if set.
                        'zero_point' = Int       : The zero-point value to use. Must also specify `scale` is set.
                        'symmetric' = Bool       : If the tensor should use symmetric quantization. Invalid if also
                                                   set `scale` or `zero_point`.
                        'reduce_range' = Bool    : If the quantization range should be reduced. Invalid if also
                                                   set `scale` or `zero_point`.
                        'rmax' = Float           : Override the maximum real tensor value in calibration data.
                                                   Invalid if also set `scale` or `zero_point`.
                        'rmin' = Float           : Override the minimum real tensor value in calibration data.
                                                   Invalid if also set `scale` or `zero_point`.
                QDQKeepRemovableActivations = True/False:
                    Default is False. If true, "removable" activations (e.g., Clip or Relu) will not be removed, and
                    will be explicitly represented in the QDQ model. If false, these activations are automatically
                    removed if activations are asymmetrically quantized. Keeping these activations is necessary if
                    optimizations or EP transformations will later remove QuantizeLinear/DequantizeLinear
                    operators from the model.
                QDQDisableWeightAdjustForInt32Bias = True/False:
                    Default is False. If true, QDQ quantizer will not adjust the weight's scale when the bias
                    has a scale (input_scale * weight_scale) that is too small.
    """
    if activation_type == QuantType.QFLOAT8E4M3FN or weight_type == QuantType.QFLOAT8E4M3FN:
        if calibrate_method != CalibrationMethod.Distribution:
            raise ValueError("Only Distribution calibration method is supported for float quantization.")

    extra_options = extra_options or {}
    nodes_to_exclude = nodes_to_exclude or []
    nodes_to_quantize = nodes_to_quantize or []
    op_types_to_quantize = op_types_to_quantize or []
    mode = QuantizationMode.QLinearOps

    if not op_types_to_quantize or len(op_types_to_quantize) == 0:
        q_linear_ops = list(QLinearOpsRegistry.keys())
        qdq_ops = list(QDQRegistry.keys())
        op_types_to_quantize = list(set(q_linear_ops + qdq_ops))

    model = (
        save_and_reload_model_with_shape_infer(model_input)
        if isinstance(model_input, onnx.ModelProto)
        else load_model_with_shape_infer(Path(model_input))
    )

    pre_processed: bool = model_has_pre_process_metadata(model)
    if not pre_processed:
        logging.warning(
            "Please consider to run pre-processing before quantization. Refer to example: "
            "https://github.com/microsoft/onnxruntime-inference-examples/blob/main/quantization/image_classification"
            "/cpu/ReadMe.md "
        )

    calib_extra_options_keys = [
        ("CalibTensorRangeSymmetric", "symmetric"),
        ("CalibMovingAverage", "moving_average"),
        ("CalibMovingAverageConstant", "averaging_constant"),
        ("CalibMaxIntermediateOutputs", "max_intermediate_outputs"),
        ("CalibPercentile", "percentile"),
    ]
    calib_extra_options = {
        key: extra_options.get(name) for (name, key) in calib_extra_options_keys if name in extra_options
    }

    if extra_options.get("SmoothQuant", False):
        import importlib  # noqa: PLC0415

        try:
            importlib.import_module("neural_compressor.adaptor.ox_utils.smooth_quant")
        except Exception as e:
            logging.error(f"{e}.")
            raise RuntimeError("neural-compressor is not correctly installed. Please check your environment.") from e

        from neural_compressor.adaptor.ox_utils.smooth_quant import ORTSmoothQuant  # noqa: PLC0415

        def inc_dataloader():
            data_reader = copy.deepcopy(calibration_data_reader)
            for data in data_reader:
                yield data, None

        orig_nodes = [i.name for i in model.graph.node]
        dataloader = inc_dataloader()
        sq = ORTSmoothQuant(model_input, dataloader, reduce_range)
        del dataloader
        model = sq.transform(extra_options.get("SmoothQuantAlpha", 0.5), extra_options.get("SmoothQuantFolding", True))
        sq_path = tempfile.TemporaryDirectory(prefix="ort.quant.")
        model_input = Path(sq_path.name).joinpath("sq_model.onnx").as_posix()
        model.save(model_input)
        nodes_to_exclude.extend([i.name for i in model.model.graph.node if i.name not in orig_nodes])
        model = load_model_with_shape_infer(Path(model_input))  # use smooth quant model for calibration

    updated_model = update_opset_version(model, weight_type)
    is_model_updated = updated_model is not model
    if is_model_updated:
        model = updated_model

    with tempfile.TemporaryDirectory(prefix="ort.quant.") as quant_tmp_dir:
        if is_model_updated:
            # Update model_input and avoid to use the original one
            model_input = copy.deepcopy(model)

        if isinstance(model_input, onnx.ModelProto):
            output_path = Path(quant_tmp_dir).joinpath("model_input.onnx").as_posix()
            onnx.save_model(
                model_input,
                output_path,
                save_as_external_data=True,
            )
            model_input = output_path

        calibrator = create_calibrator(
            Path(model_input),
            op_types_to_quantize,
            augmented_model_path=Path(quant_tmp_dir).joinpath("augmented_model.onnx").as_posix(),
            calibrate_method=calibrate_method,
            use_external_data_format=use_external_data_format,
            providers=calibration_providers,
            extra_options=calib_extra_options,
        )

        stride = extra_options.get("CalibStridedMinMax", None)
        if stride:
            total_data_size = len(calibration_data_reader)
            if total_data_size % stride != 0:
                raise ValueError(f"Total data size ({total_data_size}) is not divisible by stride size ({stride}).")

            for start in range(0, total_data_size, stride):
                end_index = start + stride
                calibration_data_reader.set_range(start_index=start, end_index=end_index)
                calibrator.collect_data(calibration_data_reader)
        else:
            calibrator.collect_data(calibration_data_reader)
        tensors_range = calibrator.compute_data()
        if not isinstance(tensors_range, TensorsData):
            raise TypeError(
                f"Unexpected type {type(tensors_range)} for tensors_range and calibrator={type(calibrator)}."
            )
        del calibrator

    check_static_quant_arguments(quant_format, activation_type, weight_type)

    if quant_format is QuantFormat.QOperator:
        quantizer = ONNXQuantizer(
            model,
            per_channel,
            reduce_range,
            mode,
            True,  # static
            weight_type,
            activation_type,
            tensors_range,
            nodes_to_quantize,
            nodes_to_exclude,
            op_types_to_quantize,
            extra_options,
        )
    else:
        quantizer = QDQQuantizer(
            model,
            per_channel,
            reduce_range,
            weight_type,
            activation_type,
            tensors_range,
            nodes_to_quantize,
            nodes_to_exclude,
            op_types_to_quantize,
            extra_options,
        )

    quantizer.quantize_model()
    quantizer.model.save_model_to_file(model_output, use_external_data_format)
    if not pre_processed:
        logging.warning(
            "Please consider pre-processing before quantization. See "
            "https://github.com/microsoft/onnxruntime-inference-examples/blob/main/quantization/image_classification"
            "/cpu/ReadMe.md "
        )

    if extra_options.get("SmoothQuant", False):
        sq_path.cleanup()


def quantize_dynamic(
    model_input: str | Path | onnx.ModelProto,
    model_output: str | Path,
    op_types_to_quantize=None,
    per_channel=False,
    reduce_range=False,
    weight_type=QuantType.QInt8,
    nodes_to_quantize=None,
    nodes_to_exclude=None,
    use_external_data_format=False,
    extra_options=None,
):
    """Given an onnx model, create a quantized onnx model and save it into a file

    Args:
        model_input: file path of model or ModelProto to quantize
        model_output: file path of quantized model
        op_types_to_quantize:
            specify the types of operators to quantize, like ['Conv'] to quantize Conv only.
            It quantizes all supported operators by default.
        per_channel: quantize weights per channel
        reduce_range:
            quantize weights with 7-bits. It may improve the accuracy for some models running on non-VNNI machine,
            especially for per-channel mode
        weight_type:
            quantization data type of weight. Please refer to
            https://onnxruntime.ai/docs/performance/quantization.html for more details on data type selection
        nodes_to_quantize:
            List of nodes names to quantize. When this list is not None only the nodes in this list
            are quantized.
            example:
            [
                'Conv__224',
                'Conv__252'
            ]
        nodes_to_exclude:
            List of nodes names to exclude. The nodes in this list will be excluded from quantization
            when it is not None.
        use_external_data_format: option used for large size (>2GB) model. Set to False by default.
        extra_options:
            key value pair dictionary for various options in different case. Current used:
                extra.Sigmoid.nnapi = True/False  (Default is False)
                ActivationSymmetric = True/False: symmetrize calibration data for activations (default is False).
                WeightSymmetric = True/False: symmetrize calibration data for weights (default is True).
                EnableSubgraph = True/False :
                    Default is False. If enabled, subgraph will be quantized. Dynamic mode currently is supported. Will
                    support more in the future.
                ForceQuantizeNoInputCheck = True/False :
                    By default, some latent operators like maxpool, transpose, do not quantize if their input is not
                    quantized already. Setting to True to force such operator always quantize input and so generate
                    quantized output. Also the True behavior could be disabled per node using the nodes_to_exclude.
                MatMulConstBOnly = True/False:
                    Default is True for dynamic mode. If enabled, only MatMul with const B will be quantized.
    """
    extra_options = extra_options or {}
    nodes_to_exclude = nodes_to_exclude or []
    nodes_to_quantize = nodes_to_quantize or []
    op_types_to_quantize = op_types_to_quantize or []

    mode = QuantizationMode.IntegerOps

    if not op_types_to_quantize or len(op_types_to_quantize) == 0:
        op_types_to_quantize = list(IntegerOpsRegistry.keys())

    model = (
        save_and_reload_model_with_shape_infer(model_input)
        if isinstance(model_input, onnx.ModelProto)
        else load_model_with_shape_infer(Path(model_input))
    )

    pre_processed: bool = model_has_pre_process_metadata(model)
    if not pre_processed:
        logging.warning(
            "Please consider to run pre-processing before quantization. Refer to example: "
            "https://github.com/microsoft/onnxruntime-inference-examples/blob/main/quantization/image_classification"
            "/cpu/ReadMe.md "
        )

    if "MatMulConstBOnly" not in extra_options:
        extra_options["MatMulConstBOnly"] = True

    model = update_opset_version(model, weight_type)

    quantizer = ONNXQuantizer(
        model,
        per_channel,
        reduce_range,
        mode,
        False,  # static
        weight_type,
        QuantType.QUInt8,  # dynamic activation only supports uint8
        None,
        nodes_to_quantize,
        nodes_to_exclude,
        op_types_to_quantize,
        extra_options,
    )

    quantizer.quantize_model()
    quantizer.model.save_model_to_file(model_output, use_external_data_format)


def quantize(
    model_input: str | Path | onnx.ModelProto,
    model_output: str | Path,
    quant_config: QuantConfig,
):
    """Quantize a model with QuantConfig.

    Args:
        model_input (str | Path | ModelProto): Path to the model or ModelProto to quantize.
        model_output (str | Path): Path to save the quantized model.
        quant_config (QuantConfig | WeightOnlyQuantConfig): Quantization Configuration.
    """
    if isinstance(quant_config, StaticQuantConfig):
        quantize_static(
            model_input,
            model_output,
            quant_config.calibration_data_reader,
            calibrate_method=quant_config.calibrate_method,
            quant_format=quant_config.quant_format,
            activation_type=quant_config.activation_type,
            weight_type=quant_config.weight_type,
            op_types_to_quantize=quant_config.op_types_to_quantize,
            nodes_to_quantize=quant_config.nodes_to_quantize,
            nodes_to_exclude=quant_config.nodes_to_exclude,
            per_channel=quant_config.per_channel,
            reduce_range=quant_config.reduce_range,
            use_external_data_format=quant_config.use_external_data_format,
            calibration_providers=quant_config.calibration_providers,
            extra_options=quant_config.extra_options,
        )

    elif isinstance(quant_config, DynamicQuantConfig):
        quantize_dynamic(
            model_input,
            model_output,
            weight_type=quant_config.weight_type,
            op_types_to_quantize=quant_config.op_types_to_quantize,
            nodes_to_quantize=quant_config.nodes_to_quantize,
            nodes_to_exclude=quant_config.nodes_to_exclude,
            per_channel=quant_config.per_channel,
            reduce_range=quant_config.reduce_range,
            use_external_data_format=quant_config.use_external_data_format,
            extra_options=quant_config.extra_options,
        )
    else:
        # training package doesn't has quantize_matmul_4bits, avoid global import
        from .matmul_nbits_quantizer import MatMulNBitsQuantizer, WeightOnlyQuantConfig  # noqa: PLC0415

        if isinstance(quant_config, WeightOnlyQuantConfig):
            model = model_input if isinstance(model_input, onnx.ModelProto) else onnx.load(model_input)
            quant = MatMulNBitsQuantizer(model, algo_config=quant_config)
            quant.process()
            quant.model.save_model_to_file(model_output, True)
        else:
            raise TypeError(
                "Invalid quantization config type, it must be either StaticQuantConfig, "
                "DynamicQuantConfig, or WeightOnlyQuantConfig."
            )
