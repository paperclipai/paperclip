# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
from __future__ import annotations

import logging
import pathlib

import onnx
from onnx import version_converter

import onnxruntime as ort


def iterate_graph_per_node_func(graph, per_node_func, **func_args):
    """
    Iterate the graph including subgraphs calling the per_node_func for each node.
    :param graph: Graph to iterate
    :param per_node_func: Function to call for each node. Signature is fn(node: onnx:NodeProto, **kwargs)
    :param func_args: The keyword args to pass through.
    """

    for node in graph.node:
        per_node_func(node, **func_args)
        # recurse into subgraph for control flow nodes (Scan/Loop/If)
        for attr in node.attribute:
            if attr.HasField("g"):
                iterate_graph_per_node_func(attr.g, per_node_func, **func_args)


def iterate_graph_per_graph_func(graph, per_graph_func, **func_args):
    """
    Iterate the graph including subgraphs calling the per_graph_func for each Graph.
    :param graph: Graph to iterate
    :param per_graph_func: Function to call for each graph. Signature is fn(graph: onnx:GraphProto, **kwargs)
    :param func_args: The keyword args to pass through.
    """

    per_graph_func(graph, **func_args)

    for node in graph.node:
        # recurse into subgraph for control flow nodes (Scan/Loop/If)
        for attr in node.attribute:
            if attr.HasField("g"):
                iterate_graph_per_graph_func(attr.g, per_graph_func, **func_args)


def get_opsets_imported(model: onnx.ModelProto):
    """
    Get the opsets imported by the model
    :param model: Model to check.
    :return: Map of domain to opset.
    """
    opsets = {}
    for entry in model.opset_import:
        # if empty it's ai.onnx
        domain = entry.domain or "ai.onnx"
        opsets[domain] = entry.version

    return opsets


def update_onnx_opset(
    model_path: pathlib.Path,
    opset: int,
    out_path: pathlib.Path | None = None,
    logger: logging.Logger | None = None,
):
    """
    Helper to update the opset of a model using onnx version_converter. Target opset must be greater than current opset.
    :param model_path: Path to model to update
    :param opset: Opset to update model to
    :param out_path: Optional output path for updated model to be saved to.
    :param logger: Optional logger for diagnostic output
    :returns: Updated onnx.ModelProto
    """

    model_path_str = str(model_path.resolve(strict=True))
    if logger:
        logger.info("Updating %s to opset %d", model_path_str, opset)

    model = onnx.load(model_path_str)

    new_model = version_converter.convert_version(model, opset)

    if out_path:
        onnx.save(new_model, str(out_path))
        if logger:
            logger.info("Saved updated model to %s", out_path)

    return new_model


def optimize_model(
    model_path: pathlib.Path,
    output_path: pathlib.Path,
    level: ort.GraphOptimizationLevel = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC,
    log_level: int = 3,
    use_external_initializers: bool = False,
):
    """
    Optimize an ONNX model using ONNX Runtime to the specified level
    :param model_path: Path to ONNX model
    :param output_path: Path to save optimized model to.
    :param level: onnxruntime.GraphOptimizationLevel to use. Default is ORT_ENABLE_BASIC.
    :param log_level: Log level. Defaults to Error (3) so we don't get output about unused initializers being removed.
                      Warning (2) or Info (1) may be desirable in some scenarios.
    :param use_external_initializers: Set flag to write initializers to an external file. Required if model > 2GB.
                                      Requires onnxruntime 1.17+
    """
    so = ort.SessionOptions()
    so.optimized_model_filepath = str(output_path.resolve())
    so.graph_optimization_level = level
    so.log_severity_level = log_level

    # save using external initializers so models > 2 GB are handled
    if use_external_initializers:
        major, minor, rest = ort.__version__.split(".", 3)
        if (int(major), int(minor)) >= (1, 17):
            so.add_session_config_entry("session.optimized_model_external_initializers_file_name", "external_data.pb")
        else:
            raise ValueError(
                "ONNX Runtime 1.17 or higher required to save initializers as external data when optimizing model. "
                f"Current ONNX Runtime version is {ort.__version__}"
            )

    # create session to optimize. this will write the updated model to output_path
    _ = ort.InferenceSession(str(model_path.resolve(strict=True)), so, providers=["CPUExecutionProvider"])


def _replace_symbolic_dim_value(graph: onnx.GraphProto, **kwargs):
    param_to_replace = kwargs["dim_param"]
    value = kwargs["value"]

    def update_dim_values(value_infos):
        for vi in value_infos:
            if vi.type.HasField("tensor_type"):
                shape = vi.type.tensor_type.shape
                if shape:
                    for dim in shape.dim:
                        if dim.HasField("dim_param") and dim.dim_param == param_to_replace:
                            dim.Clear()
                            dim.dim_value = value

    update_dim_values(graph.input)
    update_dim_values(graph.output)
    update_dim_values(graph.value_info)


