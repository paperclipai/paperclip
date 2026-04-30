import logging

import numpy as np  # noqa: F401
import onnx

from ..quant_utils import (
    TENSOR_NAME_QUANT_SUFFIX,
    QuantizedValue,
    QuantizedValueType,
    attribute_to_kwarg,
    find_by_name,  # noqa: F401
    get_mul_node,  # noqa: F401
    ms_domain,
)
from .base_operator import QuantOperatorBase  # noqa: F401
from .matmul import QOpMatMul
from .qdq_base_operator import QDQOperatorBase


def is_B_transposed(gemm_node):  # noqa: N802
    transB_attribute = [attr for attr in gemm_node.attribute if attr.name == "transB"]  # noqa: N806
    if transB_attribute:
        return onnx.helper.get_attribute_value(transB_attribute[0]) > 0

    return False


def get_beta(gemm_node):
    beta_attribute = [attr for attr in gemm_node.attribute if attr.name == "beta"]
    if beta_attribute:
        return onnx.helper.get_attribute_value(beta_attribute[0])

    return 1.0


def set_default_beta(gemm_node):
    beta_attribute = [attr for attr in gemm_node.attribute if attr.name == "beta"]
    if beta_attribute:
        beta_attribute[0].f = 1.0

    return 1.0


class QLinearGemm(QOpMatMul):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Gemm"

        (
            data_found,
            output_scale_name,
            output_zp_name,
            _,
            _,
        ) = self.quantizer._get_quantization_params(node.output[0])

        if self.quantizer.is_input_a_initializer(node.input[1]) and self.quantizer.is_per_channel():
            (
                quantized_input_names,
                zero_point_names,
                scale_names,
                nodes,
            ) = self.quantizer.quantize_activation(node, [0])
            quant_weight_tuple = self.quantizer.quantize_weight_per_channel(
                node.input[1],
                self.quantizer.weight_qType,
                0 if is_B_transposed(node) else 1,
            )
            quantized_input_names.append(quant_weight_tuple[0])
            zero_point_names.append(quant_weight_tuple[1])
            scale_names.append(quant_weight_tuple[2])
        else:
            #  Get Quantized from both activation(input[0]) and weight(input[1])
            (
                quantized_input_names,
                zero_point_names,
                scale_names,
                nodes,
            ) = self.quantizer.quantize_activation(node, [0])

            (
                quantized_input_names_weight,
                zero_point_names_weight,
                scale_names_weight,
                nodes_weight,
            ) = self.quantizer.quantize_weight(node, [1], reduce_range=self.quantizer.reduce_range)
            quantized_input_names.extend(quantized_input_names_weight)
            zero_point_names.extend(zero_point_names_weight)
            scale_names.extend(scale_names_weight)
            nodes.extend(nodes_weight)

        if not data_found or quantized_input_names is None:
            return super().quantize()

        quantized_bias_name = ""
        if len(node.input) == 3:
            if not self.quantizer.is_input_a_initializer(node.input[2]):
                return super().quantize()

            # Note: if the quantized type is float 8, the bias is converted into float 16.
            # cublasLtMatMul only supports (b)float16 or float32 bias.
            quantized_bias_name = self.quantizer.quantize_bias_static(
                node.input[2], node.input[0], node.input[1], get_beta(self.node)
            )

        qgemm_output = node.output[0] + TENSOR_NAME_QUANT_SUFFIX
        qgemm_name = node.name + "_quant" if node.name else ""

        kwargs = {}
        for attribute in node.attribute:
            if attribute.name != "beta":
                kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        # generate input
        qgemm_inputs = []
        for i in range(2):
            qgemm_inputs.extend([quantized_input_names[i], scale_names[i], zero_point_names[i]])

        qgemm_inputs.extend([quantized_bias_name, output_scale_name, output_zp_name])

        qgemm_node = onnx.helper.make_node("QGemm", qgemm_inputs, [qgemm_output], qgemm_name, **kwargs)
        nodes.append(qgemm_node)

        # Create an entry for this quantized value
        q_output = QuantizedValue(
            node.output[0],
            qgemm_output,
            output_scale_name,
            output_zp_name,
            QuantizedValueType.Input,
            node_type=node.op_type,
            node_qtype=self.quantizer.weight_qType,
        )
        self.quantizer.quantized_value_map[node.output[0]] = q_output

        self.quantizer.new_nodes += nodes


class QDQGemm(QDQOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def quantize(self):
        node = self.node
        assert node.op_type == "Gemm"

        self.quantizer.quantize_activation_tensor(node.input[0])
        if not self.disable_qdq_for_node_output:
            self.quantizer.quantize_activation_tensor(node.output[0])

        is_weight_per_channel, weight_axis = self.quantizer.is_tensor_per_channel(
            node.input[1], default_axis=0 if is_B_transposed(node) else 1
        )
        if is_weight_per_channel:
            self.quantizer.quantize_weight_tensor_per_channel(node.input[1], weight_axis)
        else:
            self.quantizer.quantize_weight_tensor(node.input[1])

        if len(node.input) == 3:
            if self.quantizer.is_input_a_initializer(node.input[2]):
                self.quantizer.quantize_bias_tensor(
                    node.name, node.input[2], node.input[0], node.input[1], get_beta(self.node)
                )
                set_default_beta(self.node)
            else:
                logging.warning(
                    f"Bias of Gemm node '{self.node.name}' is not constant. Please exclude this node for better performance."
                )
