# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

from fusion_base import Fusion
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionFastGelu(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "FastGelu", "Tanh")

    def fuse(self, tanh_node, input_name_to_nodes: dict, output_name_to_node: dict):
        if self.fuse_1(tanh_node, input_name_to_nodes, output_name_to_node):
            return

        if self.fuse_2(tanh_node, input_name_to_nodes, output_name_to_node):
            return

        if self.fuse_3(tanh_node, input_name_to_nodes, output_name_to_node):
            return

        if self.fuse_4(tanh_node, input_name_to_nodes, output_name_to_node):
            return

    def fuse_1(self, tanh_node, input_name_to_nodes, output_name_to_node) -> bool | None:
        """
        Fuse Gelu with tanh into one node:
              +---------------------------+
              |                           |
              |                           v
            [root] --> Pow --> Mul -----> Add  --> Mul --> Tanh --> Add --> Mul
              |       (Y=3)   (B=0.0447...)       (B=0.7978...)    (B=1)     ^
              |                                                              |
              +------> Mul(B=0.5)--------------------------------------------+
        Note that constant input for Add and Mul could be first or second input: like either A=0.5 or B=0.5 is fine.
        """
        if tanh_node.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[tanh_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Add":
            return
        add_after_tanh = children[0]

        if not self.model.has_constant_input(add_after_tanh, 1.0):
            return

        if add_after_tanh.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[add_after_tanh.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_after_tanh = children[0]

        mul_half = self.model.match_parent(mul_after_tanh, "Mul", None, output_name_to_node)
        if mul_half is None:
            return

        i = self.model.find_constant_input(mul_half, 0.5)
        if i < 0:
            return

        root_input = mul_half.input[0 if i == 1 else 1]

        # root_node could be None when root_input is graph input
        root_node = self.model.get_parent(mul_half, 0 if i == 1 else 1, output_name_to_node)

        mul_before_tanh = self.model.match_parent(tanh_node, "Mul", 0, output_name_to_node)
        if mul_before_tanh is None:
            return

        i = self.model.find_constant_input(mul_before_tanh, 0.7978, delta=0.0001)
        if i < 0:
            return

        add_before_tanh = self.model.match_parent(mul_before_tanh, "Add", 0 if i == 1 else 1, output_name_to_node)
        if add_before_tanh is None:
            return

        mul_after_pow = self.model.match_parent(
            add_before_tanh,
            "Mul",
            None,
            output_name_to_node,
            exclude=[root_node] if root_node else [],
        )
        if mul_after_pow is None:
            return

        i = self.model.find_constant_input(mul_after_pow, 0.0447, delta=0.0001)
        if i < 0:
            return

        pow = self.model.match_parent(mul_after_pow, "Pow", 0 if i == 1 else 1, output_name_to_node)
        if pow is None:
            return

        if not self.model.has_constant_input(pow, 3.0):
            return

        if pow.input[0] != root_input:
            return

        subgraph_nodes = [
            mul_after_tanh,
            mul_half,
            add_after_tanh,
            tanh_node,
            mul_before_tanh,
            add_before_tanh,
            mul_after_pow,
            pow,
        ]
        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            [mul_after_tanh.output[0]],
            input_name_to_nodes,
            output_name_to_node,
        ):
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        fused_node = helper.make_node(
            "FastGelu",
            inputs=[root_input],
            outputs=mul_after_tanh.output,
            name=self.model.create_node_name("FastGelu"),
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
        return True

    def fuse_2(self, tanh_node, input_name_to_nodes: dict, output_name_to_node: dict) -> bool | None:
        """
        This pattern is from Tensorflow model.
        Fuse Gelu with tanh into one node:
              +---------------------------+
              |                           |
              |                           v
            [root] --> Pow --> Mul -----> Add  --> Mul --> Tanh --> Add --> Mul(B=0.5)-->Mul-->
              |       (Y=3)   (B=0.0447...)       (B=0.7978...)    (B=1)                  ^
              |                                                                           |
              +---------------------------------------------------------------------------+
        Note that constant input for Add and Mul could be first or second input: like either A=0.5 or B=0.5 is fine.
        """
        if tanh_node.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[tanh_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Add":
            return
        add_after_tanh = children[0]

        if not self.model.has_constant_input(add_after_tanh, 1.0):
            return

        if add_after_tanh.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[add_after_tanh.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_half = children[0]

        i = self.model.find_constant_input(mul_half, 0.5)
        if i < 0:
            return

        if mul_half.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[mul_half.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_after_mul_half = children[0]

        # root_node could be None when root_input is graph input
        root_node = self.model.get_parent(
            mul_after_mul_half,
            0 if mul_after_mul_half.input[1] == mul_half.output[0] else 1,
            output_name_to_node,
        )

        mul_before_tanh = self.model.match_parent(tanh_node, "Mul", 0, output_name_to_node)
        if mul_before_tanh is None:
            return

        i = self.model.find_constant_input(mul_before_tanh, 0.7978, delta=0.0001)
        if i < 0:
            return

        add_before_tanh = self.model.match_parent(mul_before_tanh, "Add", 0 if i == 1 else 1, output_name_to_node)
        if add_before_tanh is None:
            return

        mul_after_pow = self.model.match_parent(
            add_before_tanh,
            "Mul",
            None,
            output_name_to_node,
            exclude=[root_node] if root_node else [],
        )
        if mul_after_pow is None:
            return

        i = self.model.find_constant_input(mul_after_pow, 0.0447, delta=0.0001)
        if i < 0:
            return

        pow = self.model.match_parent(mul_after_pow, "Pow", 0 if i == 1 else 1, output_name_to_node)
        if pow is None:
            return

        if not self.model.has_constant_input(pow, 3.0):
            return

        root_input = mul_after_mul_half.input[0 if mul_after_mul_half.input[1] == mul_half.output[0] else 1]

        if pow.input[0] != root_input:
            return

        subgraph_nodes = [
            mul_after_mul_half,
            mul_half,
            add_after_tanh,
            tanh_node,
            mul_before_tanh,
            add_before_tanh,
            mul_after_pow,
            pow,
        ]
        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            [mul_after_mul_half.output[0]],
            input_name_to_nodes,
            output_name_to_node,
        ):
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        fused_node = helper.make_node(
            "FastGelu",
            inputs=[root_input],
            outputs=mul_after_mul_half.output,
            name=self.model.create_node_name("FastGelu"),
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
        return True

    def fuse_3(self, tanh_node, input_name_to_nodes: dict, output_name_to_node: dict) -> bool | None:
        """
        OpenAI's gelu implementation, also used in Megatron:
           Gelu(x) = x * 0.5 * (1.0 + torch.tanh(0.79788456 * x * (1.0 + 0.044715 * x * x)))

        Fuse subgraph into a FastGelu node:
            +------------ Mul (B=0.79788456) -------------------+
            |                                                   |
            +-------------------------------+                   |
            |                               |                   |
            |                               v                   v
          [root] --> Mul (B=0.044715) --> Mul --> Add(B=1) --> Mul --> Tanh --> Add(B=1) --> Mul-->
            |                                                                                 ^
            |                                                                                 |
            +-----------> Mul (B=0.5) --------------------------------------------------------+
        """
        if tanh_node.output[0] not in input_name_to_nodes:
            return

        children = input_name_to_nodes[tanh_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Add":
            return
        add_after_tanh = children[0]

        if not self.model.has_constant_input(add_after_tanh, 1.0):
            return

        if add_after_tanh.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[add_after_tanh.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_last = children[0]

        mul_half = self.model.match_parent(mul_last, "Mul", None, output_name_to_node)
        if mul_half is None:
            return

        i = self.model.find_constant_input(mul_half, 0.5)
        if i < 0:
            return

        root_input = mul_half.input[0 if i == 1 else 1]

        mul_before_tanh = self.model.match_parent(tanh_node, "Mul", 0, output_name_to_node)
        if mul_before_tanh is None:
            return

        add_1 = self.model.match_parent(mul_before_tanh, "Add", None, output_name_to_node)
        if add_1 is None:
            return
        j = self.model.find_constant_input(add_1, 1.0)
        if j < 0:
            return

        mul_7978 = self.model.match_parent(mul_before_tanh, "Mul", None, output_name_to_node)
        if mul_7978 is None:
            return
        k = self.model.find_constant_input(mul_7978, 0.7978, delta=0.0001)
        if k < 0:
            return
        if mul_7978.input[0 if k == 1 else 1] != root_input:
            return

        mul_before_add_1 = self.model.match_parent(add_1, "Mul", 0 if j == 1 else 1, output_name_to_node)
        if mul_before_add_1 is None:
            return

        if mul_before_add_1.input[0] == root_input:
            another = 1
        elif mul_before_add_1.input[1] == root_input:
            another = 0
        else:
            return

        mul_0447 = self.model.match_parent(mul_before_add_1, "Mul", another, output_name_to_node)
        if mul_0447 is None:
            return
        m = self.model.find_constant_input(mul_0447, 0.0447, delta=0.0001)
        if m < 0:
            return

        if mul_0447.input[0 if m == 1 else 1] != root_input:
            return

        subgraph_nodes = [
            mul_0447,
            mul_before_add_1,
            add_1,
            mul_before_tanh,
            tanh_node,
            add_after_tanh,
            mul_7978,
            mul_half,
            mul_last,
        ]
        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            [mul_last.output[0]],
            input_name_to_nodes,
            output_name_to_node,
        ):
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        fused_node = helper.make_node(
            "FastGelu",
            inputs=[root_input],
            outputs=mul_last.output,
            name=self.model.create_node_name("FastGelu"),
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
        return True

    def fuse_4(self, tanh_node, input_name_to_nodes: dict, output_name_to_node: dict) -> bool | None:
        """
        PyTorch's gelu implementation with tanh approximation:
           Gelu(x) = 0.5 * x * (1 + torch.tanh(0.7978845834732056 * (x + 0.044714998453855515 * x * x * x)))

        Fuse Gelu with tanh into one node:
              +-----------------+------------------+
              |                 |                  |
              |                 v                  v
            [root] ==> Mul --> Mul --> Mul -----> Add  --> Mul --> Tanh --> Add -----> Mul --> Mul -->
              |                       (A=0.0447)          (A=0.7978)        (A=1)       ^     (A=0.5)
              |                                                                         |
              +-------------------------------------------------------------------------+
        Note that constant input for Add and Mul could be first or second input.
        """
        if tanh_node.output[0] not in input_name_to_nodes:
            return

        children = input_name_to_nodes[tanh_node.output[0]]
        if len(children) != 1 or children[0].op_type != "Add":
            return
        add_after_tanh = children[0]

        if not self.model.has_constant_input(add_after_tanh, 1.0):
            return

        if add_after_tanh.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[add_after_tanh.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_after_tanh = children[0]

        if mul_after_tanh.output[0] not in input_name_to_nodes:
            return
        children = input_name_to_nodes[mul_after_tanh.output[0]]
        if len(children) != 1 or children[0].op_type != "Mul":
            return
        mul_half = children[0]

        if not self.model.has_constant_input(mul_half, 0.5):
            return

        root_input = mul_after_tanh.input[0 if mul_after_tanh.input[1] == add_after_tanh.output[0] else 1]

        mul_before_tanh = self.model.match_parent(tanh_node, "Mul", 0, output_name_to_node)
        if mul_before_tanh is None:
            return

        k = self.model.find_constant_input(mul_before_tanh, 0.7978, delta=0.01)
        if k < 0:
            return

        add_before_tanh = self.model.match_parent(mul_before_tanh, "Add", 0 if k == 1 else 1, output_name_to_node)
        if add_before_tanh is None:
            return

        if add_before_tanh.input[0] == root_input:
            another = 1
        elif add_before_tanh.input[1] == root_input:
            another = 0
        else:
            return

        mul_after_pow = self.model.match_parent(add_before_tanh, "Mul", another, output_name_to_node)
        if mul_after_pow is None:
            return

        m = self.model.find_constant_input(mul_after_pow, 0.0447, delta=0.01)
        if m < 0:
            return

        mul_cubed = self.model.match_parent(mul_after_pow, "Mul", 0 if m == 1 else 1, output_name_to_node)
        if mul_cubed is None:
            return

        if mul_cubed.input[0] == root_input:
            another = 1
        elif mul_cubed.input[1] == root_input:
            another = 0
        else:
            return

        mul_squared = self.model.match_parent(mul_cubed, "Mul", another, output_name_to_node)
        if mul_squared is None:
            return

        if mul_squared.input[0] != root_input or mul_squared.input[1] != root_input:
            return

        subgraph_nodes = [
            mul_squared,
            mul_cubed,
            mul_after_pow,
            add_before_tanh,
            mul_before_tanh,
            tanh_node,
            add_after_tanh,
            mul_after_tanh,
            mul_half,
        ]

        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            [mul_half.output[0]],
            input_name_to_nodes,
            output_name_to_node,
        ):
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        fused_node = helper.make_node(
            "FastGelu",
            inputs=[root_input],
            outputs=mul_half.output,
            name=self.model.create_node_name("FastGelu"),
        )
        fused_node.domain = "com.microsoft"
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
        self.increase_counter("FastGelu")
        return True
