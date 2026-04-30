import logging

from fusion_base import Fusion
from fusion_skiplayernorm import FusionSkipLayerNormalization
from onnx import helper
from onnx_model import OnnxModel

logger = logging.getLogger(__name__)


class FusionSimplifiedLayerNormalization(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "SimplifiedLayerNormalization", "Mul")

    def fuse(self, node, input_name_to_nodes: dict, output_name_to_node: dict):
        if node.op_type != "Mul":
            return

        sim_ln_nodes = None
        # RMSNorm formula:
        #   S = Pow(X, 2) or S = Mul(X, X)
        #   MS = ReduceMean(S)
        #   MSEps = Add(MS, epsilon)
        #   RMS = Sqrt(MSEps)
        #   InvRMS = Div(1, RMS) or InvRMS = Reciprocal(RMS)
        #   Normalized = Mul(D, InvRMS)
        #   Y = Mul(Normalized, Scale)
        #
        #  (root_input) ----------------------------------------+
        #       |                                               |
        #       v                                               v
        #      Pow --> ReduceMean --> Add ---> Sqrt --> Div --> Mul --> Mul (node)
        #      (B=2)                  (A/B=eps)         (A=1)           (A/B=scale)
        #
        #  (root_input) ----------------------------------------+
        #      | |                                              |
        #      v v                                              v
        #      Mul --> ReduceMean --> Add ---> Sqrt --> Div --> Mul --> Mul (node)
        #      (B=2)                  (A/B=eps)         (A=1)           (A/B=scale)
        #
        return_indice = []
        sim_ln_nodes = self.model.match_parent_path(
            node,
            ["Mul", "Div", "Sqrt", "Add", "ReduceMean"],
            [None, 1, 1, 0, None],
            output_name_to_node=output_name_to_node,
            return_indice=return_indice,
        )

        if sim_ln_nodes:
            mul_node, div_node, _sqrt_node, add_node, reduce_mean_node = sim_ln_nodes
            if not self.model.has_constant_input(div_node, 1.0):
                return
            node_parent = mul_node
        else:
            # Div(1, RMS) can also be represented as Reciprocal(RMS) like
            #
            #  (root_input) -----------------------------------------------+
            #       |                                                      |
            #       v                                                      v
            #      Pow --> ReduceMean --> Add ---> Sqrt --> Reciprocal --> Mul --> Mul (node)
            #      (B=2)                  (A/B=eps)                                (A/B=scale)
            #
            #  (root_input) -----------------------------------------------+
            #      | |                                                     |
            #      v v                                                     v
            #      Mul --> ReduceMean --> Add ---> Sqrt --> Reciprocal --> Mul --> Mul (node)
            #      (B=2)                  (A/B=eps)                                (A/B=scale)
            #
            return_indice = []
            sim_ln_nodes = self.model.match_parent_path(
                node,
                ["Mul", "Reciprocal", "Sqrt", "Add", "ReduceMean"],
                [None, 1, 0, 0, None],
                output_name_to_node=output_name_to_node,
                return_indice=return_indice,
            )
            if sim_ln_nodes is not None:
                mul_node, _reciprocal_node, _sqrt_node, add_node, reduce_mean_node = sim_ln_nodes
                node_parent = mul_node
            else:
                #  (root_input) --------------------------------+
                #       |                                       |
                #       v                                       v
                #      Pow --> ReduceMean --> Add ---> Sqrt --> Div --> Mul (node)
                #      (B=2)                  (A/B=eps)                 (A/B=scale)
                #
                #  (root_input) --------------------------------+
                #      | |                                      |
                #      v v                                      v
                #      Mul --> ReduceMean --> Add ---> Sqrt --> Div --> Mul (node)
                #      (B=2)                  (A/B=eps)                 (A/B=scale)
                #
                return_indice = []
                sim_ln_nodes = self.model.match_parent_path(
                    node,
                    ["Div", "Sqrt", "Add", "ReduceMean"],
                    [None, 1, 0, None],
                    output_name_to_node=output_name_to_node,
                    return_indice=return_indice,
                )
                if sim_ln_nodes is not None:
                    div_node, _sqrt_node, add_node, reduce_mean_node = sim_ln_nodes
                    node_parent = div_node
                else:
                    return

        reduce_mean_parent = self.model.get_parent(reduce_mean_node, 0, output_name_to_node)
        if reduce_mean_parent is None or reduce_mean_parent.op_type not in ["Pow", "Mul"]:
            return

        if reduce_mean_parent.op_type == "Pow":
            if self.model.find_constant_input(reduce_mean_parent, 2.0) != 1:
                return
        else:
            assert reduce_mean_parent.op_type == "Mul"
            if reduce_mean_parent[0] != reduce_mean_parent[1]:
                return

        root_input = reduce_mean_parent.input[0]
        if root_input not in node_parent.input:
            return

        _i, epsilon = self.model.get_constant_input(add_node)
        if epsilon is None or epsilon <= 0 or epsilon > 1.0e-4:
            logger.warning(f"epsilon value is not expected: {epsilon}")
            return

        # ReduceMean must have keepdims == 1
        keepdims = self.model.get_node_attribute(reduce_mean_node, "keepdims")
        if not keepdims:
            return

        # ReduceMean axes must refer only to the last dimension.
        # Axes became an input in opset 18. Before then, axes was an attribute.
        axes = self.model.get_node_attribute(reduce_mean_node, "axes")
        if (not axes) and len(reduce_mean_node.input) > 1:
            axes = self.model.get_constant_value(reduce_mean_node.input[1])
        # Make sure only one axis as required by SimplifiedLayerNormalization spec.
        if not axes or len(axes) != 1:
            return

        self.nodes_to_remove.extend(sim_ln_nodes)
        self.nodes_to_remove.append(reduce_mean_parent)
        self.nodes_to_remove.append(node)

        normalize_node = helper.make_node(
            "SimplifiedLayerNormalization",
            inputs=[root_input, node.input[1 - return_indice[0]]],
            outputs=[node.output[0]],
            name=self.model.create_node_name("SimplifiedLayerNormalization", name_prefix="RMSNorm"),
        )
        normalize_node.attribute.extend([helper.make_attribute("epsilon", float(epsilon))])
        normalize_node.attribute.extend([helper.make_attribute("axis", axes[0])])
        normalize_node.attribute.extend([helper.make_attribute("stash_type", 1)])
        self.nodes_to_add.append(normalize_node)
        self.node_name_to_graph_name[normalize_node.name] = self.this_graph_name


class FusionSkipSimplifiedLayerNormalization(FusionSkipLayerNormalization):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "SkipSimplifiedLayerNormalization", "SimplifiedLayerNormalization")

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        super().fuse(node, input_name_to_nodes, output_name_to_node)
