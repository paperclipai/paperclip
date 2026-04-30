from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


# For operators that support 8bits operations directly, and output could
# reuse input[0]'s type, zeropoint, scale; For example,Transpose, Reshape, etc.
class Direct8BitOp(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node

        if not self.quantizer.force_quantize_no_input_check:
            # Keep backward compatibility
            # Quantize when input[0] is quantized already. Otherwise keep it.
            quantized_input_value = self.quantizer.find_quantized_value(node.input[0])
            if quantized_input_value is None:
                self.quantizer.new_nodes += [node]
                return

            quantized_output_value = QuantizedValue(
                node.output[0],
                node.output[0] + TENSOR_NAME_QUANT_SUFFIX,
                quantized_input_value.scale_name,
                quantized_input_value.zp_name,
                quantized_input_value.value_type,
            )
            self.quantizer.quantized_value_map[node.output[0]] = quantized_output_value

            node.input[0] = quantized_input_value.q_name
            node.output[0] = quantized_output_value.q_name
            self.quantizer.new_nodes += [node]

        else:
            # Force quantize those ops if possible, use exclude node list if this is not you want
            if not self.quantizer.is_valid_quantize_weight(node.input[0]):
                super().quantize()
                return

            (
                quantized_input_names,
                zero_point_names,
                scale_names,
                nodes,
            ) = self.quantizer.quantize_activation(node, [0])
            if quantized_input_names is None:
                return super().quantize()

            # Create an entry for output quantized value
            quantized_output_value = QuantizedValue(
                node.output[0],
                node.output[0] + TENSOR_NAME_QUANT_SUFFIX,
                scale_names[0],
                zero_point_names[0],
                QuantizedValueType.Input,
            )
            self.quantizer.quantized_value_map[node.output[0]] = quantized_output_value

            node.input[0] = quantized_input_names[0]
            node.output[0] = quantized_output_value.q_name
            nodes.append(node)

            self.quantizer.new_nodes += nodes


class QDQDirect8BitOp(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        if self.quantizer.force_quantize_no_input_check:
            self.quantizer.quantize_activation_tensor(self.node.input[0])
            if not self.disable_qdq_for_node_output:
                self.quantizer.quantize_output_same_as_input(self.node.output[0], self.node.input[0], self.node.name)
        elif self.quantizer.is_tensor_quantized(self.node.input[0]) and not self.disable_qdq_for_node_output:
            self.quantizer.quantize_output_same_as_input(self.node.output[0], self.node.input[0], self.node.name)
