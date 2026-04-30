from .base_operator import QuantOperatorBase


# Use the quantized tensor as input without DQ.
class QArgMax(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node

        quantized_input_value = self.quantizer.find_quantized_value(node.input[0])
        if quantized_input_value is None:
            self.quantizer.new_nodes += [node]
            return

        node.input[0] = quantized_input_value.q_name
        self.quantizer.new_nodes += [node]
