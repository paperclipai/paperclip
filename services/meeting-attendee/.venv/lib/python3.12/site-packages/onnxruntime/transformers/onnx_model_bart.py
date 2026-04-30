# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

from fusion_attention import AttentionMask
from fusion_bart_attention import FusionBartAttention
from fusion_options import FusionOptions
from fusion_reshape import FusionReshape
from onnx import numpy_helper
from onnx_model import OnnxModel
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class FusionBartReshape(FusionReshape):
    def __init__(self, model: OnnxModel):
        super().__init__(model)

    def fuse(self, reshape_node, input_name_to_nodes, output_name_to_node):
        if reshape_node.input[1] not in output_name_to_node:
            return

        concat_node = output_name_to_node[reshape_node.input[1]]
        if concat_node.op_type != "Concat" or len(concat_node.input) != 4:
            return

        path0 = self.model.match_parent_path(
            concat_node,
            ["Unsqueeze", "Gather", "Shape"],
            [0, 0, 0],
            output_name_to_node,
        )
        if path0 is None:
            return

        (_, gather_0, shape_0) = path0

        shape = []
        gather_value = self.model.get_constant_value(gather_0.input[1])
        if gather_value == 0:
            shape.append(0)

        path1 = self.model.match_parent_path(
            concat_node,
            ["Unsqueeze", "Gather", "Shape"],
            [1, 0, 0],
            output_name_to_node,
        )
        if path1 is None:
            input_1_proto = self.model.get_initializer(concat_node.input[1])
            input_2_proto = self.model.get_initializer(concat_node.input[2])
            input_3_proto = self.model.get_initializer(concat_node.input[3])
            if input_1_proto is None or input_2_proto is None or input_3_proto is None:
                return

            input_1 = numpy_helper.to_array(input_1_proto)
            input_2 = numpy_helper.to_array(input_2_proto)
            input_3 = numpy_helper.to_array(input_3_proto)
            if len(input_1) != 1 or len(input_2) != 1 or len(input_3) != 1:
                return

            if not (input_1[0] == -1 and input_2[0] > 0 and input_3[0] > 0):
                return

            shape.extend(input_1)
            shape.extend(input_2)
            shape.extend(input_3)
            gemm_path_with_bias = self.model.match_parent_path(
                reshape_node, ["Add", "MatMul"], [0, 1], output_name_to_node
            )
            gemm_path_no_bias = self.model.match_parent_path(reshape_node, ["MatMul"], [0], output_name_to_node)
            if gemm_path_with_bias is not None:
                gemm_path = gemm_path_with_bias
            elif gemm_path_no_bias is not None:
                gemm_path = gemm_path_no_bias
            else:
                return

            top_matmul = gemm_path[-1]
            root_input = top_matmul.input[0]

            self.replace_reshape_node(shape, reshape_node, concat_node)
        else:
            (_, gather_1, shape_1) = path1

            gather_value = self.model.get_constant_value(gather_1.input[1])
            if gather_value == 1:
                shape.append(0)

            input_2_proto = self.model.get_initializer(concat_node.input[2])
            input_3_proto = self.model.get_initializer(concat_node.input[3])
            if input_2_proto is None or input_3_proto is None:
                return

            input_2 = numpy_helper.to_array(input_2_proto)
            input_3 = numpy_helper.to_array(input_3_proto)
            if len(input_2) != 1 or len(input_3) != 1:
                return

            if not (input_2[0] > 0 and input_3[0] > 0):
                return

            shape.extend(input_2)
            shape.extend(input_3)
            gemm_path = self.model.match_parent_path(
                reshape_node, ["Mul", "Add", "MatMul"], [0, 0, 1], output_name_to_node
            )
            if gemm_path is None:
                return

            top_matmul = gemm_path[-1]
            root_input = top_matmul.input[0]
            if shape_0.input[0] != root_input or shape_1.input[0] != root_input:
                return

            self.replace_reshape_node(shape, reshape_node, concat_node)


class BartOnnxModel(BertOnnxModel):
    def __init__(self, model, num_heads, hidden_size, model_impl="hf"):
        super().__init__(model, num_heads, hidden_size)
        self.attention_mask = AttentionMask(self)
        self.attention_fusion = FusionBartAttention(self, self.hidden_size, self.num_heads, self.attention_mask)
        self.bart_reshape_fusion_preprocess = FusionBartReshape(self)

    def optimize(self, options: FusionOptions | None = None, add_dynamic_axes: bool = False):
        self.attention_fusion.use_multi_head_attention = False if options is None else options.use_multi_head_attention
        self.attention_fusion.disable_multi_head_attention_bias = (
            False if options is None else options.disable_multi_head_attention_bias
        )
        super().optimize(options, add_dynamic_axes)

    def fuse_attention(self):
        self.attention_fusion.apply()

    def preprocess(self):
        self.adjust_reshape_and_expand()
        self.bart_reshape_fusion_preprocess.apply()
