import itertools

from ..quant_utils import QuantizedValue, QuantizedValueType, attribute_to_kwarg, quantize_nparray  # noqa: F401
from .base_operator import QuantOperatorBase  # noqa: F401


class QDQOperatorBase:
    def __init__(self, onnx_quantizer, onnx_node):
        self.quantizer = onnx_quantizer
        self.node = onnx_node
        self.disable_qdq_for_node_output = onnx_node.op_type in onnx_quantizer.op_types_to_exclude_output_quantization

    def quantize(self):
        node = self.node

        if self.disable_qdq_for_node_output:
            tensors_to_quantize = node.input
        else:
            tensors_to_quantize = itertools.chain(node.input, node.output)

        for tensor_name in tensors_to_quantize:
            self.quantizer.quantize_activation_tensor(tensor_name)
