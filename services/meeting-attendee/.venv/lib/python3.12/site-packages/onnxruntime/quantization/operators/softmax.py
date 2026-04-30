import onnx
import onnx.helper

from ..quant_utils import TENSOR_NAME_QUANT_SUFFIX, QuantizedValue, QuantizedValueType, attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase


class QLinearSoftmax(QuantOperatorBase):
    def quantize(self):
        node = self.node
        # set limitations for softmax output scale and zp, because the output of softmax is always 0-1
        if self.quantizer.activation_qType == onnx.onnx_pb.TensorProto.UINT8:
            out_scale = 1 / 256.0
            out_zero_point = 0
        else:
            out_scale = 1 / 256.0
            out_zero_point = -128
        # only try to quantize when given quantization parameters for it
        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0], out_scale, out_zero_point)

        # get quantized input tensor names, quantize input if needed
        (
            quantized_input_names,
            input_zero_point_names,
            input_scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [0])

        if not data_found or quantized_input_names is None:
            return super().quantize()

        # Create an entry for output quantized value.
        qlinear_output_name = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        quantized_output_value = QuantizedValue(
            node.output[0],
            qlinear_output_name,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
        )
        self.quantizer.quantized_value_map[node.output[0]] = quantized_output_value

        # Create qlinear softmax node for given type
        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain
        # make qlinearsoft has the real opset_version, its default SinceVersion would be 1
        kwargs["opset"] = self.quantizer.opset_version
        qlinear_node_name = node.name + "_quant" if node.name else ""
        qnode = onnx.helper.make_node(
            "QLinear" + node.op_type,
            [
                quantized_input_names[0],
                input_scale_names[0],
                input_zero_point_names[0],
                output_scale_name,
                output_zp_name,
            ],
            [qlinear_output_name],
            qlinear_node_name,
            **kwargs,
        )

        # add all newly created nodes
        nodes.append(qnode)
        self.quantizer.new_nodes += nodes
        return None
