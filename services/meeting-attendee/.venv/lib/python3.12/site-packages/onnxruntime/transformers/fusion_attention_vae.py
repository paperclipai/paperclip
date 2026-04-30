# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

import numpy as np
from fusion_base import Fusion
from onnx import NodeProto, TensorProto, helper, numpy_helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionAttentionVae(Fusion):
    """
    Fuse Attention subgraph of Vae Decoder into one Attention node.
    """

    def __init__(self, model: OnnxModel, hidden_size: int, num_heads: int):
        super().__init__(model, "Attention", ["Softmax"])
        self.hidden_size = hidden_size
        self.num_heads = num_heads

        # Flags to show warning only once
        self.num_heads_warning = True
        self.hidden_size_warning = True

    def get_num_heads_and_hidden_size(self, reshape_q: NodeProto, add_q: NodeProto) -> tuple[int, int]:
        """Detect num_heads and hidden_size from a reshape node.

        Args:
            reshape_q (NodeProto): reshape node for Q
            add_q (NodeProto): add node for Q

        Returns:
            Tuple[int, int]: num_heads and hidden_size
        """
        concat = self.model.get_parent(reshape_q, 1)
        if concat is None or len(concat.input) != 4:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        value = self.model.get_constant_value(concat.input[2])
        if not (value is not None and isinstance(value, np.ndarray) and value.size == 1):
            return self.num_heads, self.hidden_size  # Fall back to user specified value
        num_heads = int(value)
        if num_heads <= 0:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        _, bias = self.model.get_constant_input(add_q)
        if (bias is None) or (not isinstance(bias, np.ndarray)) or bias.ndim != 1:
            return self.num_heads, self.hidden_size  # Fall back to user specified value

        hidden_size = bias.shape[0]

        if self.num_heads > 0 and num_heads != self.num_heads:
            if self.num_heads_warning:
                logger.warning(
                    "Detected number of attention heads is %d. Ignore --num_heads %d", num_heads, self.num_heads
                )
                self.num_heads_warning = False  # Do not show the warning more than once

        if self.hidden_size > 0 and hidden_size != self.hidden_size:
            if self.hidden_size_warning:
                logger.warning("Detected hidden size is %d. Ignore --hidden_size %d", hidden_size, self.hidden_size)
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
        input_name: str,
        output_name: str,
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
            input_name (str): input name
            output_name (str): output name

        Returns:
            Union[NodeProto, None]: the node created or None if failed.
        """
        if q_matmul.input[0] != input_name or k_matmul.input[0] != input_name or v_matmul.input[0] != input_name:
            logger.debug(
                "For self attention, input hidden state for q and k/v shall be same. Got %s, %s, %s",
                q_matmul.input[0],
                k_matmul.input[0],
                v_matmul.input[0],
            )
            return None

        if hidden_size > 0 and (hidden_size % num_heads) != 0:
            logger.debug("input hidden size %d is not a multiple of num of heads %d", hidden_size, num_heads)
            return None

        q_weight_tensor = self.model.get_initializer(q_matmul.input[1])
        k_weight_tensor = self.model.get_initializer(k_matmul.input[1])
        v_weight_tensor = self.model.get_initializer(v_matmul.input[1])
        if not (q_weight_tensor and k_weight_tensor and v_weight_tensor):
            return None

        q_bias_tensor = self.model.get_initializer(q_add.input[1]) or self.model.get_initializer(q_add.input[0])
        k_bias_tensor = self.model.get_initializer(k_add.input[1]) or self.model.get_initializer(k_add.input[0])
        v_bias_tensor = self.model.get_initializer(v_add.input[1]) or self.model.get_initializer(v_add.input[0])

        q_bias = numpy_helper.to_array(q_bias_tensor)
        k_bias = numpy_helper.to_array(k_bias_tensor)
        v_bias = numpy_helper.to_array(v_bias_tensor)

        q_bias_shape = np.prod(q_bias.shape)
        k_bias_shape = np.prod(k_bias.shape)
        v_bias_shape = np.prod(v_bias.shape)

        # Sometimes weights are stored in fp16
        if q_weight_tensor.data_type == 10:
            logger.debug("weights are in fp16. Please run fp16 conversion after optimization")
            return None

        q_weight = numpy_helper.to_array(q_weight_tensor)
        k_weight = numpy_helper.to_array(k_weight_tensor)
        v_weight = numpy_helper.to_array(v_weight_tensor)

        # assert q and k have same shape as expected
        if q_weight.shape != k_weight.shape or q_weight.shape != v_weight.shape:
            return None

        qw_in_size = q_weight.shape[0]
        kw_in_size = k_weight.shape[0]
        vw_in_size = v_weight.shape[0]

        assert qw_in_size == kw_in_size and kw_in_size == vw_in_size

        if hidden_size > 0 and hidden_size != qw_in_size:
            raise ValueError(
                f"Input hidden size ({hidden_size}) is not same as weight dimension of q,k,v ({qw_in_size}). "
                "Please provide a correct input hidden size or pass in 0"
            )

        # All the matrices can have the same shape or q, k matrics can have the same shape with v being different
        # For 2d weights, the shapes would be [in_size, out_size].
        # For 3d weights, shape would be [in_size, a, b] where a*b = out_size
        qw_out_size = np.prod(q_weight.shape[1:])

        qkv_weight = np.stack((q_weight, k_weight, v_weight), axis=1)
        qkv_weight_dim = 3 * int(qw_out_size)

        attention_node_name = self.model.create_node_name("Attention")

        assert q_bias_shape == k_bias_shape == v_bias_shape

        qkv_bias_dim = 0
        qkv_bias = np.stack((q_bias, k_bias, v_bias), axis=0)
        qkv_bias_dim = 3 * q_bias_shape

        self.add_initializer(
            name=attention_node_name + "_qkv_weight",
            data_type=TensorProto.FLOAT,
            dims=[qw_in_size, qkv_weight_dim],
            vals=qkv_weight,
        )

        # No bias, use zeros
        qkv_bias = np.zeros([3, hidden_size], dtype=np.float32)
        qkv_bias_dim = 3 * hidden_size

        self.add_initializer(
            name=attention_node_name + "_qkv_bias",
            data_type=TensorProto.FLOAT,
            dims=[qkv_bias_dim],
            vals=qkv_bias,
        )

        attention_inputs = [
            input_name,
            attention_node_name + "_qkv_weight",
            attention_node_name + "_qkv_bias",
        ]

        attention_node = helper.make_node(
            "Attention",
            inputs=attention_inputs,
            outputs=[output_name],
            name=attention_node_name,
        )
        attention_node.domain = "com.microsoft"
        attention_node.attribute.extend([helper.make_attribute("num_heads", num_heads)])

        self.increase_counter("Attention (self attention)")
        return attention_node

    def fuse(self, softmax_node, input_name_to_nodes, output_name_to_node):
        matmul_qkv = self.model.find_first_child_by_type(softmax_node, "MatMul", input_name_to_nodes, recursive=False)
        if matmul_qkv is None:
            return

        reshape_qkv = self.model.find_first_child_by_type(matmul_qkv, "Reshape", input_name_to_nodes, recursive=False)
        if reshape_qkv is None:
            return

        transpose_qkv = self.model.find_first_child_by_type(
            reshape_qkv, "Transpose", input_name_to_nodes, recursive=False
        )
        if transpose_qkv is None:
            return

        reshape_out = self.model.find_first_child_by_type(
            transpose_qkv, "Reshape", input_name_to_nodes, recursive=False
        )
        if reshape_out is None:
            return

        matmul_out = self.model.find_first_child_by_type(reshape_out, "MatMul", input_name_to_nodes, recursive=False)
        if matmul_out is None:
            return

        add_out = self.model.find_first_child_by_type(matmul_out, "Add", input_name_to_nodes, recursive=False)
        if add_out is None:
            return

        transpose_out = self.model.find_first_child_by_type(add_out, "Transpose", input_name_to_nodes, recursive=False)
        if transpose_out is None:
            return

        v_nodes = self.model.match_parent_path(
            matmul_qkv, ["Reshape", "Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, 0, None]
        )
        if v_nodes is None:
            logger.debug("fuse_attention: failed to match v path")
            return
        (_, _, _, add_v, matmul_v) = v_nodes

        qk_nodes = self.model.match_parent_path(matmul_qkv, ["Softmax", "Add", "Mul", "MatMul"], [0, 0, 0, 0])
        if qk_nodes is not None:
            (_softmax_qk, _add_zero, _mul_qk, matmul_qk) = qk_nodes
        else:
            logger.debug("fuse_attention: failed to match qk path")
            return

        q_nodes = self.model.match_parent_path(
            matmul_qk, ["Reshape", "Transpose", "Reshape", "Add", "MatMul"], [0, 0, 0, 0, None]
        )
        if q_nodes is None:
            logger.debug("fuse_attention: failed to match q path")
            return
        (_, _transpose_q, reshape_q, add_q, matmul_q) = q_nodes
        k_nodes = self.model.match_parent_path(
            matmul_qk, ["Transpose", "Reshape", "Transpose", "Reshape", "Add", "MatMul"], [1, 0, 0, 0, 0, None]
        )
        if k_nodes is None:
            logger.debug("fuse_attention: failed to match k path")
            return
        (_, _, _, _, add_k, matmul_k) = k_nodes

        attention_last_node = reshape_out

        q_num_heads, q_hidden_size = self.get_num_heads_and_hidden_size(reshape_q, add_q)
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
            matmul_q.input[0],
            attention_last_node.output[0],
        )
        if new_node is None:
            return

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name

        self.nodes_to_remove.extend([attention_last_node, transpose_qkv])

        # Use prune graph to remove nodes since they are shared by all attention nodes.
        self.prune_graph = True
