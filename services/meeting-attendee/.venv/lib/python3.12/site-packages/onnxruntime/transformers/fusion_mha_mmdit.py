# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_base import Fusion
from fusion_utils import FusionUtils
from onnx import NodeProto, TensorProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionMultiHeadAttentionMMDit(Fusion):
    """
    Fuse MultiHeadAttention for Multimodal Diffusion Transformer (MMDiT).
    """

    def __init__(self, model: OnnxModel):
        super().__init__(model, fused_op_type="MultiHeadAttention", search_op_types=["Softmax"])
        self.unsqueeze_update_map = {}

    def get_num_heads(self, start_node: NodeProto, output_name_to_node, input_index=0) -> int:
        """
        Detect num_heads from Reshape & Transpose of q/k/v for both Stable Diffusion 3.x and Flux 1.x:

                MatMul    .. [-1] [24] ..
                 |        |  |  /   /
                Add     Concat(axis=0)
                  |      /
                  Reshape
                     |
                 Transpose(perm=0,1,3,2)
                     |
               (start_node)
        """
        nodes = self.model.match_parent_path(
            start_node, ["Transpose", "Reshape", "Concat"], [input_index, 0, 1], output_name_to_node=output_name_to_node
        )
        if nodes is None:
            return 0

        concat_shape = nodes[-1]
        if len(concat_shape.input) != 4:
            return 0

        value = self.model.get_constant_value(concat_shape.input[2])
        if value is None:
            return 0

        if len(value.shape) != 1:
            return 0

        return int(value[0])

    def get_num_heads_from_k(self, transpose_k: NodeProto, output_name_to_node, concat_before_transpose: bool) -> int:
        """
                Detect num_heads from subgraph like the following (num_heads=24 in this example):
                               MatMu    .. [-1] [24] ..
                                 |       |  |  /   /
                                Add     Concat
                                  |      /
                                 Reshape
                                    |
                             Transpose(perm=0,2,1,3)
                                    |
                             SimplifiedLayerNormalization
                                    |
                            Transpose(perm=0,1,3,2)

                Another variant is to an extra Concat node to join two symmetrical subgraphs:

                           |              |
                          MatMul        MatMul   .. [-1] [24] ..
                           |              |       |  |  /   /
                          Add  Concat    Add      Concat
                            |  /          |      /
                          Reshape         Reshape
                            |              |
                         Transpose     Transpose(perm=0,2,1,3)
                            |              |
        SimplifiedLayerNormalization  SimplifiedLayerNormalization
                                |     /
                               Concat
                                 |
                            Transpose(perm=0,1,3,2)

                    Both patterns are used in stable diffusion 3.5 model.
        """
        if concat_before_transpose:
            nodes = self.model.match_parent_path(
                transpose_k, ["Concat", "SimplifiedLayerNormalization"], [0, 1], output_name_to_node=output_name_to_node
            )
            if nodes:
                return self.get_num_heads(nodes[1], output_name_to_node)
        else:
            nodes = self.model.match_parent_path(
                transpose_k, ["SimplifiedLayerNormalization"], [0], output_name_to_node=output_name_to_node
            )
            if nodes:
                return self.get_num_heads(nodes[0], output_name_to_node)

        return 0

    def reshape_to_3d(self, input_name: str, output_name: str) -> str:
        """Add a Reshape node to convert 4D BxSxNxH to 3D BxSxD.

        Args:
            input_name (str): input name for the 4D tensor of shape BxSxNxH.
            output_name (str): output name for the 3D tensor of shape BxSxD, where D = N * H.

        Returns:
            str: the output name
        """

        new_dims_name = "bsnh_to_bsd_reshape_dims"
        new_dims = self.model.get_initializer(new_dims_name)
        if new_dims is None:
            new_dims = numpy_helper.from_array(np.array([0, 0, -1], dtype="int64"), name=new_dims_name)
            self.model.add_initializer(new_dims, self.this_graph_name)
        reshape_q = helper.make_node(
            "Reshape",
            inputs=[input_name, new_dims_name],
            outputs=[output_name],
            name=self.model.create_node_name("Reshape"),
        )
        self.nodes_to_add.append(reshape_q)
        self.node_name_to_graph_name[reshape_q.name] = self.this_graph_name
        return reshape_q.output[0]

    def adjust_query_from_bnsh_to_bsd_no_concat(self, mul_q: NodeProto, output_name_to_node) -> str | None:
        """
        MultiHeadAttenion requires query in BSD format. This function adjusts query from BNSH to BSD format.

        Before:
                               MatMul
                                 |
                               Add      Concat
                                 |      /
                                 Reshape
                                  |
                               Transpose(perm=0,2,1,3)
                                  |
                       SimplifiedLayerNorm
                                  |
                                 Mul

        After:
                               MatMul
                                 |
                                Add      Concat
                                 |      /
                                 Reshape
                                   |
                           SimplifiedLayerNorm
                                   |
                        Reshape (shape=[0, 0, -1])
        """

        path = self.model.match_parent_path(
            mul_q,
            ["SimplifiedLayerNormalization", "Transpose"],
            [0, 0],
        )
        if path is None:
            return None
        sln_a, transpose_a = path

        if not FusionUtils.check_node_attribute(transpose_a, "perm", [0, 2, 1, 3]):
            return None

        # Update the graph
        sln_a.input[0] = transpose_a.input[0]
        sln_output = sln_a.output[0]
        sln_a.output[0] = sln_output + "_BSNH"

        return self.reshape_to_3d(sln_a.output[0], sln_output + "_BSD")

    def adjust_query_from_bnsh_to_bsd(self, mul_q: NodeProto, output_name_to_node) -> str | None:
        """
        MultiHeadAttenion requires query in BSD format. This function adjusts query from BNSH to BSD format.

            Before:
                      MatMul      MatMul
                        |            |
                        Add Concat  Add    Concat
                         |    /      |      /
                         Reshape     Reshape
                            |           |
        Transpose(perm=0,2,1,3)      Transpose(perm=0,2,1,3)
                            |           |
            SimplifiedLayerNorm  SimplifiedLayerNorm
                            |     /
                            Concat(axis=2)
                             |
                            Mul

            After:
                   MatMul        MatMul
                     |              |
                    Add Concat     Add     Concat
                     |    /         |     /
                     Reshape       Reshape
                        |            |
           SimplifiedLayerNorm  SimplifiedLayerNorm
                        |       /
                      Concat(axis=1)
                         |
                      Reshape (shape=[0, 0, -1])
        """

        path = self.model.match_parent_path(
            mul_q,
            ["Concat", "SimplifiedLayerNormalization", "Transpose"],
            [0, 0, 0],
        )
        if path is None:
            return None
        concat, sln_a, transpose_a = path

        if len(concat.input) != 2:
            return None

        path = self.model.match_parent_path(
            concat,
            ["SimplifiedLayerNormalization", "Transpose"],
            [1, 0],
        )
        if path is None:
            return None
        sln_b, transpose_b = path

        if not FusionUtils.check_node_attribute(transpose_a, "perm", [0, 2, 1, 3]):
            return None

        if not FusionUtils.check_node_attribute(transpose_b, "perm", [0, 2, 1, 3]):
            return None

        if not FusionUtils.check_node_attribute(concat, "axis", 2):
            return None

        # Update the graph
        sln_a.input[0] = transpose_a.input[0]
        sln_b.input[0] = transpose_b.input[0]

        new_concat_node = helper.make_node(
            "Concat",
            inputs=[sln_a.output[0], sln_b.output[0]],
            outputs=[concat.output[0] + "_BSNH"],
            name=self.model.create_node_name("Concat"),
            axis=1,
        )
        self.nodes_to_add.append(new_concat_node)
        self.node_name_to_graph_name[new_concat_node.name] = self.this_graph_name

        return self.reshape_to_3d(new_concat_node.output[0], concat.output[0] + "_BSD")

    def update_unsqueeze_axes_1_to_2(self, unsqueeze: NodeProto) -> str:
        updated_unsqueeze_output = self.unsqueeze_update_map.get(unsqueeze.name)
        if updated_unsqueeze_output is None:
            if len(unsqueeze.input) == 1:
                new_node = helper.make_node(
                    "Unsqueeze",
                    inputs=unsqueeze.input,
                    outputs=[unsqueeze.output[0] + "_BSNH"],
                    name=self.model.create_node_name("Unsqueeze"),
                    axes=[2],
                )
            else:
                initializer_name = "unsqueeze_axes_2"
                if self.model.get_initializer(initializer_name) is None:
                    unsqueeze_axes_2 = helper.make_tensor(
                        name=initializer_name,
                        data_type=TensorProto.INT64,
                        dims=[1],  # Shape of the tensor
                        vals=[2],  # Tensor values
                    )
                    self.model.add_initializer(unsqueeze_axes_2, self.this_graph_name)

                new_node = helper.make_node(
                    "Unsqueeze",
                    inputs=[unsqueeze.input[0], initializer_name],
                    outputs=[unsqueeze.output[0] + "_BSNH"],
                    name=self.model.create_node_name("Unsqueeze"),
                )

            self.nodes_to_add.append(new_node)
            self.node_name_to_graph_name[new_node.name] = self.this_graph_name
            updated_unsqueeze_output = new_node.output[0]
            self.unsqueeze_update_map[unsqueeze.name] = updated_unsqueeze_output

        return updated_unsqueeze_output

    def update_unsqueeze_axes(self, add: NodeProto, output_name_to_node: dict[str, NodeProto]) -> bool:
        """
        Update axes of Unsqueeze from [1] to [2] in the following pattern:
                  Unsqueeze        Unsqueeze
                  (axes=[0])       (axes=[0])
                     |              |
                  Unsqueeze        Unsqueeze
              ... (axes=[1])  ...  (axes=[1])
                |     /        |   /
                   Mul         Mul
                    |       /
                     Add
        Args:
            add (NodeProto): the Add node
            output_name_to_node (Dict[str, NodeProto]): mapping from output name to node

        Returns:
            bool: True if the pattern is matched and updated successfully, False otherwise.
        """
        if len(add.input) != 2:
            return False

        # Check axes of Unsqueeze nodes are [0] and [1], and change to [0] and [2] respectively.
        nodes_b = self.model.match_parent_path(add, ["Mul", "Unsqueeze", "Unsqueeze"], [1, 1, 0], output_name_to_node)
        if nodes_b is None:
            return False

        fusion_utils = FusionUtils(self.model)
        axes_1 = fusion_utils.get_squeeze_or_unsqueeze_axes(nodes_b[1])
        if axes_1 is None or axes_1 != [1]:
            return False

        axes_0 = fusion_utils.get_squeeze_or_unsqueeze_axes(nodes_b[2])
        if axes_0 is None or axes_0 != [0]:
            return False

        # Check axes of Unsqueeze nodes are [0] and [1], and change to [0] and [2] respectively.
        nodes_a = self.model.match_parent_path(add, ["Mul", "Unsqueeze", "Unsqueeze"], [0, 1, 0], output_name_to_node)
        if nodes_a is None:
            return False

        axes_1 = fusion_utils.get_squeeze_or_unsqueeze_axes(nodes_a[1])
        if axes_1 is None or axes_1 != [1]:
            return False

        axes_0 = fusion_utils.get_squeeze_or_unsqueeze_axes(nodes_a[2])
        if axes_0 is None or axes_0 != [0]:
            return False

        nodes_a[0].input[1] = self.update_unsqueeze_axes_1_to_2(nodes_a[1])
        nodes_b[0].input[1] = self.update_unsqueeze_axes_1_to_2(nodes_b[1])
        return True

    def adjust_flux_query_from_bnsh_to_bsd(self, mul_q: NodeProto, output_name_to_node) -> str | None:
        """
        Adjust graph to change query format from BNSH to BSD for Flux model.
        Note that the graph pattern is complex, and we only do a shallow match here.

        Before:
                       |               |
        Transpose(perm=0,2,1,3)    Transpose(perm=0,2,1,3)
                        |              |
        SimplifiedLayerNorm  SimplifiedLayerNorm
                        |             /
                        Concat(axis=2)
                         |
                        Mul     Mul
                         |    /
                          Add
                           |
                          Mul

        After (Transpose nods are removed, and a Reshape is added):

                        |           |
            SimplifiedLayerNorm  SimplifiedLayerNorm
                        |         /
                    Concat(axis=1)
                        |
                        Mul    Mul
                         |    /
                          Add
                           |
                       Reshape (shape=[0, 0, -1])
        """

        path = self.model.match_parent_path(
            mul_q,
            ["Add", "Mul", "Concat", "SimplifiedLayerNormalization", "Transpose"],
            [0, 0, 0, 0, 0],
        )
        if path is None:
            return None
        add, _mul_a, concat, sln_a, transpose_a = path

        if len(concat.input) != 2:
            return None

        path = self.model.match_parent_path(
            concat,
            ["SimplifiedLayerNormalization", "Transpose"],
            [1, 0],
        )
        if path is None:
            return None
        sln_b, transpose_b = path

        if not FusionUtils.check_node_attribute(transpose_a, "perm", [0, 2, 1, 3]):
            return None

        if not FusionUtils.check_node_attribute(transpose_b, "perm", [0, 2, 1, 3]):
            return None

        if not FusionUtils.check_node_attribute(concat, "axis", 2):
            return None

        # Need adjust axes of Unsqueeze nodes from [1] to [2] so that the tensors to Mul nodes are BSNH instead of BNSH.
        if not self.update_unsqueeze_axes(add, output_name_to_node):
            return None

        # Update the graph
        sln_a.input[0] = transpose_a.input[0]
        sln_b.input[0] = transpose_b.input[0]

        new_concat_node = helper.make_node(
            "Concat",
            inputs=[sln_a.output[0], sln_b.output[0]],
            outputs=[concat.output[0] + "_BSNH"],
            name=self.model.create_node_name("Concat"),
            axis=1,
        )
        self.nodes_to_add.append(new_concat_node)
        self.node_name_to_graph_name[new_concat_node.name] = self.this_graph_name
        self.model.replace_input_of_all_nodes(concat.output[0], new_concat_node.output[0])

        return self.reshape_to_3d(add.output[0], add.output[0] + "_BSD")

    def adjust_flux_single_query_from_bnsh_to_bsd(self, mul_q: NodeProto, output_name_to_node) -> str | None:
        """
        Adjust graph to change query format from BNSH to BSD for Flux model.
        Note that the graph pattern is complex, and we only do a shallow match here.

        Before:
                      |
                    Transpose(perm=0,2,1,3)
                      |
                    SimplifiedLayerNorm
                      |
                     Mul     Mul
                       |   /
                       Add
                        |
                       Mul

        After (Transpose is removed, and a Reshape is added):

                        |
                      SimplifiedLayerNorm
                        |
                        Mul   Mul
                         |   /
                         Add
                          |
                       Reshape (shape=[0, 0, -1])
        """

        path = self.model.match_parent_path(
            mul_q,
            ["Add", "Mul", "SimplifiedLayerNormalization", "Transpose"],
            [0, 0, 0, 0],
        )
        if path is None:
            return None
        add, _mul_a, sln_a, transpose_a = path

        if not FusionUtils.check_node_attribute(transpose_a, "perm", [0, 2, 1, 3]):
            return None

        # Need adjust axes of Unsqueeze nodes from [1] to [2] so that the tensors to Mul nodes are BSNH instead of BNSH.
        if not self.update_unsqueeze_axes(add, output_name_to_node):
            return None

        # Update the graph
        sln_a.input[0] = transpose_a.input[0]
        add.output[0] = add.output[0] + "_BSNH"

        return self.reshape_to_3d(add.output[0], add.output[0] + "_BSD")

    def transpose_reshape_bnsh_to_bsd(self, q: str, output_name_to_node) -> str | None:
        transpose_q = helper.make_node(
            "Transpose",
            [q],
            [q + "_BSNH"],
            name=self.model.create_node_name("Transpose", name_prefix="Transpose_BNSH_to_BSNH"),
            perm=[0, 2, 1, 3],
        )
        self.nodes_to_add.append(transpose_q)
        self.node_name_to_graph_name[transpose_q.name] = self.this_graph_name

        return self.reshape_to_3d(q + "_BSNH", q + "_BSD")

    def create_multihead_attention_node(
        self,
        q: str,
        k: str,
        v: str,
        output: str,
        num_heads: int,
    ) -> NodeProto:
        """
        Create a MultiHeadAttention node.

        Args:
            q (str): name of q
            k (str): name of k
            v (str): name of v
            output (str): output name of MHA
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.

        Returns:
            NodeProto: the node created.
        """

        assert num_heads > 0

        # Add inputs for MHA: Query, Key, Value (Proj_Bias, Mask, Attention_Bias, Past_K, Past_V are optional)
        mha_inputs = [q, k, v]

        # Add outputs for MHA (Present_K, Present_V are optional)
        mha_outputs = [output]

        mha_node = helper.make_node(
            "MultiHeadAttention",
            inputs=mha_inputs,
            outputs=mha_outputs,
            name=self.model.create_node_name("MultiHeadAttention"),
        )

        mha_node.domain = "com.microsoft"
        mha_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        # No mask is used in MMDit model, so we need not set the optional mask_filter_value attribute.
        return mha_node

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        assert node.op_type == "Softmax"
        softmax = node

        # Softmax output shall not be graph output.
        if self.model.find_graph_output(softmax.output[0]):
            return

        nodes = self.model.match_child_path(
            softmax, ["MatMul", "Transpose", "Reshape"], [(0, 0), (0, 0), (0, 0)], input_name_to_nodes
        )
        if nodes is None:
            return

        matmul_s_v, transpose_out, reshape_out = nodes
        if not FusionUtils.check_node_attribute(transpose_out, "perm", [0, 2, 1, 3]):
            return

        q_nodes = self.model.match_parent_path(
            softmax,
            ["MatMul", "Mul", "Sqrt", "Div", "Sqrt", "Cast", "Slice", "Shape"],
            [0, 0, 1, 0, 1, 0, 0, 0],
        )

        if q_nodes is None:
            return

        matmul_qk, mul_q, sqrt_q_2, div_q, sqrt_q, _, _, shape_q = q_nodes

        q_bnsh = mul_q.input[0]
        if q_bnsh != shape_q.input[0]:
            return

        k_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose"], [1, 0])
        if k_nodes is None:
            return

        mul_k, transpose_k = k_nodes
        k = transpose_k.input[0]
        if not FusionUtils.check_node_attribute(transpose_k, "perm", [0, 1, 3, 2]):
            return

        k_scale_nodes = self.model.match_parent_path(mul_k, ["Sqrt", "Div"], [1, 0])
        if k_scale_nodes is None:
            return
        if k_scale_nodes[0].input[0] != sqrt_q_2.input[0]:
            return

        v = matmul_s_v.input[1]

        # Here we sanity check the v path to make sure it is in the expected BNSH format.
        concat_v = self.model.match_parent(matmul_s_v, "Concat", input_index=1, output_name_to_node=output_name_to_node)
        if concat_v is not None:
            # Match v path like:
            #   -- Transpose (perm=[0,2,1,3]) ----+
            #                                     |
            #                                     v
            #   -- Transpose (perm=[0,2,1,3]) -> Concat -> (v)
            transpose_1 = self.model.match_parent(
                concat_v, "Transpose", input_index=0, output_name_to_node=output_name_to_node
            )
            if transpose_1 is None:
                return
            if not FusionUtils.check_node_attribute(transpose_1, "perm", [0, 2, 1, 3]):
                return

            transpose_2 = self.model.match_parent(
                concat_v, "Transpose", input_index=1, output_name_to_node=output_name_to_node
            )
            if transpose_2 is None:
                return
            if not FusionUtils.check_node_attribute(transpose_2, "perm", [0, 2, 1, 3]):
                return
        else:
            # Match v path like:
            #   -- Transpose (perm=[0,2,1,3]) -> (v)
            transpose_1 = self.model.match_parent(
                matmul_s_v, "Transpose", input_index=1, output_name_to_node=output_name_to_node
            )
            if transpose_1 is None:
                return
            if not FusionUtils.check_node_attribute(transpose_1, "perm", [0, 2, 1, 3]):
                return

        # Match patterns for Flux.
        num_heads = (
            self.get_num_heads(concat_v, output_name_to_node)
            if concat_v
            else self.get_num_heads(matmul_s_v, output_name_to_node, input_index=1)
        )

        if num_heads == 0:
            # Match patterns for Stable Diffusion 3.5.
            num_heads = self.get_num_heads_from_k(transpose_k, output_name_to_node, concat_v is not None)
            if num_heads <= 0:
                return

        # Q is in BNSH format, we need to adjust it to BSD format due to limitation of MHA op.
        # TODO: MHA op support BNSH format to reduce the effort in fusion.
        if concat_v is not None:
            query = self.adjust_query_from_bnsh_to_bsd(mul_q, output_name_to_node)
        else:
            query = self.adjust_query_from_bnsh_to_bsd_no_concat(mul_q, output_name_to_node)

        if query is None:
            query = self.adjust_flux_query_from_bnsh_to_bsd(mul_q, output_name_to_node)
            if query is None:
                query = self.adjust_flux_single_query_from_bnsh_to_bsd(mul_q, output_name_to_node)
                if query is None:
                    # fallback to use Transpose and Add to adjust query from BNSH to BSD
                    # This is more general approach.
                    # However, it might be slower if the extra Transpose node cannot be removed by ORT optimizer.
                    query = self.transpose_reshape_bnsh_to_bsd(q_bnsh, output_name_to_node)

        new_node = self.create_multihead_attention_node(
            q=query,
            k=k,
            v=v,
            output=reshape_out.output[0],
            num_heads=num_heads,
        )
        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([matmul_s_v, transpose_out, reshape_out])

        # Use prune graph to remove nodes
        self.prune_graph = True
