# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from collections.abc import Sequence
from logging import getLogger
from typing import Any

import numpy as np
import onnx
from onnx import helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class DynamoOnnxHelper:
    """
    Helper class for processing ONNX models exported by Torch Dynamo.
    """

    def __init__(self, model: onnx.ModelProto):
        self.model = OnnxModel(model)

    def update_edges(self, edge_mapping: dict) -> None:
        """
        Updates the edges in the model according to the given mapping.
        """
        for node in self.model.model.graph.node:
            for i in range(len(node.input)):
                if node.input[i] in edge_mapping:
                    node.input[i] = edge_mapping[node.input[i]]
            for i in range(len(node.output)):
                if node.output[i] in edge_mapping:
                    node.output[i] = edge_mapping[node.output[i]]

        for graph_input in self.model.model.graph.input:
            if graph_input.name in edge_mapping:
                graph_input.name = edge_mapping[graph_input.name]
        for graph_output in self.model.model.graph.output:
            if graph_output.name in edge_mapping:
                graph_output.name = edge_mapping[graph_output.name]

    def unroll_function(self, func_name: str) -> None:
        """
        Unrolls the function with the given name in the model.
        """
        logger.debug(f"Unrolling function {func_name}...")
        nodes_to_remove = []
        nodes_to_add = []
        edges_to_remove = []
        edges_to_add = []
        for node in self.model.model.graph.node:
            if node.op_type == func_name:
                nodes_to_remove.append(node)
                edges_to_remove.extend(list(node.input) + list(node.output))

        func_to_remove = None
        for f in self.model.model.functions:
            if f.name == func_name:
                nodes_to_add.extend(list(f.node))
                edges_to_add.extend(list(f.input) + list(f.output))
                func_to_remove = f

        assert len(edges_to_remove) == len(edges_to_add)

        for node in nodes_to_remove:
            self.model.model.graph.node.remove(node)
        for node in nodes_to_add:
            self.model.model.graph.node.append(node)
        if func_to_remove is not None:
            self.model.model.functions.remove(func_to_remove)

        edge_mapping = {}
        for i in range(len(edges_to_remove)):
            k = edges_to_remove[i]
            v = edges_to_add[i]
            if k != v:
                edge_mapping[k] = v

        return self.update_edges(edge_mapping)

    def remove_function(self, func_name: str, input_id: int, output_id: int) -> None:
        """
        Removes the function in the model.
        """
        edge_mapping = {}
        nodes_to_remove = []
        for node in self.model.model.graph.node:
            if node.op_type.find(func_name) != -1:
                edge_mapping[node.input[input_id]] = node.output[output_id]
                nodes_to_remove.append(node)
        for node in nodes_to_remove:
            self.model.model.graph.node.remove(node)

        self.update_edges(edge_mapping)

    def remove_dropout_layer(self) -> None:
        """
        Removes the dropout layer in the model.
        """
        logger.debug("Removing dropout layer...")
        self.remove_function("Dropout", 0, 0)

    def remove_lm_head_layer(self) -> None:
        """
        Removes the LM head layer in the model.
        """
        logger.debug("Removing LM head layer...")
        # bugbug: need to copy the right vi over
        self.remove_function("Linear_lm_head", 2, 0)

    def add_initializer(self, name: str, data_type: int, dims: Sequence[int], vals: Any, raw: bool = True):
        if raw:
            np_type = helper.tensor_dtype_to_np_dtype(data_type)
            if not isinstance(vals, np.ndarray):
                bytes = np.array(vals, dtype=np_type).tobytes()
            else:
                bytes = vals.astype(np_type).tobytes()
            tensor = helper.make_tensor(
                name=name,
                data_type=data_type,
                dims=dims,
                vals=bytes,
                raw=True,
            )
        else:
            tensor = helper.make_tensor(
                name=name,
                data_type=data_type,
                dims=dims,
                vals=vals,
                raw=False,
            )

        self.model.add_initializer(tensor)
        return tensor

    def convert_constants_to_initializers(self, min_size: int = 1) -> None:
        """
        Converts Constant ops of size [min_size] or higher to initializers
        """
        logger.debug(f"Converting constants greater than size {min_size} to initializers")

        constant_nodes = self.model.get_nodes_by_op_type("Constant")
        nodes_to_remove = []

        for node in constant_nodes:
            # Get info from Constant op
            np_data = self.model.get_constant_value(node.output[0])

            # Skip if there are less than [min_size] elements
            if np_data is None or np_data.size < min_size:
                continue

            # Add new initializer with same name as Constant op's output
            for att in node.attribute:
                if att.name == "value":
                    self.add_initializer(
                        name=node.output[0],
                        data_type=att.t.data_type,
                        dims=list(np_data.shape),
                        vals=np_data,
                    )
                    break

            nodes_to_remove.append(node)

        # Remove Constant ops from graph
        self.model.remove_nodes(nodes_to_remove)

    def clear_metadata(self) -> None:
        """
        Clear metadata fields in all nodes
        """
        for graph in self.model.graphs():
            graph.ClearField("metadata_props")
        for node in self.model.nodes():
            node.ClearField("metadata_props")

    @staticmethod
    def fold_transpose_initializers(model) -> None:
        """
        Constant fold Transpose initializers without changing the initializer names
        """
        from onnxscript import ir  # noqa: PLC0415

        for name, initializer in model.graph.initializers.items():
            user_nodes = initializer.consumers()
            if len(user_nodes) == 1 and user_nodes[0].op_type == "Transpose":
                transpose_node = user_nodes[0]
                perm = transpose_node.attributes.get("perm")
                if perm is None:
                    transposed_tensor = ir.tensor(initializer.const_value.numpy().transpose())
                else:
                    transposed_tensor = ir.tensor(initializer.const_value.numpy().transpose(perm.as_ints()))
                new_initializer = ir.Value(
                    name=initializer.name,
                    shape=transposed_tensor.shape,
                    type=ir.TensorType(transposed_tensor.dtype),
                    const_value=transposed_tensor,
                )
                ir.convenience.replace_all_uses_with(transpose_node.outputs[0], new_initializer)
                model.graph.initializers[name] = new_initializer
                transpose_node.graph.remove(transpose_node, safe=True)
