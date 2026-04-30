# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
"""Define SpaceToDepth fusion."""

import onnx

from ... import fusions, onnx_model


class FusionSpaceToDepth(fusions.Fusion):
    """Fusion for SpaceToDepth."""

    def __init__(self, model: onnx_model.ONNXModel):
        """Initialize.

        Args:
            model: An onnx_model.ONNXModel instance.
        """
        super().__init__(model, "SpaceToDepth", "Reshape")

    def _fuse_yolo(
        self,
        node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """Fuse for early version of YOLO.

        Pattern:

                |     [N, C, H, W]
             Reshape
                |     [N, C, H/blk, blk, W/blk, blk]
            Transpose
                |     [N, C, H/blk, W/blk, blk, blk]
             Reshape
                |     [N, C, H/blk * W/blk, blk * blk]
            Transpose
                |     [N, C, blk * blk, H/blk * W/blk]
             Reshape
                |     [N, C, blk * blk, H/blk, W/blk]
            Transpose
                |     [N, blk * blk, C, H/blk, W/blk]
             Reshape
                |     [N, blk * blk * C, H/blk, W/blk]

        This sequence can be fused into a single SpaceToDepth with blocksize `blk`. Note that unlike DepthToSpace
        supporting DCR or CRD mode, SpaceToDepth only supports DCR mode in its latest opset version (13), which matches
        the pattern here.
        """
        reshape_node1 = node

        def get_target_child(parent_node, target_op_type):
            """Get target child of given node."""
            if parent_node.output[0] not in input_name_to_nodes:
                return None

            children = input_name_to_nodes[parent_node.output[0]]
            if len(children) > 1 or children[0].op_type != target_op_type:
                return None

            return children[0]

        if (
            (transpose_node1 := get_target_child(reshape_node1, "Transpose")) is None
            or (reshape_node2 := get_target_child(transpose_node1, "Reshape")) is None
            or (transpose_node2 := get_target_child(reshape_node2, "Transpose")) is None
            or (reshape_node3 := get_target_child(transpose_node2, "Reshape")) is None
            or (transpose_node3 := get_target_child(reshape_node3, "Transpose")) is None
            or (reshape_node4 := get_target_child(transpose_node3, "Reshape")) is None
        ):
            return False

        def get_tensor_shape(tensor_name):
            """Get shape for given tensor name."""
            tensor_type = self.model.get_tensor_type(tensor_name)
            if not tensor_type:
                return None

            tensor_shape = self.tensor_shape_to_list(tensor_type)
            if not tensor_shape:
                return None

            return tensor_shape

        if (
            (input_shape := get_tensor_shape(reshape_node1.input[0])) is None
            or (reshape_shape1 := get_tensor_shape(reshape_node1.output[0])) is None
            or (reshape_shape2 := get_tensor_shape(reshape_node2.output[0])) is None
            or (reshape_shape3 := get_tensor_shape(reshape_node3.output[0])) is None
            or (reshape_shape4 := get_tensor_shape(reshape_node4.output[0])) is None
        ):
            return False

        transpose_perm1 = self.get_node_attribute(transpose_node1, "perm")
        transpose_perm2 = self.get_node_attribute(transpose_node2, "perm")
        transpose_perm3 = self.get_node_attribute(transpose_node3, "perm")

        # Check rank.
        if (
            len(input_shape) != 4
            or len(reshape_shape1) != 6
            or len(reshape_shape2) != 4
            or len(reshape_shape3) != 5
            or len(reshape_shape4) != 4
        ):
            return False

        # Check shape and perm.
        batch, channel, height, width = input_shape
        blocksize = reshape_shape1[3]
        if (
            reshape_shape1 != [batch, channel, height // blocksize, blocksize, width // blocksize, blocksize]
            or transpose_perm1 != [0, 1, 2, 4, 3, 5]
            or reshape_shape2 != [batch, channel, (height // blocksize) * (width // blocksize), blocksize**2]
            or transpose_perm2 != [0, 1, 3, 2]
            or reshape_shape3 != [batch, channel, blocksize**2, height // blocksize, width // blocksize]
            or transpose_perm3 != [0, 2, 1, 3, 4]
            or reshape_shape4 != [batch, blocksize**2 * channel, height // blocksize, width // blocksize]
        ):
            return False

        self.nodes_to_remove.extend(
            [
                reshape_node1,
                transpose_node1,
                reshape_node2,
                transpose_node2,
                reshape_node3,
                transpose_node3,
                reshape_node4,
            ]
        )

        s2d_node = onnx.helper.make_node(
            self.fused_op_type,
            name=self.create_unique_node_name(),
            inputs=[reshape_node1.input[0]],
            outputs=[reshape_node4.output[0]],
            blocksize=blocksize,
        )
        self.nodes_to_add.append(s2d_node)

        return True

    def fuse(
        self,
        node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """Fuse a sequence of Reshape and Transpose nodes into a single SpaceToDepth node.

        Args:
            node: An onnx.NodeProto matching the specified search type (i.e., Reshape).
            input_name_to_nodes: A dict mapping tensor name to consumed nodes.
            output_name_to_node: A dict mapping tensor name to produced node.
        """
        self._fuse_yolo(node, input_name_to_nodes, output_name_to_node)
