# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from logging import getLogger

from fusion_base import Fusion
from onnx import TensorProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class FusionLayerNormalization(Fusion):
    def __init__(self, model: OnnxModel, check_constant_and_dimension: bool = True, force: bool = False):
        super().__init__(model, "LayerNormalization", "ReduceMean")
        self.check_constant_and_dimension = check_constant_and_dimension
        self.force = force

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        Fuse Layer Normalization subgraph into one node LayerNormalization:
              +----------------------+
              |                      |
              |                      v
          [Root] --> ReduceMean -->  Sub  --> Pow --> ReduceMean --> Add --> Sqrt --> Div --> Mul --> Add
                     (axis=2 or -1)  |      (Y=2)   (axis=2 or -1)  (B=E-6 or E-12)    ^
                                     |                                                 |
                                     +-------------------------------------------------+

         It also handles cases of duplicated sub nodes exported from older version of PyTorch:
              +----------------------+
              |                      v
              |           +-------> Sub-----------------------------------------------+
              |           |                                                           |
              |           |                                                           v
          [Root] --> ReduceMean -->  Sub  --> Pow --> ReduceMean --> Add --> Sqrt --> Div  --> Mul --> Add
              |                      ^
              |                      |
              +----------------------+
        """
        subgraph_nodes = []
        children = self.model.get_children(node, input_name_to_nodes)
        if len(children) == 0 or len(children) > 2:
            return

        root_input = node.input[0]

        if children[0].op_type != "Sub" or children[0].input[0] != root_input:
            return

        if len(children) == 2:
            if children[1].op_type != "Sub" or children[1].input[0] != root_input:
                return

        div_node = None
        for child in children:
            # Check if Sub --> Div exists
            div_node_1 = self.model.find_first_child_by_type(child, "Div", input_name_to_nodes, recursive=False)
            if div_node_1 is not None:
                div_node = div_node_1
                break
            else:
                # Check if Sub --> Cast --> Div
                div_node_2 = self.model.match_child_path(child, ["Cast", "Div"])
                if div_node_2 is not None:
                    div_node = div_node_2[-1]
                    break

        if div_node is None:
            return

        _path_id, parent_nodes, _ = self.model.match_parent_paths(
            div_node,
            [
                (["Sqrt", "Add", "ReduceMean", "Pow", "Sub"], [1, 0, 0, 0, 0]),
                (["Sqrt", "Add", "ReduceMean", "Pow", "Cast", "Sub"], [1, 0, 0, 0, 0, 0]),
            ],
            output_name_to_node,
        )
        if parent_nodes is None:
            return

        sub_node = parent_nodes[-1]
        if sub_node not in children:
            return

        add_eps_node = parent_nodes[1]
        i, epsilon = self.model.get_constant_input(add_eps_node)
        if epsilon is None or epsilon <= 0 or epsilon > 1.0e-4:
            logger.debug(f"skip SkipLayerNormalization fusion since epsilon value is not expected: {epsilon}")
            return

        pow_node = parent_nodes[3]
        if self.model.find_constant_input(pow_node, 2.0) != 1:
            return

        if div_node.output[0] not in input_name_to_nodes:
            return

        # In MMDit model, Div might have two Mul+Add children paths.
        div_children = input_name_to_nodes[div_node.output[0]]
        for temp_node in div_children:
            if temp_node.op_type == "Cast":
                # Div --> Cast --> Mul
                subgraph_nodes.append(temp_node)  # add Cast node to list of subgraph nodes
                if temp_node.output[0] not in input_name_to_nodes:
                    continue
                mul_node = input_name_to_nodes[temp_node.output[0]][0]
            else:
                # Div --> Mul
                mul_node = temp_node
            if mul_node.op_type != "Mul":
                continue

            if mul_node.output[0] not in input_name_to_nodes:
                continue
            last_add_node = input_name_to_nodes[mul_node.output[0]][0]
            if last_add_node.op_type != "Add":
                continue

            subgraph_nodes.append(node)
            subgraph_nodes.extend(children)
            subgraph_nodes.extend(parent_nodes[:-1])

            subgraph_nodes.extend([last_add_node, mul_node, div_node])

            node_before_weight = div_node if temp_node.op_type != "Cast" else temp_node
            weight_input = mul_node.input[1 - self.model.input_index(node_before_weight.output[0], mul_node)]
            if self.check_constant_and_dimension and not self.model.is_constant_with_specified_dimension(
                weight_input, 1, "layernorm weight"
            ):
                continue

            bias_input = last_add_node.input[1 - self.model.input_index(mul_node.output[0], last_add_node)]
            if self.check_constant_and_dimension and not self.model.is_constant_with_specified_dimension(
                bias_input, 1, "layernorm bias"
            ):
                continue

            layer_norm_output = last_add_node.output[0]
            if not self.model.is_safe_to_fuse_nodes(
                subgraph_nodes,
                last_add_node.output,
                input_name_to_nodes,
                output_name_to_node,
            ):
                # If it is not safe to fuse, somce computation may be duplicated if we force to fuse it.
                # It it unknown that force fusion might bring performance gain/loss.
                # User need test performance impact to see whether forcing fusion can help.
                if self.force:
                    self.prune_graph = True
                else:
                    logger.debug("It is not safe to fuse LayerNormalization node. Skip")
                    continue
            else:
                self.nodes_to_remove.extend(subgraph_nodes)

            normalize_node = helper.make_node(
                "LayerNormalization",
                inputs=[node.input[0], weight_input, bias_input],
                outputs=[layer_norm_output],
                name=self.model.create_node_name("LayerNormalization", name_prefix="LayerNorm"),
            )
            normalize_node.attribute.extend([helper.make_attribute("epsilon", float(epsilon))])
            self.nodes_to_add.append(normalize_node)
            self.node_name_to_graph_name[normalize_node.name] = self.this_graph_name


class FusionLayerNormalizationNCHW(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "LayerNormalization", "ReduceMean")

    def get_weight_or_bias(self, output_name, description):
        value = self.model.get_constant_value(output_name)
        if value is None:
            logger.debug(f"{description} {output_name} is not initializer.")
            return None

        if len(value.shape) != 3 or value.shape[1] != 1 or value.shape[2] != 1:
            logger.debug(f"{description} {output_name} shall have 3 dimensions Cx1x1. Got shape {value.shape}")
            return None

        return value.reshape([value.shape[0]])

    def create_transpose_node(self, input_name: str, perm: list[int], output_name=None):
        """Append a Transpose node after an input"""
        node_name = self.model.create_node_name("Transpose")

        if output_name is None:
            output_name = node_name + "_out" + "-" + input_name

        transpose_node = helper.make_node("Transpose", inputs=[input_name], outputs=[output_name], name=node_name)
        transpose_node.attribute.extend([helper.make_attribute("perm", perm)])

        return transpose_node

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
        Fuse Layer Normalization subgraph into one node LayerNormalization:
              +----------------------+
              | NxCxHxW              |
              |                      v                                                     (Cx1x1)  (Cx1x1)
          [Root] --> ReduceMean -->  Sub --> Pow --> ReduceMean --> Add --> Sqrt --> Div --> Mul --> Add -->
                     (axes=1)        |      (Y=2)     (axes=1)     (E-6)             ^
                                     |                                               |
                                     +-----------------------------------------------+

        Fused subgraph:
                       (0,2,3,1)                            (0,3,1,2)
            [Root] --> Transpose --> LayerNormalization --> Transpose -->
        """
        axes = OnnxModel.get_node_attribute(node, "axes")
        if (not isinstance(axes, list)) or axes != [1]:
            return

        subgraph_nodes = []
        children = self.model.get_children(node, input_name_to_nodes)
        if len(children) != 1:
            return

        root_input = node.input[0]

        if children[0].op_type != "Sub" or children[0].input[0] != root_input:
            return
        sub = children[0]

        div_node = self.model.find_first_child_by_type(sub, "Div", input_name_to_nodes, recursive=False)
        if div_node is None:
            return

        parent_nodes = self.model.match_parent_path(
            div_node,
            ["Sqrt", "Add", "ReduceMean", "Pow", "Sub"],
            [1, 0, 0, 0, 0],
            output_name_to_node,
        )
        if parent_nodes is None:
            return

        _sqrt_node, second_add_node, reduce_mean_node, pow_node, sub_node = parent_nodes
        if sub != sub_node:
            return

        i, epsilon = self.model.get_constant_input(second_add_node)
        if epsilon is None or epsilon <= 0 or epsilon > 1.0e-4:
            logger.debug(f"skip SkipLayerNormalization fusion since epsilon value is not expected: {epsilon}")
            return

        axes = OnnxModel.get_node_attribute(reduce_mean_node, "axes")
        assert isinstance(axes, list)
        if axes != [1]:
            return

        if self.model.find_constant_input(pow_node, 2.0) != 1:
            return

        temp_node = input_name_to_nodes[div_node.output[0]][0]
        mul_node = temp_node
        if mul_node.op_type != "Mul":
            return

        last_add_node = input_name_to_nodes[mul_node.output[0]][0]
        if last_add_node.op_type != "Add":
            return

        subgraph_nodes.append(node)
        subgraph_nodes.extend(parent_nodes)
        subgraph_nodes.extend([last_add_node, mul_node, div_node])

        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            last_add_node.output,
            input_name_to_nodes,
            output_name_to_node,
        ):
            logger.debug("It is not safe to fuse LayerNormalization node. Skip")
            return

        node_before_weight = div_node if temp_node.op_type != "Cast" else temp_node
        weight_input = mul_node.input[1 - self.model.input_index(node_before_weight.output[0], mul_node)]
        weight = self.get_weight_or_bias(weight_input, "layernorm weight")
        if weight is None:
            return

        bias_input = last_add_node.input[1 - self.model.input_index(mul_node.output[0], last_add_node)]
        bias = self.get_weight_or_bias(bias_input, "layernorm bias")
        if bias is None:
            return

        weight_nhwc = helper.make_tensor(weight_input + "_NHWC", TensorProto.FLOAT, weight.shape, weight)

        bias_nhwc = helper.make_tensor(bias_input + "_NHWC", TensorProto.FLOAT, weight.shape, weight)
        self.model.add_initializer(weight_nhwc, self.this_graph_name)
        self.model.add_initializer(bias_nhwc, self.this_graph_name)

        self.nodes_to_remove.extend(subgraph_nodes)

        transpose_input = self.create_transpose_node(node.input[0], [0, 2, 3, 1])

        layernorm_node_name = self.model.create_node_name("LayerNormalization", name_prefix="LayerNorm")

        transpose_output = self.create_transpose_node(
            layernorm_node_name + "_out_nhwc", [0, 3, 1, 2], last_add_node.output[0]
        )

        normalize_node = helper.make_node(
            "LayerNormalization",
            inputs=[transpose_input.output[0], weight_input + "_NHWC", bias_input + "_NHWC"],
            outputs=[layernorm_node_name + "_out_nhwc"],
            name=layernorm_node_name,
        )
        normalize_node.attribute.extend([helper.make_attribute("epsilon", float(epsilon))])

        self.nodes_to_add.append(transpose_input)
        self.nodes_to_add.append(normalize_node)
        self.nodes_to_add.append(transpose_output)
        self.node_name_to_graph_name[transpose_input.name] = self.this_graph_name
        self.node_name_to_graph_name[normalize_node.name] = self.this_graph_name
        self.node_name_to_graph_name[transpose_output.name] = self.this_graph_name

        counter_name = "LayerNormalization(NHWC)"
        self.increase_counter(counter_name)


