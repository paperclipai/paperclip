# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import argparse
import logging
import os
import pathlib
import tempfile
from collections import deque
from enum import IntEnum

import onnx

from ..onnx_model_utils import ModelProtoWithShapeInfo, get_producer_consumer_maps, is_fixed_size_tensor, optimize_model


class _SupportedOpsChecker:
    """
    Class to process the md file with list of supported ops and caveats for an execution provider.
    e.g. /tools/ci_build/github/android/nnapi_supported_ops.md
         /tools/ci_build/github/apple/coreml_supported_mlprogram_ops.md
         /tools/ci_build/github/apple/coreml_supported_neuralnetwork_ops.md
    """

    def __init__(self, filename):
        self._filename = filename
        self._ops = {}  # op to caveats
        self._ops_seen = set()

        with open(filename) as f:
            for line in f:
                # we're looking for a markdown table with 2 columns. first is op name. second is caveats
                # op name is domain:op
                if line.startswith("|"):
                    pieces = line.strip().split("|")
                    if len(pieces) == 4:  # pre-first '|'. op, caveat, post-last '|'
                        domain_op = pieces[1]
                        caveat = pieces[2]
                        caveat = caveat.replace("<br/>", " ")  # remove some HTML tags
                        # skip lines that don't have the ':' which separates the domain and op
                        # e.g. the table header will fail this check
                        if ":" in domain_op:
                            self._ops[domain_op] = caveat

    def is_op_supported(self, node):
        domain = node.domain if node.domain else "ai.onnx"
        domain_op = domain + ":" + node.op_type

        is_supported = domain_op in self._ops
        if is_supported:
            self._ops_seen.add(domain_op)

        return is_supported

    def get_caveats(self):
        caveats = []
        for op in sorted(self._ops_seen):
            caveat = self._ops[op]
            if caveat:
                caveats.append(f"{op}:{caveat}")

        return caveats


