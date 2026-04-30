import numpy as np
import onnx
from onnx import onnx_pb as onnx_proto

from ..quant_utils import (
    TENSOR_NAME_QUANT_SUFFIX,
    QuantizedValue,
    QuantizedValueType,
    attribute_to_kwarg,
    find_by_name,
    get_mul_node,
)
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


class ConvInteger(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def add_bias(self, nodes, scaled_output):
        """
        Given a node, this function handles bias add by adding a "reshape" node on bias and an "add" node
            parameter nodes: new nodes would be appended into nodes
            parameter node: current node (Conv)
            parameter scaled_output: output of quant conv without bias
            parameter output: output of Conv
            parameter bias_name: bias of Conv
            return: the name of output
        """
        node = self.node
        model = self.quantizer.model
        # Add tensors for the shape to be reshaped to
        weight = find_by_name(node.input[1], model.initializer())
        if weight is None:
            raise ValueError(f"Expected {node.input[1]} to be an initializer")

        # Add reshape for correct broadcase
        output = node.output[0]
        reshape_input_data = node.input[2]  # bias of Conv
        reshape_input_shape = output + "_bias_reshape_shape"
        reshape_output = output + "_bias_reshape_output"

        shape = np.ones((len(weight.dims)), dtype=np.int64)
        shape[1] = -1
        init_shape = onnx.helper.make_tensor(
            reshape_input_shape, onnx_proto.TensorProto.INT64, [len(weight.dims)], shape
        )
        model.add_initializer(init_shape)

        reshape_node = onnx.helper.make_node("Reshape", [reshape_input_data, reshape_input_shape], [reshape_output])
        nodes.append(reshape_node)

        # Add an Add operation for bias
        add_node = onnx.helper.make_node("Add", [scaled_output, reshape_output], [output], output + "_bias_add")
        nodes.append(add_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Conv"
        #  Get Quantized from both activation(input[0]) and weight(input[1])
        (
            quantized_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [0])

        (
            quantized_input_names_weight,
            zero_point_names_weight,
            scale_names_weight,
            nodes_weight,
        ) = self.quantizer.quantize_weight(node, [1], reduce_range=self.quantizer.reduce_range)
        quantized_input_names.extend(quantized_input_names_weight)
        zero_point_names.extend(zero_point_names_weight)
        scale_names.extend(scale_names_weight)
        nodes.extend(nodes_weight)

        conv_integer_output = node.output[0] + "_output_quantized"
        conv_integer_name = node.name + "_quant" if node.name else ""

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        conv_integer_node = onnx.helper.make_node(
            "ConvInteger", quantized_input_names + zero_point_names, [conv_integer_output], conv_integer_name, **kwargs
        )
        nodes.append(conv_integer_node)

        # Add cast operation to cast convInteger output to float.
        onnx_type = self.quantizer.get_tensor_type(node.output[0], mandatory=True)
        cast_op_output = conv_integer_output + "_cast_output"
        cast_node = onnx.helper.make_node(
            "Cast",
            [conv_integer_output],
            [cast_op_output],
            conv_integer_output + "_cast",
            to=onnx_type,  # TODO: FLOAT ot FLOAT16
        )
        nodes.append(cast_node)

        # Add mul operation to multiply scales of two inputs.
        assert len(scale_names) == 2
        if conv_integer_name:
            scales_mul_op = conv_integer_name + "_scales_mul"
        else:
            scales_mul_op = scale_names[0] + "_" + scale_names[1] + "_mul"

        scales_mul_node = find_by_name(scales_mul_op, self.quantizer.new_nodes)
        if scales_mul_node is None:
            scales_mul_node = get_mul_node(scale_names, scales_mul_op + ":0", scales_mul_op)
            nodes.append(scales_mul_node)

        scales_mul_op_output = scales_mul_node.output[0]

        has_bias = len(node.input) == 3
        scaled_output_name = node.output[0] if not has_bias else node.output[0] + "quant_scaled_output"

        # Add mul operation to multiply mul_scales_op result with output of ConvInteger
        # and make the output of this node the same as output of original conv node.
        output_scale_mul_op = conv_integer_name + "_output_scale_mul" if conv_integer_name else ""
        nodes.append(
            get_mul_node(
                [cast_op_output, scales_mul_op_output],
                scaled_output_name,
                output_scale_mul_op,
            )
        )

        if has_bias:
            self.add_bias(nodes, scaled_output_name)

        self.quantizer.new_nodes += nodes


class QLinearConv(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Conv"

        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])

        if self.quantizer.is_input_a_initializer(node.input[1]) and self.quantizer.is_per_channel():
            (
                quantized_input_names,
                zero_point_names,
                scale_names,
                nodes,
            ) = self.quantizer.quantize_activation(node, [0])
            quant_weight_tuple = self.quantizer.quantize_weight_per_channel(
                node.input[1],
                onnx_proto.TensorProto.INT8,
                0,  # self.quantizer.weight_qType?
            )
            quantized_input_names.append(quant_weight_tuple[0])
            zero_point_names.append(quant_weight_tuple[1])
            scale_names.append(quant_weight_tuple[2])
        else:
            (
                quantized_input_names,
                zero_point_names,
                scale_names,
                nodes,
            ) = self.quantizer.quantize_activation(node, [0])

            (
                quantized_input_names_weight,
                zero_point_names_weight,
                scale_names_weight,
                nodes_weight,
            ) = self.quantizer.quantize_weight(node, [1], reduce_range=self.quantizer.reduce_range)
            quantized_input_names.extend(quantized_input_names_weight)
            zero_point_names.extend(zero_point_names_weight)
            scale_names.extend(scale_names_weight)
            nodes.extend(nodes_weight)

        if not data_found or quantized_input_names is None:
            return super().quantize()

        quantized_bias_name = ""
        bias_present = False
        if len(node.input) == 3:
            if self.quantizer.weight_qType == onnx_proto.TensorProto.FLOAT8E4M3FN:
                raise RuntimeError("Quantization to FLOAT8E4M3FN for operator Conv is not supported.")
            quantized_bias_name = self.quantizer.quantize_bias_static(node.input[2], node.input[0], node.input[1])
            bias_present = True

        qlinear_conv_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qlinear_conv_name = node.name + "_quant" if node.name else ""

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        qlinear_conv_inputs = []
        # Input 0
        qlinear_conv_inputs.append(quantized_input_names[0])
        qlinear_conv_inputs.append(scale_names[0])
        qlinear_conv_inputs.append(zero_point_names[0])
        # Input 1
        qlinear_conv_inputs.append(quantized_input_names[1])
        qlinear_conv_inputs.append(scale_names[1])
        qlinear_conv_inputs.append(zero_point_names[1])

        # Output
        qlinear_conv_inputs.append(output_scale_name)
        qlinear_conv_inputs.append(output_zp_name)

        if bias_present:
            qlinear_conv_inputs.append(quantized_bias_name)

        qlinear_conv_node = onnx.helper.make_node(
            "QLinearConv", qlinear_conv_inputs, [qlinear_conv_output], qlinear_conv_name, **kwargs
        )
        nodes.append(qlinear_conv_node)

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            qlinear_conv_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        self.quantizer.new_nodes += nodes


class QDQConv(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Conv" or node.op_type == "ConvTranspose"

        self.quantizer.quantize_activation_tensor(node.input[0])
        if not self.disable_qdq_for_node_output:
            self.quantizer.quantize_activation_tensor(node.output[0])

        is_weight_per_channel, weight_axis = self.quantizer.is_tensor_per_channel(
            node.input[1], default_axis=0 if node.op_type == "Conv" else 1
        )
        if is_weight_per_channel:
            self.quantizer.quantize_weight_tensor_per_channel(node.input[1], weight_axis)
        else:
            self.quantizer.quantize_weight_tensor(node.input[1])

        if len(node.input) == 3:
            self.quantizer.quantize_bias_tensor(node.name, node.input[2], node.input[0], node.input[1])
