# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import onnx

from ...fusions import Fusion
from ...onnx_model import ONNXModel


class FusionLpNormalization(Fusion):
    def __init__(self, model: ONNXModel, epsilon: float = 1e-12):
        super().__init__(model, "LpNormalization", "ReduceL2")
        self.epsilon = epsilon

    def fuse(
        self,
        reduce_node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """
        Interface function that tries to fuse a node sequence containing a ReduceL2 node into a single
        LpNormalization node.

        Pattern 1:
                    [root] --> ReduceL2 -----> Clip  --> Expand ----> Div -->
                       |      (axis=-1)    (min=epsilon) (shape=root)  ^
                       |   (keepdims=True)                             |
                       |                                               |
                       +-----------------------------------------------+
        Notes:
          - ReduceL2 must use the last axis, and keepdims == True
          - Clip must only have a min attribute that is ~1e-12
          - Expand must restore the shape to root.shape
          - The output of Expand must be the second input to Div.
        """
        if reduce_node.output[0] not in input_name_to_nodes:
            return

        # ReduceL2 must have one Clip child
        children = input_name_to_nodes[reduce_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Clip":
            return

        # ReduceL2 must have keepdims == True
        keepdims = self.get_node_attribute(reduce_node, "keepdims")
        if not keepdims:
            return

        # ReduceL2 axes must refer only to the last dimension.
        # Axes became an input in opset 18. Before then, axes was an attribute
        reduce_input_ttype = self.model.get_tensor_type(reduce_node.input[0])
        if not reduce_input_ttype:
            return

        reduce_input_shape = self.tensor_shape_to_list(reduce_input_ttype)
        if not reduce_input_shape:
            return

        axes = self.get_node_attribute(reduce_node, "axes")
        if not axes and len(reduce_node.input) > 1:
            axes = self.model.get_constant_value(reduce_node.input[1])

        if not axes or len(axes) != 1:
            return

        last_dim = len(reduce_input_shape) - 1
        if axes[0] != -1 and axes[0] != last_dim:
            return

        # Clip node must have a min attribute approximately equal to 1e-12
        clip_node = children[0]
        clip_min = self.get_node_attribute(clip_node, "min")
        if clip_min is None and len(clip_node.input) > 1:
            clip_min = self.model.get_constant_value(clip_node.input[1])

        clip_max = self.get_node_attribute(clip_node, "max")  # TODO: clip_max could be FLOAT_MAX
        if clip_max is None and len(clip_node.input) > 2:
            clip_max = self.model.get_constant_value(clip_node.input[2])

        if not (clip_max is None and clip_min is not None and clip_min > 0 and abs(clip_min - self.epsilon) < 1e-13):
            return

        if clip_node.output[0] not in input_name_to_nodes:
            return

        # Clip must have a single Expand child.
        children = input_name_to_nodes[clip_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Expand":
            return

        expand_node = children[0]
        if expand_node.output[0] not in input_name_to_nodes:
            return

        # Expand must have a single Div child
        children = input_name_to_nodes[expand_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Div":
            return

        div_node = children[0]

        # The first input to Div must be the root of the subgraph (i.e., reduce_node.input[0])
        # The second input to Div must be the output of the Expand.
        # As long as these two inputs go to the same Div node, then ONNX validation will ensure that
        # their shapes match.
        if div_node.input[0] != reduce_node.input[0]:
            return
        if div_node.input[1] != expand_node.output[0]:
            return

        subgraph_input = reduce_node.input[0]
        subgraph_output = div_node.output[0]

        subgraph_nodes = [reduce_node, clip_node, expand_node, div_node]
        if not self.is_safe_to_fuse_nodes(subgraph_nodes, [subgraph_output], input_name_to_nodes, output_name_to_node):
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        fused_node = onnx.helper.make_node(
            self.fused_op_type,
            name=self.create_unique_node_name(),
            inputs=[subgraph_input],
            outputs=[subgraph_output],
            p=2,
            axis=-1,
        )
        self.nodes_to_add.append(fused_node)