class PartitioningInfo:
    class TryWithEP(IntEnum):
        NO = (0,)
        MAYBE = (1,)
        YES = 2

    def __init__(
        self,
        num_nodes: int,
        num_supported_nodes: int,
        num_partitions: int,
        supported_ops_checker: _SupportedOpsChecker,
        supported_groups: list[onnx.NodeProto],
        unsupported_ops: set[str],
        nodes_unsupported_due_to_op: int,
        nodes_unsupported_due_to_dynamic_input: int,
        num_unsupported_nodes_due_to_rank: int,
        ops_with_unsupported_rank: set[str],
    ):
        self.num_nodes = num_nodes
        self.num_supported_nodes = num_supported_nodes
        self.num_partitions = num_partitions
        self.supported_ops_checker = supported_ops_checker
        self.supported_groups = supported_groups
        self.unsupported_ops = unsupported_ops
        self.nodes_unsupported_due_to_op = nodes_unsupported_due_to_op
        self.nodes_unsupported_due_to_dynamic_input = nodes_unsupported_due_to_dynamic_input
        self.num_unsupported_nodes_due_to_rank = num_unsupported_nodes_due_to_rank
        self.ops_with_unsupported_rank = ops_with_unsupported_rank

        self.num_subgraphs = 0
        self.num_nodes_in_subgraphs = 0

    def merge(self, other: PartitioningInfo):
        """
        Merge the information from another PartitioningInfo instance into this one.
        """
        self.num_nodes += other.num_nodes
        self.num_supported_nodes += other.num_supported_nodes
        self.num_partitions += other.num_partitions
        self.supported_groups.extend(other.supported_groups)
        self.unsupported_ops.update(other.unsupported_ops)
        self.nodes_unsupported_due_to_op += other.nodes_unsupported_due_to_op
        self.nodes_unsupported_due_to_dynamic_input += other.nodes_unsupported_due_to_dynamic_input
        self.num_unsupported_nodes_due_to_rank += other.num_unsupported_nodes_due_to_rank
        self.ops_with_unsupported_rank.update(other.ops_with_unsupported_rank)

        # hard assumption that we merge into the main graph partitioning info
        self.num_subgraphs += 1
        self.num_nodes_in_subgraphs += other.num_nodes

    def suitability(self):
        # semi-arbitrary choices that err on the side of MAYBE.
        # having 1 partition is always preferred, but if that is small it may not be useful.
        # having 2 partitions may be okay if they cover most nodes
        # more than 2 partitions and the device copy cost is almost guaranteed to outweigh the benefit of using the NPU
        # NOTE: This assumes the EP is not CPU based and there is device copy overhead to consider
        pct_supported = self.num_supported_nodes / self.num_nodes * 100
        if self.num_partitions == 1:
            if pct_supported > 75:
                return PartitioningInfo.TryWithEP.YES
            elif pct_supported > 50:
                return PartitioningInfo.TryWithEP.MAYBE
            else:
                return PartitioningInfo.TryWithEP.NO

        if self.num_partitions == 2:
            if pct_supported > 75:
                return PartitioningInfo.TryWithEP.MAYBE
            else:
                return PartitioningInfo.TryWithEP.NO

        return PartitioningInfo.TryWithEP.NO

    def print_analysis(self, logger: logging.Logger, ep_name: str):
        """
        Analyze the partitioning information and log the analysis
        :param logger: Logger to use
        :param ep_name: Execution provider name to use in the log messages
        """

        logger.info(
            f"{self.num_partitions} partitions with a total of {self.num_supported_nodes}/{self.num_nodes} "
            f"nodes can be handled by the {ep_name} EP."
        )

        if self.supported_groups:
            logger.info(
                f"\tPartition sizes: [{', '.join([str(len(partition)) for partition in self.supported_groups])}]"
            )

            # dump full groups if debug output is enabled
            for group in self.supported_groups:
                logger.debug(f"Nodes in group: {','.join([f'{node.op_type}:{node.name}' for node in group])}")

        logger.info(f"Unsupported nodes due to operator={self.nodes_unsupported_due_to_op}")
        if self.unsupported_ops:
            logger.info(f"\tUnsupported ops: {','.join(sorted(self.unsupported_ops))}")

        caveats = self.supported_ops_checker.get_caveats()
        if caveats:
            indent = " " * 5
            logger.info(
                "\tCaveats that have not been checked and may result in a node not actually being supported:  "
                f"{''.join([os.linesep + indent + caveat for caveat in caveats])}"
            )

        if self.nodes_unsupported_due_to_dynamic_input:
            logger.info(
                "Unsupported nodes due to input having a dynamic shape=%d",
                self.nodes_unsupported_due_to_dynamic_input,
            )

        if self.num_unsupported_nodes_due_to_rank:
            logger.info(f"Unsupported nodes due to rank of input data={self.num_unsupported_nodes_due_to_rank}")
            logger.info(f"\tOps with unsupported rank: {','.join(sorted(self.ops_with_unsupported_rank))}")

        if self.num_subgraphs > 0:
            # TODO: CoreML has a flag. NNAPI doesn't. Either should be able to support a subgraph when treated as a
            # separate graph (only extra detail would be making sure implicit inputs are handled).
            # Merging the subgraph into the parent graph would be more complex.
            #   e.g. for CoreML we could potentially convert Loop to while_loop and If to cond if the subgraphs in the
            #        control flow node are fully supported.
            #        NNAPI also has While and If.

            # It most likely will be necessary to support merging in If nodes with fully supported subgraphs,
            # as the subgraphs in those are often very simple, so the performance cost of going to the CPU EP and back
            # is high.
            logger.info(
                f"{self.num_nodes_in_subgraphs} nodes are in {self.num_subgraphs} subgraphs. "
                "Check EP as to whether subgraphs are supported."
            )

        pct_nodes_using_ep = self.num_supported_nodes / self.num_nodes * 100
        if self.num_partitions == 0:
            logger.info(f"{ep_name} cannot run any nodes in this model.")
        elif self.num_partitions == 1:
            if pct_nodes_using_ep > 75:
                logger.info(
                    f"{ep_name} should work well for this model as there is one partition "
                    f"covering {pct_nodes_using_ep:.1f}% of the nodes in the model."
                )
            elif pct_nodes_using_ep > 50:
                logger.info(
                    f"{ep_name} may work well for this model, however only {pct_nodes_using_ep:.1f}% of nodes "
                    "will use it. Performance testing is required to validate."
                )
            else:
                logger.info(
                    f"{ep_name} will probably not work will for this model as only {pct_nodes_using_ep:.2f}% "
                    "of nodes will use it."
                )

        elif self.num_partitions == 2 and pct_nodes_using_ep > 75:
            logger.info(
                f"{ep_name} can be considered for this model as there are two partitions "
                f"covering {pct_nodes_using_ep:.1f}% of the nodes. "
                "Performance testing is required to validate."
            )
        else:
            logger.info(
                f"{ep_name} is not recommended with this model as there are {self.num_partitions} partitions "
                f"covering {pct_nodes_using_ep:.1f}% of the nodes in the model. "
                "This will most likely result in worse performance than just using the CPU EP."
            )


