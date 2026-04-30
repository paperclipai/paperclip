# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import itertools
import logging
import os
import sys
from collections import deque
from pathlib import Path

from float16 import convert_float_to_float16
from onnx import (
    AttributeProto,
    GraphProto,
    ModelProto,
    NodeProto,
    TensorProto,
    ValueInfoProto,
    helper,
    numpy_helper,
    save_model,
)
from onnx.external_data_helper import load_external_data_for_tensor, uses_external_data
from shape_infer_helper import SymbolicShapeInferenceHelper

logger = logging.getLogger(__name__)


class OnnxModel:
    def __init__(self, model):
        self.initialize(model)

    def initialize(self, model):
        self.model: ModelProto = model
        self._node_name_suffix: dict[str, int] = {}  # key is node name prefix, value is the last suffix generated
        self.shape_infer_helper: SymbolicShapeInferenceHelper = None
        self.enable_shape_infer: bool = True
        self.all_graphs: list[GraphProto] | None = None

        # Cache of shape and data type from onnx graph to speed up optimization.
        # Be careful that fusion shall not reuse node output name for different shape/type (in adding/removing nodes)
        # Note that these do not cache the symbolic shape inference result.
        self._dtype_dict: dict[str, int] | None = None
        self._shape_dict: dict[str, list] | None = None

    def disable_shape_inference(self):
        self.enable_shape_infer = False

    def infer_runtime_shape(self, dynamic_axis_mapping={}, update=False):  # noqa: B006
        if self.enable_shape_infer:
            if self.shape_infer_helper is None or update:
                self.shape_infer_helper = SymbolicShapeInferenceHelper(self.model)

            try:
                if self.shape_infer_helper.infer(dynamic_axis_mapping):
                    return self.shape_infer_helper
            except Exception:
                self.enable_shape_infer = False  # disable shape inference to suppress same error message.
                print("failed in shape inference", sys.exc_info()[0])

        return None

    def input_name_to_nodes(self, exclude_subgraphs=False):
        input_name_to_nodes = {}
        nodes_to_search = self.nodes() if not exclude_subgraphs else self.model.graph.node
        for node in nodes_to_search:
            for input_name in node.input:
                if input_name:  # could be empty when it is optional
                    if input_name not in input_name_to_nodes:
                        input_name_to_nodes[input_name] = [node]
                    else:
                        input_name_to_nodes[input_name].append(node)
        return input_name_to_nodes

    def output_name_to_node(self, exclude_subgraphs=False):
        output_name_to_node = {}
        nodes_to_search = self.nodes() if not exclude_subgraphs else self.model.graph.node
        for node in nodes_to_search:
            for output_name in node.output:
                if output_name:  # could be empty when it is optional
                    output_name_to_node[output_name] = node
        return output_name_to_node

    def functions(self):
        all_functions = [list(self.model.functions)]
        return all_functions

    def nodes(self):
        all_nodes = []
        for graph in self.graphs():
            for node in graph.node:
                all_nodes.append(node)  # noqa: PERF402
        return all_nodes

    def graph(self):
        return self.model.graph

    def graphs(self):
        if self.all_graphs is not None:
            return self.all_graphs
        self.all_graphs = []
        graph_queue = [self.model.graph]
        while graph_queue:
            graph = graph_queue.pop(0)
            self.all_graphs.append(graph)
            for node in graph.node:
                for attr in node.attribute:
                    if attr.type == AttributeProto.AttributeType.GRAPH:
                        assert isinstance(attr.g, GraphProto)
                        graph_queue.append(attr.g)
                    if attr.type == AttributeProto.AttributeType.GRAPHS:
                        for g in attr.graphs:
                            assert isinstance(g, GraphProto)
                            graph_queue.append(g)
        return self.all_graphs

    def get_graphs_input_names(self):
        input_names = []
        for graph in self.graphs():
            for input in graph.input:
                input_names.append(input.name)
        return input_names

    def get_graphs_output_names(self):
        output_names = []
        for graph in self.graphs():
            for output in graph.output:
                output_names.append(output.name)
        return output_names

    def get_graph_by_node(self, node):
        for graph in self.graphs():
            if node in graph.node:
                return graph
        return None

    def get_graph_by_name(self, graph_name):
        for graph in self.graphs():
            if graph_name == graph.name:
                return graph
        return None

    def get_topological_insert_id(self, graph, outputs):
        for idx, node in enumerate(graph.node):
            for input in node.input:
                if input in outputs:
                    return idx
        return len(graph.node)

    def remove_node(self, node):
        for graph in self.graphs():
            if node in graph.node:
                graph.node.remove(node)
                return
        logger.warning("Failed to remove node %s", node)  # It might be a bug to hit this line.

    def remove_nodes(self, nodes_to_remove):
        for node in nodes_to_remove:
            self.remove_node(node)

    def add_node(self, node, graph_name=None):
        if graph_name is None or graph_name == self.model.graph.name:
            self.model.graph.node.extend([node])
        else:
            graph = self.get_graph_by_name(graph_name)
            insert_idx = self.get_topological_insert_id(graph, node.output)
            graph.node.insert(insert_idx, node)

    def add_nodes(self, nodes_to_add, node_name_to_graph_name=None):
        if node_name_to_graph_name is None:
            self.model.graph.node.extend(nodes_to_add)
        else:
            for node in nodes_to_add:
                graph_name = node_name_to_graph_name[node.name]
                self.add_node(node, graph_name)

    def add_initializer(self, tensor, graph_name=None):
        if graph_name is None or graph_name == self.model.graph.name:
            self.model.graph.initializer.extend([tensor])
        else:
            graph = self.get_graph_by_name(graph_name)
            graph.initializer.extend([tensor])

    def add_input(self, input, graph_name=None):
        if graph_name is None or graph_name == self.model.graph.name:
            self.model.graph.input.extend([input])
        else:
            graph = self.get_graph_by_name(graph_name)
            graph.input.extend([input])

    @staticmethod
    def replace_node_input(node, old_input_name, new_input_name):
        assert isinstance(old_input_name, str) and isinstance(new_input_name, str)
        for j in range(len(node.input)):
            if node.input[j] == old_input_name:
                node.input[j] = new_input_name

    def replace_input_of_all_nodes(self, old_input_name, new_input_name):
        for node in self.nodes():
            OnnxModel.replace_node_input(node, old_input_name, new_input_name)

    @staticmethod
    def replace_node_output(node, old_output_name, new_output_name):
        assert isinstance(old_output_name, str) and isinstance(new_output_name, str)
        for j in range(len(node.output)):
            if node.output[j] == old_output_name:
                node.output[j] = new_output_name

    def replace_output_of_all_nodes(self, old_output_name, new_output_name):
        # This function shall be used carefully. For example:
        #       Add --[old_name]--> Cast ---> [new_name]
        #        |
        #        +----[old_name]--> Transpose -->
        # If we want to remove the Cast node: replace output of Add to new_name is not enough;
        # The input of Transpose shall also be updated to new_name.
        for node in self.model.graph.node:
            OnnxModel.replace_node_output(node, old_output_name, new_output_name)

    def get_initializer(self, name):
        for graph in self.graphs():
            for tensor in graph.initializer:
                if tensor.name == name:
                    return tensor
        return None

    def get_nodes_by_op_type(self, op_type):
        nodes = []
        for node in self.nodes():
            if node.op_type == op_type:
                nodes.append(node)
        return nodes

    def get_children(self, node, input_name_to_nodes=None, output_index=None):
        if input_name_to_nodes is None:
            input_name_to_nodes = self.input_name_to_nodes()

        children = []
        if output_index is not None:
            if output_index < len(node.output):
                output = node.output[output_index]
                if output in input_name_to_nodes:
                    children = list(input_name_to_nodes[output])
        else:
            for output in node.output:
                if output in input_name_to_nodes:
                    children.extend(input_name_to_nodes[output])

        return children

    def get_parents(self, node, output_name_to_node=None):
        if output_name_to_node is None:
            output_name_to_node = self.output_name_to_node()

        parents = []
        for input in node.input:
            if input in output_name_to_node:
                parents.append(output_name_to_node[input])
        return parents

    def get_parent(self, node, i, output_name_to_node=None):
        if output_name_to_node is None:
            output_name_to_node = self.output_name_to_node()

        if len(node.input) <= i:
            return None

        input = node.input[i]
        if input not in output_name_to_node:
            return None

        return output_name_to_node[input]

    def match_first_parent(self, node, parent_op_type, output_name_to_node, exclude=[]):  # noqa: B006
        """
        Find parent node based on constraints on op_type.

        Args:
            node (str): current node name.
            parent_op_type (str): constraint of parent node op_type.
            output_name_to_node (dict): dictionary with output name as key, and node as value.
            exclude (list): list of nodes that are excluded (not allowed to match as parent).

        Returns:
            parent: The matched parent node. None if not found.
            index: The input index of matched parent node. None if not found.
        """
        for i, input in enumerate(node.input):
            if input in output_name_to_node:
                parent = output_name_to_node[input]
                if parent.op_type == parent_op_type and parent not in exclude:
                    return parent, i
                else:
                    logger.debug(f"To find first {parent_op_type}, current {parent.op_type}")
        return None, None

    def match_parent(
        self,
        node,
        parent_op_type,
        input_index=None,
        output_name_to_node=None,
        exclude=[],  # noqa: B006
        return_indice=None,
    ):
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
            output_name_to_node = self.output_name_to_node()

        if input_index is None:
            parent, index = self.match_first_parent(node, parent_op_type, output_name_to_node, exclude)
            if return_indice is not None:
                return_indice.append(index)
            return parent

        if input_index >= len(node.input):
            logger.debug(f"input_index {input_index} >= node inputs {len(node.input)}")
            return None

        parent = self.get_parent(node, input_index, output_name_to_node)
        if parent is not None and parent.op_type == parent_op_type and parent not in exclude:
            return parent

        if parent is not None:
            logger.debug(f"Expect {parent_op_type}, Got {parent.op_type}")

        return None

    def match_parent_paths(self, node, paths, output_name_to_node):
        for i, path in enumerate(paths):
            assert isinstance(path, (list, tuple))
            return_indice = []
            matched = self.match_parent_path(node, path[0], path[1], output_name_to_node, return_indice)
            if matched:
                return i, matched, return_indice
        return -1, None, None

    def match_parent_paths_all(self, node, paths, output_name_to_node):
        match_i, matches, return_indices = [], [], []
        for i, path in enumerate(paths):
            assert isinstance(path, (list, tuple))
            return_indice = []
            matched = self.match_parent_path(node, path[0], path[1], output_name_to_node, return_indice)
            if matched:
                match_i.append(i)
                matches.append(matched)
                return_indices.append(return_indice)
        return match_i, matches, return_indices

    def match_parent_path(
        self,
        node,
        parent_op_types,
        parent_input_index=None,
        output_name_to_node=None,
        return_indice=None,
    ):
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
            output_name_to_node = self.output_name_to_node()

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
                if parent_input_index is not None:
                    logger.debug(
                        f"Failed to match index={i} parent_input_index={parent_input_index[i]} op_type={op_type}",
                        stack_info=True,
                    )
                else:
                    logger.debug(f"Failed to match index={i} op_type={op_type}", stack_info=True)
                return None

            matched_parents.append(matched_parent)
            current_node = matched_parent

        return matched_parents

    def find_first_child_by_type(self, node, child_type, input_name_to_nodes=None, recursive=True):
        children = self.get_children(node, input_name_to_nodes)
        dq = deque(children)
        while len(dq) > 0:
            current_node = dq.pop()
            if current_node.op_type == child_type:
                return current_node

            if recursive:
                children = self.get_children(current_node, input_name_to_nodes)
                for child in children:
                    dq.appendleft(child)

        return None

    def match_child_path(
        self,
        node,
        child_op_types,
        edges: list[tuple[int, int]] | None = None,
        input_name_to_nodes=None,
        exclude=[],  # noqa: B006
    ):
        """
        Find a sequence of input edges based on constraints on parent op_type and index.
        Note that we use greedy approach and only consider the first matched child, so it has chance to miss matching.

        Args:
            node (str): current node name.
            child_op_types (str): constraint of child node op_type of each input edge.
            edges (list): each edge is represented by two integers: output index of parent node, input index of child node.
                         None means no constraint.
            exclude(list): list of nodes that are excluded (not allowed to match as child).

        Returns:
            children: a list of matched children node.
        """
        if edges is not None:
            assert len(edges) == len(child_op_types)
            for edge in edges:
                assert (
                    isinstance(edge, tuple) and len(edge) == 2 and isinstance(edge[0], int) and isinstance(edge[1], int)
                )

        if input_name_to_nodes is None:
            input_name_to_nodes = self.input_name_to_nodes()

        current_node = node
        matched_children = []
        for i, op_type in enumerate(child_op_types):
            matched_child = None

            if edges is None:
                children_nodes = self.get_children(current_node, input_name_to_nodes=input_name_to_nodes)
            else:
                children_nodes = self.get_children(
                    current_node, input_name_to_nodes=input_name_to_nodes, output_index=edges[i][0]
                )

            for child in children_nodes:
                if child.op_type == op_type and child not in exclude:
                    if edges is not None and child.input[edges[i][1]] != current_node.output[edges[i][0]]:
                        continue

                    # Here we use greedy approach and only consider the first matched child.
                    # TODO: match recursively if we encounter cases that the correct child is not the first matched.
                    matched_child = child
                    break

            if matched_child is None:
                logger.debug(f"Failed to match child {i} op_type={op_type}", stack_info=True)
                return None

            matched_children.append(matched_child)
            current_node = matched_child

        return matched_children

    def find_first_parent_by_type(self, node, parent_type, output_name_to_node=None, recursive=True):
        if output_name_to_node is None:
            output_name_to_node = self.output_name_to_node()

        parents = self.get_parents(node, output_name_to_node)
        dq = deque(parents)
        while len(dq) > 0:
            current_node = dq.pop()
            if current_node.op_type == parent_type:
                return current_node

            if recursive:
                parents = self.get_parents(current_node, output_name_to_node)
                for parent in parents:
                    dq.appendleft(parent)

        return None

    def get_constant_value(self, output_name):
        for node in self.get_nodes_by_op_type("Constant"):
            if node.output[0] == output_name:
                for att in node.attribute:
                    if att.name == "value":
                        return numpy_helper.to_array(att.t)

        # Fall back to intializer since constant folding might have been applied.
        initializer = self.get_initializer(output_name)
        if initializer is not None:
            return numpy_helper.to_array(initializer)

        return None

    def get_constant_input(self, node):
        for i, input in enumerate(node.input):
            value = self.get_constant_value(input)
            if value is not None:
                return i, value

        return None, None

    def find_constant_input(self, node, expected_value, delta=0.000001):
        i, value = self.get_constant_input(node)
        if value is not None and value.size == 1 and abs(value - expected_value) < delta:
            return i

        return -1

    def is_constant_with_specified_dimension(self, output_name, dimensions, description):
        value = self.get_constant_value(output_name)
        if value is None:
            logger.debug(f"{description} {output_name} is not initializer.")
            return False

        if len(value.shape) != dimensions:
            logger.debug(f"{description} {output_name} shall have {dimensions} dimensions. Got shape {value.shape}")
            return False

        return True

    def has_constant_input(self, node, expected_value, delta=0.000001):
        return self.find_constant_input(node, expected_value, delta) >= 0

    def get_children_subgraph_nodes(self, root_node, stop_nodes, input_name_to_nodes=None):
        if input_name_to_nodes is None:
            input_name_to_nodes = self.input_name_to_nodes()

        children = input_name_to_nodes[root_node.output[0]]

        unique_nodes = []

        dq = deque(children)
        while len(dq) > 0:
            current_node = dq.pop()
            if current_node in stop_nodes:
                continue

            if current_node not in unique_nodes:
                unique_nodes.append(current_node)

                for output in current_node.output:
                    if output in input_name_to_nodes:
                        children = input_name_to_nodes[output]
                        for child in children:
                            dq.appendleft(child)

        return unique_nodes

    def tensor_shape_to_list(self, tensor_type):
        """Convert tensor shape to list"""
        shape_list = []
        for d in tensor_type.shape.dim:
            if d.HasField("dim_value"):
                shape_list.append(d.dim_value)  # known dimension
            elif d.HasField("dim_param"):
                shape_list.append(d.dim_param)  # unknown dimension with symbolic name
            else:
                shape_list.append("?")  # shall not happen
        return shape_list

    def get_dtype(self, name: str, symbolic_shape_helper: SymbolicShapeInferenceHelper | None = None):
        """Try get data type given a name (could be initializer, input or output of graph or node)."""

        if self._dtype_dict is None:
            self._dtype_dict = {}
            for value_info in itertools.chain(
                self.model.graph.value_info,
                self.model.graph.input,
                self.model.graph.output,
            ):
                self._dtype_dict[value_info.name] = value_info.type.tensor_type.elem_type

            for initializer in self.model.graph.initializer:
                if initializer.name not in self._dtype_dict:
                    self._dtype_dict[initializer.name] = initializer.data_type

        if name in self._dtype_dict:
            return self._dtype_dict[name]

        if symbolic_shape_helper is not None and name in symbolic_shape_helper.known_vi_:
            value_info = symbolic_shape_helper.known_vi_[name]
            return value_info.type.tensor_type.elem_type

        return None

    def get_shape(self, name: str, symbolic_shape_helper: SymbolicShapeInferenceHelper | None = None):
        """Try get shape given a name (could be initializer, input or output of graph or node)."""

        if self._shape_dict is None:
            self._shape_dict = {}
            for value_info in itertools.chain(
                self.model.graph.value_info,
                self.model.graph.input,
                self.model.graph.output,
            ):
                if value_info.type.tensor_type.HasField("shape"):
                    shape = []
                    for dim in value_info.type.tensor_type.shape.dim:
                        if dim.dim_param:
                            shape.append(dim.dim_param)
                        else:
                            shape.append(dim.dim_value)
                    self._shape_dict[value_info.name] = shape

            for initializer in self.model.graph.initializer:
                if initializer.name not in self._shape_dict:
                    self._shape_dict[initializer.name] = initializer.dims

        if name in self._shape_dict:
            return self._shape_dict[name]

        if symbolic_shape_helper is not None and name in symbolic_shape_helper.known_vi_:
            value_info = symbolic_shape_helper.known_vi_[name]
            return value_info.type.tensor_type.elem_type

        return None

    @staticmethod
    def get_node_attribute(node: NodeProto, attribute_name: str):
        for attr in node.attribute:
            if attr.name == attribute_name:
                value = helper.get_attribute_value(attr)
                return value
        return None

    def remove_cascaded_cast_nodes(self):
        """Remove Cast node that are followed by another Cast node like  --> Cast --> Cast -->
        Note that this shall be used carefully since it might introduce semantic change.
        For example, float -> int -> float could get different value than the original float value.
        So, it is recommended to used only in post-processing of mixed precision conversion.
        """
        output_name_to_node = self.output_name_to_node()
        removed_count = 0
        for node in self.nodes():
            if node.op_type == "Cast":
                parent = self.get_parent(node, 0, output_name_to_node=output_name_to_node)
                if parent and parent.op_type == "Cast":
                    node.input[0] = parent.input[0]
                    removed_count += 1

        if removed_count > 0:
            logger.info("Removed %d cascaded Cast nodes", removed_count)
            self.prune_graph()

    def remove_useless_cast_nodes(self):
        """Remove cast nodes that are not needed: input and output has same data type."""
        shape_infer = self.infer_runtime_shape(update=True)
        if self.enable_shape_infer and shape_infer is None:
            logger.warning("shape inference failed which might impact useless cast node detection.")

        nodes_to_remove = []
        for node in self.nodes():
            if node.op_type == "Cast":
                input_dtype = self.get_dtype(node.input[0], shape_infer)
                output_dtype = self.get_dtype(node.output[0], shape_infer)
                if input_dtype and input_dtype == output_dtype:
                    nodes_to_remove.append(node)

        if nodes_to_remove:
            graph_input_names = set(self.get_graphs_input_names())
            graph_output_names = set(self.get_graphs_output_names())
            for node in nodes_to_remove:
                if bool(set(node.output) & graph_output_names):
                    if (not bool(set(node.input) & graph_input_names)) and len(
                        self.input_name_to_nodes()[node.input[0]]
                    ) == 1:
                        self.replace_output_of_all_nodes(node.input[0], node.output[0])
                    else:
                        continue
                else:
                    self.replace_input_of_all_nodes(node.output[0], node.input[0])
                self.remove_node(node)

            logger.info(
                "Removed %d Cast nodes with output type same as input",
                len(nodes_to_remove),
            )

    def convert_model_float32_to_float16(self, cast_input_output=True):
        logger.warning(
            "The function convert_model_float32_to_float16 is deprecated. Use convert_float_to_float16 instead!"
        )
        self.convert_float_to_float16(use_symbolic_shape_infer=True, keep_io_types=cast_input_output)

    def convert_float_to_float16(self, use_symbolic_shape_infer=True, **kwargs):
        """Convert a model to half (default) or mixed precision.
           To use mixed precision, user need specify which graph inputs, outputs, operator type
           or list of nodes shall keep in float32.

           Note that the conversion might not proceed without type information for the whole graph.

           By default, we use symbolic shape inference to get type information. The benefit of symbolic shape inference
           is that it could handle fused operators in com.microsoft domain. Those operators cannot be handled in onnx shape
           inference so symbolic shape inference is recommended for optimized model.

           When symbolic shape inference is used (even if it failed), ONNX shape inference will be disabled.

           Note that onnx shape inference will fail for model larger than 2GB. For large model, you have to enable
           symbolic shape inference. If your model is not optimized, you can also use model path to call
           convert_float_to_float16 in float16.py (see https://github.com/microsoft/onnxruntime/pull/15067) to
           avoid the 2GB limit.

        Args:
            use_symbolic_shape_infer (bool, optional): use symbolic shape inference instead of onnx shape inference.
                                                       Defaults to True.
            keep_io_types (Union[bool, List[str]], optional): boolean or a list of float32 input/output names.
                                                              If True, model inputs/outputs should be left as float32.
                                                              Defaults to True.
            op_block_list (List[str], optional): List of operator types to leave as float32.
                                                 Defaults to None, which will use `float16.DEFAULT_OP_BLOCK_LIST`.
            node_block_list (List[str], optional): List of node names to leave as float32. Defaults to None.
            force_fp16_initializers(bool): force converting all float initializers to float16.
                                           Default to false.
            min_positive_val (float, optional): minimal positive value. Defaults to 1e-7.
            max_finite_val (float, optional): maximal finite value. Defaults to 1e4.
            force_fp16_inputs(Dict[str, List[int]]): Force the conversion of the inputs of some operators to float16, even if
                                                     this script's preference it to keep them in float32.
        """
        if "keep_io_types" not in kwargs:
            kwargs["keep_io_types"] = True

        model = self.model
        if use_symbolic_shape_infer:
            # Use symbolic shape inference since custom operators (like Gelu, SkipLayerNormalization etc)
            # are not recognized by onnx shape inference.
            shape_infer_helper = SymbolicShapeInferenceHelper(model)
            try:
                model_with_shape = shape_infer_helper.infer_shapes(model, auto_merge=True, guess_output_rank=False)

                # auto_merge might cause issue (see https://github.com/microsoft/onnxruntime/issues/15521)
                # we only merge tensor data type but not shape information back to the original onnx model.
                # Note that float16 conversion need data type but not shape information.
                if model_with_shape is not None:
                    name_vi = {}
                    for vi in model_with_shape.graph.value_info:
                        if (
                            hasattr(vi.type, "tensor_type")
                            and hasattr(vi.type.tensor_type, "elem_type")
                            and vi.type.tensor_type.elem_type != TensorProto.UNDEFINED
                            and vi.name
                        ):
                            vi_copy = ValueInfoProto()
                            vi_copy.CopyFrom(vi)
                            if hasattr(vi_copy.type.tensor_type, "shape"):
                                vi_copy.type.tensor_type.ClearField("shape")
                            name_vi[vi.name] = vi_copy
                    for vi in model.graph.value_info:
                        if vi.name in name_vi:
                            del name_vi[vi.name]
                    for vi in name_vi.values():
                        model.graph.value_info.append(vi)
            except Exception:
                logger.warning(
                    "Failed to run symbolic shape inference. Please file an issue in https://github.com/microsoft/onnxruntime."
                )

        parameters = {"disable_shape_infer": use_symbolic_shape_infer}
        parameters.update(
            {
                key: kwargs[key]
                for key in [
                    "keep_io_types",
                    "min_positive_val",
                    "max_finite_val",
                    "op_block_list",
                    "node_block_list",
                    "force_fp16_initializers",
                    "force_fp16_inputs",
                    "use_bfloat16_as_blocked_nodes_dtype",
                ]
                if key in kwargs
            }
        )

        fp16_model = convert_float_to_float16(model, **parameters)
        self.initialize(fp16_model)

        self.remove_cascaded_cast_nodes()

        self.remove_useless_cast_nodes()

    def create_node_name(self, op_type, name_prefix=None):
        """Create a unique node name that starts with a prefix (default is operator type).
           The name will not be duplicated with any name that generated or existed in current graphs.
        Args:
            op_type (str): operator type
            name_prefix (str, optional): prefix of node name. Defaults to None.

        Returns:
            str: node name
        """

        if name_prefix:
            prefix = name_prefix if name_prefix.endswith("_") else (name_prefix + "_")
        else:
            prefix = op_type + "_"

        suffix: int = 0
        if prefix in self._node_name_suffix:
            suffix = self._node_name_suffix[prefix] + 1
        else:
            # Check existed node name only once for a prefix
            # as we assume create_node_name is called for every new node in fusion.
            for node in self.nodes():
                if node.name and node.name.startswith(prefix):
                    try:
                        index = int(node.name[len(prefix) :])
                        suffix = max(index + 1, suffix)
                    except ValueError:
                        continue

        # Record the generated suffix so that we can avoid generating duplicated name.
        self._node_name_suffix[prefix] = suffix

        return prefix + str(suffix)

    def find_graph_input(self, input_name):
        for input in self.model.graph.input:
            if input.name == input_name:
                return input
        return None

    def find_graph_output(self, output_name):
        for output in self.model.graph.output:
            if output.name == output_name:
                return output
        return None

    def get_parent_subgraph_nodes(self, node, stop_nodes, output_name_to_node=None):
        if output_name_to_node is None:
            output_name_to_node = self.output_name_to_node()

        unique_nodes = []

        parents = self.get_parents(node, output_name_to_node)
        dq = deque(parents)
        while len(dq) > 0:
            current_node = dq.pop()
            if current_node in stop_nodes:
                continue

            if current_node not in unique_nodes:
                unique_nodes.append(current_node)

                for input in current_node.input:
                    if input in output_name_to_node:
                        dq.appendleft(output_name_to_node[input])

        return unique_nodes

    def get_graph_inputs(self, current_node, recursive=False):
        """
        Find graph inputs that linked to current node.
        """
        graph_inputs = []
        for input in current_node.input:
            if self.find_graph_input(input) and input not in graph_inputs:
                graph_inputs.append(input)

        if recursive:
            parent_nodes = self.get_parent_subgraph_nodes(current_node, [])
            for node in parent_nodes:
                for input in node.input:
                    if self.find_graph_input(input) and input not in graph_inputs:
                        graph_inputs.append(input)
        return graph_inputs

    @staticmethod
    def input_index(node_output, child_node):
        for index, input in enumerate(child_node.input):
            if input == node_output:
                return index
        return -1

    def remove_unused_constant(self):
        input_name_to_nodes = self.input_name_to_nodes()

        # remove unused constant
        unused_nodes = []
        nodes = self.nodes()
        for node in nodes:
            if node.op_type == "Constant" and node.output[0] not in input_name_to_nodes:
                unused_nodes.append(node)

        self.remove_nodes(unused_nodes)

        if len(unused_nodes) > 0:
            logger.debug(f"Removed unused constant nodes: {len(unused_nodes)}")

    def _get_subgraph_inputs_of_node(self, node):
        """
        Get inputs to all nodes in all subgraphs of a node
        """
        # Note: This function only handles one-level subgraphs of child nodes.
        subgraph_nodes_inputs = set()
        for attr in node.attribute:
            if attr.type == AttributeProto.GRAPH:
                child_nodes = attr.g.node
                for child_node in child_nodes:
                    subgraph_nodes_inputs.update(child_node.input)
        return subgraph_nodes_inputs

    def _get_subgraph_nodes_and_inputs(self, ops_with_graph_attrs):
        """
        Get input names to all nodes in all subgraphs where subgraphs are
        graph attributes of a node in the main graph
        """
        subgraph_nodes = list(filter(lambda node: node.op_type in ops_with_graph_attrs, self.model.graph.node))
        subgraph_nodes_inputs = set()
        for parent_node in subgraph_nodes:
            subgraph_inputs_of_parent_node = self._get_subgraph_inputs_of_node(parent_node)
            subgraph_nodes_inputs.update(subgraph_inputs_of_parent_node)
        return subgraph_nodes, subgraph_nodes_inputs

    def prune_graph(self, outputs=None, allow_remove_graph_inputs=True):
        """
        Prune graph to keep only required outputs. It removes unnecessary nodes that are not linked
        (directly or indirectly) to any required output.

        There is also an option to remove graph inputs that are not used to generate any required output.

        Args:
            outputs (list): a list of graph outputs to retain. If it is None, all graph outputs will be kept.
            allow_remove_graph_inputs (bool): allow remove graph inputs.
        """

        keep_outputs = [output.name for output in self.model.graph.output] if outputs is None else outputs

        input_name_to_nodes_for_main_graph = self.input_name_to_nodes(exclude_subgraphs=True)
        output_name_to_node = self.output_name_to_node()

        def get_first_output(node):
            if node.output[0]:
                return node.output[0]
            return next(iter([o for o in node.output if o]), None)

        if len(self.graphs()) > 1:
            # Get input names for all nodes in all subgraphs
            subgraph_nodes, subgraph_nodes_inputs = self._get_subgraph_nodes_and_inputs(
                ops_with_graph_attrs={"Loop", "Scan", "If"}
            )
            if len(subgraph_nodes) == 0:
                # TODO: support other ops such as `BeamSearch` that have subgraphs as op attributes
                logger.debug("Skip prune_graph since graph has subgraph")
                return

            # For graphs with subgraphs, add dangling outputs from parent graph nodes to list of outputs to keep
            for node in self.model.graph.node:
                # TODO: This for-loop logic currently assumes that Loop/Scan/If nodes will not be
                # pruned because their subgraphs are needed for computations. This might not be
                # true in all cases.
                if node in subgraph_nodes:
                    continue

                # Check if node output is an input of a subgraph node and not an input to a node in the main graph
                for output in node.output:
                    if output in subgraph_nodes_inputs and output not in input_name_to_nodes_for_main_graph:
                        keep_outputs += [output]

        # Keep track of nodes to keep. The key is first output of node, and the value is the node.
        output_to_node = {}

        # Start from graph outputs, and find parent nodes recursively, and add nodes to the output_to_node dictionary.
        dq = deque()
        for output in keep_outputs:
            if output in output_name_to_node:
                dq.append(output_name_to_node[output])
        while len(dq) > 0:
            node = dq.pop()
            first_output = get_first_output(node)
            if first_output and (first_output not in output_to_node):
                output_to_node[first_output] = node
                for name in node.input:
                    if len(name) > 0 and (name in output_name_to_node) and (name not in output_to_node):
                        dq.appendleft(output_name_to_node[name])

        # Keep only those nodes in the output_to_node dictionary.
        nodes_to_keep = []
        num_nodes_removed = 0
        for node in self.model.graph.node:
            first_output = get_first_output(node)
            kept_node = output_to_node.get(first_output)

            # Need to double check the node since fused node might reuse output name of some nodes to be removed.
            # It is slow to compare whole node, so we compare op_type first to avoid comparing node in most cases.
            if kept_node and kept_node.op_type == node.op_type and kept_node == node:
                nodes_to_keep.append(node)
            else:
                num_nodes_removed += 1

        self.all_graphs = (
            None  # to prevent pass-by-copy after ClearField(), forces the use of pass-by-reference instead
        )
        self.model.graph.ClearField("node")
        self.model.graph.node.extend(nodes_to_keep)

        # Remove graph outputs not in list
        output_to_remove = []
        if outputs is not None:
            for output in self.model.graph.output:
                if output.name not in outputs:
                    output_to_remove.append(output)
            for output in output_to_remove:
                self.model.graph.output.remove(output)

        # Remove graph inputs not used by any node.
        input_to_remove = []
        if allow_remove_graph_inputs:
            input_name_to_nodes = self.input_name_to_nodes()
            input_to_remove = [input for input in self.model.graph.input if input.name not in input_name_to_nodes]
            for name in input_to_remove:
                self.model.graph.input.remove(name)

        if input_to_remove or output_to_remove or num_nodes_removed > 0:
            removed = []
            if input_to_remove:
                removed.append(f"{len(input_to_remove)} inputs")
            if output_to_remove:
                removed.append(f"{len(output_to_remove)} outputs")
            if num_nodes_removed > 0:
                removed.append(f"{num_nodes_removed} nodes")
            logger.info("Removed %s", ", ".join(removed))

        self.update_graph()

    def update_graph(self, verbose=False, allow_remove_graph_inputs=False):
        graph = self.model.graph

        remaining_input_names = set()
        for node in graph.node:
            if node.op_type in ["Loop", "Scan", "If"]:
                # Add input names of nodes in subgraphs
                subgraph_inputs_of_node = self._get_subgraph_inputs_of_node(node)
                remaining_input_names.update(subgraph_inputs_of_node)

            if node.op_type != "Constant":
                remaining_input_names.update(node.input)
        if verbose:
            logger.debug(f"remaining input names: {remaining_input_names}")

        # remove graph input that is not used
        inputs_to_remove = []
        if allow_remove_graph_inputs:
            for input in graph.input:
                if input.name not in remaining_input_names:
                    inputs_to_remove.append(input)
            for input in inputs_to_remove:
                graph.input.remove(input)

        names_to_remove = [input.name for input in inputs_to_remove]
        logger.debug(f"remove {len(inputs_to_remove)} unused inputs: {names_to_remove}")

        # remove weights that are not used
        weights_to_remove = []
        weights_to_keep = []
        for initializer in graph.initializer:
            if initializer.name not in remaining_input_names and not self.find_graph_output(initializer.name):
                weights_to_remove.append(initializer)
            else:
                weights_to_keep.append(initializer.name)
        for initializer in weights_to_remove:
            graph.initializer.remove(initializer)

        names_to_remove = [initializer.name for initializer in weights_to_remove]
        logger.debug(f"remove {len(weights_to_remove)} unused initializers: {names_to_remove}")
        if verbose:
            logger.debug(f"remaining initializers:{weights_to_keep}")

        self.remove_unused_constant()

    def is_safe_to_fuse_nodes(self, nodes_to_remove, keep_outputs, input_name_to_nodes, output_name_to_node):
        for node_to_remove in nodes_to_remove:
            for output_to_remove in node_to_remove.output:
                if output_to_remove in keep_outputs:
                    continue

                if output_to_remove in input_name_to_nodes:
                    for impacted_node in input_name_to_nodes[output_to_remove]:
                        if impacted_node not in nodes_to_remove:
                            logger.debug(
                                "it is not safe to remove nodes since output %s is used by %s",
                                output_to_remove,
                                impacted_node,
                            )
                            return False
        return True

    @staticmethod
    def graph_topological_sort(graph, is_deterministic=False):
        deps_set = set()  # dependency set of all node
        sorted_node_set = set()  # sorted node set
        sorted_nodes = []  # initialize sorted_nodes

        initializer_names = [init.name for init in graph.initializer]
        graph_input_names = [input.name for input in graph.input]
        input_names = initializer_names + graph_input_names

        if is_deterministic:
            input_names.sort()

        for input_name in input_names:
            deps_set.add(input_name)

        sorted_node_set_len = -1
        graph_nodes = graph.node if not is_deterministic else sorted(graph.node, key=lambda x: x.name)

        last_node_name = None
        while len(sorted_node_set) != len(graph_nodes):
            if len(sorted_node_set) == sorted_node_set_len:
                break
            sorted_node_set_len = len(sorted_node_set)
            for node_idx, node in enumerate(graph_nodes):
                if node_idx in sorted_node_set:
                    continue
                input_count = sum(1 for _ in node.input if _)
                if input_count == 0:
                    sorted_nodes.append(node)
                    sorted_node_set.add(node_idx)
                    for output in node.output:
                        if output:
                            deps_set.add(output)
                    continue
                failed = False
                for input_name in node.input:
                    if input_name and input_name not in deps_set:
                        failed = True
                        last_node_name = node.name
                if not failed:
                    sorted_nodes.append(node)
                    sorted_node_set.add(node_idx)
                    for output in node.output:
                        if output:
                            deps_set.add(output)
                else:
                    continue

        if len(sorted_node_set) != len(graph.node):
            raise RuntimeError(
                f"Graph is not a DAG: len(sorted_node_set)={len(sorted_node_set)}, len(graph.node)={len(graph.node)}, failed at node {last_node_name}"
            )

        graph.ClearField("node")
        graph.node.extend(sorted_nodes)

    def topological_sort(self, is_deterministic=False, dump_model_on_failure=False):
        # TODO: support graph_topological_sort() in subgraphs
        # for graph in self.graphs():
        #    self.graph_topological_sort(graph)
        try:
            OnnxModel.graph_topological_sort(self.model.graph, is_deterministic)
        except RuntimeError as e:
            if dump_model_on_failure:
                logger.info(
                    "Failed to sort graph in topological order. Dumping model to _topo_sort_failed.onnx for debugging."
                )
                OnnxModel.save(
                    self.model, "_topo_sort_failed.onnx", save_as_external_data=True, all_tensors_to_one_file=True
                )
            raise e

    @staticmethod
    def save(
        model,
        output_path,
        save_as_external_data=False,
        all_tensors_to_one_file=True,
        size_threshold=1024,
        convert_attribute=False,
    ):
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)

        # Add ms domain if needed
        ms_opset = [opset for opset in model.opset_import if opset.domain == "com.microsoft"]
        # Check whether there is custom op in top level graph (our fusion is on top level right now).
        # May need to extend to subgraph if our fusion are extended to subgraphs.
        ms_node = [node for node in model.graph.node if node.domain == "com.microsoft"]
        if ms_node and not ms_opset:
            opset = model.opset_import.add()
            opset.version = 1
            opset.domain = "com.microsoft"

        if save_as_external_data:
            # Save model to external data, which is needed for model size > 2GB
            output_dir = Path(output_path).parent
            output_dir.mkdir(parents=True, exist_ok=True)
            external_data_path = output_path + ".data"
            location = Path(external_data_path).name if all_tensors_to_one_file else None

            if os.path.exists(output_path):
                logger.info(f"Delete the existing onnx file: {output_path}")
                os.remove(output_path)

            if all_tensors_to_one_file:
                if os.path.exists(external_data_path):
                    # Delete the external data file. Otherwise, data will be appended to existing file.
                    logger.info(f"Delete the existing external data file: {external_data_path}")
                    os.remove(external_data_path)
            else:
                if os.listdir(output_dir):
                    raise RuntimeError(f"Output directory ({output_dir}) for external data is not empty.")

            save_model(
                model,
                output_path,
                save_as_external_data=True,
                all_tensors_to_one_file=all_tensors_to_one_file,
                location=location,
                size_threshold=size_threshold,
                convert_attribute=convert_attribute,
            )
        else:
            save_model(model, output_path)

    def save_model_to_file(
        self,
        output_path,
        use_external_data_format=False,
        all_tensors_to_one_file=True,
        size_threshold=1024,
        convert_attribute=False,
    ):
        logger.info("Sort graphs in topological order")
        self.topological_sort()

        # Note: After the model is saved to another directory with external data,
        #       You need reload the onnx model if you want to read tensor from self.model object.
        #       It is because the base directory is not updated for self.model object so attempt to read tensor data
        #       might encounter error since external data cannot be located.
        OnnxModel.save(
            self.model,
            output_path,
            use_external_data_format,
            all_tensors_to_one_file,
            size_threshold,
            convert_attribute,
        )
        logger.info(f"Model saved to {output_path}")

    def get_graph_inputs_excluding_initializers(self):
        """
        Returns real graph inputs (excluding initializers from older onnx model).
        """
        graph_inputs = []
        for input in self.model.graph.input:
            if self.get_initializer(input.name) is None:
                graph_inputs.append(input)
        return graph_inputs

    def get_opset_version(self):
        """Get opset version of onnx domain

        Raises:
            RuntimeError: ONNX model has no opset for default domain.

        Returns:
            int: opset version of onnx domain.
        """
        for opset in self.model.opset_import:
            if opset.domain in ["", "ai.onnx"]:
                return opset.version
        raise RuntimeError("ONNX model has no opset for default domain")

    def get_operator_statistics(self, include_domain=False):
        """
        Returns node count of operators.
        """
        op_count = {}
        for node in self.nodes():
            op = (node.domain + ":" if include_domain and node.domain else "") + node.op_type
            op_count[op] = 1 if op not in op_count else (op_count[op] + 1)

        # Sorted by count in the descending order, then by key in alphabetical order.
        logger.info(f"Operators:{sorted(op_count.items(), key=lambda kv: (-kv[1], kv[0]))}")

        return op_count

    @staticmethod
    def to_data_hash(tensor: TensorProto, base_dir: str = "") -> int:
        """Converts a tensor def object to a hash for data comparison purposes.
        Args:
            tensor: a TensorProto object.
            base_dir: if external tensor exists, base_dir can help to find the path to it
        Returns:
            hash: a hash of the data.
        """
        if tensor.HasField("segment"):
            raise ValueError("Currently not supporting loading segments.")
        if tensor.data_type == TensorProto.UNDEFINED:
            raise TypeError("The element type in the input tensor is not defined.")
        tensor_dtype = tensor.data_type
        storage_field = helper.tensor_dtype_to_field(tensor_dtype)

        if tensor.data_type == TensorProto.STRING:
            utf8_strings = getattr(tensor, storage_field)
            return hash(tuple(s.decode("utf-8") for s in utf8_strings))
        # Load raw data from external tensor if it exists
        if uses_external_data(tensor):
            load_external_data_for_tensor(tensor, base_dir)
        if tensor.HasField("raw_data"):
            return hash(tensor.raw_data)
        else:
            np_data = numpy_helper.to_array(tensor)
            return hash(np_data.tobytes())

    @staticmethod
    def has_same_value(
        tensor1: TensorProto,
        tensor2: TensorProto,
        signature_cache1: dict | None = None,
        signature_cache2: dict | None = None,
        rtol: float = 1e-05,
        atol: float = 1e-08,
    ) -> bool:
        """Returns True when two tensors have same value.
           Note that name can be different.

        Args:
            tensor1 (TensorProto): initializer 1
            tensor2 (TensorProto): initializer 2
            signature_cache1 (dict): Optional dictionary to store data signatures of tensor1 in order to speed up comparison.
            signature_cache2 (dict): Optional dictionary to store data signatures of tensor2 in order to speed up comparison.
            rtol (float): Optional relative difference threshold for minor precision differences
            atol (float): Optional absolute difference threshold for minor precision differences
        Returns:
            bool: True when two initializers has same value.
        """
        sig1 = (
            signature_cache1[tensor1.name]
            if signature_cache1 and tensor1.name in signature_cache1
            else OnnxModel.to_data_hash(tensor1)
        )
        sig2 = (
            signature_cache2[tensor2.name]
            if signature_cache2 and tensor2.name in signature_cache2
            else OnnxModel.to_data_hash(tensor2)
        )
        if signature_cache1 is not None:
            signature_cache1[tensor1.name] = sig1
        if signature_cache2 is not None:
            signature_cache2[tensor2.name] = sig2
        if tensor1.data_type == tensor2.data_type and tensor1.dims == tensor2.dims:
            n1 = numpy_helper.to_array(tensor1)
            n2 = numpy_helper.to_array(tensor2)
            if sig1 == sig2:
                # Same signature, now do the expensive check to confirm the data is the same
                return (n1 == n2).all()
            else:
                # Check if tensors are allclose
                from numpy import allclose  # noqa: PLC0415

                return allclose(n1, n2, rtol=rtol, atol=atol)

        return False

    def remove_initializer(self, tensor):
        for graph in self.graphs():
            if tensor in graph.initializer:
                graph.initializer.remove(tensor)
                return
        logger.warning("Failed to remove initializer %s", tensor)  # It might be a bug to hit this line.

    def remove_duplicated_initializer(self, cache: dict | None):
        """Remove initializers with duplicated values, and only keep the first one.
        It could help reduce size of models (like ALBert) with shared weights.
        If require_raw_data passed, method will only compare raw_data initializers to speed runtime
        Note: this function does not process subgraph.
        """
        if len(self.graphs()) > 1:
            logger.warning("remove_duplicated_initializer does not process subgraphs.")

        initializer_count = len(self.model.graph.initializer)

        same = [-1] * initializer_count
        for i in range(initializer_count - 1):
            if same[i] >= 0:
                continue
            for j in range(i + 1, initializer_count):
                if OnnxModel.has_same_value(
                    self.model.graph.initializer[i],
                    self.model.graph.initializer[j],
                    cache,
                    cache,
                ):
                    same[j] = i

        count = 0
        for i in range(initializer_count):
            if same[i] >= 0:
                count += 1
                self.replace_input_of_all_nodes(
                    self.model.graph.initializer[i].name,
                    self.model.graph.initializer[same[i]].name,
                )

        if count > 0:
            self.update_graph()
            print(f"Removed {count} initializers with duplicated value")

    def add_prefix_to_names(self, prefix: str):
        """Add prefix to initializer or intermediate outputs in graph. Main graph inputs and outputs are excluded.
        It could help avoid conflicting in name of node_args when merging two graphs.
        Note: this function does not process subgraph.
        """
        if len(self.graphs()) > 1:
            logger.warning("add_prefix_to_names does not process subgraphs.")

        # Exclude the names of inputs and outputs of main graph (but not subgraphs)
        # and empty names ("") as they have special meaning to denote missing optional inputs
        excluded = [i.name for i in self.model.graph.input] + [o.name for o in self.model.graph.output] + [""]

        for initializer in self.model.graph.initializer:
            if initializer.name not in excluded:
                if prefix + initializer.name not in excluded:
                    initializer.name = prefix + initializer.name

        for node in self.model.graph.node:
            # update name of node inputs
            for j in range(len(node.input)):
                if node.input[j] not in excluded:
                    if prefix + node.input[j] not in excluded:
                        node.input[j] = prefix + node.input[j]

            # update name of node outputs
            for j in range(len(node.output)):
                if node.output[j] not in excluded:
                    if prefix + node.output[j] not in excluded:
                        node.output[j] = prefix + node.output[j]

        for value_info in self.model.graph.value_info:
            if value_info.name not in excluded:
                value_info.name = prefix + value_info.name

    def clean_shape_infer(self):
        self.model.graph.ClearField("value_info")

    def use_float16(self):
        """Check whether the model uses float16"""
        queue = []  # queue for BFS
        queue.append(self.model.graph)
        while queue:
            sub_graphs = []
            for graph in queue:
                if not isinstance(graph, GraphProto):
                    continue

                for v in itertools.chain(graph.input, graph.output, graph.value_info):
                    if v.type.tensor_type.elem_type == TensorProto.FLOAT16:
                        return True
                    if v.type.HasField("sequence_type"):
                        if v.type.sequence_type.elem_type.tensor_type.elem_type == TensorProto.FLOAT16:
                            return True

                for t in graph.initializer:
                    if t.data_type == TensorProto.FLOAT16:
                        return True

                for node in graph.node:
                    if node.op_type == "Cast":
                        for attr in node.attribute:
                            if attr.name == "to" and attr.i == TensorProto.FLOAT16:
                                return True

                    for attr in node.attribute:
                        if attr.type == AttributeProto.GRAPH:
                            sub_graphs.append(attr.g)

                        for g in attr.graphs:
                            sub_graphs.append(g)  # noqa: PERF402

                        if isinstance(attr.t, TensorProto) and attr.t.data_type == TensorProto.FLOAT16:
                            return True

                        for t in attr.tensors:
                            if isinstance(t, TensorProto) and t.data_type == TensorProto.FLOAT16:
                                return True

            queue = sub_graphs

        return False

    def change_graph_input_type(
        self,
        graph_input: ValueInfoProto,
        new_type: int,
    ):
        """Change graph input type, and add Cast node if needed.

        Args:
            graph_input (ValueInfoProto): input of the graph
            new_type (int): new data type like TensorProto.INT32.

        Returns:
            NodeProto: a new Cast node that added. None if Cast node is not added.
            List[NodeProto]: Cast nodes that have been removed.
        """
        assert isinstance(graph_input, ValueInfoProto)
        assert self.find_graph_input(graph_input.name)

        if graph_input.type.tensor_type.elem_type == int(new_type):
            return None, []

        graph = self.graph()
        new_cast_node = None
        nodes_to_remove = []

        input_name_to_nodes = self.input_name_to_nodes()
        if graph_input.name in input_name_to_nodes:
            nodes = input_name_to_nodes[graph_input.name]

            # For children that is not Cast node, insert a Cast node to convert int32 to original data type.
            nodes_not_cast = [node for node in nodes if node.op_type != "Cast"]
            if nodes_not_cast:
                node_name = self.create_node_name("Cast")
                output_name = node_name + "_" + graph_input.name
                new_value_info = graph.value_info.add()
                new_value_info.CopyFrom(graph_input)
                new_value_info.name = output_name
                new_cast_node = helper.make_node(
                    "Cast",
                    [graph_input.name],
                    [output_name],
                    to=int(graph_input.type.tensor_type.elem_type),
                    name=node_name,
                )
                graph.node.extend([new_cast_node])

                for node in nodes_not_cast:
                    OnnxModel.replace_node_input(node, graph_input.name, output_name)

            # For children that is Cast node, no need to insert Cast.
            # When the children is Cast to int32, we can remove that Cast node since input type is int32 now.
            nodes_cast = [node for node in nodes if node.op_type == "Cast"]
            for node in nodes_cast:
                if OnnxModel.get_node_attribute(node, "to") == int(new_type):
                    self.replace_input_of_all_nodes(node.output[0], graph_input.name)
                if not self.find_graph_output(node.output[0]):
                    nodes_to_remove.append(node)
            if nodes_to_remove:
                self.remove_nodes(nodes_to_remove)

        graph_input.type.tensor_type.elem_type = int(new_type)
        return new_cast_node, nodes_to_remove

    def change_graph_output_type(
        self,
        graph_output: ValueInfoProto,
        new_type: int,
    ):
        """Change graph input type, and add Cast node if needed.

        Args:
            graph_input (str | ValueInfoProto): output of the graph
            new_type (int): new data type.

        Returns:
            NodeProto: a new Cast node that added. None if Cast node is not added.
        """
        assert isinstance(graph_output, ValueInfoProto)
        assert self.find_graph_output(graph_output.name)

        if graph_output.type.tensor_type.elem_type == int(new_type):
            return None

        cast_node = None
        graph = self.graph()

        # Add a cast node
        node_name = self.create_node_name("Cast")
        input_name = node_name + "_" + graph_output.name
        self.replace_input_of_all_nodes(graph_output.name, input_name)
        new_value_info = graph.value_info.add()
        new_value_info.CopyFrom(graph_output)
        new_value_info.name = input_name
        cast_node = helper.make_node(
            "Cast",
            [input_name],
            [graph_output.name],
            to=int(new_type),
            name=node_name,
        )
        graph.node.extend([cast_node])
        graph_output.type.tensor_type.elem_type = int(new_type)
        return cast_node

    def rename_graph_output(self, old_name: str, new_name: str):
        if new_name in self.output_name_to_node():
            raise RuntimeError("{new_name} exists in graph")

        graph = self.graph()
        for output in graph.output:
            if output.name == old_name:
                logger.debug("replace output name from %s to %s", old_name, new_name)
                self.replace_input_of_all_nodes(old_name, new_name)
                self.replace_output_of_all_nodes(old_name, new_name)
                output.name = new_name
