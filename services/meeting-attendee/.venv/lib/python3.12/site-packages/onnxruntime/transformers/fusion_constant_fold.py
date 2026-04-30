# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import NumpyHelper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionConstantFold(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "", ["Transpose"])
        self.count = 0

    def apply(self):
        super().apply()
        if self.count > 0:
            logger.info(f"Constant Folded: {self.count}")

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        """
        Apply multiple fusions on Transpose nodes that can be constant folded.
        """
        self.fuse_1(node, input_name_to_nodes, output_name_to_node)
        self.fuse_2(node, input_name_to_nodes, output_name_to_node)

    def fuse_1(self, node, input_name_to_nodes, output_name_to_node):
        """
        Constant fold any initializer data representing a MatMul's
        weights that are stored in a Transpose op

        Ex: Transpose --> Gemm or Transpose --> MatMul
        """
        # Check if Transpose node only has one input and one output
        if len(node.input) != 1 or len(node.output) != 1:
            logger.debug("fuse_constant_fold: node has more than one input or output")
            return

        # Check if input is initializer data
        proto = self.model.get_initializer(node.input[0])
        if proto is None:
            logger.debug("fuse_constant_fold: failed to identify initializer input")
            return

        # Check that all nodes using input are Transpose ops that also only use the initializer data as input
        skip = False
        for child_node in input_name_to_nodes[node.input[0]]:
            if not (child_node.op_type == "Transpose" and len(node.input) == 1):
                skip = True
                break
        if skip:
            logger.debug("fuse_constant_fold: other non-Transpose nodes use the initializer")
            return

        # Check that all nodes using output are Gemm or MatMul ops
        for child_node in input_name_to_nodes[node.output[0]]:
            if not (child_node.op_type == "Gemm" or child_node.op_type == "MatMul"):
                skip = True
                break
        if skip:
            logger.debug("fuse_constant_fold: other non-Gemm and non-MatMul nodes use the transposed data")
            return

        # Check if initializer data is 2D
        weight = NumpyHelper.to_array(proto)
        if len(weight.shape) != 2:
            logger.debug("fuse_constant_fold: shape of initializer data is not 2D")
            return

        # Remove old TensorProto and add new TensorProto while re-using same name
        name = proto.name
        dtype = proto.data_type
        self.remove_initializer(proto)
        self.add_initializer(
            name=name,
            data_type=dtype,
            dims=[weight.shape[1], weight.shape[0]],
            vals=weight.T,
        )

        # Update weights input to be the initializer name and not
        # the output of the Transpose op
        for child_node in input_name_to_nodes[node.output[0]]:
            for i in range(len(child_node.input)):
                if child_node.input[i] == node.output[0]:
                    child_node.input[i] = node.input[0]

                    if child_node.op_type == "Gemm" and (i == 0 or i == 1):
                        # Ensure that transA/transB is set to 0 in Gemm
                        key = "transA" if i == 0 else "transB"
                        for j, attr_key in enumerate(child_node.attribute):
                            if attr_key.name == key:
                                child_node.attribute[j].i = 0

        # Add node to list of nodes to remove
        self.nodes_to_remove.append(node)
        self.count += 1

    def fuse_2(self, node, input_name_to_nodes, output_name_to_node):
        """
        Constant fold any Transpose --> Transpose ops since the root input
        is the final result

        Ex: root_input --> Transpose --> Transpose --> next_node to root_input --> next_node
        """
        # Check if Transpose node only has one input and one output
        if len(node.input) != 1 or len(node.output) != 1:
            logger.debug("fuse_constant_fold: node has more than one input or output")
            return

        # Check if parent node is Transpose node with only one input and one output
        parent_node = self.model.match_parent(node, "Transpose", 0)
        if parent_node is None:
            logger.debug("fuse_constant_fold: failed to identify parent Transpose node")
            return
        if len(parent_node.input) != 1 or len(parent_node.output) != 1:
            logger.debug("fuse_constant_fold: parent node has more than one input or output")
            return

        node_perm = node.attribute[0].ints
        parent_node_perm = parent_node.attribute[0].ints

        if node_perm != parent_node_perm:
            logger.debug("fuse_constant_fold: Transpose node permutations aren't identical")
            return

        # For nodes that use output of child Transpose node as an input,
        # replace that input with root_input
        root_input = parent_node.input[0]
        output_nodes = input_name_to_nodes[node.output[0]]
        for output_node in output_nodes:
            for i, input_ in enumerate(output_node.input):
                if input_ == node.output[0]:
                    output_node.input[i] = root_input

        # Add node to list of nodes to remove
        self.nodes_to_remove.append(node)
        self.nodes_to_remove.append(parent_node)
        self.count += 1