def _check_partitioning_for_graph(
    graph: onnx.GraphProto,
    node_to_producers: dict[onnx.NodeProto, set[onnx.NodeProto]],
    node_to_consumers: dict[onnx.NodeProto, set[onnx.NodeProto]],
    supported_ops_checker: _SupportedOpsChecker,
    outer_scope_initializers: set[str],
    require_fixed_input_sizes: bool,
    value_info: dict[str, onnx.ValueInfoProto],
    max_rank: int = 999,  # max rank if EP has a limitation
):
    # initializers have fixed sizes.
    initializers = [i.name for i in graph.initializer]

    def _is_fixed_shape_value(value):
        if value in value_info:
            return is_fixed_size_tensor(value_info[value])

        if value in initializers or value in outer_scope_initializers:
            return True

        # if something has an unknown shape (e.g. something downstream of a Reshape with dynamic input for the shape)
        # it won't have an entry in value_info
        return False

    #
    # Replicate logic from /onnxruntime/core/providers/partitioning_utils.cc:CreateSupportedPartitionNodeGroups
    # to roughly estimate number of partitions for nodes that is_node_supported_fn returns true for.
    #
    # We keep the structure and variable names as close as possible to the C++ implementation to simplify keeping them
    # in sync if future updates are needed.
    #
    # NOTE: CreateSupportedPartitionNodeGroups was recently updated to be QDQ aware so that partitions did not split
    # QDQ node groups. This code does not need to be QDQ aware as splitting a QDQ node group does not affect the total
    # number of partitions or supported nodes.
    #

    # we don't currently support a callback for additional group closure checks in the python implementation
    on_group_closed_fn = None

    supported_groups = []
    # number of inputs from unprocessed nodes (in-degree) per node
    in_degree = {}
    # nodes that are ready to process
    nodes_to_process = deque()  # deque of Node instances
    # nodes that will be processed when considering the next partition node group
    nodes_to_process_with_next_group = deque()

    # initialize in-degrees and find root nodes
    for node in graph.node:
        node_input_edge_count = len(node_to_producers[node]) if node in node_to_producers else 0
        in_degree[node] = node_input_edge_count
        if node_input_edge_count == 0:
            # node is only dependent on graph input or initializers
            nodes_to_process.append(node)

    supported_group = []
    # the partition node group's border is the aggregate of its nodes' output nodes
    supported_group_border = set()
    num_supported_nodes = 0
    num_unsupported_nodes_due_to_op = 0
    num_unsupported_nodes_due_to_dynamic_input = 0
    num_unsupported_nodes_due_to_rank = 0
    unsupported_ops = set()
    ops_with_unsupported_rank = set()

    def close_group():
        if supported_group:
            keep_partition = not on_group_closed_fn or on_group_closed_fn(supported_group)

            if keep_partition:
                supported_groups.append(supported_group.copy())

            supported_group.clear()
            supported_group_border.clear()

    while nodes_to_process or nodes_to_process_with_next_group:
        if not nodes_to_process:
            close_group()
            nodes_to_process = nodes_to_process_with_next_group
            nodes_to_process_with_next_group = deque()
            continue

        node = nodes_to_process.popleft()

        is_op_supported = supported_ops_checker.is_op_supported(node)
        is_input_shape_supported = not require_fixed_input_sizes or all(_is_fixed_shape_value(i) for i in node.input)

        is_rank_supported = True
        if value_info:
            for node_input in node.input:
                if node_input and node_input in value_info and value_info[node_input].type.HasField("tensor_type"):
                    input_rank = len(value_info[node_input].type.tensor_type.shape.dim)
                    if input_rank > max_rank:
                        is_rank_supported = False
                        break

        # special-case if we can infer the rank from the length of the 'perms' Transpose attribute
        # e.g. this works with SegmentAnything where dynamic Reshape operators result in no shape info.
        if node.op_type == "Transpose" and len(node.attribute[0].ints) > max_rank:
            is_rank_supported = False

        is_node_supported = is_op_supported and is_input_shape_supported and is_rank_supported

        if not is_node_supported:
            if node in supported_group_border:
                # an unsupported node on the border will be processed after the current partition node group
                # so skip any additional processing/counting here
                nodes_to_process_with_next_group.append(node)
                continue

            if not is_op_supported:
                unsupported_ops.add(f"{node.domain if node.domain else 'ai.onnx'}:{node.op_type}")
                num_unsupported_nodes_due_to_op += 1

            if not is_input_shape_supported:
                num_unsupported_nodes_due_to_dynamic_input += 1

            if not is_rank_supported:
                num_unsupported_nodes_due_to_rank += 1
                ops_with_unsupported_rank.add(f"{node.domain if node.domain else 'ai.onnx'}:{node.op_type}")

        if is_node_supported:
            num_supported_nodes += 1

            # add node to the partition node group
            supported_group.append(node)

            # remove node from the border and add its outputs to the border
            if node in supported_group_border:  # noqa: FURB132
                supported_group_border.remove(node)

            # for each consumer node add to supported_group_border
            if node in node_to_consumers:
                for consumer in node_to_consumers[node]:
                    supported_group_border.add(consumer)

        # adjust in-degrees of the node outputs and add any new nodes to process
        if node in node_to_consumers:
            for consumer in node_to_consumers[node]:
                consumer_node_in_degree = in_degree[consumer]
                consumer_node_in_degree -= 1
                if consumer_node_in_degree == 0:
                    nodes_to_process.append(consumer)

                in_degree[consumer] = consumer_node_in_degree

    close_group()

    num_nodes = len(graph.node)
    num_partitions = len(supported_groups)

    info = PartitioningInfo(
        num_nodes,
        num_supported_nodes,
        num_partitions,
        supported_ops_checker,
        supported_groups,
        unsupported_ops,
        num_unsupported_nodes_due_to_op,
        num_unsupported_nodes_due_to_dynamic_input,
        num_unsupported_nodes_due_to_rank,
        ops_with_unsupported_rank,
    )

    return info


