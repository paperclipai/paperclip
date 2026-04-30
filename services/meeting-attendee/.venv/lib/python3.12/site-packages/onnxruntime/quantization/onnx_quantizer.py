# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
import logging

import numpy as np
import onnx
import onnx.numpy_helper
from onnx import onnx_pb as onnx_proto

from .base_quantizer import BaseQuantizer, QuantizationParams
from .calibrate import TensorData
from .onnx_model import ONNXModel
from .quant_utils import (
    TENSOR_NAME_QUANT_SUFFIX,
    QuantizationMode,
    QuantizedValue,
    QuantizedValueType,
    __producer__,
    __version__,
    add_infer_metadata,
    attribute_to_kwarg,
    compute_scale_zp,
    compute_scale_zp_float8,
    find_by_name,
    get_qmin_qmax_for_qType,
    get_qrange_for_qType,
    ms_domain,
    quantize_onnx_initializer,
    save_and_reload_model_with_shape_infer,
    tensor_proto_to_array,
)
from .registry import CreateOpQuantizer


class ONNXQuantizer(BaseQuantizer):
    def __init__(
        self,
        model,
        per_channel,
        reduce_range,
        mode,
        static,
        weight_qType,
        activation_qType,
        tensors_range,
        nodes_to_quantize,
        nodes_to_exclude,
        op_types_to_quantize,
        extra_options=None,
    ):
        BaseQuantizer.__init__(
            self,
            model,
            per_channel,
            reduce_range,
            weight_qType,
            activation_qType,
            tensors_range,
            nodes_to_quantize,
            nodes_to_exclude,
            op_types_to_quantize,
            extra_options,
        )

        if not static:
            self.model.replace_gemm_with_matmul()
            # We need to update value_infos.
            model = save_and_reload_model_with_shape_infer(self.model.model)
            self.value_infos = {vi.name: vi for vi in model.graph.value_info}
            self.value_infos.update({ot.name: ot for ot in model.graph.output})
            self.value_infos.update({it.name: it for it in model.graph.input})
            self.model = ONNXModel(model)

        self.mode = mode  # QuantizationMode.Value
        self.static = static  # use static quantization for inputs.
        self.fuse_dynamic_quant = self.opset_version > 10

        self.q_matmul_const_b_only = "MatMulConstBOnly" in self.extra_options and self.extra_options["MatMulConstBOnly"]

        self.new_nodes = []
        self.graph_scope = "/"  # for human readable debug information
        self.tensor_names = {}  # in case the shape inference not totally working
        self.tensor_names.update({ot.name: 1 for ot in model.graph.output})
        self.tensor_names.update({it.name: 1 for it in model.graph.input})
        for node in self.model.model.graph.node:
            self.tensor_names.update(dict.fromkeys(node.output, 1))

        if self.mode not in QuantizationMode:
            raise ValueError(f"unsupported quantization mode {self.mode}")

        self.quantization_params = self.calculate_quantization_params()

        # QuantizeRange tensor name and zero tensor name for scale and zero point calculation.
        # Used when static is False
        self.fixed_qrange_uint8_name = "fixed_quantization_range_uint8"
        self.fixed_qrange_int8_name = "fixed_quantization_range_int8"
        # For uint8 data-type, to compute zero point, we subtract rmin from 0 (represented by fixed_zero_name tensor)
        self.fixed_zero_name = "fixed_zero"
        # For int8 data-type, zero point is always zero (respresented by fixed_zero_point_name tensor)
        self.fixed_zero_zp_name = "fixed_zero_zp"

        # Map of all original value names to quantized value names
        self.quantized_value_map = {}
        # some output from nodes will be quantized, yet itself should be treat as existing so
        # no dequantized will be applied when needed later
        self.generated_value_names = self.model.get_non_initializer_inputs()

    # routines for subgraph support
    def quantize_subgraph(self, subgraph, graph_key):
        """
        generate submodel for the subgraph, so that we re-utilize current quantization implementation.
        quantize the submodel
        update subgraph and set it back to node
        """
        warped_model = onnx.helper.make_model(
            subgraph,
            producer_name="onnx-quantizer",
            opset_imports=self.model.model.opset_import,
        )
        add_infer_metadata(warped_model)
        sub_quantizer = ONNXQuantizer(
            warped_model,
            self.per_channel,
            self.reduce_range,
            self.mode,
            self.static,
            self.weight_qType,
            self.activation_qType,
            self.tensors_range,
            self.nodes_to_quantize,
            self.nodes_to_exclude,
            self.op_types_to_quantize,
            self.extra_options,
        )
        sub_quantizer.parent = self
        sub_quantizer.graph_scope = f"{self.graph_scope}{graph_key}/"
        sub_quantizer.quantize_model()
        return sub_quantizer.model.model.graph

    def quantize_node_with_sub_graph(self, node):
        """
        Check subgraph, if any, quantize it and replace it.
        return new_nodes added for quantizing subgraph
        """
        graph_attrs = [
            attr
            for attr in node.attribute
            if attr.type == onnx.AttributeProto.GRAPH or attr.type == onnx.AttributeProto.GRAPHS
        ]
        if len(graph_attrs) == 0:
            return node
        node_name = node.name if node.name else f"{node.op_type}_node_count_{len(self.new_nodes)}"
        kwargs = {}
        for attr in node.attribute:
            if attr.type == onnx.AttributeProto.GRAPH:
                kv = {attr.name: self.quantize_subgraph(attr.g, f"{node_name}:{attr.name}")}
            elif attr.type == onnx.AttributeProto.GRAPHS:
                value = []
                for subgraph in attr.graphs:
                    value.extend(
                        [
                            self.quantize_subgraph(
                                subgraph,
                                f"{node_name}:{attr.name}:{len(value)}",
                            )
                        ]
                    )
                kv = {attr.name: value}
            else:
                kv = attribute_to_kwarg(attr)
            kwargs.update(kv)
        return onnx.helper.make_node(node.op_type, node.input, node.output, name=node.name, **kwargs)

    def has_QDQ_nodes(self):  # noqa: N802
        """
        Detect if model already has QuantizeLinear or DequantizeLinear.
        """
        return any(
            node.op_type == "QuantizeLinear" or node.op_type == "DequantizeLinear" for node in self.model.nodes()
        )

    def find_initializer_in_path(self, initializer_name):
        if find_by_name(initializer_name, self.model.initializer()) is not None:
            return True
        if self.parent is not None:
            return self.parent.find_initializer_in_path(initializer_name)
        return False

    def add_new_nodes(self, nodes):
        self.new_nodes.extend(nodes)
        for node in nodes:
            for output_name in node.output:
                self.generated_value_names.add(output_name)

    def quantize_model(self):
        if self.has_QDQ_nodes():
            logging.warning(
                "Please check if the model is already quantized. "
                "Note you don't need to quantize a QAT model. OnnxRuntime support to run QAT model directly."
            )

        for node in self.model.nodes():
            # quantize subgraphes if have
            if self.enable_subgraph_quantization:
                node = self.quantize_node_with_sub_graph(node)  # noqa: PLW2901

            number_of_existing_new_nodes = len(self.new_nodes)
            op_quantizer = CreateOpQuantizer(self, node)
            op_quantizer.quantize()
            for i in range(number_of_existing_new_nodes, len(self.new_nodes)):
                for output_name in self.new_nodes[i].output:
                    self.generated_value_names.add(output_name)

        self._dequantize_outputs()

        # extend is used to append to the list for a protobuf fields
        # https://developers.google.com/protocol-buffers/docs/reference/python-generated?csw=1#fields
        self.model.graph().ClearField("node")
        self.model.graph().node.extend(self.new_nodes)

        # Remove ununsed initializers from graph, starting from the top level graph.
        if self.parent is None:
            _, initializers_not_found = self.model.clean_initializers()
            if len(initializers_not_found) > 0:
                raise RuntimeError("Invalid model with unknown initializers/tensors." + str(initializers_not_found))

        self.model.model.producer_name = __producer__
        self.model.model.producer_version = __version__
        # Add ms domain if needed
        ms_opset = [opset for opset in self.model.model.opset_import if opset.domain == ms_domain]
        if not ms_opset:
            ms_nodes = [node for node in self.new_nodes if node.domain == "com.microsoft"]
            if ms_nodes:
                opset = self.model.model.opset_import.add()
                opset.version = 1
                opset.domain = ms_domain

        return self.model.model

    def _get_default_tensor_type(self, tensor_name):
        if "DefaultTensorType" in self.extra_options:
            logging.info(
                "get_tensor_type returns DefaultTensorType for tensor name %r, use %d",
                tensor_name,
                self.extra_options["DefaultTensorType"],
            )
            return self.extra_options["DefaultTensorType"]
        raise RuntimeError(
            f"Unable to find data type for weight_name={tensor_name!r}. "
            f"shape_inference failed to return a type probably this node is "
            f"from a different domain or using an input produced by such an operator. "
            f"This may happen if you quantize a model already quantized. "
            f"You may use extra_options `DefaultTensorType` to indicate "
            f"the default weight type, usually `onnx.TensorProto.FLOAT`."
        )

    def get_tensor_type(self, tensor_name, mandatory=False):
        weight = find_by_name(tensor_name, self.model.initializer())
        if weight is not None:
            return weight.data_type
        if tensor_name in self.value_infos:
            vi = self.value_infos[tensor_name]
            if vi.type.HasField("tensor_type"):
                if mandatory and vi.type.tensor_type.elem_type == 0:
                    return self._get_default_tensor_type(tensor_name)
                return vi.type.tensor_type.elem_type
        if (not self.enable_subgraph_quantization) or (self.parent is None):
            if mandatory:
                return self._get_default_tensor_type(tensor_name)
            return None
        otype = self.parent.is_valid_quantize_weight(tensor_name)
        if otype is not None:
            return otype
        if self.enable_subgraph_quantization and self.parent:
            res = self.parent.get_tensor_type(tensor_name)
            if res is not None:
                return res
        if mandatory:
            return self._get_default_tensor_type(tensor_name)
        return None

    def is_float_tensor(self, tensor_name):
        if self.is_input_a_initializer(tensor_name):
            return self.is_valid_quantize_weight(tensor_name)

        if tensor_name in self.value_infos:
            vi = self.value_infos[tensor_name]
            if vi.type.HasField("tensor_type") and vi.type.tensor_type.elem_type in (
                onnx_proto.TensorProto.FLOAT,
                onnx_proto.TensorProto.FLOAT16,
            ):
                return True
            logging.warning(
                f"Inference failed or unsupported type to quantize for tensor {tensor_name!r}, type is {vi.type}."
            )
            return False

        if self.enable_subgraph_quantization and self.parent:
            return self.parent.is_float_tensor(tensor_name)

        logging.warning(
            f"Failed to infer data type of tensor: {tensor_name!r}. Please add data type info for this tensor "
            f"if your model has customized operators."
        )
        return False

    def _get_dynamic_input_quantization_params(self, input_name, nodes_list, qType, initial_type):
        """
        Create nodes for dynamic quantization of input and add them to nodes_list.
            parameter input_name: Name of the input.
            parameter nodes_list: new nodes are appended to this list.
            parameter qType: type to quantize to.
            parameter initial_type: type to quantize from
            return: scale_name, zero_point_name, scale_shape, zero_point_shape.
        """
        if qType == onnx_proto.TensorProto.INT8:
            return self._get_dynamic_input_quantization_params_int8(input_name, nodes_list, initial_type)
        if qType == onnx_proto.TensorProto.UINT8:
            return self._get_dynamic_input_quantization_params_uint8(input_name, nodes_list, initial_type)
        raise ValueError(f"Unexpected value for qType={qType}.")

    def _get_dynamic_input_quantization_params_int8(self, input_name, nodes_list, initial_type):
        """
        Create nodes for dynamic quantization of input to int8 and add them to nodes_list
            parameter input_name: Name of the input.
            parameter nodes_list: new nodes are appended to this list.
            parameter initial_type: initial weight type (FLOAT or FLOAT16)
            return: scale_name, zero_point_name, scale_shape, zero_point_shape.
        """
        qType = onnx_proto.TensorProto.INT8  # noqa: N806

        # Reduce min and Reduce max
        input_scale_name = input_name + "_scale"

        reduce_min_name = input_name + "_ReduceMin"
        reduce_min_node = onnx.helper.make_node(
            "ReduceMin",
            [input_name],
            [reduce_min_name + ":0"],
            reduce_min_name,
            keepdims=0,
        )
        nodes_list.append(reduce_min_node)

        reduce_max_name = input_name + "_ReduceMax"
        reduce_max_node = onnx.helper.make_node(
            "ReduceMax",
            [input_name],
            [reduce_max_name + ":0"],
            reduce_max_name,
            keepdims=0,
        )
        nodes_list.append(reduce_max_node)

        # Compute scale
        #   Find abs(rmin)
        reduce_min_abs_name = reduce_min_name + "_Abs"
        reduce_min_abs_node = onnx.helper.make_node(
            "Abs",
            [reduce_min_node.output[0]],
            [reduce_min_abs_name + ":0"],
            reduce_min_abs_name,
        )
        nodes_list.append(reduce_min_abs_node)
        #   Find abs(rmax)
        reduce_max_abs_name = reduce_max_name + "_Abs"
        reduce_max_abs_node = onnx.helper.make_node(
            "Abs",
            [reduce_max_node.output[0]],
            [reduce_max_abs_name + ":0"],
            reduce_max_abs_name,
        )
        nodes_list.append(reduce_max_abs_node)
        #   Compute max of abs(rmin) and abs(rmax)
        abs_max_name = input_name + "_Abs_Max"
        abs_max_node = onnx.helper.make_node(
            "Max",
            [reduce_min_abs_node.output[0], reduce_max_abs_node.output[0]],
            [abs_max_name + ":0"],
            abs_max_name,
        )
        nodes_list.append(abs_max_node)
        #   and divide by (quantize_range/2.0) which will be equal to max(...)*2.0/quantize_range
        initializer_div = onnx.helper.make_tensor(
            self.fixed_qrange_int8_name,
            initial_type,
            [],
            [get_qrange_for_qType(qType) / 2.0],
        )
        self.model.add_initializer(initializer_div)
        scale_div_name = input_name + "scale_Div"
        scale_div_node = onnx.helper.make_node(
            "Div",
            [abs_max_node.output[0], self.fixed_qrange_int8_name],
            [input_scale_name],
            scale_div_name,
        )
        nodes_list.append(scale_div_node)

        # Zero point
        initializer_zp = onnx.helper.make_tensor(self.fixed_zero_zp_name, qType, [], [0])
        self.model.add_initializer(initializer_zp)

        return input_scale_name, self.fixed_zero_zp_name, [], []

    def _get_dynamic_input_quantization_params_uint8(self, input_name, nodes_list, initial_type):
        """
        Create nodes for dynamic quantization of input to uint8 and add them to nodes_list
            parameter input_name: Name of the input.
            parameter nodes_list: new nodes are appended to this list.
            parameter initial_type: initial weight type (FLAOT or FLOAT16)
            return: scale_name, zero_point_name, scale_shape, zero_point_shape.
        """
        qType = onnx_proto.TensorProto.UINT8  # noqa: N806
        # Reduce min and Reduce max
        input_scale_name = input_name + "_scale"
        input_zp_name = input_name + "_zero_point"

        reduce_min_name = input_name + "_ReduceMin"
        reduce_min_node = onnx.helper.make_node(
            "ReduceMin",
            [input_name],
            [reduce_min_name + ":0"],
            reduce_min_name,
            keepdims=0,
        )
        nodes_list.append(reduce_min_node)

        reduce_max_name = input_name + "_ReduceMax"
        reduce_max_node = onnx.helper.make_node(
            "ReduceMax",
            [input_name],
            [reduce_max_name + ":0"],
            reduce_max_name,
            keepdims=0,
        )
        nodes_list.append(reduce_max_node)

        # Add tensors for quantize range and zero value.
        initializer_qrange = onnx.helper.make_tensor(
            self.fixed_qrange_uint8_name,
            initial_type,
            [],
            [get_qrange_for_qType(qType)],
        )
        self.model.add_initializer(initializer_qrange)
        initializer_qvalue = onnx.helper.make_tensor(self.fixed_zero_name, initial_type, [], [0.0])
        self.model.add_initializer(initializer_qvalue)

        # Compute Scale
        #   Subtract rmax and rmin
        scale_sub_name = input_name + "_scale_Sub"
        scale_sub_node = onnx.helper.make_node(
            "Sub",
            [reduce_max_node.output[0], reduce_min_node.output[0]],
            [scale_sub_name + ":0"],
            scale_sub_name,
        )
        nodes_list.append(scale_sub_node)
        #   and divide by quantize range
        scale_div_name = input_name + "_scale_Div"
        scale_div_node = onnx.helper.make_node(
            "Div",
            [scale_sub_node.output[0], self.fixed_qrange_uint8_name],
            [input_scale_name],
            scale_div_name,
        )
        nodes_list.append(scale_div_node)

        # Compute zero point
        #   Subtract zero and rmin
        zp_sub_name = input_name + "_zero_point_Sub"
        zp_sub_node = onnx.helper.make_node(
            "Sub",
            [self.fixed_zero_name, reduce_min_node.output[0]],
            [zp_sub_name + ":0"],
            zp_sub_name,
        )
        nodes_list.append(zp_sub_node)
        #   Divide by scale
        zp_div_name = input_name + "_zero_point_Div"
        zp_div_node = onnx.helper.make_node(
            "Div",
            [zp_sub_node.output[0], input_scale_name],
            [zp_div_name + ":0"],
            zp_div_name,
        )
        nodes_list.append(zp_div_node)
        #   Compute floor
        zp_floor_name = input_name + "_zero_point_Floor"
        zp_floor_node = onnx.helper.make_node("Floor", zp_div_node.output, [zp_floor_name + ":0"], zp_floor_name)
        nodes_list.append(zp_floor_node)
        #   Cast to integer
        zp_cast_name = input_name + "_zero_point_Cast"
        zp_cast_node = onnx.helper.make_node("Cast", zp_floor_node.output, [input_zp_name], zp_cast_name, to=qType)
        nodes_list.append(zp_cast_node)

        return input_scale_name, input_zp_name, [], []

    def _get_quantization_params(self, param_name, use_scale=None, use_zeropoint=None):
        """
        Create initializers and inputs in the graph for zero point and scale of output.
        Zero point and scale values are obtained from self.quantization_params if specified.
            parameter param_name: Name of the quantization parameter.
            return: result, scale_name, zero_point_name, scale_shape, zero_point_shape.
        """
        zero_point_type = self.activation_qType

        if use_scale is None or use_zeropoint is None:
            if self.quantization_params is None or param_name not in self.quantization_params:
                logging.info(f'Quantization parameters for tensor:"{param_name}" not specified')
                return False, "", "", "", ""

            params = self.quantization_params[param_name]
            if not isinstance(params, QuantizationParams):
                raise TypeError(f"Unexpected type {type(params)} for {param_name!r}.")
            if params is None or len(params) != 3:
                raise ValueError(
                    "Quantization parameters should contain zero point, scale, quant type. "
                    f"Specified values for output {param_name}: {params}"
                )

            zero_point_values = np.array([params["zero_point"]])
            if not hasattr(params["scale"], "dtype") or params["scale"].dtype not in (np.float32, np.float16):
                raise ValueError(f"Unexpected type {type(params['scale'])} and param_name={param_name!r}")
            scale_values = np.array([params["scale"]])
            assert scale_values.dtype != np.float64
            zero_point_type = params["quant_type"]
        else:
            zero_point_values = np.array([use_zeropoint])
            scale_values = np.array([use_scale])
            params = self.quantization_params[param_name]
            if "scale" in params:
                dtype = params["scale"].dtype
                scale_values = scale_values.astype(dtype)
            assert scale_values.dtype != np.float64

        zero_point_shape = []
        zero_point_name = param_name + "_zero_point"
        scale_shape = []
        scale_name = param_name + "_scale"

        # Add initializers
        init_zp = onnx.helper.make_tensor(
            zero_point_name, zero_point_type, zero_point_shape, zero_point_values.ravel().tolist()
        )
        self.model.add_initializer(init_zp)
        if scale_values.dtype == np.float32:
            scale_type = onnx_proto.TensorProto.FLOAT
        elif scale_values.dtype == np.float16:
            scale_type = onnx_proto.TensorProto.FLOAT16
        else:
            raise ValueError(f"Unexpected dtype={scale_values.dtype} for param_name={param_name!r}")
        init_scale = onnx.helper.make_tensor(scale_name, scale_type, scale_shape, scale_values.reshape((-1,)).tolist())
        self.model.add_initializer(init_scale)

        return True, scale_name, zero_point_name, scale_shape, zero_point_shape

    def _get_quantize_input_nodes(
        self, node, input_index, qType, given_scale_name=None, given_zp_name=None, initial_type=None
    ):
        """
        Given an input for a node (which is not a initializer), this function

        - add nodes to compute zero point and scale for this input if they don't exist.
        - add new QuantizeLinear node to quantize the input.

        :param node: node being quantized in NodeProto format.
        :param input_index: index of input in node.input.
        :param qType: type to quantize to.
        :param given_scale_name: if those inputs need to be quanitzed using this scale tensor.
        :param given_zp_name: if those inputs to be quantized using this zeropoint tensor.
        :param initial_type: type of the weight to quantize
        :return: List of newly created nodes in NodeProto format.
        """
        input_name = node.input[input_index]
        assert input_name != "", "Cannot access undefined variable in graph."
        output_name = input_name + TENSOR_NAME_QUANT_SUFFIX
        ql_node_name = input_name + "_QuantizeLinear"

        if (given_scale_name is not None) and (given_zp_name is not None):
            data_found, scale_name, zp_name = (True, given_scale_name, given_zp_name)
        else:
            data_found, scale_name, zp_name, _, _ = self._get_quantization_params(input_name)

        nodes = []
        if data_found:
            qlinear_node = onnx.helper.make_node(
                "QuantizeLinear",
                [input_name, scale_name, zp_name],
                [output_name],
                ql_node_name,
            )
        else:
            if self.static:
                return None
            # dynamic mode
            # Scale and Zero Points not available for this input. Add nodes to dynamically compute it
            if self.fuse_dynamic_quant and qType == onnx_proto.TensorProto.UINT8:
                scale_name = input_name + "_scale"
                zp_name = input_name + "_zero_point"
                qlinear_node = onnx.helper.make_node(
                    "DynamicQuantizeLinear",
                    [input_name],
                    [output_name, scale_name, zp_name],
                    ql_node_name,
                )
            else:
                assert initial_type is not None, (
                    f"Cannot quantize input without knowing the initial type, "
                    f"input_name={input_name!r}, input_index={input_index}, qType={qType}, node={node}"
                )
                (
                    scale_name,
                    zp_name,
                    scale_shape,
                    zp_shape,
                ) = self._get_dynamic_input_quantization_params(input_name, nodes, qType, initial_type=initial_type)
                qlinear_node = onnx.helper.make_node(
                    "QuantizeLinear",
                    [input_name, scale_name, zp_name],
                    [output_name],
                    ql_node_name,
                )

        self.quantized_value_map[input_name] = QuantizedValue(input_name, output_name, scale_name, zp_name, qType)
        return [*nodes, qlinear_node]

    def find_quantized_value(self, input_name):
        if input_name in self.quantized_value_map:
            return self.quantized_value_map[input_name]
        if self.parent is not None:
            return self.parent.find_quantized_value(input_name)
        return None

    def adjust_single_weight_scale_if_needed(
        self,
        bias_val,
        input_scale,
        weight_scale,
        weight_scale_dtype,
        weight_name,
        bias_name,
        qrange,
        multiplicative_epsilon,
        idx=None,
    ):
        """Adjust a single weight scale to ensure the int32 bias does not overflow."""
        absmax = np.abs(bias_val)
        bias_smallest_valid_scale = multiplicative_epsilon * (2.0 * absmax) / qrange

        input_scale_fp64 = np.array(input_scale.item(), dtype=np.float64)
        weight_scale_fp64 = np.array(weight_scale.item(), dtype=np.float64)
        bias_candidate_scale = input_scale_fp64 * weight_scale_fp64

        if (bias_candidate_scale < bias_smallest_valid_scale) and (bias_candidate_scale > 0.0):
            ratio = bias_smallest_valid_scale / bias_candidate_scale
            new_scale = weight_scale_fp64 * ratio
            if idx is None:
                logging.info(
                    f"Increasing scale for weight `{weight_name}` by the ratio {ratio} to "
                    f"ensure bias `{bias_name}` has a valid scale."
                )
                return True, np.array(new_scale, dtype=weight_scale_dtype)
            else:
                logging.info(
                    f"Increased scale[{idx}] for weight `{weight_name}` by ratio {ratio} "
                    f"to ensure bias `{bias_name}` has a valid scale."
                )
                return True, new_scale.astype(weight_scale_dtype)
        return False, weight_scale

    def _adjust_weight_scale_for_int32_bias(
        self,
        input_scale: np.ndarray,
        weight_scale: np.ndarray,
        weight_name: str,
        bias_tp: onnx.TensorProto,
        is_per_channel: bool,
    ) -> tuple[bool, np.ndarray | None]:
        """Checks if the bias scale is too small and increases the weight scale if needed."""

        if not weight_scale.size:
            return False, None

        bias_float_data = tensor_proto_to_array(bias_tp)
        int32_info = np.iinfo(np.int32)
        multiplicative_epsilon = 1.0001
        qrange = np.array(int32_info.max, dtype=np.float64) - np.array(int32_info.min + 1, dtype=np.float64)
        weight_scale_dtype = weight_scale.dtype
        updated = False

        if not is_per_channel:
            rmin = np.minimum(bias_float_data.min(), np.array(0, dtype=np.float64))
            rmax = np.maximum(bias_float_data.max(), np.array(0, dtype=np.float64))
            absmax = np.maximum(np.abs(rmin), np.abs(rmax))
            changed, new_scale = self.adjust_single_weight_scale_if_needed(
                absmax,
                input_scale,
                weight_scale,
                weight_scale_dtype,
                weight_name,
                bias_tp.name,
                qrange,
                multiplicative_epsilon,
            )
            if changed:
                weight_scale = new_scale
                updated = True
        elif weight_scale.shape and len(weight_scale.shape) == 1:
            for i in range(weight_scale.shape[0]):
                changed, new_scale = self.adjust_single_weight_scale_if_needed(
                    bias_float_data[i],
                    input_scale,
                    weight_scale[i],
                    weight_scale_dtype,
                    weight_name,
                    bias_tp.name,
                    qrange,
                    multiplicative_epsilon,
                    idx=i,
                )
                if changed:
                    weight_scale[i] = new_scale
                    updated = True

        return updated, weight_scale

    def _requantize_weight(self, weight_name: str, new_scale: np.ndarray) -> None:
        """Re-quantizes the given weight initializer using the provided scale."""

        if weight_name not in self.quantized_value_map:
            return

        qv = self.quantized_value_map[weight_name]

        weight_tp = find_by_name(weight_name, self.model.initializer())
        scale_init = find_by_name(qv.scale_name, self.model.initializer())
        zp_init = find_by_name(qv.zp_name, self.model.initializer())
        q_weight_init = find_by_name(qv.q_name, self.model.initializer())

        if weight_tp is None or scale_init is None or zp_init is None or q_weight_init is None:
            return

        self.model.remove_initializer(scale_init)
        self.model.remove_initializer(q_weight_init)

        weight_zero_point = onnx.numpy_helper.to_array(zp_init)
        axis = qv.axis

        # Add new scale initializer
        scale_np = np.asarray(new_scale, dtype=onnx.helper.tensor_dtype_to_np_dtype(weight_tp.data_type))
        new_scale_init = onnx.numpy_helper.from_array(scale_np.reshape(scale_init.dims), qv.scale_name)
        self.model.add_initializer(new_scale_init)

        # Add new quantized weight initializer
        new_q_weight = quantize_onnx_initializer(
            weight_tp,
            self.weight_qType,
            weight_zero_point,
            scale_np,
            axis,
            quant_weight_name=qv.q_name,
        )
        self.model.add_initializer(new_q_weight)

    def quantize_bias_static(self, bias_name, input_name, weight_name, beta=1.0):
        """
        Quantized the bias. Zero Point == 0 and Scale == Input_Scale * Weight_Scale
        """

        # Handle case where bias already in quantization map
        if bias_name in self.quantized_value_map:
            return self.quantized_value_map[bias_name].q_name

        # get scale for weight
        weight_scale_name = self.quantized_value_map[weight_name].scale_name
        weight_initializer = find_by_name(weight_scale_name, self.model.initializer())
        weight_scale = tensor_proto_to_array(weight_initializer)

        # get scale for input
        if input_name in self.quantized_value_map:
            input_scale_name = self.quantized_value_map[input_name].scale_name
        elif input_name in self.quantization_params:
            _, input_scale_name, _, _, _ = self._get_quantization_params(input_name)
        else:
            raise ValueError(f"Expected {input_name} to be in quantized value map for static quantization")

        inputscale_initializer = find_by_name(input_scale_name, self.model.initializer())
        input_scale = tensor_proto_to_array(inputscale_initializer)

        # Adjust weight scale if quantizing to int32 may overflow due to a small scale
        weight_zp_name = self.quantized_value_map[weight_name].zp_name
        weight_zp_init = find_by_name(weight_zp_name, self.model.initializer())
        weight_zero_point = onnx.numpy_helper.to_array(weight_zp_init) if weight_zp_init is not None else None
        is_per_channel = self.per_channel
        if (
            weight_zero_point is not None
            and weight_zero_point.size
            and not weight_zero_point.any()
            and self.weight_qType in (onnx_proto.TensorProto.INT8,)
        ):
            bias_initializer = find_by_name(bias_name, self.model.initializer())
            did_update, new_weight_scale = self._adjust_weight_scale_for_int32_bias(
                input_scale,
                weight_scale,
                weight_name,
                bias_initializer,
                is_per_channel,
            )
            if did_update:
                self._requantize_weight(weight_name, new_weight_scale)
                weight_scale = new_weight_scale

        (
            quantized_bias_name,
            quantized_bias_scale_name,
            quantized_bias_zp_name,
            bias_scale_data,
            node_type,
            node_qtype,
        ) = self.quantize_bias_static_impl(bias_name, input_scale, weight_scale, beta)

        assert bias_name not in self.quantized_value_map
        quantized_value = QuantizedValue(
            bias_name,
            quantized_bias_name,
            quantized_bias_scale_name,
            quantized_bias_zp_name,
            QuantizedValueType.Initializer,
            0 if bias_scale_data.size > 1 else None,
            node_type=node_type,
            node_qtype=node_qtype,
        )
        self.quantized_value_map[bias_name] = quantized_value

        return quantized_bias_name

    def contains_tensor(self, tensor_name):
        """
        only check for value info and newly generated tensor names, initializers are checked separately
        """
        return (
            (tensor_name in self.value_infos)
            or (tensor_name in self.tensor_names)
            or (tensor_name in self.generated_value_names)
        )

    def quantize_activation(self, node, indices, from_subgraph=False):
        return self.__quantize_inputs(
            node=node,
            indices=indices,
            initializer_use_weight_qType=False,
            reduce_range=False,
            op_level_per_channel=False,
            axis=-1,
            from_subgraph=from_subgraph,
        )

    # In some circumstances a weight is not an initializer, for example of MatMul, if both A and B are not
    # initializer, B can still be considered as Weight
    def quantize_weight(
        self,
        node,
        indices,
        reduce_range=False,
        op_level_per_channel=False,
        axis=-1,
        from_subgraph=False,
    ):
        return self.__quantize_inputs(
            node=node,
            indices=indices,
            initializer_use_weight_qType=True,
            reduce_range=reduce_range,
            op_level_per_channel=op_level_per_channel,
            axis=axis,
            from_subgraph=from_subgraph,
        )

    def __quantize_inputs(
        self,
        node,
        indices,
        initializer_use_weight_qType=True,
        reduce_range=False,
        op_level_per_channel=False,
        axis=-1,
        from_subgraph=False,
    ):
        """
        Given a node, this function quantizes the inputs as follows:
            - If input is an initializer, quantize the initializer data, replace old initializer
              with new initializer
            - Else, add QuantizeLinear nodes to perform quantization
            parameter node: node being quantized in NodeProto format.
            parameter indices: input indices to quantize.
            return: (List of quantized input names,
                     List of zero point names used for input quantization,
                     List of scale names used for input quantization,
                     List of new QuantizeLinear nodes created)
        """

        scale_names = []
        zero_point_names = []
        quantized_input_names = []
        nodes = []

        for input_index in indices:
            node_input = node.input[input_index]

            # Find if this input is already quantized
            if node_input in self.quantized_value_map:
                quantized_value = self.quantized_value_map[node_input]
                scale_names.append(quantized_value.scale_name)
                zero_point_names.append(quantized_value.zp_name)
                quantized_input_names.append(quantized_value.q_name)
                continue
            # adding this for case embed_layernorm.py has optional segment_embedding
            if not node_input:
                quantized_input_names.append("")
                scale_names.append("")
                zero_point_names.append("")
                continue
            # Quantize the input
            initializer = find_by_name(node_input, self.model.initializer())
            if initializer is not None:
                if self.per_channel and op_level_per_channel:
                    (
                        q_weight_name,
                        zp_name,
                        scale_name,
                    ) = self.quantize_weight_per_channel(
                        initializer.name,
                        self.weight_qType if initializer_use_weight_qType else self.activation_qType,
                        axis,
                        reduce_range,
                    )
                else:
                    q_weight_name, zp_name, scale_name = self.quantize_initializer(
                        initializer,
                        self.weight_qType if initializer_use_weight_qType else self.activation_qType,
                        reduce_range,
                    )

                quantized_input_names.append(q_weight_name)
                zero_point_names.append(zp_name)
                scale_names.append(scale_name)
            elif self.contains_tensor(node_input):
                # Add QuantizeLinear node.
                qlinear_node = self.model.find_node_by_name(
                    node_input + "_QuantizeLinear", self.new_nodes, self.model.graph()
                )
                if qlinear_node is None:
                    input_name = node.input[input_index]
                    if input_name in self.value_infos:
                        value_info = self.value_infos[input_name]
                        assert value_info.HasField("type"), f"value_info={value_info} has no type."
                        assert value_info.type.HasField("tensor_type"), f"value_info={value_info} is not a tensor."
                        initial_type = value_info.type.tensor_type.elem_type
                    else:
                        # Shape inference failed. Fallback to self.tensor_names.
                        assert input_name in self.tensor_names, (
                            f"shape inference failed for {input_name!r} and "
                            f"attribute 'tensor_names' does not have any value for "
                            f"this tensor."
                        )
                        initial_type = self.tensor_names[input_name]
                    quantize_input_nodes = self._get_quantize_input_nodes(
                        node, input_index, self.activation_qType, initial_type=initial_type
                    )
                    if quantize_input_nodes is None:
                        return (None, None, None, None)
                    if from_subgraph:
                        self.add_new_nodes(quantize_input_nodes)
                    else:
                        nodes.extend(quantize_input_nodes)
                    qlinear_node = quantize_input_nodes[-1]

                if qlinear_node.op_type == "QuantizeLinear":
                    quantized_input_names.extend(qlinear_node.output)
                    scale_names.append(qlinear_node.input[1])
                    zero_point_names.append(qlinear_node.input[2])
                else:
                    quantized_input_names.append(qlinear_node.output[0])
                    scale_names.append(qlinear_node.output[1])
                    zero_point_names.append(qlinear_node.output[2])
            elif self.parent is not None:
                (
                    parent_quantized_input_names,
                    parent_zero_point_names,
                    parent_scale_names,
                    _,
                ) = self.parent.__quantize_inputs(
                    node,
                    [input_index],
                    initializer_use_weight_qType=initializer_use_weight_qType,
                    reduce_range=reduce_range,
                    op_level_per_channel=op_level_per_channel,
                    axis=axis,
                    from_subgraph=True,
                )
                quantized_input_names.append(parent_quantized_input_names[0])
                scale_names.append(parent_scale_names[0])
                zero_point_names.append(parent_zero_point_names[0])
                # node should not be add this child level here
            else:
                raise ValueError(f"Invalid tensor name to quantize: {node_input} @graph scope{self.graph_scope}")

        return quantized_input_names, zero_point_names, scale_names, nodes

    def quantize_initializer(self, weight, qType, reduce_range=False, keep_float_weight=False):
        """
        :param weight: TensorProto initializer
        :param qType: type to quantize to
        :param keep_float_weight: Whether to quantize the weight. In some cases, we only want to qunatize scale and zero point.
                                  If keep_float_weight is False, quantize the weight, or don't quantize the weight.
        :return: quantized weight name, zero point name, scale name
        """
        # Find if this input is already quantized
        if weight.name in self.quantized_value_map:
            quantized_value = self.quantized_value_map[weight.name]
            return (
                quantized_value.q_name,
                quantized_value.zp_name,
                quantized_value.scale_name,
            )

        q_weight_name, zp_name, scale_name = self.quantize_initializer_impl(
            weight, qType, reduce_range, keep_float_weight
        )

        # Log entry for this quantized weight
        quantized_value = QuantizedValue(
            weight.name,
            q_weight_name,
            scale_name,
            zp_name,
            QuantizedValueType.Initializer,
            None,
        )
        self.quantized_value_map[weight.name] = quantized_value
        return q_weight_name, zp_name, scale_name

    def quantize_weight_per_channel(
        self,
        weight_name,
        weight_qType,
        channel_axis,
        reduce_range=True,
        keep_float_weight=False,
    ):
        # Find if this input is already quantized
        if weight_name in self.quantized_value_map:
            quantized_value = self.quantized_value_map[weight_name]
            return (
                quantized_value.q_name,
                quantized_value.zp_name,
                quantized_value.scale_name,
            )

        q_weight_name, zp_name, scale_name = self.quantize_weight_per_channel_impl(
            weight_name, weight_qType, channel_axis, reduce_range, keep_float_weight
        )
        quantized_value = QuantizedValue(
            weight_name,
            q_weight_name,
            scale_name,
            zp_name,
            QuantizedValueType.Initializer,
            None,
        )
        self.quantized_value_map[weight_name] = quantized_value

        return q_weight_name, zp_name, scale_name

    def _dequantize_value(self, value_name):
        """
        Given a value (input/output) which is quantized, add a DequantizeLinear node to dequantize
        it back to float32 or float16
            parameter value_name: value to dequantize
            parameter new_nodes_list: List of new nodes created before processing current node
            return: None if there is already a DequantizeLinear node that dequantizes it
                    A DequantizeLinear node otherwise
        """
        if (value_name in self.quantized_value_map) and (value_name not in self.generated_value_names):
            quantized_value = self.quantized_value_map[value_name]
            # Add DequantizeLinear Node for this input

            scale_init = find_by_name(quantized_value.scale_name, self.model.initializer())

            # In case we are working with subgraphs, the graph `producer_name` is set to `"onnx-quantizer"` in the `quantize_subgraph` method. In this case, the scale initializer may be on the top level graph, so the check below can not be done.
            if self.model.model.producer_name != "onnx-quantizer" or (
                self.model.model.producer_name == "onnx-quantizer" and scale_init is not None
            ):
                # axis is not specified so scale_init must be a scalar.
                assert scale_init is None or onnx.numpy_helper.to_array(scale_init).size == 1

            dqlinear_name = value_name + "_DequantizeLinear"
            dqlinear_node = self.model.find_node_by_name(dqlinear_name, self.new_nodes, self.model.graph())
            if dqlinear_node is None:
                dqlinear_inputs = [
                    quantized_value.q_name,
                    quantized_value.scale_name,
                    quantized_value.zp_name,
                ]
                dequantize_node = onnx.helper.make_node(
                    "DequantizeLinear", dqlinear_inputs, [value_name], dqlinear_name
                )
                return dequantize_node
            else:
                # DQ op is already present, assert it's output matches the input of current node
                assert value_name == dqlinear_node.output[0]
        return None

    def _dequantize_outputs(self):
        """
        Dequantize output if it is quantized
            parameter new_nodes_list: List of new nodes created before processing current node
            return: List of new nodes created
        """

        for output in self.model.graph().output:
            dequantize_node = self._dequantize_value(output.name)
            if dequantize_node is not None:
                self.new_nodes.append(dequantize_node)

    def calculate_quantization_params(self):
        if self.tensors_range is None:
            return None

        self.adjust_tensor_ranges()

        quantization_params = {}
        for tensor_name in self.tensors_range:
            td = self.tensors_range[tensor_name]
            if not isinstance(td, TensorData):
                raise TypeError(f"Unexpected type {type(td)} for {tensor_name!r}.")

            quant_overrides = self.tensor_quant_overrides.get_per_tensor_overrides(tensor_name, default_val={})

            quant_type = self.activation_qType
            if "quant_type" in quant_overrides:
                quant_type = quant_overrides["quant_type"].tensor_type

            if "scale" in quant_overrides and "zero_point" in quant_overrides:
                zero, scale = quant_overrides["zero_point"], quant_overrides["scale"]
            elif quant_type == onnx.TensorProto.FLOAT8E4M3FN:
                zero, scale = compute_scale_zp_float8(quant_type, td.avg_std[1])
            else:
                rmin = quant_overrides.get("rmin", td.range_value[0])
                rmax = quant_overrides.get("rmax", td.range_value[1])
                symmetric = quant_overrides.get("symmetric", self.is_activation_symmetric)
                reduce_range = quant_overrides.get("reduce_range", False)
                qmin, qmax = get_qmin_qmax_for_qType(quant_type, reduce_range=reduce_range, symmetric=symmetric)
                zero, scale = compute_scale_zp(rmin, rmax, qmin, qmax, symmetric, self.min_real_range)

            quantization_params[tensor_name] = QuantizationParams(zero_point=zero, scale=scale, quant_type=quant_type)

        return quantization_params
