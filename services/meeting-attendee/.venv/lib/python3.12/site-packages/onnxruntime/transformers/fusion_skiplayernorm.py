# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

from logging import getLogger

from fusion_base import Fusion
from fusion_utils import NumpyHelper
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


def _is_broadcast_skip(input_shape, skip_shape):
    """Check if skip_shape can broadcast to input_shape for SkipLayerNormalization.

    The kernel supports: input 3D (B,S,H) with skip 3D (1,S,H) or skip 2D (S,H).
    """
    if len(input_shape) != 3:
        return False
    if len(skip_shape) == 3:
        return skip_shape[0] == 1 and skip_shape[1] == input_shape[1] and skip_shape[2] == input_shape[2]
    if len(skip_shape) == 2:
        return skip_shape[0] == input_shape[1] and skip_shape[1] == input_shape[2]
    return False


class FusionSkipLayerNormalization(Fusion):
    """
    Fuse Add + LayerNormalization into one node: SkipLayerNormalization.
    Supports broadcasting of the skip input: (1, sequence_length, hidden_size)
    or (sequence_length, hidden_size) will be broadcast to match the input shape.
    """

    def __init__(
        self,
        model: OnnxModel,
        fused_op_type: str = "SkipLayerNormalization",
        search_op_types: str = "LayerNormalization",
        shape_infer: bool = True,
    ):
        super().__init__(model, fused_op_type, search_op_types)
        if shape_infer:
            # Update shape inference is needed since other fusions might add new edge which does not have shape info yet.
            self.shape_infer_helper = self.model.infer_runtime_shape({"batch_size": 4, "seq_len": 7}, update=True)
            if self.shape_infer_helper is None:
                # TODO(tianleiwu): support subgraph in shape inference.
                logger.warning("symbolic shape inference disabled or failed.")

    def get_skip_index(self, add):
        """Identify which Add input is the skip tensor (the one that may broadcast).

        Returns (skip_index, broadcast):
            skip_index: 0 or 1 (which Add input is skip), -1 if incompatible
            broadcast: True if broadcasting is needed
        """
        shape_a = self.shape_infer_helper.get_edge_shape(add.input[0])
        shape_b = self.shape_infer_helper.get_edge_shape(add.input[1])
        if shape_a is None or shape_b is None:
            return -1, False

        if shape_a == shape_b:
            return (1, False) if len(shape_a) == 3 else (-1, False)

        # Check if b is a broadcastable skip for a
        if _is_broadcast_skip(shape_a, shape_b):
            return 1, True
        # Check if a is a broadcastable skip for b
        if _is_broadcast_skip(shape_b, shape_a):
            return 0, True

        return -1, False

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        add = self.model.get_parent(node, 0, output_name_to_node)

        # In some models there is input_ids->gather->add->LayerNorm and one of input of the
        # add node is initializer with fixed shape which should not be fused into SkipLayerNorm
        if add is None or add.op_type != "Add":
            return

        # The number of inputs of add should be 2
        if len(add.input) != 2:
            return

        for add_input in add.input:
            if self.model.get_initializer(add_input) is not None:
                return

        # To avoid an Add node have two children of LayerNormalization, we shall only fuse one SkipLayerNormalization
        if add in self.nodes_to_remove:
            return

        # Root Mean Square Layer Normalization
        simplified = node.op_type == "SimplifiedLayerNormalization"

        skip_index = 1  # default: add.input[1] is the skip
        _broadcast = False

        if hasattr(self, "shape_infer_helper"):
            if self.shape_infer_helper is not None:
                skip_index, _broadcast = self.get_skip_index(add)
                if skip_index < 0:
                    logger.debug(
                        "skip SkipLayerNormalization fusion since shapes of inputs (%s, %s) are not compatible",
                        add.input[0],
                        add.input[1],
                    )
                    return
            else:
                logger.debug("skip SkipLayerNormalization fusion since symbolic shape inference failed")
                return

        gather_path = self.model.match_parent_path(add, ["Gather"], [None])
        if gather_path is not None and self.model.find_graph_input(gather_path[0].input[1]) is None:
            if self.model.match_parent_path(gather_path[0], ["ConstantOfShape"], [1]) is None:
                return

        # When broadcasting is needed, check that neither Add input comes from a Gather
        # (embedding lookup). Embedding Add+LayerNorm should be fused by EmbedLayerNormalization
        # later in the pipeline, not as SkipLayerNormalization.
        if _broadcast:
            for i in range(2):
                parent = self.model.get_parent(add, i, output_name_to_node)
                if parent is not None and parent.op_type == "Gather":
                    logger.debug(
                        "skip SkipLayerNormalization broadcast fusion since Add input %d comes from Gather (embedding)",
                        i,
                    )
                    return

        # This means that the residual Add before the LayerNormalization produces an output
        # that is consumed by some other nodes or graph output other than the LayerNormalization itself
        # We can still go ahead with the SkipLayerNormalization fusion but we need to
        # preserve the output of Add and that needs to be produced by SkipLayerNormalization.
        add_has_graph_output = self.model.find_graph_output(add.output[0]) is not None
        residual_add_has_multiple_consumers = (
            add_has_graph_output or len(self.model.get_children(add, input_name_to_nodes)) > 1
        )

        outputs_to_keep = node.output

        if residual_add_has_multiple_consumers:
            outputs_to_keep.extend([add.output[0]])

        outputs = [node.output[0]]

        # Skip the other optional outputs of SkipLayerNormalization before adding the Add's output
        if residual_add_has_multiple_consumers:
            outputs.extend(["", "", add.output[0]])

        if self.model.is_safe_to_fuse_nodes([add, node], outputs_to_keep, input_name_to_nodes, output_name_to_node):
            self.nodes_to_remove.extend([add, node])

            input_index = 1 - skip_index
            inputs = (
                [add.input[input_index], add.input[skip_index], node.input[1], node.input[2]]
                if not simplified
                else [add.input[input_index], add.input[skip_index], node.input[1]]
            )
            normalize_node = helper.make_node(
                self.fused_op_type,
                inputs=inputs,
                outputs=outputs,
                name=self.model.create_node_name(self.fused_op_type, name_prefix="SkipLayerNorm"),
            )
            normalize_node.domain = "com.microsoft"

            # Pass attribute "epsilon" from layernorm node to SkipLayerNormalization
            for att in node.attribute:
                if att.name == "epsilon":
                    normalize_node.attribute.extend([att])

            # Set default epsilon if no epsilon exists from layernorm
            if len(normalize_node.attribute) == 0:
                normalize_node.attribute.extend([helper.make_attribute("epsilon", 1.0e-12)])

            self.nodes_to_add.append(normalize_node)
            self.node_name_to_graph_name[normalize_node.name] = self.this_graph_name