def check_partitioning(
    main_graph: onnx.GraphProto,
    supported_ops_checker: _SupportedOpsChecker,
    require_fixed_input_sizes: bool,
    max_rank: int = 999,
) -> PartitioningInfo:
    """
    Estimate the partitions the graph will be split into for nodes that is_node_supported_fn returns true for.

    The check on whether a node is supported is purely based on the operator type. Additional limitations
    (e.g. NNAPI EP only supports 2D Conv) are not checked, so partitions may not be 100% accurate. The limitations
    for operators in the partitions are printed so the user can manually check.
    :param main_graph: Graph to process
    :param supported_ops_checker: Checker with info on supported ops.
    :param require_fixed_input_sizes: If True, require that the inputs to a potentially supported node are fixed size
                                      tensors for it to be considered as supported. This requires
                                      onnx.shape_inference.infer_shapes to have been run on the model to populate the
                                      shape information.
                                      If False, shapes are ignored during the check.
    :param max_rank: Set if EP has a limitation on the rank of tensors it supports.
    :return PartitioningInfo instance with details
    """

    if require_fixed_input_sizes and len(main_graph.value_info) == 0 and len(main_graph.node) > 1:
        raise ValueError("Run onnx.shape_inference.infer_shapes on the model to populate the shape information.")

    # create lookup map from ValueInfo for efficiency
    def _update_value_info(graph: onnx.GraphProto, value_to_shape: dict[str, onnx.ValueInfoProto]):
        for v in graph.input:
            value_to_shape[v.name] = v
        for v in graph.output:
            value_to_shape[v.name] = v
        for v in graph.value_info:
            value_to_shape[v.name] = v

    # the producer/consumer maps are for the entire model
    node_to_producers, node_to_consumers = get_producer_consumer_maps(main_graph)

    def _check_graph(
        graph: onnx.GraphProto,
        outer_scope_value_info: dict[str, onnx.ValueInfoProto] | None,
        outer_scope_initializers: set[str] | None = None,
        partitioning_info: PartitioningInfo | None = None,
    ) -> PartitioningInfo:
        if outer_scope_value_info is not None:
            # extend value info if we're using it. we replace any value shadowed with a local one
            value_info = outer_scope_value_info.copy()
            _update_value_info(graph, value_info)
        else:
            value_info = {}

        if outer_scope_initializers is None:
            outer_scope_initializers = set()

        info = _check_partitioning_for_graph(
            graph,
            node_to_producers,
            node_to_consumers,
            supported_ops_checker,
            outer_scope_initializers,
            require_fixed_input_sizes,
            value_info,
            max_rank,
        )

        if partitioning_info:
            # merge in subgraph info
            partitioning_info.merge(info)
        else:
            # main graph info
            partitioning_info = info

        # setup outer scope initializers. we copy the input set as a model may have multiple subgraphs
        # on multiple levels, so we need to keep the set for each descent separate
        subgraph_outer_scope_initializers = set(outer_scope_initializers)
        for initializer in graph.initializer:
            subgraph_outer_scope_initializers.add(initializer.name)

        for node in graph.node:
            # recurse into nodes with subgraphs
            for attr in node.attribute:
                if attr.HasField("g"):
                    subgraph = attr.g
                    partitioning_info = _check_graph(
                        subgraph, value_info, subgraph_outer_scope_initializers, partitioning_info
                    )

        return partitioning_info

    aggregated_partitioning_info = _check_graph(main_graph, {} if require_fixed_input_sizes else None)

    return aggregated_partitioning_info


