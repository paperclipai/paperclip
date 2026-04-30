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


class FusionQOrderedLayerNormalization(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "QOrderedLayerNormalization", "LayerNormalization")

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        Fuse (quantized) Layer Normalization subgraph into one node QOrderedLayerNormalization:
            quantized input  -> DQ
                                |
                                |
            (other inputs)-> LayerNormalization --> Q -->

            should become

            (quantized input + other inputs)->  QOrderedLayerNormalization --> Q -->
        """

        children = self.model.get_children(node, input_name_to_nodes)

        # Should only have 1 child - QuantizeLinear (or)
        # Should have 2 children - QuantizeLinear + Shape
        if not (
            (len(children) == 1 and children[0].op_type == "QuantizeLinear")
            or (len(children) == 2 and children[0].op_type == "QuantizeLinear" and children[1].op_type == "Shape")
        ):
            return

        downstream_quantize_node = children[0]
        downstream_shape_node = None

        if len(children) == 2:
            downstream_shape_node = children[1]

        if not FusionUtils.check_qdq_node_for_fusion(downstream_quantize_node, self.model):
            return

        # The first input to LayerNormalization should flow through a DequantizeLinear node
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
        subgraph_nodes = [node]  # LayerNormalization
        subgraph_nodes.extend([downstream_quantize_node])  # Q node after LayerNormalization

        upstream_dequantize_node_children = self.model.get_children(upstream_dequantize_node, input_name_to_nodes)

        # In GPT2, the DQ node will be feeding a residual downstream Add and hence,
        # we do not want to remove it
        if len(upstream_dequantize_node_children) == 1:
            subgraph_nodes.extend([upstream_dequantize_node])  # DQ node before LayerNormalization

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
            logger.debug("It is not safe to fuse QOrderedLayerNormalization node. Skip")
            return

        self.nodes_to_remove.extend(subgraph_nodes)

        normalize_node = helper.make_node(
            "QOrderedLayerNormalization",
            inputs=[
                upstream_dequantize_node.input[0],
                upstream_dequantize_node.input[1],
                node.input[1],
                node.input[2],
                downstream_quantize_node.input[1],
            ],
            outputs=[downstream_quantize_node.output[0]],
            name=self.model.create_node_name("QOrderedLayerNormalization", name_prefix="QOrderedLayerNormalization"),
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
        normalize_node.attribute.extend([helper.make_attribute("order_X", 1)])
        normalize_node.attribute.extend([helper.make_attribute("order_Y", 1)])

        normalize_node.domain = "com.microsoft"

        self.nodes_to_add.append(normalize_node)
        self.node_name_to_graph_name[normalize_node.name] = self.this_graph_name
