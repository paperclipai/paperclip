# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

from fusion_base import Fusion
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionBiasSplitGelu(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "BiasSplitGelu", "Gelu")

    def fuse(self, gelu_node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        [root] --->Add -------------------->  Slice ---------------> Mul -->
                   |                            ^                    ^
                   |                            |                    |
                   +----------------------------+---Slice --> Gelu---+
                   |                            |     ^
                   |                            |-----|
                   |                            |     |
                   |                           Mul   Mul
                   |                            ^     ^
                   v                            |     |
                  Shape ---> Gather --> Add --> Div --+
        """
        if gelu_node.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[gelu_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_after_gelu = children[0]

        slice_before_gelu = self.model.match_parent(gelu_node, "Slice", 0, output_name_to_node)
        if slice_before_gelu is None:
            return

        if self.model.find_constant_input(slice_before_gelu, -1, delta=0.001) != 3:
            return

        add_output = slice_before_gelu.input[0]

        start_index_nodes = self.model.match_parent_path(
            slice_before_gelu,
            ["Div", "Add", "Gather", "Shape", "Add"],
            [1, 0, 0, 0, 0],
            output_name_to_node,  # Mul(1) is optional
        )
        if start_index_nodes is None:
            start_index_nodes = self.model.match_parent_path(
                slice_before_gelu,
                ["Mul", "Div", "Add", "Gather", "Shape", "Add"],
                [1, 0, 0, 0, 0, 0],
                output_name_to_node,
            )

        if start_index_nodes is None or start_index_nodes[-2].input[0] != add_output:
            return

        end_index_nodes = self.model.match_parent_path(slice_before_gelu, ["Mul", "Div"], [2, 0], output_name_to_node)

        if (
            end_index_nodes is None or end_index_nodes[1] not in start_index_nodes
        ):  # the Div is parent of both two Mul nodes
            return

        slice_before_mul = self.model.match_parent(mul_after_gelu, "Slice", 0, output_name_to_node)
        if slice_before_mul is None:
            return

        if (
            slice_before_mul.input[2] != slice_before_gelu.input[1]
        ):  # end index of slice_before_mul is start index of slice_before_gelu
            return

        subgraph_nodes = [
            *start_index_nodes,
            end_index_nodes[0],
            mul_after_gelu,
            gelu_node,
            slice_before_mul,
            slice_before_gelu,
        ]
        subgraph_output = mul_after_gelu.output[0]
        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes, [subgraph_output], input_name_to_nodes, output_name_to_node
        ):
            logger.info("Skip fuse BiasSplitGelu since it is not safe to fuse the subgraph.")
            return

        add_node = start_index_nodes[-1]
        bias_index, _value = self.model.get_constant_input(add_node)
        if not isinstance(bias_index, int):
            return
        self.nodes_to_remove.extend(subgraph_nodes)
        node_name = self.model.create_node_name("BiasSplitGelu", name_prefix="BiasSplitGelu")
        fused_node = helper.make_node(
            "BiasSplitGelu",
            inputs=[add_node.input[1 - bias_index], add_node.input[bias_index]],
            outputs=[subgraph_output],
            name=node_name,
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[node_name] = self.this_graph_name