def _remove_invalid_dim_values_impl(graph: onnx.GraphProto):
    def clear_invalid_values(value):
        if value.type.HasField("tensor_type"):
            shape = value.type.tensor_type.shape
            if shape:
                for dim in shape.dim:
                    if dim.HasField("dim_value") and dim.dim_value < 1:
                        dim.Clear()

    for i in graph.input:
        clear_invalid_values(i)

    for o in graph.output:
        clear_invalid_values(o)

    for vi in graph.value_info:
        clear_invalid_values(vi)


def remove_invalid_dim_values(graph: onnx.GraphProto):
    """
    Iterate the graph and subgraphs, unsetting any dim_value entries that have a value of less than 1.
    These are typically erroneously inserted by a converter to represent a dynamic dimension.
    :param graph: GraphProto to update
    """
    iterate_graph_per_graph_func(graph, _remove_invalid_dim_values_impl)


def make_dim_param_fixed(graph: onnx.GraphProto, param_name: str, value: int):
    """
    Iterate all values in the graph, replacing dim_param in a tensor shape with the provided value.
    :param graph: GraphProto to update
    :param param_name: dim_param to set
    :param value: value to use
    """
    iterate_graph_per_graph_func(graph, _replace_symbolic_dim_value, dim_param=param_name, value=value)


def make_input_shape_fixed(graph: onnx.GraphProto, input_name: str, fixed_shape: [int]):
    """
    Update the named graph input to set shape to the provided value. This can be used to set unknown dims as well
    as to replace dim values.
    If setting the input shape replaces a dim_param, update any other values in the graph that use the dim_param.
    :param graph: Graph to update
    :param input_name: Name of graph input to update.
    :param fixed_shape: Shape to use.
    """

    # remove any invalid dim values first. typically this is a dim_value of -1.
    remove_invalid_dim_values(graph)

    for i in graph.input:
        if i.name == input_name:
            if not i.type.HasField("tensor_type"):
                raise ValueError(f"Input {input_name} is not a tensor")

            # graph inputs are required to have a shape to provide the rank
            shape = i.type.tensor_type.shape
            if len(shape.dim) != len(fixed_shape):
                raise ValueError(f"Rank mismatch. Existing:{len(shape.dim)} Replacement:{len(fixed_shape)}")

            for idx, dim in enumerate(shape.dim):
                # check any existing fixed dims match
                if dim.HasField("dim_value"):
                    if dim.dim_value != fixed_shape[idx]:
                        raise ValueError(
                            f"Can't replace existing fixed size of {dim.dim_value} with {fixed_shape[idx]} "
                            f"for dimension {idx + 1}"
                        )
                elif dim.HasField("dim_param"):
                    # replacing a dim_param so have to do that through the entire graph
                    make_dim_param_fixed(graph, dim.dim_param, fixed_shape[idx])
                else:
                    # replacing an unknown dim
                    dim.Clear()
                    dim.dim_value = fixed_shape[idx]

            return

    raise ValueError(
        f"Input {input_name} was not found in graph inputs. "
        f"Valid input names are: {','.join([i.name for i in graph.input])}"
    )


def fix_output_shapes(model: onnx.ModelProto):
    """
    Update the output shapesof a model where the input shape/s were made fixed, if possible.
    This is mainly to make the model usage clearer if the output shapes can be inferred from the new input shapes.
    :param model: Model that had input shapes fixed.
    """

    # get a version of the model with shape inferencing info in it. this will provide fixed output shapes if possible.
    m2 = onnx.shape_inference.infer_shapes(model)
    onnx.checker.check_model(m2)

    for idx, o in enumerate(model.graph.output):
        if not is_fixed_size_tensor(o):
            new_o = m2.graph.output[idx]
            if is_fixed_size_tensor(new_o):
                o.type.tensor_type.shape.CopyFrom(new_o.type.tensor_type.shape)


def _create_producer_consumer_link(
    node_to_producers: dict, node_to_consumers: dict, producer: onnx.NodeProto, consumer: onnx.NodeProto
):
    """
    Create links between two nodes for a value produced by one and consumed by the other.
    :param node_to_producers: Map of NodeProto to set of nodes that produce values the node consumes as inputs.
    :param node_to_consumers: Map of NodeProto to set of nodes that consume values the node produces as outputs.
    :param producer: Producer node
    :param consumer: Consumer node
    """

    if consumer not in node_to_producers:
        node_to_producers[consumer] = set()

    if producer not in node_to_consumers:
        node_to_consumers[producer] = set()

    # add entry mapping this node to the producer of this input
    node_to_producers[consumer].add(producer)
    node_to_consumers[producer].add(consumer)