class FusionBiasSkipLayerNormalization(Fusion):
    def __init__(self, model: OnnxModel):
        super().__init__(model, "SkipLayerNormalization", "SkipLayerNormalization", "add bias")

    def fuse(self, node, input_name_to_nodes, output_name_to_node):
        if len(node.input) != 4:
            return

        return_indice = []
        nodes = self.model.match_parent_path(node, ["Add", "MatMul"], [None, None], output_name_to_node, return_indice)
        if nodes is not None:
            (add, _matmul) = nodes
        else:
            # In case of fp16, we could have a Cast between the MatMul and the bias Add
            return_indice = []
            nodes = self.model.match_parent_path(
                node, ["Add", "Cast", "MatMul"], [None, None, None], output_name_to_node, return_indice
            )
            if nodes is not None:
                (add, _cast, _matmul) = nodes
            else:
                return

        assert len(return_indice) == 2 or len(return_indice) == 3
        add_input_index = return_indice[0]
        if add_input_index >= 2:
            return
        sln_input = add.input[return_indice[1]]
        bias_input = add.input[1 - return_indice[1]]
        skip_input = node.input[1 - add_input_index]

        # bias should be one dimension
        initializer = self.model.get_initializer(bias_input)
        if initializer is None:
            return
        bias_weight = NumpyHelper.to_array(initializer)
        if bias_weight is None:
            logger.debug("Bias weight not found")
            return
        if len(bias_weight.shape) != 1:
            logger.debug("Bias weight is not 1D")
            return

        subgraph_nodes = [node, add]
        if not self.model.is_safe_to_fuse_nodes(subgraph_nodes, node.output, input_name_to_nodes, output_name_to_node):
            logger.debug("Skip fusing SkipLayerNormalization with Bias since it is not safe")
            return

        self.nodes_to_remove.extend(subgraph_nodes)
        inputs = [
            sln_input,
            skip_input,
            node.input[2],
            node.input[3],
            bias_input,
        ]
        new_node = helper.make_node(
            "SkipLayerNormalization",
            inputs=inputs,
            outputs=node.output,
            name=self.model.create_node_name("SkipLayerNormalization", "SkipLayerNorm_AddBias_"),
        )
        new_node.domain = "com.microsoft"

        # Pass attribute "epsilon" from skiplayernorm node to skiplayernorm(add bias)
        for att in node.attribute:
            if att.name == "epsilon":
                new_node.attribute.extend([att])

        # Set default epsilon if no epsilon exists from skiplayernorm
        if len(new_node.attribute) == 0:
            new_node.attribute.extend([helper.make_attribute("epsilon", 1.0e-12)])

        self.nodes_to_add.append(new_node)
        self.node_name_to_graph_name[new_node.name] = self.this_graph_name
