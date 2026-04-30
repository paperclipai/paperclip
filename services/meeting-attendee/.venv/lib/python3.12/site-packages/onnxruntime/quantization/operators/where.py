import onnx

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


class QLinearWhere(QuantOperatorBase):
    def should_quantize(self):
        return True

    def quantize(self):
        node = self.node
        assert node.op_type == "Where"
        if not self.quantizer.force_quantize_no_input_check:
            self.quantizer.new_nodes += [node]
            return
        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])
        (
            q_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [1, 2])
        if not data_found or q_input_names is None:
            return super().quantize()
        qlinear_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qlinear_output_name = node.name + "_quant" if node.name else ""

        q_output = QuantizedValue(
            node.output[0],
            qlinear_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        qlwhere_inputs = [
            node.input[0],
            q_input_names[0],
            scale_names[0],
            zero_point_names[0],
            q_input_names[1],
            scale_names[1],
            zero_point_names[1],
            output_scale_name,
            output_zp_name,
        ]
        qlwhere_node = onnx.helper.make_node(
            "QLinearWhere", qlwhere_inputs, [qlinear_output], qlinear_output_name, **kwargs
        )

        self.quantizer.new_nodes += nodes
        self.quantizer.new_nodes += [qlwhere_node]


class QDQWhere(QDQOperatorBase):
    def quantize(self):
        node = self.node
        assert node.op_type == "Where"
        if self.quantizer.force_quantize_no_input_check:
            if not self.quantizer.is_tensor_quantized(node.input[1]):
                self.quantizer.quantize_activation_tensor(node.input[1])
            if not self.quantizer.is_tensor_quantized(node.input[2]):
                self.quantizer.quantize_activation_tensor(node.input[2])
            if not self.disable_qdq_for_node_output:
                for output in node.output:
                    self.quantizer.quantize_activation_tensor(output)
        elif (
            self.quantizer.is_tensor_quantized(node.input[1])
            and self.quantizer.is_tensor_quantized(node.input[2])
            and not self.disable_qdq_for_node_output
        ):
            for output in node.output:
                self.quantizer.quantize_activation_tensor(output)
