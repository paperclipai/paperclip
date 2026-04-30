class QuantOperatorBase:
    def __init__(self, onnx_quantizer, onnx_node):
        self.quantizer = onnx_quantizer
        self.node = onnx_node

    def should_quantize(self):
        if not self.quantizer.should_quantize_node(self.node):
            return False

        return self.quantizer.is_float_tensor(self.node.input[0])

    def quantize(self):
        """
        Given a node which does not support quantization, this method checks whether the input to
        this node is quantized and adds a DequantizeLinear node to dequantize this input back to FP32
            parameter node: Current node
            parameter new_nodes_list: List of new nodes created before processing current node
            return: List of new nodes created
        """
        for _, node_input in enumerate(self.node.input):
            dequantize_node = self.quantizer._dequantize_value(node_input)
            if dequantize_node is not None:
                self.quantizer.new_nodes.append(dequantize_node)

        # Append the original node
        self.quantizer.new_nodes.append(self.node)
