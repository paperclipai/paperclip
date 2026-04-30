from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase

"""
    Quantize Gather
"""


class GatherQuant(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def should_quantize(self):
        if not self.quantizer.should_quantize_node(self.node):
            return False

        return self.quantizer.is_valid_quantize_weight(self.node.input[0])

    def quantize(self):
        node = self.node
        assert node.op_type == "Gather"

        (
            quantized_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [0])
        if quantized_input_names is None:
            return super().quantize()

        gather_new_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            gather_new_output,
            scale_names[0],
            zero_point_names[0],
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        node.output[0] = gather_new_output
        node.input[0] = quantized_input_names[0]
        nodes.append(node)

        self.quantizer.new_nodes += nodes


class QDQGather(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Gather" or node.op_type == "GatherElements"

        if self.quantizer.is_valid_quantize_weight(node.input[0]) or self.quantizer.force_quantize_no_input_check:
            self.quantizer.quantize_activation_tensor(node.input[0])
            self.quantizer.quantize_output_same_as_input(node.output[0], node.input[0], node.name)
        elif self.quantizer.is_tensor_quantized(node.input[0]):
            self.quantizer.quantize_output_same_as_input(node.output[0], node.input[0], node.name)