class FusionLayerNormalizationTF(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "LayerNormalization", "Add", "TF")

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        """
         Layer Norm from Tensorflow model(using keras2onnx or tf2onnx):
          +------------------------------------+
          |                                    |
          |                                    |
        (Cast_1)                               |
          |                                    |
          |                                    v                                           (B)                             (B)             (A)
         Add --> (Cast_1) --> ReduceMean -->  Sub  --> Mul --> ReduceMean --> (Cast_3) --> Add --> Sqrt --> Reciprocol --> Mul --> Mul --> Sub --> Add
          |                       |                                                                                         |       ^              ^
          |                       |                                                                                         |       |              |
          |                       +--------------------------------------------------(Cast_2)-------------------------------|-------+              |
          |                                                                                                                 v                      |
          +---------------------------------------------------------------------------------------------------------------> Mul--------------------+
        """
        return_indice = []
        _, parent_nodes, return_indice = self.model.match_parent_paths(
            node,
            [
                (
                    [
                        "Sub",
                        "Mul",
                        "Mul",
                        "Reciprocal",
                        "Sqrt",
                        "Add",
                        "ReduceMean",
                        "Mul",
                        "Sub",
                        "ReduceMean",
                    ],
                    [1, 1, None, 0, 0, 0, None, 0, 0, None],
                ),
                (
                    [
                        "Sub",
                        "Mul",
                        "Mul",
                        "Reciprocal",
                        "Sqrt",
                        "Add",
                        "Cast",
                        "ReduceMean",
                        "Mul",
                        "Sub",
                        "ReduceMean",
                    ],
                    [1, 1, None, 0, 0, 0, 0, None, 0, 0, None],
                ),
            ],
            output_name_to_node,
        )

        if parent_nodes is None:
            return

        assert len(return_indice) == 3
        if not (return_indice[0] in [0, 1] and return_indice[1] in [0, 1] and return_indice[2] in [0, 1]):
            logger.debug("return indice is exepected in [0, 1], but got {return_indice}")
            return

        (
            sub_node_0,
            mul_node_0,
            mul_node_1,
            reciprocol_node,
            sqrt_node,
            add_node_0,
        ) = parent_nodes[:6]
        reduce_mean_node_0, mul_node_2, sub_node_1, reduce_mean_node_1 = parent_nodes[-4:]

        cast_node_3 = None
        if len(parent_nodes) == 11:
            cast_node_3 = parent_nodes[6]
            assert cast_node_3.op_type == "Cast"

        mul_node_3 = self.model.match_parent(node, "Mul", 0, output_name_to_node)
        if mul_node_3 is None:
            logger.debug("mul_node_3 not found")
            return

        node_before_reduce = self.model.get_parent(reduce_mean_node_1, 0, output_name_to_node)
        root_node = (
            node_before_reduce
            if cast_node_3 is None
            else self.model.get_parent(node_before_reduce, 0, output_name_to_node)
        )
        if root_node is None:
            logger.debug("root node is none")
            return

        i, epsilon = self.model.get_constant_input(add_node_0)
        if epsilon is None or epsilon <= 0 or (epsilon > 1.0e-5 and cast_node_3 is None):
            logger.debug("epsilon is not matched")
            return

        if cast_node_3 is None and (
            reduce_mean_node_1.input[0] not in mul_node_3.input or reduce_mean_node_1.input[0] not in sub_node_1.input
        ):
            logger.debug("reduce_mean_node_1 and mul_node_3 shall link from root node")
            return

        if cast_node_3 is not None and (
            node_before_reduce.input[0] not in mul_node_3.input or reduce_mean_node_1.input[0] not in sub_node_1.input
        ):
            logger.debug("reduce_mean_node_1 and mul_node_3 shall link from root node")
            return

        if mul_node_2.input[0] != mul_node_2.input[1]:
            logger.debug("mul_node_2 shall have two same inputs")
            return

        subgraph_nodes = [
            node,
            sub_node_0,
            mul_node_0,
            mul_node_1,
            reciprocol_node,
            sqrt_node,
            add_node_0,
            reduce_mean_node_0,
            mul_node_2,
            sub_node_1,
            reduce_mean_node_1,
            mul_node_3,
        ]

        if cast_node_3 is not None:
            cast_node_2 = self.model.match_parent(mul_node_0, "Cast", 0, output_name_to_node)
            if cast_node_2 is None:
                logger.debug("cast_node_2 not found")
                return
            subgraph_nodes.extend([node_before_reduce, cast_node_2, cast_node_3])

        if not self.model.is_safe_to_fuse_nodes(
            subgraph_nodes,
            node.output,
            self.model.input_name_to_nodes(),
            self.model.output_name_to_node(),
        ):
            logger.debug("not safe to fuse layer normalization")
            return

        self.nodes_to_remove.extend(subgraph_nodes)

        weight_input = mul_node_1.input[1]
        bias_input = sub_node_0.input[0]

        # TODO: add epsilon attribute
        fused_node = helper.make_node(
            "LayerNormalization",
            inputs=[mul_node_3.input[0], weight_input, bias_input],
            outputs=[node.output[0]],
            name=self.model.create_node_name("LayerNormalization", name_prefix="LayerNorm"),
        )
        fused_node.attribute.extend([helper.make_attribute("epsilon", float(epsilon))])
        self.nodes_to_add.append(fused_node)
        self.node_name_to_graph_name[fused_node.name] = self.this_graph_name
