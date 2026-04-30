# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import FusionUtils
from onnx import NodeProto, TensorProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionTranspose(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "Transpose", "Transpose")

    def fuse(
        self,
        transpose_node: NodeProto,
        input_name_to_nodes: dict[str, list[NodeProto]],
        output_name_to_node: dict[str, NodeProto],
    ):
        """
        Note that onnxruntime will do comprehensive transpose optimization after loading model.
        The purpose of this fusion is to make graph clean before running onnxruntime.

        Case 1:
              (input)-->Transpose(perm=a)-->Transpose(perm=b)-->
        After:
              (input)-->Transpose(perm=a)-->  (this path can be removed if the output is not used anymore)
                |
                +----->Transpose(perm=a*b)-->

        Case 2 (Cast has only one child):
              (input)-->Transpose(perm=a)--> Cast -->Transpose(perm=b)-->
        After:
              (input)-->Transpose(perm=a)-->  (this path can be removed if the output is not used anymore)
                |
                +----->Cast --> Transpose(perm=a*b)-->
        """
        transpose_b = transpose_node
        if transpose_b.input[0] not in output_name_to_node:
            return

        transpose_a = output_name_to_node[transpose_b.input[0]]
        if transpose_a.op_type != "Cast":
            cast_node = None
        else:
            cast_node = transpose_a

            cast_children = self.model.get_children(cast_node, input_name_to_nodes)
            if cast_children and len(cast_children) > 1:
                return

            if cast_node.input[0] not in output_name_to_node:
                return

            transpose_a = output_name_to_node[cast_node.input[0]]

        if transpose_a.op_type != "Transpose":
            return

        permutation = OnnxModel.get_node_attribute(transpose_b, "perm")
        assert isinstance(permutation, list)

        parent_permutation = OnnxModel.get_node_attribute(transpose_a, "perm")
        assert isinstance(parent_permutation, list)

        assert len(parent_permutation) == len(permutation)

        output_permutation = []
        for _j, index in enumerate(permutation):
            output_permutation.append(parent_permutation[index])

        if cast_node is None:
            if FusionUtils.skip_parent(self.model, transpose_b, transpose_a, input_name_to_nodes):
                self.nodes_to_remove.append(transpose_a)
        else:
            if FusionUtils.skip_parent(self.model, cast_node, transpose_a, input_name_to_nodes):
                self.nodes_to_remove.append(transpose_a)
        transpose_b.ClearField("attribute")
        transpose_b.attribute.extend([helper.make_attribute("perm", output_permutation)])


class FusionInsertTranspose(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "", "GroupNorm")

    def create_transpose_node(self, input_name: str, perm: list[int], output_name=None):
        """Append a Transpose node after an input"""
        node_name = self.model.create_node_name("Transpose")
        if output_name is None:
            output_name = node_name + "_out" + "-" + input_name
        transpose_node = helper.make_node("Transpose", inputs=[input_name], outputs=[output_name], name=node_name)
        transpose_node.attribute.extend([helper.make_attribute("perm", perm)])
        return transpose_node

    def fuse(
        self,
        group_norm_node: NodeProto,
        input_name_to_nodes: dict[str, list[NodeProto]],
        output_name_to_node: dict[str, NodeProto],
    ):
        """
        This optimization will insert an Transpose, and onnxruntime transpose optimizer will remove it together with
        another Transpose so that we can get effect of reducing one Transpose after onnxruntime optimization.
        Before:
            --> Gemm --> Unsqueeze(axes=[2]) --> Unsqueeze(axes=[3]) --> Add --> Transpose([0,2,3,1]) --> GroupNorm
        After:
            --> Gemm --> Unsqueeze(axes=[1]) --> Unsqueeze(axes=[2]) -->Transpose([0,3,1,2]) --> Add --> Transpose([0,2,3,1]) --> GroupNorm
        """
        gemm_path = self.model.match_parent_path(
            group_norm_node, ["Transpose", "Add", "Unsqueeze", "Unsqueeze", "Gemm"], [0, 0, None, 0, 0]
        )
        if gemm_path is None:
            return
        transpose, add, unsqueeze_3, unsqueeze_2, gemm = gemm_path
        if self.model.find_graph_output(unsqueeze_3.output[0]):
            return

        permutation = OnnxModel.get_node_attribute(transpose, "perm")
        assert isinstance(permutation, list)
        if permutation != [0, 2, 3, 1]:
            return

        if not (
            len(unsqueeze_3.input) == 2
            and self.model.get_constant_value(unsqueeze_3.input[1]) == 3
            and len(unsqueeze_2.input) == 2
            and self.model.get_constant_value(unsqueeze_2.input[1]) == 2
            and len(self.model.get_children(gemm, input_name_to_nodes)) == 1
            and len(self.model.get_children(unsqueeze_3, input_name_to_nodes)) == 1
            and len(self.model.get_children(unsqueeze_2, input_name_to_nodes)) == 1
        ):
            return

        # Here we use hard-coded name so that it could be shared for the whole model.
        axes_1 = "ort_const_unsqueeze_axes_1"
        if self.model.get_initializer(axes_1) is None:
            self.add_initializer(
                name=axes_1,
                data_type=TensorProto.INT64,
                dims=[1],
                vals=[1],
                raw=False,
            )

        axes_2 = "ort_const_unsqueeze_axes_2"
        if self.model.get_initializer(axes_2) is None:
            self.add_initializer(
                name=axes_2,
                data_type=TensorProto.INT64,
                dims=[1],
                vals=[2],
                raw=False,
            )

        unsqueeze_3.input[1] = "ort_const_unsqueeze_axes_2"
        unsqueeze_2.input[1] = "ort_const_unsqueeze_axes_1"
        transpose_output_name = self.model.create_node_name("Transpose") + "_NCHW"
        self.model.replace_input_of_all_nodes(unsqueeze_3.output[0], transpose_output_name)
        new_transpose = self.create_transpose_node(unsqueeze_3.output[0], [0, 3, 1, 2], transpose_output_name)
        self.model.add_node(new_transpose, self.this_graph_name)
        self.increase_counter("Insert Transpose")
