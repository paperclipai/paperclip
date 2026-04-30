import onnx

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase


class QGlobalAveragePool(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "GlobalAveragePool"

        # If input to this node is not quantized then keep this node.
        if node.input[0] not in self.quantizer.quantized_value_map:
            return super().quantize()

        quantized_input_value = self.quantizer.quantized_value_map[node.input[0]]

        # Create an entry for output quantized value.
        quantized_input_value = self.quantizer.quantized_value_map[node.input[0]]
        (
            data_found,
            output_scale_name_from_parameter,
            output_zp_name_from_parameter,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])
        # Just use input scale and zp if parameters for output is not specified.
        output_scale_name = output_scale_name_from_parameter if data_found else quantized_input_value.scale_name
        output_zp_name = output_zp_name_from_parameter if data_found else quantized_input_value.zp_name
        quantized_output_value = QuantizedValue(
            node.output[0],
            node.output[0] + TENSOR_NAME_QUANT_SUFFIX,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = quantized_output_value

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain
        kwargs["channels_last"] = 0
        qnode_name = node.name + "_quant" if node.name else ""

        qnode = onnx.helper.make_node(
            "QLinear" + node.op_type,
            [
                quantized_input_value.q_name,
                quantized_input_value.scale_name,
                quantized_input_value.zp_name,
                output_scale_name,
                output_zp_name,
            ],
            [quantized_output_value.q_name],
            qnode_name,
            **kwargs,
        )
        self.quantizer.new_nodes += [qnode]
