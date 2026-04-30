import logging

import onnx
from onnx import onnx_pb as onnx_proto  # noqa: F401

from ..quant_utils import attribute_to_kwarg, ms_domain
from .base_operator import QuantOperatorBase

"""
Quantizes the EmbedLayerNorm fused ONNXRuntime Op.

This Quant operator keeps the input and segment IDs at int32 but will quantize all initializer and
weight inputs associated with the node to uint8.
"""


class EmbedLayerNormalizationQuant(QuantOperatorBase):
    def __init__(self, onnx_quantizer, onnx_node):
        super().__init__(onnx_quantizer, onnx_node)

    def should_quantize(self):
        return self.quantizer.should_quantize_node(self.node)

    def quantize(self):
        node = self.node
        assert node.op_type == "EmbedLayerNormalization"

        if len(node.output) > 2:
            logging.info(f"Quantization is not applied to {node.name} since it has 3 outputs")
            return super().quantize()

        """
        Pre-quantization EmbedLayerNorm inputs:
        [0] input_ids (int32)
        [1] segment_ids (int32)
        [2] word_embedding (float32)
        [3] position_embedding (float32)
        [4] segment_embedding (float32)
        [5] gamma (float32)
        [6] beta (float32)
        [7] mask (int32) (optional)
        """
        (
            quantized_input_names,
            zero_point_names,
            scale_names,
            nodes,
        ) = self.quantizer.quantize_activation(node, [2, 3, 4, 5, 6])
        if quantized_input_names is None:
            return super().quantize()

        qembed_layer_norm_name = "" if not node.name else node.name + "_quant"

        """
        Quantized Input Tensor List
        [0] input_ids (int32)
        [1] segment_ids (int32)
        [2] word_embedding (uint8)
        [3] position_embedding (uint8)
        [4] segment_embedding (uint8)
        [5] gamma (uint8)
        [6] beta (uint8)
        [7] mask (int32) (optional)
        [8] word_embedding_scale (float)
        [9] position_embedding_scale (float)
        [10] segment_embedding_scale (float)
        [11] gamma_scale (float)
        [12] beta_scale (float)
        [13] word_embedding_zero_point (uint8)
        [14] position_embedding_zero_point (uint8)
        [15] segment_embedding_zero_point (uint8)
        [16] gamma_zero_point (uint8)
        [17] beta_zero_point (uint8)
        """
        inputs = []
        # 'input_ids'
        inputs.extend([node.input[0]])
        # 'segment_ids'
        inputs.extend([node.input[1]])
        # 'word_embedding_quant'
        inputs.extend([quantized_input_names[0]])
        # 'position_embedding_quant'
        inputs.extend([quantized_input_names[1]])
        # 'segment_embedding_quant'
        inputs.extend([quantized_input_names[2]])
        # 'gamma_quant'
        inputs.extend([quantized_input_names[3]])
        # 'beta_quant'
        inputs.extend([quantized_input_names[4]])
        # 'mask' (optional)
        inputs.extend([node.input[7] if len(node.input) > 7 else ""])

        # Add all scales:
        inputs.extend([scale_names[0]])
        inputs.extend([scale_names[1]])
        inputs.extend([scale_names[2]])
        inputs.extend([scale_names[3]])
        inputs.extend([scale_names[4]])

        # Add all zero points:
        inputs.extend([zero_point_names[0]])
        inputs.extend([zero_point_names[1]])
        inputs.extend([zero_point_names[2]])
        inputs.extend([zero_point_names[3]])
        inputs.extend([zero_point_names[4]])

        kwargs = {}
        for attribute in node.attribute:
            kwargs.update(attribute_to_kwarg(attribute))
        kwargs["domain"] = ms_domain

        qembed_layer_norm_node = onnx.helper.make_node(
            "QEmbedLayerNormalization",
            inputs,
            node.output,
            qembed_layer_norm_name,
            **kwargs,
        )
        nodes.append(qembed_layer_norm_node)

        self.quantizer.new_nodes += nodes
