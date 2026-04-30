# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_base import Fusion
from fusion_utils import NumpyHelper
from onnx import NodeProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionMultiHeadAttentionSam2(Fusion):
    """
    Fuse MultiHeadAttention subgraph of Segment Anything v2 (SAM2).
    """

    def __init__(
        self,
        model: OnnxModel,
        hidden_size: int,
        num_heads: int,
    ):
        super().__init__(model, "MultiHeadAttention", ["LayerNormalization"])
        self.hidden_size = hidden_size
        self.num_heads = num_heads

        # Flags to show warning only once
        self.num_heads_warning = True
        self.hidden_size_warning = True

    def get_decoder_num_heads(self, reshape_q: NodeProto) -> int:
        """Detect num_heads from a reshape node.

        Args:
            reshape_q (NodeProto): reshape node for Q
        Returns:
            int: num_heads, or 0 if not found
        """
        num_heads = 0

        # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
        shape_value = self.model.get_constant_value(reshape_q.input[1])
        if shape_value is not None:
            if isinstance(shape_value, np.ndarray) and list(shape_value.shape) == [4]:
                num_heads = int(shape_value[2])

        if isinstance(num_heads, int) and num_heads > 0:
            return num_heads

        return 0

    def get_encoder_num_heads(self, reshape_in: NodeProto) -> int:
        """Detect num_heads from a reshape node.

        Args:
            reshape_q (NodeProto): reshape node for Q
        Returns:
            int: num_heads, or 0 if not found
        """
        num_heads = 0

        shape_value = self.model.get_constant_value(reshape_in.input[1])
        if shape_value is not None:
            if isinstance(shape_value, np.ndarray) and list(shape_value.shape) == [5]:
                num_heads = int(shape_value[3])
        else:
            concat_shape = self.model.match_parent(reshape_in, "Concat", 1)
            if concat_shape is not None and len(concat_shape.input) == 5:
                # we assume that reshape fusion has done, so the shape is a tensor like [0, 0, num_heads, head_size]
                shape_value = self.model.get_constant_value(concat_shape.input[3])
                if shape_value is not None:
                    if isinstance(shape_value, np.ndarray) and list(shape_value.shape) == [1]:
                        num_heads = int(shape_value[0])

        if isinstance(num_heads, int) and num_heads > 0:
            return num_heads

        return 0

    def get_hidden_size(self, layernorm_node):
        """Detect hidden_size from LayerNormalization node.
        Args:
            layernorm_node (NodeProto): LayerNormalization node before Q, K and V
        Returns:
            int: hidden_size, or 0 if not found
        """
        layernorm_bias = self.model.get_initializer(layernorm_node.input[2])
        if layernorm_bias:
            return NumpyHelper.to_array(layernorm_bias).shape[0]

        return 0

    def get_num_heads_and_hidden_size(
        self, reshape_q: NodeProto, layernorm_node: NodeProto, is_encoder: bool = False
    ) -> tuple[int, int]:
        """Detect num_heads and hidden_size.

        Args:
            reshape_q (NodeProto): reshape node for Q
            layernorm_node (NodeProto): LayerNormalization node before Q, K, V
        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """
        if is_encoder:
            num_heads = self.get_encoder_num_heads(reshape_q)
        else:
            num_heads = self.get_decoder_num_heads(reshape_q)
        if num_heads <= 0:
            num_heads = self.num_heads  # Fall back to user specified value

        if self.num_heads > 0 and num_heads != self.num_heads:
            if self.num_heads_warning:
                logger.warning(f"--num_heads is {self.num_heads}. Detected value is {num_heads}. Using detected value.")
                self.num_heads_warning = False  # Do not show the warning more than once

        hidden_size = self.get_hidden_size(layernorm_node)
        if hidden_size <= 0:
            hidden_size = self.hidden_size  # Fall back to user specified value

        if self.hidden_size > 0 and hidden_size != self.hidden_size:
            if self.hidden_size_warning:
                logger.warning(
                    f"--hidden_size is {self.hidden_size}. Detected value is {hidden_size}. Using detected value."
                )
                self.hidden_size_warning = False  # Do not show the warning more than once

        return num_heads, hidden_size

    def create_attention_node(
        self,
        q_matmul: NodeProto,
        q_add: NodeProto,
        k_matmul: NodeProto,
        k_add: NodeProto,
        v_matmul: NodeProto,
        v_add: NodeProto,
        num_heads: int,
        hidden_size: int,
        output: str,
    ) -> NodeProto | None:
        """Create an Attention node.

        Args:
            q_matmul (NodeProto): MatMul node in fully connection for Q
            q_add (NodeProto): Add bias node in fully connection for Q
            k_matmul (NodeProto): MatMul node in fully connection for K
            k_add (NodeProto): Add bias node in fully connection for K
            v_matmul (NodeProto): MatMul node in fully connection for V
            v_add (NodeProto): Add bias node in fully connection for V
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.
            hidden_size (int): hidden dimension. If a model is pruned, it is the hidden dimension after pruning.
            output (str): output name

        Returns:
            Union[NodeProto, None]: the node created or None if failed.
        """
        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug(f"input hidden size {hidden_size} is not a multiple of num of heads {num_heads}")
            return None

        q_weight = self.model.get_initializer(q_matmul.input[1])
        k_weight = self.model.get_initializer(k_matmul.input[1])
        v_weight = self.model.get_initializer(v_matmul.input[1])
        if not (q_weight and k_weight and v_weight):
            return None

        qw = NumpyHelper.to_array(q_weight)
        kw = NumpyHelper.to_array(k_weight)
        vw = NumpyHelper.to_array(v_weight)
        logger.debug(f"qw={qw.shape} kw={kw.shape} vw={vw.shape} hidden_size={hidden_size}")

        attention_node_name = self.model.create_node_name("MultiHeadAttention")

        attention_inputs = [
            q_add.output[0],
            k_add.output[0],
            v_add.output[0],
        ]

        attention_node = helper.make_node(
            "MultiHeadAttention",
            inputs=attention_inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        counter_name = "MultiHeadAttention ({})".format("cross attention")
        self.increase_counter(counter_name)
        return attention_node

    def fuse(self, normalize_node, input_name_to_nodes, output_name_to_node):
        if self.fuse_sam_encoder_pattern(normalize_node, input_name_to_nodes, output_name_to_node):
            return

        match_qkv = self.match_attention_subgraph(normalize_node)
        if match_qkv is None:
            if normalize_node.input[0] not in output_name_to_node:
                return

            skip_add = output_name_to_node[normalize_node.input[0]]
            if skip_add.op_type != "Add":
                return

            match_qkv = self.match_attention_subgraph(skip_add)

            if match_qkv is None:
                return

        reshape_qkv, transpose_qkv, reshape_q, matmul_q, add_q, matmul_k, add_k, matmul_v, add_v = match_qkv

        attention_last_node = reshape_qkv

        q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q, normalize_node, False)
        if q_num_heads <= 0:
            logger.debug("fuse_attention: failed to detect num_heads")
            return

        # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
        new_node = self.create_attention_node(
            matmul_q,
            add_q,
            matmul_k,
            add_k,
            matmul_v,
            add_v,
            q_num_heads,
            q_hidden_size,
            output=attention_last_node.output[0],
        )
        if new_node is None:
            return

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([attention_last_node, transpose_qkv])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True

    def match_attention_subgraph(self, node_after_output_projection):
        """Match Q, K and V paths exported by PyTorch 2.*"""
        qkv_nodes = self.model.match_parent_path(
            node_after_output_projection,
            ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [None, None, None, 0, 0],
        )

        if qkv_nodes is None:
            return None

        (_, _, reshape_qkv, transpose_qkv, matmul_qkv) = qkv_nodes

        v_nodes = self.model.match_parent_path(matmul_qkv, ["Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, None])
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return None
        (_, _, add_v, matmul_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "MatMul"], [0, 0])
        if qk_nodes is not None:
            (_softmax_qk, matmul_qk) = qk_nodes
        else:
            logger.debug("fuse_attention: failed to match qk path")
            return None

        q_nodes = self.model.match_parent_path(
            matmul_qk, ["Mul", "Transpose", "Reshape", "Add", "MatMul"], [0, None, 0, 0, None]
        )
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return None
        (mul_q, _transpose_q, reshape_q, add_q, matmul_q) = q_nodes

        k_nodes = self.model.match_parent_path(
            matmul_qk, ["Mul", "Transpose", "Reshape", "Add", "MatMul"], [1, None, 0, 0, None]
        )
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return None

        (_mul_k, _, _, add_k, matmul_k) = k_nodes

        # The scalar for Q and K is sqrt(1.0/sqrt(head_size)).
        mul_q_nodes = self.model.match_parent_path(
            mul_q,
            ["Sqrt", "Div", "Sqrt", "Cast", "Slice", "Shape", "Transpose", "Reshape"],
            [None, 0, 1, 0, 0, 0, 0, 0],
        )
        if mul_q_nodes is None or mul_q_nodes[-1] != reshape_q:
            logger.debug("fuse_attention: failed to match mul_q path")
            return None

        return reshape_qkv, transpose_qkv, reshape_q, matmul_q, add_q, matmul_k, add_k, matmul_v, add_v

    # --------------------------------------------------------
    # The following are for SAM encoder
    # --------------------------------------------------------
    def fuse_sam_encoder_pattern(self, normalize_node, input_name_to_nodes, output_name_to_node) -> bool:
        # SAM encoder attention layer pattern:
        #           Add -----------+
        #            |             |
        #        LayerNorm         |
        #            |             |
        #        Reshape           |
        #            |             |
        #        Transpose         |
        #            |             |
        #        MatMul            |
        #            |             |
        #           Add            |
        #            |             |
        #         Reshape          |
        #            |             |
        #          Split           |
        #            |             |
        #  Self Attention subgraph |
        #            |             |
        #        Reshape           |
        #            |             |
        #        Transpose         |
        #            |             |
        #        Reshape           |
        #            |             |
        #            Add ----------+
        #            |
        #         LayerNorm (starts from here)

        nodes = self.model.match_parent_path(
            normalize_node,
            ["Add", "Reshape", "Transpose", "Reshape"],
            [0, None, 0, 0],
        )
        if nodes is None:
            nodes = self.model.match_parent_path(
                normalize_node,
                ["Add", "Slice", "Slice", "Reshape", "Transpose", "Reshape"],
                [0, None, 0, 0, 0, 0],
            )
        if nodes is None:
            nodes = self.model.match_parent_path(
                normalize_node,
                ["Add"],
                [0],
            )
        if nodes is None:
            return False

        node_after_output_projection = nodes[-1]
        matched_sdpa = self.match_sam_encoder_attention_subgraph(
            node_after_output_projection, input_index=1 if len(nodes) == 1 else None
        )
        if matched_sdpa is None:
            return False

        reshape_out, transpose_out, split_qkv, transpose_q, transpose_k, transpose_v = matched_sdpa

        # B, S, N, H => B, N, S, H
        permutation_q = OnnxModel.get_node_attribute(transpose_q, "perm")
        if (not isinstance(permutation_q, list)) or permutation_q != [0, 2, 1, 3]:
            return False

        # B, S, N, H => B, N, H, S
        permutation_k = OnnxModel.get_node_attribute(transpose_k, "perm")
        if (not isinstance(permutation_k, list)) or permutation_k != [0, 2, 3, 1]:
            return False

        # B, S, N, H => B, N, S, H
        permutation_v = OnnxModel.get_node_attribute(transpose_v, "perm")
        if (not isinstance(permutation_v, list)) or permutation_v != [0, 2, 1, 3]:
            return False

        input_projection_nodes = self.model.match_parent_path(
            split_qkv,
            ["Reshape", "Add", "MatMul"],
            [0, 0, None],
        )
        if input_projection_nodes is None:
            return False
        reshape_in, add_in, matmul_in = input_projection_nodes
        q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_in, normalize_node, True)
        if q_num_heads <= 0:
            logger.debug("fuse_attention: failed to detect num_heads")
            return False

        # Add a shape to convert 4D BxSxNxH to 3D BxSxD, which is required by MHA operator.
        new_dims_name = "bsnh_to_bsd_reshape_dims"
        new_dims = self.model.get_initializer(new_dims_name)
        if new_dims is None:
            new_dims = numpy_helper.from_array(np.array([0, 0, -1], dtype="int64"), name=new_dims_name)
            self.model.add_initializer(new_dims, self.this_graph_name)
        reshape_q_name = self.model.create_node_name("Reshape")
        reshape_q = helper.make_node(
            "Reshape",
            inputs=[transpose_q.input[0], new_dims_name],
            outputs=[transpose_q.input[0] + "_BSD"],
            name=reshape_q_name,
        )
        self.nodes_to_add.append(reshape_q)
        self.node_name_to_graph_name[reshape_q.name] = self.this_graph_name

        # Reuse the transpose_q node to transpose K from BSNH to BNSH. Here we update the input and output of the node.
        transpose_k_bnsh = transpose_q
        transpose_k_bnsh.input[0] = transpose_k.input[0]
        transpose_k_bnsh.output[0] = transpose_k.input[0] + "_BNSH"

        logger.debug(f"Found MHA: {q_num_heads=} {q_hidden_size=}")

        # number of heads are same for all the paths, hence to create attention node, we pass the q_num_heads
        new_node = self.create_mha_node(
            reshape_q,
            transpose_k_bnsh,
            transpose_v,
            q_num_heads,
        )
        if new_node is None:
            return False

        # Update the input of the next node that consumes the output of the MHA.
        assert len(self.model.get_children(transpose_out, input_name_to_nodes)) == 1
        reshape_out.input[0] = new_node.output[0]

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name
        self.nodes_to_remove.extend([transpose_out])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True
        return True

    def match_sam_encoder_attention_subgraph(self, node_after_output_projection, input_index=None):
        """Match SDPA pattern in SAM2 enconder.*"""

        # nodes of output projection and the second MatMul in SDPA.
        out_nodes = self.model.match_parent_path(
            node_after_output_projection,
            ["Add", "MatMul", "Reshape", "Transpose", "MatMul"],
            [input_index, None, None, 0, 0],
        )

        if out_nodes is None:
            return None

        (_, _, reshape_out, transpose_out, matmul_qk_v) = out_nodes

        # Split and Reshape is for packed QKV
        v_nodes = self.model.match_parent_path(matmul_qk_v, ["Transpose", "Squeeze", "Split", "Reshape"], [1, 0, 0, 0])
        if v_nodes is None:
            logger.debug("failed to match v path")
            return None
        (transpose_v, _, split_qkv, reshape_qkv) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qk_v, ["Softmax", "MatMul"], [0, 0])
        if qk_nodes is not None:
            (_softmax_qk, matmul_qk) = qk_nodes
        else:
            logger.debug("failed to match qk path")
            return None

        q_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Squeeze", "Split"], [0, None, 0, 0])
        if q_nodes is None:
            q_nodes = self.model.match_parent_path(
                matmul_qk,
                ["Mul", "Transpose", "Reshape", "Transpose", "MaxPool", "Transpose", "Reshape", "Squeeze", "Split"],
                [0, None, 0, 0, 0, 0, 0, 0, 0],
            )
            if q_nodes is None:
                logger.debug("failed to match q path")
                return None

        if q_nodes[-1] != split_qkv:
            return None
        transpose_q = q_nodes[1]

        k_nodes = self.model.match_parent_path(matmul_qk, ["Mul", "Transpose", "Squeeze", "Split"], [1, None, 0, 0])
        if k_nodes is None:
            logger.debug("failed to match k path")
            return None

        if k_nodes[-1] != split_qkv:
            return None
        (mul_k, transpose_k, _squeeze_k, _) = k_nodes

        return reshape_out, transpose_out, split_qkv, transpose_q, transpose_k, transpose_v

    def create_mha_node(
        self,
        reshape_q: NodeProto,
        transpose_k: NodeProto,
        transpose_v: NodeProto,
        num_heads: int,
    ) -> NodeProto:
        """Create a MultiHeadAttention node for SAM2 encoder.

        Args:
            reshape_q (NodeProto): Reshape node for Q, output is 3D BxSxNH format
            transpose_k (NodeProto): Transpose node for K, output is BNSH format
            transpose_v (NodeProto): Transpose node for V, output is BNSH format
            num_heads (int): number of attention heads. If a model is pruned, it is the number of heads after pruning.

        Returns:
            NodeProto: the MultiHeadAttention node created.
        """

        attention_node_name = self.model.create_node_name("MultiHeadAttention")

        inputs = [
            reshape_q.output[0],
            transpose_k.output[0],
            transpose_v.output[0],
        ]

        # Create a new output name since the shape is 3D, which is different from the original output shape (4D).
        output = attention_node_name + "_out"

        attention_node = helper.make_node(
            "MultiHeadAttention",
            inputs=inputs,
            outputs=[output],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        counter_name = "MultiHeadAttention ({})".format("self attention")
        self.increase_counter(counter_name)
        return attention_node