def _check_ep_partitioning(
    model: onnx.ModelProto, supported_ops_config: pathlib.Path, require_fixed_input_sizes: bool, max_rank: int = 999
):
    supported_ops = _SupportedOpsChecker(supported_ops_config)
    partition_info = check_partitioning(model.graph, supported_ops, require_fixed_input_sizes, max_rank)
    return partition_info


def check_nnapi_partitions(model, require_fixed_input_sizes: bool):
    # if we're running in the ORT python package the file should be local. otherwise assume we're running from the
    # ORT repo
    script_dir = pathlib.Path(__file__).parent
    local_config = script_dir / "nnapi_supported_ops.md"
    if local_config.exists():
        config_path = local_config
    else:
        ort_root = script_dir.parents[3]
        config_path = ort_root / "tools" / "ci_build" / "github" / "android" / "nnapi_supported_ops.md"

    return _check_ep_partitioning(model, config_path, require_fixed_input_sizes)


def check_coreml_partitions(model: onnx.ModelProto, require_fixed_input_sizes: bool, config_filename: str):
    # if we're running in the ORT python package the file should be local. otherwise assume we're running from the
    # ORT repo
    script_dir = pathlib.Path(__file__).parent
    local_config = script_dir / config_filename
    if local_config.exists():
        config_path = local_config
    else:
        ort_root = script_dir.parents[3]
        config_path = ort_root / "tools" / "ci_build" / "github" / "apple" / config_filename

    max_rank = 5
    return _check_ep_partitioning(model, config_path, require_fixed_input_sizes, max_rank)


