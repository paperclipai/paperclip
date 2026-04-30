# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import FusionUtils
from onnx import helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionNhwcConv(Fusion):
    """Convert Conv to NhwcConv"""

    def __init__(self, model: OnnxModel, update_weight=False):
        super().__init__(model, "NhwcConv", ["Conv"], "NhwcConv")
        self.update_weight = update_weight
        self.fusion_utils = FusionUtils(model)

    def create_transpose_node(self, input_name: str, perm: list[int], output_name=None):
        """Append a Transpose node after an input"""
        node_name = self.model.create_node_name("Transpose")

        if output_name is None:
            output_name = node_name + "_out" + "-" + input_name

        transpose_node = helper.make_node("Transpose", inputs=[input_name], outputs=[output_name], name=node_name)
        transpose_node.attribute.extend([helper.make_attribute("perm", perm)])

        return transpose_node

    def fuse(self, conv, input_name_to_nodes, output_name_to_node):
        # Add Transpose node to convert input from NCHW to NHWC
        input_transpose_node = self.create_transpose_node(conv.input[0], [0, 2, 3, 1])

        nhwc_conv_input = input_transpose_node.output[0]

        # Create a tensor for transposed weights (already in NHWC format).
        node_name = self.model.create_node_name("NhwcConv")

        # Make sure the weights is 4D
        weight_tensor = self.model.get_initializer(conv.input[1])
        if weight_tensor is None:
            return
        weight = numpy_helper.to_array(weight_tensor)
        if len(weight.shape) != 4:
            return

        dtype = self.model.get_dtype(nhwc_conv_input)
        if not (dtype is not None and weight_tensor.data_type == dtype):
            cast_node = self.fusion_utils.add_cast_node(
                input_name=nhwc_conv_input,
                to_type=weight_tensor.data_type,
                output_name_to_node=output_name_to_node,
            )
            nhwc_conv_input = cast_node.output[0]

        if self.update_weight:
            # Transpose weights from NCHW to NHWC
            weight = weight.transpose(0, 2, 3, 1)

            weight_name = node_name + "_weight_NHWC"
            self.add_initializer(
                name=weight_name,
                data_type=weight_tensor.data_type,
                dims=list(weight.shape),
                vals=weight,
            )
            weight_transpose_node = None
        else:
            weight_transpose_node = self.create_transpose_node(conv.input[1], [0, 2, 3, 1])
            weight_name = weight_transpose_node.output[0]

        nhwc_output_name = node_name + "_out" + "-" + conv.output[0]
        nhwc_conv = helper.make_node(
            "NhwcConv",
            inputs=[nhwc_conv_input, weight_name, *conv.input[2:]],
            outputs=[nhwc_output_name],
            name=node_name + "-" + conv.name,
        )
        nhwc_conv.attribute.extend(conv.attribute)
        nhwc_conv.domain = "com.microsoft"

        output_transpose_node = self.create_transpose_node(nhwc_conv.output[0], [0, 3, 1, 2], conv.output[0])

        self.nodes_to_remove.append(conv)

        nodes_to_add = [input_transpose_node, nhwc_conv, output_transpose_node]
        if weight_transpose_node:
            nodes_to_add.append(weight_transpose_node)
        for node in nodes_to_add:
            self.node_name_to_graph_name[node.name] = self.this_graph_name
        self.nodes_to_add.extend(nodes_to_add)

        self.increase_counter("NhwcConv")
