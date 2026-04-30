# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import logging
import tempfile
from pathlib import Path

import onnx

from ....tools.onnx_model_utils import fix_output_shapes, make_input_shape_fixed, optimize_model
from ....tools.remove_initializer_from_input import remove_initializer_from_input
from ...fusions import FusionGelu, FusionLayerNormalization
from ...onnx_model import ONNXModel
from .fusion_lpnorm import FusionLpNormalization
from .fusion_spacetodepth import FusionSpaceToDepth


def qnn_preprocess_model(
    model_input: str | Path | onnx.ModelProto,
    model_output: str | Path,
    exclude_initializer_from_input: bool = False,
    fuse_layernorm: bool = False,
    save_as_external_data: bool = False,
    all_tensors_to_one_file: bool = False,
    external_data_location: str | None = None,
    external_data_size_threshold: int = 1024,
    external_data_convert_attribute: bool = False,
    inputs_to_make_channel_last: list[str] | None = None,
    outputs_to_make_channel_last: list[str] | None = None,
    dynamic_input_shapes: list[tuple[str, str]] | None = None,
) -> bool:
    """
    If necessary, this method creates a new "pre-processed" model in preparation for
    quantization of a model to be used in QNN EP. Returns true if a new model was created.

    This method perfoms the following operations:
    - Fuse Erf sequence into a single Gelu node.
    - Fuse ReduceL2 sequence into a single LpNormalization node (p == 2).
    - (Optional) Fuse ReduceMean sequence into a single LayerNormalization node.

    Args:
        model_input: Path to the input model file or ModelProto.
        model_output: Path the output model file, which is only created if this method returns True.
        exclude_initializer_from_input: A bool specifying whether to exclude initializer from input.
            Defaults to False.
        fuse_layernorm: True if ReduceMean sequences should be fused into LayerNormalization nodes.
            Defaults to False.
        save_as_external_data: True if output model should be saved with external data. Defaults to false.
        all_tensors_to_one_file: Effective only if save_as_external_data is true. Defaults to false.
            If true, save all tensors to one external file specified by external_data_location.
            If false, save each tensor to a file named with the tensor name.
        external_data_location: Effective only if save_as_external_data is true. Defaults to None.
            Specify the external file to which all tensors are saved. Path is relative
            to the model path. If not specified, the model's name is used.
        external_data_size_threshold: Effective only if save_as_external_data is true. Defaults to 1024.
            Tensors with a data size >= external_data_size_threshold are converted to external data.
            To convert every tensor with raw data to external data, set to 0.
        external_data_convert_attribute: Effective only if save_as_external_data is true. Defaults to false.
            If true, convert all tensors to external data.
            If false, convert only non-attribute tensors to external data.
        inputs_to_make_channel_last: List of graph input names to transpose to be "channel-last". For example,
            if "input0" originally has the shape (N, C, D1, D2, ..., Dn), the resulting model will change input0's
            shape to (N, D1, D2, ..., Dn, C) and add a transpose node after it.

            Original:
                input0 (N, C, D1, D2, ..., Dn) --> <Nodes>

            Updated:
                input0 (N, D1, D2, ..., Dn, C) --> Transpose --> input0_chanfirst (N, C, D1, D2, ..., Dn) --> <Nodes>

            This can potentially improve inference latency for QDQ models running on QNN EP because the
            additional transpose node may allow other transpose nodes inserted during ORT layout transformation
            to cancel out.
        outputs_to_make_channel_last: List of graph output names to transpose to be "channel-last". For example,
            if "output0" originally has the shape (N, C, D1, D2, ..., Dn), the resulting model will change output0's
            shape to (N, D1, D2, ..., Dn, C) and add a transpose node before it.

            Original:
                <Nodes> --> output0 (N, C, D1, D2, ..., Dn)

            Updated:
                <Nodes> --> output0_chanfirst (N, C, D1, D2, ..., Dn) --> Transpose --> output0 (N, D1, D2, ..., Dn, C)

            This can potentially improve inference latency for QDQ models running on QNN EP because the
            additional transpose node may allow other transpose nodes inserted during ORT layout transformation
            to cancel out.
        dynamic_input_shapes: A list of tuples specifying model input name to and its static shape in comma seprated
            format, for example: [('input', '1,3,256,256')]. Defaults to None.
    """
    modified = False
    model = model_input if isinstance(model_input, onnx.ModelProto) else onnx.load_model(model_input)
    model = save_and_reload_optimize_model(model, shape_infer=True)
    onnx_model = ONNXModel(model)

    # Optionally, fix the dynamic input shapes.
    if dynamic_input_shapes:
        for input_name, input_shape_str in dynamic_input_shapes:
            input_shape = [int(i) for i in input_shape_str.split(",")]
            make_input_shape_fixed(onnx_model.graph(), input_name, input_shape)
        fix_output_shapes(onnx_model.model)
        modified = True

    # Exclude initializer from input if model.ir_version >= 4
    if exclude_initializer_from_input:
        modified |= remove_initializer_from_input(onnx_model.model)

    # Fuse Erf sequence into a single Gelu
    fusion_gelu = FusionGelu(onnx_model)
    if fusion_gelu.apply():
        modified = True

    # Fuse ReduceL2 sequence into a single LpNormalization node with p == 2.
    fusion_lpnorm = FusionLpNormalization(onnx_model)
    if fusion_lpnorm.apply():
        modified = True

    # Fuse Reshape/Transpose sequence into a single SpaceToDepth.
    fusion_s2d = FusionSpaceToDepth(onnx_model)
    if fusion_s2d.apply():
        modified = True

    # Optionally, fuse ReduceMean sequence into a single LayerNormalization node.
    if fuse_layernorm:
        onnx_opset = next(x for x in model.opset_import if x.domain == "" or x.domain == "ai.onnx")

        # Need opset >= 17 to use LayerNormalization.
        if onnx_opset.version < 17:
            logging.warning(
                "Unable to fuse ReduceMean sequence into a LayerNormalization node. "
                "ONNX model must use an opset >= 17 in order to use LayerNormalization, "
                f"but found version {onnx_opset.version}. Please use onnx.version_converter to update your model."
            )
        else:
            fusion_layernorm = FusionLayerNormalization(onnx_model)
            if fusion_layernorm.apply():
                modified = True

    # Optionally, transpose inputs and/or outputs to make them "channel-last".
    if inputs_to_make_channel_last or outputs_to_make_channel_last:
        transpose_node_prefix = "Transpose_channel_"
        transpose_node_suffix: int = onnx_model.get_largest_node_name_suffix(transpose_node_prefix) + 1
        update_io_to_channel_last(
            onnx_model.model,
            inputs_to_make_channel_last,
            outputs_to_make_channel_last,
            transpose_node_name_prefix=transpose_node_prefix,
            transpose_node_name_start_suffix=transpose_node_suffix,
        )
        modified = True

    # Make sure all nodes have a name.
    unnamed_node_prefix = "qnn_preproc_node_"
    available_suffix = onnx_model.get_largest_node_name_suffix(unnamed_node_prefix) + 1
    for node in onnx_model.model.graph.node:
        if node.op_type != "Constant" and not node.name:
            new_node_name = f"{unnamed_node_prefix}{available_suffix!s}"
            available_suffix += 1
            node.name = new_node_name
            modified = True
            logging.warning(f"Node of type {node.op_type} does not have a name. Renamed to {new_node_name}.")

    if modified:
        onnx_model.topological_sort()
        onnx.save_model(
            model,
            model_output,
            save_as_external_data=save_as_external_data,
            all_tensors_to_one_file=all_tensors_to_one_file,
            location=external_data_location,
            size_threshold=external_data_size_threshold,
            convert_attribute=external_data_convert_attribute,
        )

    return modified


