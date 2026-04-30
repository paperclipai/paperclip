# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

from fusion_base import Fusion
from numpy import ndarray
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionBiasAdd(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "BiasAdd", "Add")

    def fuse(self, add_node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        Fuse Add bias and Add skip connection into BiasAdd
        """

        nodes = self.model.match_parent_path(
            add_node,
            ["Add", "MatMul", "BiasSplitGelu", "MatMul", "SkipLayerNormalization"],
            [0, None, 0, 0, 0],
            output_name_to_node,
        )

        if nodes is None:
            return

        bias_node = nodes[0]
        skip_layer_norm = nodes[-1]

        # Check skip connection is from SkipLayerNormalization output
        if add_node.input[1] not in skip_layer_norm.output:
            return

        bias_index, bias_value = self.model.get_constant_input(bias_node)
        if not (isinstance(bias_index, int) and (bias_value is not None) and isinstance(bias_value, ndarray)):
            return
        if bias_value.ndim != 1:
            return

        self.nodes_to_remove.extend([add_node, bias_node])
        node_name = self.model.create_node_name("BiasAdd")
        fused_node = helper.make_node(
            "BiasAdd",
            inputs=[bias_node.input[1 - bias_index], bias_node.input[bias_index], add_node.input[1]],
            outputs=[add_node.output[0]],
            name=node_name,
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[node_name] = self.this_graph_name
