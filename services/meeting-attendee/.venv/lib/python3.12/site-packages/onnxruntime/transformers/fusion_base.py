# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
from collections import defaultdict
from collections.abc import Sequence
from logging import getLogger
from typing import Any

import numpy as np
from onnx import NodeProto, TensorProto, helper
from onnx_model import OnnxModel

logger = getLogger(__name__)


class Fusion:
    """
    Base class for Graph Fusion
    """

    def __init__(
        self,
        model: OnnxModel,
        fused_op_type: str,
        search_op_types: str | list[str],
        description: str = "",
    ):
        self.search_op_types: list[str] = [search_op_types] if isinstance(search_op_types, str) else search_op_types
        self.fused_op_type: str = fused_op_type
        self.description: str = f"{fused_op_type}({description})" if description else fused_op_type
        self.model: OnnxModel = model
        self.nodes_to_remove: list = []
        self.nodes_to_add: list = []
        self.prune_graph: bool = False
        self.node_name_to_graph_name: dict = {}
        self.this_graph_name: str | None = None
        # It is optional that subclass updates fused_count since we will also check nodes_to_add to get counter.
        self.fused_count: defaultdict = defaultdict(int)

    def increase_counter(self, fused_op_name: str):
        """
        Increase counter of a fused operator.
        """
        self.fused_count[fused_op_name] += 1

    def fuse(
        self,
        node: NodeProto,
        input_name_to_nodes: dict[str, list[NodeProto]],
        output_name_to_node: dict[str, NodeProto],
    ):
        """Interface for fusion that starts from a node"""
        raise NotImplementedError

    def apply(self):
        """
        Apply graph fusion on the whole model graph.
        It searched nodes of given operators, and start fusion on each of those nodes.
        """
        logger.debug(f"start {self.description} fusion...")
        input_name_to_nodes = self.model.input_name_to_nodes()
        output_name_to_node = self.model.output_name_to_node()

        # This assumes that two search ops will not be fused at same time!
        for search_op_type in self.search_op_types:
            for node in self.model.get_nodes_by_op_type(search_op_type):
                graph = self.model.get_graph_by_node(node)
                if graph is None:
                    raise Exception("Can not find node in any graph")
                self.this_graph_name = graph.name
                self.fuse(node, input_name_to_nodes, output_name_to_node)

        op_list = [node.op_type for node in self.nodes_to_add]
        if self.fused_count:
            for key, value in self.fused_count.items():
                if value:
                    logger.info(f"Fused {key}: {value}")
        else:
            count = op_list.count(self.fused_op_type)
            if count > 0:
                logger.info(f"Fused {self.description}: {count}")

        self.model.remove_nodes(self.nodes_to_remove)
        self.model.add_nodes(self.nodes_to_add, self.node_name_to_graph_name)

        if self.prune_graph:
            self.model.prune_graph()
        elif self.nodes_to_remove or self.nodes_to_add:
            self.model.update_graph()

    def add_initializer(self, name: str, data_type: int, dims: Sequence[int], vals: Any, raw: bool = True):
        if raw:
            if not isinstance(vals, np.ndarray):
                np_type = helper.tensor_dtype_to_np_dtype(data_type)
                bytes = np.array(vals, dtype=np_type).tobytes()
            else:
                bytes = vals.tobytes()
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

        self.model.add_initializer(tensor, self.this_graph_name)
        return tensor

    def remove_initializer(self, tensor: TensorProto):
        self.model.remove_initializer(tensor)

    def add_nodes_to_remove(self, nodes: list[NodeProto]):
        # Some nodes are shared between paths (e.g. rotary embedding nodes in the Q and K paths).
        # When path A is fused, its shared nodes are added to `self.nodes_to_remove`. But when path B
        # is fused, its shared nodes are also added to `self.nodes_to_remove`. When the nodes are
        # iteratively removed from `self.nodes_to_remove`, path A's shared nodes are removed first.
        # Since path A's shared nodes are removed, path B's shared nodes are not removed because they
        # were previously removed for path A. This causes an error to print in remove_node that a node
        # has failed to be removed.
        #
        # To avoid this error, we pre-emptively check if the shared nodes are already in `self.nodes_to_remove`.
        # We could alternatively convert `self.nodes_to_remove` to a set to avoid this issue, but there could
        # be scenarios where the nodes need to be removed in a specific order and converting to a set would
        # lose this order.
        for node in nodes:
            if node not in self.nodes_to_remove:
                self.nodes_to_remove.append(node)

    def add_nodes_to_remove_with_nodes_to_keep(self, nodes: list[NodeProto], nodes_to_keep: list[NodeProto]):
        for node in nodes:
            if node not in self.nodes_to_remove and node not in nodes_to_keep:
                self.nodes_to_remove.append(node)
