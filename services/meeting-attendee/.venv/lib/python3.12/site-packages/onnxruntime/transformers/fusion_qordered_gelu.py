# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import FusionUtils
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionQOrderedGelu(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "QOrderedGelu", ["Gelu", "FastGelu"])

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        INPUT PATTERN
        Fuse (quantized) Gelu subgraph into one node QOrderedGelu:
            -> quantized input  -> DQ -> Gelu -> Q ->

        (or)

            -> quantized input  -> DQ -> FastGelu -> Q ->

        OUTPUT PATTERN
            -> QOrderedGelu ->
        """
        gelu_children = self.model.get_children(node, input_name_to_nodes)

        # Should only have 1 child - QuantizeLinear (or)
        # Should have 2 children - QuantizeLinear + Shape
        if not (
            (len(gelu_children) == 1 and gelu_children[0].op_type == "QuantizeLinear")
            or (
                len(gelu_children) == 2
                and gelu_children[0].op_type == "QuantizeLinear"
                and gelu_children[1].op_type == "Shape"
            )
        ):
            return

        downstream_quantize_node = gelu_children[0]
        downstream_shape_node = None

        if len(gelu_children) == 2:
            downstream_shape_node = gelu_children[1]

        if not FusionUtils.check_qdq_node_for_fusion(downstream_quantize_node, self.model):
            return

        # The first input to Gelu should flow through a DequantizeLinear node
        first_path_id, first_input_parent_nodes, _ = self.model.match_parent_paths(
            node,
            [(["DequantizeLinear"], [0])],
            output_name_to_node,
        )

        if first_path_id < 0:
            return

        upstream_dequantize_node = first_input_parent_nodes[0]

        if not FusionUtils.check_qdq_node_for_fusion(upstream_dequantize_node, self.model):
            return

        # Fusion logic
        subgraph_nodes = [node]  # Gelu/FastGelu
        subgraph_nodes.extend([downstream_quantize_node, upstream_dequantize_node])  # Relevant Q, DQ nodes

        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            (
                [node.output[0], downstream_quantize_node.output[0]]
                if downstream_shape_node is not None
                else downstream_quantize_node.output
            ),
            input_name_to_nodes,
            output_name_to_node,
        ):
            logger.debug("It is not safe to fuse QOrderedGelu node. Skip")
            return

        self.nodes_to_remove.extend(subgraph_nodes)

        ordered_gelu_node = helper.make_node(
            "QOrderedGelu",
            inputs=[
                upstream_dequantize_node.input[0],
                upstream_dequantize_node.input[1],
                downstream_quantize_node.input[1],
            ],
            outputs=[downstream_quantize_node.output[0]],
            name=self.model.create_node_name("QOrderedGelu", name_prefix="QOrderedGelu"),
        )

        # Arrange the downstream Shape's input to be fed from the
        # downstream QuantizeLinear node, so that fusion will
        # be deemed safe
        if downstream_shape_node is not None:
            self.model.replace_node_input(
                downstream_shape_node, downstream_shape_node.input[0], downstream_quantize_node.output[0]
            )

        # TODO: We only support CuBlasLt order ORDER_ROW for now.
        # Once we start supporting other data ordering format(s), we
        # will support user configuring the data ordering for the op.
        ordered_gelu_node.attribute.extend([helper.make_attribute("order_X", 1)])
        ordered_gelu_node.attribute.extend([helper.make_attribute("order_Y", 1)])

        ordered_gelu_node.domain = "com.microsoft"

        self.nodes_to_add.append(ordered_gelu_node)
        self.node_name_to_graph_name[ordered_gelu_node.name] = self.this_graph_name
