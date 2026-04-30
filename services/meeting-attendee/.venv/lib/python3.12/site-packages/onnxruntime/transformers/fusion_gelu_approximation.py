# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from fusion_base import Fusion
from onnx import helper
from onnx_model import OnnxModel


class FusionGeluApproximation(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "FastGelu", ["Gelu", "BiasGelu"], "GeluApproximation")

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        new_node = helper.make_node(
            "FastGelu",
            inputs=node.input,
            outputs=node.output,
            name=self.model.create_node_name("FastGelu", node.op_type + "_Approximation"),
        )
        new_node.domain = "com.microsoft"
        self.nodes_to_remove.append(node)
        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name