def save_and_reload_optimize_model(model: onnx.ModelProto, shape_infer: bool) -> onnx.ModelProto:
    with tempfile.TemporaryDirectory(prefix="ort.qnn_preproc.") as qnn_preproc_tmp_dir:
        model_in_path = Path(qnn_preproc_tmp_dir).joinpath("qnn_proc_input.onnx")
        onnx.save_model(model, model_in_path, save_as_external_data=True)
        if shape_infer:
            model_infer_path = Path(qnn_preproc_tmp_dir).joinpath("qnn_proc_infer.onnx")
            onnx.shape_inference.infer_shapes_path(str(model_in_path), str(model_infer_path))
            model_in_path = model_infer_path
        model_out_path = Path(qnn_preproc_tmp_dir).joinpath("qnn_proc_output.onnx")
        optimize_model(model_in_path, model_out_path)
        ret_model = onnx.load_model(model_out_path)
        ret_metaprops = {"onnx.infer": "onnxruntime.tools.qnn.preprocess"}
        if ret_model.metadata_props:
            ret_metaprops.update(ret_model.metadata_props)
        onnx.helper.set_model_props(ret_model, ret_metaprops)
        return ret_model


class InputOutputNameMap:
    def __init__(
        self,
        orig_tensor_names: set[str],
        orig_graph_inputs: dict[str, onnx.ValueInfoProto],
        orig_graph_outputs: dict[str, onnx.ValueInfoProto],
    ):
        self.orig_tensor_names = orig_tensor_names
        self.orig_graph_inputs = orig_graph_inputs
        self.orig_graph_outputs = orig_graph_outputs
        self.updated_io_names = {}
        self.new_value_infos = []

    def get_new_name(self, orig_name: str):
        if orig_name in self.updated_io_names:
            return self.updated_io_names[orig_name]

        # Make a new tensor name that is unique among all tensors in the graph.
        prefix: str = f"{orig_name}_channel_first_"
        suffix: int = -1
        for tensor_name in self.orig_tensor_names:
            if tensor_name.startswith(prefix) and tensor_name[len(prefix) :].isdigit():
                index = int(tensor_name[len(prefix) :])
                suffix = max(suffix, index)

        suffix += 1  # This is the first available suffix.
        new_name = f"{prefix}{suffix!s}"

        # Add new value_info objects for these new tensors.
        orig_value_info = self.orig_graph_inputs.get(orig_name) or self.orig_graph_outputs[orig_name]
        value_info_proto = onnx.ValueInfoProto()
        value_info_proto.CopyFrom(orig_value_info)
        value_info_proto.name = new_name
        self.new_value_infos.append(value_info_proto)

        self.updated_io_names[orig_name] = new_name
        return self.updated_io_names[orig_name]


