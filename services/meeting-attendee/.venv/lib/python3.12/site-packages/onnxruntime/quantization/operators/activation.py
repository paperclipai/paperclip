import onnx

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase
from .qdq_base_operator import QDQOperatorBase


class QLinearActivation(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def QuantizeClipRelu(self):  # noqa: N802
        node = self.node
        assert node.op_type == "Relu" or node.op_type == "Clip"

        # When mode is QLinearOps, the output quantization params are calculated based on outputs from
        # activation nodes, therefore these nodes can be removed from the graph if they follow a quantized op.
        # If input to this node is not quantized then keep this node
        # If activation is symmetric, not quantize the op and simply return
        if node.input[0] not in self.quantizer.quantized_value_map or self.quantizer.is_activation_symmetric:
            return super().quantize()

        quantized_value = self.quantizer.quantized_value_map[node.input[0]]
        self.quantizer.quantized_value_map[node.output[0]] = quantized_value

    def quantize(self):
        node = self.node
        if node.op_type == "Relu" or node.op_type == "Clip":
            self.QuantizeClipRelu()
            return

        nnapi_sigmoid_option = "extra.Sigmoid.nnapi"
        sigmoid_nnapi_mode = (
            node.op_type == "Sigmoid"
            and nnapi_sigmoid_option in self.quantizer.extra_options
            and self.quantizer.extra_options[nnapi_sigmoid_option]
        )
        use_scale = 1 / 256.0 if sigmoid_nnapi_mode else None
        use_zeropoint = 0 if sigmoid_nnapi_mode else None

        # No assert on op_type as it is controlled by registry
        # only try to quantize when given quantization parameters for it
        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0], use_scale, use_zeropoint)
        (
            quantized_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [0])
        if not data_found or quantized_input_names is None:
            return super().quantize()

        qlinear_activation_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qlinear_activation_name = ""
        if node.name:
            qlinear_activation_name = node.name + "_quant"
        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        qlinear_activation_inputs = [
            quantized_input_names[0],
            scale_names[0],
            zero_point_names[0],
            output_scale_name,
            output_zp_name,
        ]

        qlinear_activation_node = onnx.helper.make_node(
            "QLinear" + node.op_type,
            qlinear_activation_inputs,
            [qlinear_activation_output],
            qlinear_activation_name,
            **kwargs,
        )

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            qlinear_activation_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        nodes.append(qlinear_activation_node)
        self.quantizer.new_nodes += nodes


class QDQRemovableActivation(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node

        # If input to this node is not quantized then keep this node
        if not self.quantizer.is_tensor_quantized(node.input[0]):
            return

        if (
            not self.quantizer.is_activation_symmetric
            and not self.quantizer.qdq_keep_removable_activations
            and self.quantizer.try_replacing_upstream_output(node.input[0], node.output[0])
        ):
            self.quantizer.remove_node(self.node)
        else:
            self.quantizer.quantize_activation_tensor(node.input[0])

        if not self.disable_qdq_for_node_output:
            self.quantizer.quantize_activation_tensor(node.output[0])
