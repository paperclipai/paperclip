# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import FusionUtils
from numpy import ndarray
from onnx import NodeProto, TensorProto
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionShape(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "Shape", "Concat")
        self.utils = FusionUtils(model)
        self.shape_infer = None
        self.shape_infer_done = False

    def get_dimensions_from_tensor_proto(self, tensor_proto: TensorProto) -> int | None:
        if tensor_proto.type.tensor_type.HasField("shape"):
            return len(tensor_proto.type.tensor_type.shape.dim)
        else:
            return None

    def get_dimensions(self, input_name: str) -> int | None:
        shape = self.model.get_shape(input_name)
        if shape is not None:
            return len(shape)

        if not self.shape_infer_done:
            self.shape_infer = self.model.infer_runtime_shape(update=True)
            self.shape_infer_done = True

        if self.shape_infer is not None:
            return self.get_dimensions_from_tensor_proto(self.shape_infer.known_vi_[input_name])

        return None

    def fuse(
        self,
        concat_node: NodeProto,
        input_name_to_nodes: dict[str, list[NodeProto]],
        output_name_to_node: dict[str, NodeProto],
    ):
        #
        # Simplify subgraph like
        #
        #          (2d_input)
        #           /       \
        #       Shape       shape
        #       /             \
        #   Gather(indices=0)  Gather(indices=1)
        #       |                |
        #   Unsqueeze(axes=0)   Unsqueeze(axes=0)
        #          \           /
        #             Concat
        #               |
        #
        # into  (2d_input) --> Shape -->
        #
        opset_version = self.model.get_opset_version()

        inputs = len(concat_node.input)
        root = None
        shape_output = None
        for i in range(inputs):
            path = self.model.match_parent_path(
                concat_node,
                ["Unsqueeze", "Gather", "Shape"],
                [i, 0, 0],
                output_name_to_node,
            )
            if path is None:
                return

            unsqueeze, gather, shape = path
            if i == 0:
                shape_output = shape.output[0]
            if root is None:
                root = shape.input[0]
                if self.get_dimensions(root) != inputs:
                    return
            elif shape.input[0] != root:
                return

            if not FusionUtils.check_node_attribute(unsqueeze, "axis", 0, default_value=0):
                return

            if opset_version < 13:
                if not FusionUtils.check_node_attribute(unsqueeze, "axes", [0]):
                    return
            else:
                if not self.utils.check_node_input_value(unsqueeze, 1, [0]):
                    return

            value = self.model.get_constant_value(gather.input[1])

            if not (isinstance(value, ndarray) and value.size == 1 and value.item() == i):
                return

        if self.model.find_graph_output(concat_node.output[0]) is None:
            self.model.replace_input_of_all_nodes(concat_node.output[0], shape_output)
            self.increase_counter("Reshape")
            self.prune_graph = True