def check_shapes(graph: onnx.GraphProto, logger: logging.Logger | None = None):
    """
    Check the shapes of graph inputs, values and graph outputs to determine if they have static or dynamic sizes.
    NNAPI does not support dynamically sized values. CoreML does, but it will most likely cost performance.
    :param graph: Graph to check. If shape inferencing has been run the checks on values will be meaningful.
    :param logger: Optional logger for diagnostic information.
    :return: Tuple of List of inputs with dynamic shapes, Number of dynamic values found
    """

    # it's OK if the input is dynamically sized and we do a Resize early to a fixed size.
    # it's not good if lots of ops have dynamic inputs

    num_fixed_values = 0
    num_dynamic_values = 0

    dynamic_inputs = []
    for i in graph.input:
        if not is_fixed_size_tensor(i):
            dynamic_inputs.append(i)
            # split/join to remove repeated whitespace and newlines from str(i)
            if logger:
                logger.info(f"Input is not a fixed size tensor: {' '.join(str(i).split())}")
            num_dynamic_values += 1
        else:
            num_fixed_values += 1

    dynamic_outputs = []
    for o in graph.output:
        if not is_fixed_size_tensor(o):
            dynamic_outputs.append(o)
            if logger:
                logger.info(f"Output is not a fixed size tensor: {' '.join(str(o).split())}")
            num_dynamic_values += 1
        else:
            num_fixed_values += 1

    # check we have value info.
    # special case some test graphs with a single node which only have graph input and output values, and
    # a model where all inputs are dynamic (results in no value_info)
    if not graph.value_info and not (len(graph.node) == 1 or len(dynamic_inputs) == len(graph.input)):
        logger.warning(
            "Unable to check shapes within model. ONNX shape inferencing should be run on the model prior to checking."
        )

    for vi in graph.value_info:
        if is_fixed_size_tensor(vi):
            num_fixed_values += 1
        else:
            num_dynamic_values += 1

    if logger:
        logger.info(
            f"Num values with fixed shape={num_fixed_values}. Num values with dynamic shape={num_dynamic_values}"
        )

        if dynamic_inputs:
            if dynamic_outputs:
                logger.info(
                    "Model has dynamic inputs and outputs. Consider re-exporting model with fixed sizes "
                    "if NNAPI or CoreML can be used with this model."
                )
            else:
                logger.info(
                    """Model has dynamically sized inputs but fixed sized outputs.
                       If the sizes become fixed early in the model (e.g. pre-processing of a dynamic input size
                       results in a fixed input size for the majority of the model) performance with NNAPI and CoreML,
                       if applicable, should not be significantly impacted."""
                )

    return dynamic_inputs, num_dynamic_values


