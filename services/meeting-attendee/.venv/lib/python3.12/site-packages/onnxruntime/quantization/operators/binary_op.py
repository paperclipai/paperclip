import onnx
from onnx import onnx_pb as onnx_proto  # noqa: F401

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase


class QLinearBinaryOp(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node

        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])
        (
            quantized_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [0, 1])
        if not data_found or quantized_input_names is None:
            return super().quantize()

        qlinear_binary_math_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qlinear_binary_math_name = node.name + "_quant" if node.name else ""

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        qlinear_binary_math_inputs = []
        # Input 0
        qlinear_binary_math_inputs.append(quantized_input_names[0])
        qlinear_binary_math_inputs.append(scale_names[0])
        qlinear_binary_math_inputs.append(zero_point_names[0])
        # Input 1
        qlinear_binary_math_inputs.append(quantized_input_names[1])
        qlinear_binary_math_inputs.append(scale_names[1])
        qlinear_binary_math_inputs.append(zero_point_names[1])

        # Output
        qlinear_binary_math_inputs.append(output_scale_name)
        qlinear_binary_math_inputs.append(output_zp_name)

        qlinear_binary_math_node = onnx.helper.make_node(
            "QLinear" + node.op_type,
            qlinear_binary_math_inputs,
            [qlinear_binary_math_output],
            qlinear_binary_math_name,
            **kwargs,
        )
        nodes.append(qlinear_binary_math_node)

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            qlinear_binary_math_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        self.quantizer.new_nodes += nodes
