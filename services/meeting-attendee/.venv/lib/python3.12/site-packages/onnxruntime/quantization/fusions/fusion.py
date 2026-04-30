# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

from collections import deque

import onnx

from ..onnx_model import ONNXModel


class Fusion:
    """
    Base class for fusions.
    """

    def __init__(self, model: ONNXModel, fused_op_type: str, search_op_type: str):
        self.search_op_type: str = search_op_type
        self.fused_op_type: str = fused_op_type
        self.model: ONNXModel = model
        self.nodes_to_remove: list = []
        self.nodes_to_add: list = []

        self._new_node_name_prefix = self.fused_op_type + "_fused_" + self.search_op_type + "_"
        self._new_node_name_suffix = None  # int|None used to create unique node names for the fused ops.

    def fuse(
        self,
        node: onnx.NodeProto,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ):
        """
        Interface function for derived fusion classes. Tries to fuse a node sequence containing
        the specified node.
        """
        raise NotImplementedError

    def apply(self) -> bool:
        """
        Apply graph fusion on the entire model graph.
        """
        input_name_to_nodes = self.model.input_name_to_nodes()
        output_name_to_node = self.model.output_name_to_node()

        for node in self.model.nodes():
            if node.op_type == self.search_op_type:
                self.fuse(node, input_name_to_nodes, output_name_to_node)

        self.model.remove_nodes(self.nodes_to_remove)
        self.model.add_nodes(self.nodes_to_add)

        graph_updated = bool(self.nodes_to_remove or self.nodes_to_add)

        if graph_updated:
            self.model.remove_unused_constant()

        return graph_updated

    def create_unique_node_name(self):
        prefix = self._new_node_name_prefix

        if self._new_node_name_suffix is None:
            largest_suffix: int = self.model.get_largest_node_name_suffix(prefix)
            self._new_node_name_suffix = largest_suffix + 1

        new_name = f"{prefix}{self._new_node_name_suffix!s}"
        self._new_node_name_suffix += 1

        return new_name

    @staticmethod
    def is_safe_to_fuse_nodes(
        nodes_to_remove: list[onnx.NodeProto],
        keep_outputs: list[str],
        input_name_to_nodes: dict[str, list[onnx.NodeProto]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ) -> bool:
        for node_to_remove in nodes_to_remove:
            for output_to_remove in node_to_remove.output:
                if output_to_remove in keep_outputs:
                    continue

                if output_to_remove in input_name_to_nodes:
                    for impacted_node in input_name_to_nodes[output_to_remove]:
                        if impacted_node not in nodes_to_remove:
                            # Not safe to remove nodes since output is used by impacted_node
                            return False
        return True

    @staticmethod
    def get_node_attribute(node: onnx.NodeProto, attribute_name: str):
        for attr in node.attribute:
            if attr.name == attribute_name:
                value = onnx.helper.get_attribute_value(attr)
                return value
        return None

    @staticmethod
    def input_index(node_output: str, child_node: onnx.NodeProto) -> int:
        for index, input_name in enumerate(child_node.input):
            if input_name == node_output:
                return index
        return -1

    @staticmethod
    def tensor_shape_to_list(tensor_type) -> list[int]:
        shape_list = []
        for d in tensor_type.shape.dim:
            if d.HasField("dim_value"):
                shape_list.append(d.dim_value)  # known dimension
            elif d.HasField("dim_param"):
                shape_list.append(d.dim_param)  # unknown dimension with symbolic name
            else:
                shape_list.append("?")  # shall not happen
        return shape_list

    def get_constant_input(self, node: onnx.NodeProto):
        for i, inp in enumerate(node.input):
            value = self.model.get_constant_value(inp)
            if value is not None:
                return i, value

        return None, None

    def find_constant_input(self, node: onnx.NodeProto, expected_value: float, delta: float = 0.000001) -> int:
        i, value = self.get_constant_input(node)
        if value is not None and value.size == 1 and abs(value - expected_value) < delta:
            return i

        return -1

    def has_constant_input(self, node: onnx.NodeProto, expected_value: float, delta: float = 0.000001) -> bool:
        return self.find_constant_input(node, expected_value, delta) >= 0

    def is_constant_with_specified_rank(self, output_name: str, rank: int) -> bool:
        value = self.model.get_constant_value(output_name)
        if value is None:
            return False  # Not an initializer

        if len(value.shape) != rank:
            return False  # Wrong dimensions

        return True

    def match_first_parent(
        self,
        node: onnx.NodeProto,
        parent_op_type: str,
        output_name_to_node: dict[str, onnx.NodeProto] | None = None,
        exclude: list[onnx.NodeProto] = [],  # noqa: B006
    ) -> tuple[onnx.NodeProto | None, int | None]:
        """
        Find parent node based on constraints on op_type.

        Args:
            node: current node.
            parent_op_type (str): constraint of parent node op_type.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            exclude (list): list of nodes that are excluded (not allowed to match as parent).

        Returns:
            parent: The matched parent node. None if not found.
            index: The input index of matched parent node. None if not found.
        """
        if output_name_to_node is None:
            output_name_to_node = self.model.output_name_to_node()

        for i, inp in enumerate(node.input):
            if inp in output_name_to_node:
                parent = output_name_to_node[inp]
                if parent.op_type == parent_op_type and parent not in exclude:
                    return parent, i

        return None, None

    def match_parent(
        self,
        node: onnx.NodeProto,
        parent_op_type: str,
        input_index: int | None = None,
        output_name_to_node: dict[str, onnx.NodeProto] | None = None,
        exclude: list[onnx.NodeProto] = [],  # noqa: B006
        return_indice: list[int] | None = None,
    ) -> onnx.NodeProto | None:
        """
        Find parent node based on constraints on op_type and index.
        When input_index is None, we will find the first parent node based on constraints,
        and return_indice will be appended the corresponding input index.

        Args:
            node (str): current node name.
            parent_op_type (str): constraint of parent node op_type.
            input_index (int or None): only check the parent given input index of current node.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            exclude (list): list of nodes that are excluded (not allowed to match as parent).
            return_indice (list): a list to append the input index when input_index is None.

        Returns:
            parent: The matched parent node.
        """
        assert node is not None
        assert input_index is None or input_index >= 0

        if output_name_to_node is None:
            output_name_to_node = self.model.output_name_to_node()

        if input_index is None:
            parent, index = self.match_first_parent(node, parent_op_type, output_name_to_node, exclude)
            if return_indice is not None:
                return_indice.append(index)
            return parent

        if input_index >= len(node.input):
            # Input index out of bounds.
            return None

        parent = self.model.get_parent(node, input_index, output_name_to_node)
        if parent is not None and parent.op_type == parent_op_type and parent not in exclude:
            return parent

        return None

    def match_parent_path(
        self,
        node: onnx.NodeProto,
        parent_op_types: list[str],
        parent_input_index: list[int] | None = None,
        output_name_to_node: dict[str, onnx.NodeProto] | None = None,
        return_indice: list[int] | None = None,
    ) -> list[onnx.NodeProto] | None:
        """
        Find a sequence of input edges based on constraints on parent op_type and index.
        When input_index is None, we will find the first parent node based on constraints,
        and return_indice will be appended the corresponding input index.

        Args:
            node (str): current node name.
            parent_op_types (str): constraint of parent node op_type of each input edge.
            parent_input_index (list): constraint of input index of each input edge. None means no constraint.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            return_indice (list): a list to append the input index
                                  When there is no constraint on input index of an edge.

        Returns:
            parents: a list of matched parent node.
        """
        if parent_input_index is not None:
            assert len(parent_input_index) == len(parent_op_types)

        if output_name_to_node is None:
            output_name_to_node = self.model.output_name_to_node()

        current_node = node
        matched_parents = []
        for i, op_type in enumerate(parent_op_types):
            matched_parent = self.match_parent(
                current_node,
                op_type,
                parent_input_index[i] if parent_input_index is not None else None,
                output_name_to_node,
                exclude=[],
                return_indice=return_indice,
            )
            if matched_parent is None:
                return None

            matched_parents.append(matched_parent)
            current_node = matched_parent

        return matched_parents

    def match_parent_paths(
        self,
        node: onnx.NodeProto,
        paths: list[tuple[list[str], list[int]]],
        output_name_to_node: dict[str, onnx.NodeProto],
    ) -> tuple[int, list[onnx.NodeProto] | None, list[int] | None]:
        """
        Find a matching parent path to the given node.
        """
        for i, path in enumerate(paths):
            return_indice = []
            matched = self.match_parent_path(node, path[0], path[1], output_name_to_node, return_indice)
            if matched:
                return i, matched, return_indice
        return -1, None, None

    def find_first_child_by_type(
        self,
        node: onnx.NodeProto,
        child_type: str,
        input_name_to_nodes: dict[str, list[onnx.NodeProto]] | None = None,
        recursive: bool = True,
    ) -> onnx.NodeProto | None:
        children = self.model.get_children(node, input_name_to_nodes)
        dq = deque(children)
        while len(dq) > 0:
            current_node = dq.pop()
            if current_node.op_type == child_type:
                return current_node

            if recursive:
                children = self.model.get_children(current_node, input_name_to_nodes)
                for child in children:
                    dq.appendleft(child)

        return None
