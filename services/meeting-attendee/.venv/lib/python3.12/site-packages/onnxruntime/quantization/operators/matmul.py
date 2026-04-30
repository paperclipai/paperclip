import itertools
import logging

import onnx
from onnx import onnx_pb as onnx_proto

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, find_by_name, get_mul_node
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


class QOpMatMul(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def should_quantize(self):
        if not self.quantizer.should_quantize_node(self.node):
            logging.debug(f"Ignore MatMul {self.node.name}]")
            return False

        if (not self.quantizer.is_float_tensor(self.node.input[1])) and (
            not self.quantizer.is_float_tensor(self.node.input[0])
        ):
            logging.info(f"Ignore MatMul due to non float inputs {self.node.name}]")
            return False

        # do not quantize non-constant B matrices for matmul
        if self.quantizer.q_matmul_const_b_only:
            if not self.quantizer.find_initializer_in_path(self.node.input[1]):
                logging.info(f"Ignore MatMul due to non constant B: {self.quantizer.graph_scope}[{self.node.name}]")
                return False
        return True


"""
    Used when quantize mode is QuantizationMode.IntegerOps.
"""


class MatMulInteger(QOpMatMul):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "MatMul"
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
        ) = self.quantizer.quantize_weight(node, [1], reduce_range=True, op_level_per_channel=True)
        quantized_input_names.extend(quantized_input_names_weight)
        zero_point_names.extend(zero_point_names_weight)
        scale_names.extend(scale_names_weight)
        nodes.extend(nodes_weight)

        matmul_integer_output = node.output[0] + "_output_quantized"
        matmul_integer_name = node.name + "_quant" if node.name else ""
        matmul_integer_node = onnx.helper.make_node(
            "MatMulInteger",
            quantized_input_names + zero_point_names,
            [matmul_integer_output],
            matmul_integer_name,
        )
        nodes.append(matmul_integer_node)

        # Add cast operation to cast matmulInteger output to float.
        cast_op_output = matmul_integer_output + "_cast_output"
        otype = self.quantizer.get_tensor_type(node.output[0], mandatory=True)
        cast_node = onnx.helper.make_node(
            "Cast",
            [matmul_integer_output],
            [cast_op_output],
            matmul_integer_output + "_cast",
            to=otype,
        )
        nodes.append(cast_node)

        # Add mul operation to multiply scales of two inputs.
        assert len(scale_names) == 2
        scales_mul_op = (
            matmul_integer_name + "_scales_mul"
            if matmul_integer_name
            else scale_names[0] + "_" + scale_names[1] + "_mul"
        )

        scales_mul_node = find_by_name(scales_mul_op, self.quantizer.new_nodes)
        if scales_mul_node is None:
            scales_mul_node = get_mul_node(scale_names, scales_mul_op + ":0", scales_mul_op)
            nodes.append(scales_mul_node)

        scales_mul_op_output = scales_mul_node.output[0]

        # Add mul operation to multiply mul_scales_op result with output of MatMulInteger
        # and make the output of this node the same as output of original matmul node.
        output_scale_mul_op = ""
        if matmul_integer_name:
            output_scale_mul_op = matmul_integer_name + "_output_scale_mul"
        nodes.append(
            get_mul_node(
                [cast_op_output, scales_mul_op_output],
                node.output[0],
                output_scale_mul_op,
            )
        )
        self.quantizer.new_nodes += nodes


"""
    Used when quantize mode is QuantizationMode.QLinearOps
"""


class QLinearMatMul(QOpMatMul):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "MatMul"
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
        ) = self.quantizer.quantize_weight(node, [1], reduce_range=True, op_level_per_channel=True)
        quantized_input_names.extend(quantized_input_names_weight)
        zero_point_names.extend(zero_point_names_weight)
        scale_names.extend(scale_names_weight)

        nodes.extend(nodes_weight)
        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])
        if not data_found or quantized_input_names is None:
            return super().quantize()

        qlinear_matmul_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qlinear_matmul_name = node.name + "_quant" if node.name else ""

        qlinear_matmul_inputs = []
        # Input 0
        qlinear_matmul_inputs.append(quantized_input_names[0])
        qlinear_matmul_inputs.append(scale_names[0])
        qlinear_matmul_inputs.append(zero_point_names[0])
        # Input 1
        qlinear_matmul_inputs.append(quantized_input_names[1])
        qlinear_matmul_inputs.append(scale_names[1])
        qlinear_matmul_inputs.append(zero_point_names[1])
        # Output quantization parameter
        qlinear_matmul_inputs.append(output_scale_name)
        qlinear_matmul_inputs.append(output_zp_name)

        domain = (
            "com.microsoft"
            if self.quantizer.weight_qType
            in {
                onnx_proto.TensorProto.FLOAT8E4M3FN,
                onnx_proto.TensorProto.FLOAT8E4M3FNUZ,
                onnx_proto.TensorProto.FLOAT8E5M2,
                onnx_proto.TensorProto.FLOAT8E5M2FNUZ,
            }
            else ""
        )
        qlinear_matmul_node = onnx.helper.make_node(
            "QLinearMatMul",
            qlinear_matmul_inputs,
            [qlinear_matmul_output],
            qlinear_matmul_name,
            domain=domain,
        )
        nodes.append(qlinear_matmul_node)

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            qlinear_matmul_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        self.quantizer.new_nodes += nodes


class QDQMatMul(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "MatMul"

        if self.disable_qdq_for_node_output:
            nodes_to_iterate = node.input
        else:
            nodes_to_iterate = itertools.chain(node.input, node.output)

        for tensor_name in nodes_to_iterate:
            if find_by_name(tensor_name, self.quantizer.model.initializer()):
                is_per_channel, channel_axis = self.quantizer.is_tensor_per_channel(
                    tensor_name, default_axis=1, op_type=node.op_type
                )
                if is_per_channel:
                    self.quantizer.quantize_weight_tensor_per_channel(tensor_name, channel_axis)
                else:
                    self.quantizer.quantize_weight_tensor(tensor_name)
            else:
                self.quantizer.quantize_activation_tensor(tensor_name)
