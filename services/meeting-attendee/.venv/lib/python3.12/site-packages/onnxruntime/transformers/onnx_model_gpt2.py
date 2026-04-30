# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging

import onnx
from fusion_gpt_attention import FusionGptAttention
from fusion_gpt_attention_megatron import FusionGptAttentionMegatron
from fusion_gpt_attention_no_past import FusionGptAttentionNoPast
from fusion_rotary_attention import FusionRotaryAttention
from onnx_model_bert import BertOnnxModel

logger = logging.getLogger(__name__)


class Gpt2OnnxModel(BertOnnxModel):
    def __init__(self, model, num_heads, hidden_size):
        super().__init__(model, num_heads, hidden_size)

    def fuse_attention(self):
        if len(self.model.graph.input) == 1 or len(self.model.graph.output) == 1:
            fusion = FusionGptAttentionNoPast(self, self.num_heads)
            fusion.apply()
        else:
            fusion = FusionGptAttention(self, self.num_heads)
            fusion.apply()
            fusion = FusionGptAttentionMegatron(self, self.num_heads)
            fusion.apply()

        fusion = FusionRotaryAttention(self, self.hidden_size, self.num_heads)
        fusion.apply()

    def postprocess(self):
        """
        Remove extra reshape nodes.
        """
        logger.debug("start postprocessing...")

        input_name_to_nodes = self.input_name_to_nodes()
        output_name_to_node = self.output_name_to_node()

        reshape_count = 0
        for gemm_node in self.get_nodes_by_op_type("Gemm"):
            reshape_after_gemm = self.find_first_child_by_type(
                gemm_node, "Reshape", input_name_to_nodes, recursive=False
            )

            nodes = self.match_parent_path(gemm_node, ["Reshape", "FastGelu"], [0, 0], output_name_to_node)
            if nodes is None:
                nodes = self.match_parent_path(
                    gemm_node,
                    ["Reshape", "LayerNormalization"],
                    [0, 0],
                    output_name_to_node,
                )

                if nodes is None:
                    nodes = self.match_parent_path(
                        gemm_node,
                        ["Reshape", "SkipLayerNormalization"],
                        [0, 0],
                        output_name_to_node,
                    )

                    if nodes is None:
                        continue

            (reshape_before_gemm, root_node) = nodes

            matmul_node_name = self.create_node_name("MatMul", "FullyConnect_MatMul")
            matmul_node = onnx.helper.make_node(
                "MatMul",
                inputs=[matmul_node_name + "_input", gemm_node.input[1]],
                outputs=[matmul_node_name + "_output"],
                name=matmul_node_name,
            )

            add_node_name = self.create_node_name("Add", "FullyConnect_Add")
            add_node = onnx.helper.make_node(
                "Add",
                inputs=[matmul_node_name + "_output", gemm_node.input[2]],
                outputs=[add_node_name + "_output"],
                name=add_node_name,
            )

            self.replace_input_of_all_nodes(reshape_after_gemm.output[0], add_node_name + "_output")

            # Link root node output with MatMul
            self.replace_input_of_all_nodes(root_node.output[0], matmul_node_name + "_input")
            root_node.output[0] = matmul_node_name + "_input"

            self.replace_input_of_all_nodes(reshape_after_gemm.output[0], add_node_name + "_output")

            self.add_node(matmul_node)
            self.add_node(add_node)

            reshape_count += 2

        self.prune_graph()
        logger.info(f"postprocess: remove Reshape count: {reshape_count}")