def checker(model_path: pathlib.Path, logger: logging.Logger):
    model_with_shape_info_wrapper = ModelProtoWithShapeInfo(model_path)
    model_with_shape_info = model_with_shape_info_wrapper.model_with_shape_info

    dynamic_inputs, num_dynamic_values = check_shapes(model_with_shape_info.graph)

    def check_ep(ep_name, checker_func):
        logger.info(f"Checking {ep_name}")

        # check with shape info first so supported nodes takes into account values with dynamic shapes
        require_fixed_input_sizes = True
        partition_info = checker_func(model_with_shape_info, require_fixed_input_sizes)
        if logger.getEffectiveLevel() <= logging.INFO:
            partition_info.print_analysis(logger, ep_name)

        suitability = partition_info.suitability()
        logger.info(f"Model should perform well with {ep_name} as is: {suitability.name}")

        if suitability != PartitioningInfo.TryWithEP.YES and dynamic_inputs:
            logger.info("--------")
            logger.info("Checking if model will perform better if the dynamic shapes are fixed...")
            require_fixed_input_sizes = False
            partition_info_with_fixed_shapes = checker_func(model_with_shape_info, require_fixed_input_sizes)

            if logger.getEffectiveLevel() <= logging.INFO:
                # analyze and log detailed info
                logger.info("Partition information if the model was updated to make the shapes fixed:")
                partition_info_with_fixed_shapes.print_analysis(logger, ep_name)

            fixed_shape_suitability = partition_info_with_fixed_shapes.suitability()
            logger.info(
                f"Model should perform well with {ep_name} if modified to have fixed input shapes: "
                f"{fixed_shape_suitability.name}"
            )

            if fixed_shape_suitability != PartitioningInfo.TryWithEP.NO:
                logger.info("Shapes can be altered using python -m onnxruntime.tools.make_dynamic_shape_fixed")

            if fixed_shape_suitability.value > suitability.value:
                suitability = fixed_shape_suitability

        logger.info("================")
        logger.info("")

        return suitability

    nnapi_suitability = check_ep("NNAPI", check_nnapi_partitions)

    # Check for NeuralNetwork CoreML model
    def check_nn_coreml(model: onnx.ModelProto, require_fixed_input_sizes):
        return check_coreml_partitions(model, require_fixed_input_sizes, "coreml_supported_neuralnetwork_ops.md")

    # Check for MLProgram CoreML model
    def check_mlprogram_coreml(model: onnx.ModelProto, require_fixed_input_sizes):
        return check_coreml_partitions(model, require_fixed_input_sizes, "coreml_supported_mlprogram_ops.md")

    coreml_nn_suitability = check_ep("CoreML NeuralNetwork", check_nn_coreml)
    coreml_mlprogram_suitability = check_ep("CoreML MLProgram", check_mlprogram_coreml)

    if (
        nnapi_suitability != PartitioningInfo.TryWithEP.YES
        or coreml_nn_suitability != PartitioningInfo.TryWithEP.YES
        or coreml_mlprogram_suitability != PartitioningInfo.TryWithEP.YES
    ) and logger.getEffectiveLevel() > logging.INFO:
        logger.info("Re-run with log level of INFO for more details on the NNAPI/CoreML issues.")

    return (
        nnapi_suitability != PartitioningInfo.TryWithEP.NO
        or coreml_nn_suitability != PartitioningInfo.TryWithEP.NO
        or coreml_mlprogram_suitability != PartitioningInfo.TryWithEP.NO
    )


def analyze_model(model_path: pathlib.Path, skip_optimize: bool = False, logger: logging.Logger | None = None):
    """
    Analyze the provided model to determine if it's likely to work well with the NNAPI or CoreML Execution Providers
    :param model_path: Model to analyze.
    :param skip_optimize: Skip optimizing to BASIC level before checking. When exporting to ORT format we will do this
                          optimization..
    :param logger: Logger for output
    :return: True if either the NNAPI or CoreML Execution Providers may work well with this model.
    """
    if not logger:
        logger = logging.getLogger("usability_checker")
        logger.setLevel(logging.INFO)

    logger.info(f"Checking {model_path} for usability with ORT Mobile.")

    with tempfile.TemporaryDirectory() as tmp:
        if not skip_optimize:
            tmp_path = pathlib.Path(tmp) / model_path.name
            optimize_model(model_path, tmp_path, use_external_initializers=True)
            model_path = tmp_path

        try_eps = checker(model_path.resolve(strict=True), logger)

    return try_eps


def parse_args():
    parser = argparse.ArgumentParser(
        os.path.basename(__file__), description="""Analyze an ONNX model for usage with the ORT mobile"""
    )

    parser.add_argument("--log_level", choices=["debug", "info"], default="info", help="Logging level")
    parser.add_argument(
        "--skip_optimize",
        action="store_true",
        help="Don't optimize the model to BASIC level prior to analyzing. "
        "Optimization will occur when exporting the model to ORT format, so in general "
        "should not be skipped unless you have a specific reason to do so.",
    )
    parser.add_argument("model_path", type=pathlib.Path, help="Provide path to ONNX model")

    return parser.parse_args()


def run_analyze_model():
    args = parse_args()
    logger = logging.getLogger("default")

    if args.log_level == "debug":
        logger.setLevel(logging.DEBUG)
    elif args.log_level == "info":
        logger.setLevel(logging.INFO)
    elif args.log_level == "warning":
        logger.setLevel(logging.WARNING)
    else:
        logger.setLevel(logging.ERROR)

    model_path = args.model_path.resolve()
    analyze_model(model_path, args.skip_optimize, logger)


if __name__ == "__main__":
    run_analyze_model()
