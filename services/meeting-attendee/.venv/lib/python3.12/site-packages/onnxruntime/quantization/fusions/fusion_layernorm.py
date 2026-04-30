# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import onnx

from ..onnx_model import ONNXModel
from .fusion import Fusion


class FusionLayerNormalization(Fusion):
    def __init__(self, model: ONNXModel):
        super().__init__(model, "LayerNormalization", "ReduceMean")

    def fuse(
        self,
        reduce_mean_node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """
        Interface function that tries to fuse a node sequence containing a ReduceMean node into a single
        LayerNormalization node.

              +----------------------+
              |                      |
              |                      v
          [Root] --> ReduceMean -->  Sub  --> Pow --> ReduceMean --> Add --> Sqrt --> Div --> Mul --> Add
                     (axis=2 or -1)  |      (Y=2)   (axis=2 or -1)  (E-6 or E-12 or 0) ^
                                     |                                                 |
                                     +-------------------------------------------------+

         Or, using Mul instead of Pow:

              +----------------------+
              |                      |
              |                      v
          [Root] --> ReduceMean -->  Sub  --> Mul --> ReduceMean --> Add --> Sqrt --> Div --> Mul --> Add
                     (axis=2 or -1)  |     (in0=in1)   (axis=2 or -1)  (E-6 or E-12 or 0) ^
                                     |                                                 |
                                     +-------------------------------------------------+

         It also handles cases of duplicated sub nodes exported from older version of PyTorch:

              +----------------------+
              |                      v
              |           +-------> Sub-----------------------------------------------+
              |           |                                                           |
              |           |                                                           v
          [Root] --> ReduceMean -->  Sub  --> (Pow or Mul) --> ReduceMean --> Add --> Sqrt --> Div  --> Mul --> Add
              |                      ^
              |                      |
              +----------------------+
        """
        children = self.model.get_children(reduce_mean_node, input_name_to_nodes)
        if len(children) == 0 or len(children) > 2:
            return

        root_input = reduce_mean_node.input[0]

        if children[0].op_type != "Sub" or children[0].input[0] != root_input:
            return

        if len(children) == 2:
            if children[1].op_type != "Sub" or children[1].input[0] != root_input:
                return

        div_node = None
        for child in children:
            div_node = self.find_first_child_by_type(child, "Div", input_name_to_nodes, recursive=False)
            if div_node is not None:
                break
        if div_node is None:
            return

        path_id, parent_nodes, _ = self.match_parent_paths(
            div_node,
            [
                (["Sqrt", "Add", "ReduceMean", "Pow", "Sub"], [1, 0, 0, 0, 0]),
                (["Sqrt", "Add", "ReduceMean", "Pow", "Cast", "Sub"], [1, 0, 0, 0, 0, 0]),
                (["Sqrt", "Add", "ReduceMean", "Mul", "Sub"], [1, 0, 0, 0, 0]),
                (["Sqrt", "Add", "ReduceMean", "Mul", "Cast", "Sub"], [1, 0, 0, 0, 0, 0]),
            ],
            output_name_to_node,
        )
        if path_id < 0:
            return

        sub_node = parent_nodes[-1]
        if sub_node not in children:
            return

        second_add_node = parent_nodes[1]
        i, add_weight = self.get_constant_input(second_add_node)
        if add_weight is None or add_weight <= 0 or add_weight > 1.0e-4:
            # Skip fusion since epsilon value is not expected.
            return

        pow_or_mul_node = parent_nodes[3]
        if pow_or_mul_node.op_type == "Pow" and self.find_constant_input(pow_or_mul_node, 2.0) != 1:
            return
        elif pow_or_mul_node.op_type == "Mul" and pow_or_mul_node.input[0] != pow_or_mul_node.input[1]:
            return

        mul_node = input_name_to_nodes[div_node.output[0]][0]
        if mul_node.op_type != "Mul":
            return

        last_add_node = input_name_to_nodes[mul_node.output[0]][0]
        if last_add_node.op_type != "Add":
            return

        subgraph_nodes = [reduce_mean_node]
        subgraph_nodes.extend(children)
        subgraph_nodes.extend(parent_nodes[:-1])

        subgraph_nodes.extend([last_add_node, mul_node, div_node])
        if not self.is_safe_to_fuse_nodes(
            subgraph_nodes,
            last_add_node.output,
            input_name_to_nodes,
            output_name_to_node,
        ):
            return

        weight_input = mul_node.input[1 - self.input_index(div_node.output[0], mul_node)]
        if not self.is_constant_with_specified_rank(weight_input, 1):
            return

        bias_input = last_add_node.input[1 - self.input_index(mul_node.output[0], last_add_node)]
        if not self.is_constant_with_specified_rank(bias_input, 1):
            return

        self.nodes_to_remove.extend(subgraph_nodes)

        normalize_node = onnx.helper.make_node(
            "LayerNormalization",
            name=self.create_unique_node_name(),
            inputs=[reduce_mean_node.input[0], weight_input, bias_input],
            outputs=[last_add_node.output[0]],
        )
        normalize_node.attribute.extend([onnx.helper.make_attribute("epsilon", float(add_weight))])
        self.nodes_to_add.append(normalize_node)