def _map_node_dependencies(graph: onnx.GraphProto, node_to_producers: dict, node_to_consumers: dict):
    graph_inputs = {i.name for i in graph.input}
    initializers = {i.name for i in graph.initializer}

    # map of value name to node that creates it. copy parent values but override if values get shadowed
    producers = {}

    implicit_inputs = set()

    def is_local_value(value):
        return value in producers or value in initializers or value in graph_inputs

    for node in graph.node:
        inputs = list(node.input)

        for attr in node.attribute:
            if attr.HasField("g"):
                subgraph_implicit_inputs = _map_node_dependencies(attr.g, node_to_producers, node_to_consumers)
                inputs += subgraph_implicit_inputs

        for i in inputs:
            if not i:
                # missing optional input
                continue

            if is_local_value(i):
                if i in producers:
                    producer = producers[i]
                    _create_producer_consumer_link(node_to_producers, node_to_consumers, producer, node)
            else:
                implicit_inputs.add(i)

        for o in node.output:
            producers[o] = node

    return implicit_inputs


def get_producer_consumer_maps(graph: onnx.GraphProto):
    """
    Get maps for connections between the node that produces each value and the nodes that consume the value.
    Processing includes subgraphs. As the map key is a Node instance from the Graph there should be no ambiguity.
    :param graph: Graph to process.
    :return: Tuple with two maps.
             First is node_to_producers map of a node to set of all nodes producing input it consumes.
             Second is node_to_consumers map of a node to set of all nodes consuming output it creates.
             e.g. NodeA and NodeB provide inputs to NodeC. NodeC provides input to NodeD
             node_to_consumers[NodeA] = set([NodeC])
             node_to_consumers[NodeB] = set([NodeC])
             node_to_producers[NodeC] = set([NodeA, NodeB])
             node_to_consumers[NodeC] = set([NodeD])
             node_to_producers[NodeD] = set([NodeC])
    """

    # use a hash of the object id for NodeProto.
    # we need this for the partitioning checker where we keep maps with nodes as the key.
    onnx.NodeProto.__hash__ = lambda self: id(self)

    node_to_producers = {}  # map of node instance to nodes producing input values it consumes
    node_to_consumers = {}  # map of node instance to nodes consuming output values it produces

    implicit_inputs = _map_node_dependencies(graph, node_to_producers, node_to_consumers)

    # top level graph should have no implicit inputs
    if implicit_inputs:
        raise ValueError(
            f"This appears to be an invalid model with missing inputs of {','.join(sorted(implicit_inputs))}"
        )

    return node_to_producers, node_to_consumers


def is_fixed_size_tensor(value: onnx.ValueInfoProto):
    """
    Check if value is a tensor with a fixed shape.
    :param value: onnx.ValueInfoProto to check
    :return: True if value is a tensor, with a shape, where all dimensions have fixed values.
    """

    is_fixed = False
    if value.type.HasField("tensor_type"):
        shape = value.type.tensor_type.shape
        if shape:
            is_fixed = True  # scalar has no dims so set to True and unset if we hit a dim without a valid value
            for dim in shape.dim:
                if dim.HasField("dim_value") and dim.dim_value > 0:
                    continue

                # anything else means it's a dynamic value
                is_fixed = False
                break

    return is_fixed


def get_optimization_level(level):
    """Convert string to GraphOptimizationLevel."""
    if level == "disable":
        return ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    if level == "basic":
        # Constant folding and other optimizations that only use ONNX operators
        return ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    if level == "extended":
        # Optimizations using custom operators, excluding NCHWc and NHWC layout optimizers
        return ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    if level == "layout":
        # NCHWc and NHWC layout optimizers
        return ort.GraphOptimizationLevel.ORT_ENABLE_LAYOUT
    if level == "all":
        return ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    raise ValueError("Invalid optimization level of " + level)


class ModelProtoWithShapeInfo:
    """
    Class to load an ONNX model and run shape inferencing on it to populate the ValueInfo.
    The model_with_shape_info property will contain the updated model.
    If the model is > 2GB and uses external data a temporary file is required to run shape inferencing successfully.
    This helper class handles automatic removal of the temporary file.
    """

    def __init__(self, model_path: pathlib.Path):
        """
        :param model_path: Path to ONNX model to load and run shape inferencing on.
        """

        self.model_path = model_path

        model = onnx.load(str(model_path))
        self.model_with_shape_info = onnx.shape_inference.infer_shapes(model, strict_mode=True)

        # ONNX has a silent failure from the call to infer_shapes when the model is > 2GB.
        # We detect that by checking the nodes in the returned model.
        self._tmp_model_path = None
        if len(model.graph.node) > 0 and len(self.model_with_shape_info.graph.node) == 0:
            self._tmp_model_path = pathlib.Path(model_path).with_suffix(".temp_with_shapeinf.onnx")
            onnx.shape_inference.infer_shapes_path(str(model_path), str(self._tmp_model_path), strict_mode=True)
            self.model_with_shape_info = onnx.load(str(self._tmp_model_path))

    def __del__(self):
        if self._tmp_model_path:
            self._tmp_model_path.unlink(missing_ok=True)