def update_io_to_channel_last(
    model: onnx.ModelProto,
    inputs_to_update: list[str] | None,
    outputs_to_update: list[str] | None,
    transpose_node_name_prefix: str = "Transpose_channel_",
    transpose_node_name_start_suffix: int = 0,
):
    inputs_to_update = set(inputs_to_update or [])
    outputs_to_update = set(outputs_to_update or [])

    if not inputs_to_update and not outputs_to_update:
        return

    graph = model.graph
    orig_graph_inputs = {ginput.name: ginput for ginput in graph.input}
    orig_graph_outputs = {goutput.name: goutput for goutput in graph.output}

    # Check that the user passed in actual input and output names.
    for input_name in inputs_to_update:
        if input_name not in orig_graph_inputs:
            raise ValueError(f"{input_name} is not a graph input")

    for output_name in outputs_to_update:
        if output_name not in orig_graph_outputs:
            raise ValueError(f"{output_name} is not a graph output")

    orig_tensor_names = set()
    orig_tensor_names.update(set(orig_graph_inputs))
    orig_tensor_names.update(set(orig_graph_outputs))
    orig_tensor_names.update(input_name for node in graph.node for input_name in node.input if input_name)

    # Maps original input (or output) name to its updated name used within the graph.
    io_map = InputOutputNameMap(orig_tensor_names, orig_graph_inputs, orig_graph_outputs)

    # Update each node's inputs/outputs to use the transposed versions.
    for node in graph.node:
        for i in range(len(node.input)):
            if node.input[i] and node.input[i] in inputs_to_update:
                node.input[i] = io_map.get_new_name(node.input[i])
            elif node.input[i] and node.input[i] in outputs_to_update:
                node.input[i] = io_map.get_new_name(node.input[i])

        for i in range(len(node.output)):
            if node.output[i] in outputs_to_update:
                node.output[i] = io_map.get_new_name(node.output[i])

    # Update graph inputs to channel-last and a Transpose (to channel-first) after each.
    for g_input_name in inputs_to_update:
        g_input = orig_graph_inputs[g_input_name]

        if not g_input.type.HasField("tensor_type") or not g_input.type.tensor_type.HasField("shape"):
            raise ValueError(f"Expected input {g_input.name} to have a tensor_type with a shape")

        input_shape = g_input.type.tensor_type.shape
        input_rank = len(input_shape.dim)

        if input_rank < 3:
            raise ValueError(f"Expected input {g_input.name} to be of rank >= 3")

        channel_dim = onnx.TensorShapeProto.Dimension()
        channel_dim.CopyFrom(input_shape.dim[1])
        for i in range(1, input_rank - 1):
            input_shape.dim[i].CopyFrom(input_shape.dim[i + 1])
        input_shape.dim[input_rank - 1].CopyFrom(channel_dim)

        transpose_perm = list(range(input_rank))
        for i in range(input_rank):
            transpose_perm[i] = i if i < 1 else i - 1
        transpose_perm[1] = input_rank - 1

        transpose_node = onnx.helper.make_node(
            "Transpose",
            name=f"{transpose_node_name_prefix}{transpose_node_name_start_suffix!s}",
            inputs=[g_input.name],
            outputs=[io_map.get_new_name(g_input.name)],
            perm=transpose_perm,
        )
        transpose_node_name_start_suffix += 1

        graph.node.extend([transpose_node])

    # Update graph outputs to channel-last and a Transpose (from channel-first) before each.
    for g_output_name in outputs_to_update:
        g_output = orig_graph_outputs[g_output_name]
        if not g_output.type.HasField("tensor_type") or not g_output.type.tensor_type.HasField("shape"):
            raise ValueError(f"Expected output {g_output.name} to have a tensor_type with a shape")

        output_shape = g_output.type.tensor_type.shape
        output_rank = len(output_shape.dim)

        if output_rank < 3:
            raise ValueError(f"Expected output {g_output.name} to be of rank >= 3")

        channel_dim = onnx.TensorShapeProto.Dimension()
        channel_dim.CopyFrom(output_shape.dim[1])
        for i in range(1, output_rank - 1):
            output_shape.dim[i].CopyFrom(output_shape.dim[i + 1])
        output_shape.dim[output_rank - 1].CopyFrom(channel_dim)

        transpose_perm = list(range(output_rank))
        for i in range(output_rank):
            transpose_perm[i] = i if i == 0 else i + 1
        transpose_perm[output_rank - 1] = 1

        transpose_node = onnx.helper.make_node(
            "Transpose",
            name=f"{transpose_node_name_prefix}{transpose_node_name_start_suffix!s}",
            inputs=[io_map.get_new_name(g_output.name)],
            outputs=[g_output.name],
            perm=transpose_perm,
        )
        transpose_node_name_start_suffix += 1

        graph.node.extend([transpose_node])

    graph.value_info.extend(io_map.new_value_infos)
