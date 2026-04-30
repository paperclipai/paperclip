# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# This file is modified from https://github.com/microsoft/onnxconverter-common/blob/master/onnxconverter_common/float16.py
# Modifications:
# (1) Update default value of min_positive_val and max_finite_val
# (2) keep_io_types can be list of names
# (3) convert initializers if needed to preserve precision
# (4) add force_fp16_initializers option
# (5) handle Resize and GroupNorm with mixed float inputs
# (6) allow convert_float_to_float16 to accept model path

import itertools
import logging
import os
import tempfile

import numpy as np
import onnx
from onnx import AttributeProto, GraphProto, ModelProto, NodeProto, TensorProto, helper, numpy_helper
from onnx.shape_inference import infer_shapes, infer_shapes_path
from packaging import version

logger = logging.getLogger(__name__)


def _npfloat16_to_int(np_list):
    """
    Convert numpy float16 to python int.

    :param np_list: numpy float16 list
    :return int_list: python int list
    """
    return [int(bin(_.view("H"))[2:].zfill(16), 2) for _ in np_list]


def convert_np_to_float16(np_array, min_positive_val=5.96e-08, max_finite_val=65504.0):
    """
    Convert float32 numpy array to float16 without changing sign or finiteness.
    Positive values less than min_positive_val are mapped to min_positive_val.
    Positive finite values greater than max_finite_val are mapped to max_finite_val.
    Similar for negative values. NaN, 0, inf, and -inf are unchanged.
    """

    def between(a, b, c):
        return np.logical_and(a < b, b < c)

    if np_array[np.where(np_array > 0)].shape[0] > 0:
        positive_max = np_array[np.where(np_array > 0)].max()
        positive_min = np_array[np.where(np_array > 0)].min()
        if positive_max >= max_finite_val:
            logger.debug(f"the float32 number {positive_max} will be truncated to {max_finite_val}")
        if positive_min <= min_positive_val:
            logger.debug(f"the float32 number {positive_min} will be truncated to {min_positive_val}")

    if np_array[np.where(np_array < 0)].shape[0] > 0:
        negative_max = np_array[np.where(np_array < 0)].max()
        negative_min = np_array[np.where(np_array < 0)].min()
        if negative_min <= -max_finite_val:
            logger.debug(f"the float32 number {negative_min} will be truncated to {-max_finite_val}")
        if negative_max >= -min_positive_val:
            logger.debug(f"the float32 number {negative_max} will be truncated to {-min_positive_val}")

    np_array = np.where(between(0, np_array, min_positive_val), min_positive_val, np_array)
    np_array = np.where(between(-min_positive_val, np_array, 0), -min_positive_val, np_array)
    np_array = np.where(between(max_finite_val, np_array, float("inf")), max_finite_val, np_array)
    np_array = np.where(between(float("-inf"), np_array, -max_finite_val), -max_finite_val, np_array)
    return np.float16(np_array)


def convert_tensor_float_to_float16(tensor, min_positive_val=5.96e-08, max_finite_val=65504.0):
    """Convert tensor float to float16.

    Args:
        tensor (TensorProto): the tensor to convert.
        min_positive_val (float, optional): minimal positive value. Defaults to 1e-7.
        max_finite_val (float, optional): maximal finite value. Defaults to 1e4.

    Raises:
        ValueError: input type is not TensorProto.

    Returns:
        TensorProto: the converted tensor.
    """

    if not isinstance(tensor, TensorProto):
        raise ValueError(f"Expected input type is an ONNX TensorProto but got {type(tensor)}")

    if tensor.data_type == TensorProto.FLOAT:
        tensor.data_type = TensorProto.FLOAT16
        # convert float_data (float type) to float16 and write to int32_data
        if tensor.float_data:
            float16_data = convert_np_to_float16(np.array(tensor.float_data), min_positive_val, max_finite_val)
            int_list = _npfloat16_to_int(float16_data)
            tensor.int32_data[:] = int_list
            tensor.float_data[:] = []
        # convert raw_data (bytes type)
        if tensor.raw_data:
            # convert n.raw_data to float
            float32_list = np.frombuffer(tensor.raw_data, dtype="float32")
            # convert float to float16
            float16_list = convert_np_to_float16(float32_list, min_positive_val, max_finite_val)
            # convert float16 to bytes and write back to raw_data
            tensor.raw_data = float16_list.tobytes()
    return tensor


def make_value_info_from_tensor(tensor):
    shape = numpy_helper.to_array(tensor).shape
    return helper.make_tensor_value_info(tensor.name, tensor.data_type, shape)


DEFAULT_OP_BLOCK_LIST = [
    "ArrayFeatureExtractor",
    "Binarizer",
    "CastMap",
    "CategoryMapper",
    "DictVectorizer",
    "FeatureVectorizer",
    "Imputer",
    "LabelEncoder",
    "LinearClassifier",
    "LinearRegressor",
    "Normalizer",
    "OneHotEncoder",
    "RandomUniformLike",
    "SVMClassifier",
    "SVMRegressor",
    "Scaler",
    "TreeEnsembleClassifier",
    "TreeEnsembleRegressor",
    "TreeEnsemble",
    "ZipMap",
    "NonMaxSuppression",
    "TopK",
    "RoiAlign",
    "Range",
    "CumSum",
    "Min",
    "Max",
    "Upsample",
]


# Some operators has data type fixed as float for some inputs. Key is op_type, value is list of input indices
# Note that DirectML allows float16 gamma and beta in GroupNorm. Use force_fp16_inputs parameter could overwrite this.
ALWAYS_FLOAT_INPUTS = {"Resize": [2], "GroupNorm": [1, 2], "SkipGroupNorm": [1, 2]}


class InitializerTracker:
    """Class for keeping track of initializer."""

    def __init__(self, initializer: TensorProto):
        self.initializer = initializer
        self.fp32_nodes = []
        self.fp16_nodes = []

    def add_node(self, node: NodeProto, is_node_blocked):
        if is_node_blocked:
            self.fp32_nodes.append(node)
        else:
            self.fp16_nodes.append(node)


def convert_float_to_float16(
    model,
    min_positive_val=5.96e-08,
    max_finite_val=65504.0,
    keep_io_types=False,
    disable_shape_infer=False,
    op_block_list=None,
    node_block_list=None,
    force_fp16_initializers=False,
    force_fp16_inputs=None,
    use_bfloat16_as_blocked_nodes_dtype=False,
):
    """Convert tensor float type in the input ONNX model to tensor float16.

    Args:
        model (ModelProto or str): The ONNX model or path of the model to convert.
        min_positive_val (float, optional): minimal positive value. Defaults to 5.96e-08.
        max_finite_val (float, optional): maximal finite value of float16. Defaults to 65504.
        keep_io_types (Union[bool, List[str]], optional): It could be boolean or a list of float32 input/output names.
                                                          If True, model inputs/outputs should be left as float32.
                                                          Defaults to False.
        disable_shape_infer (bool, optional): Skips running onnx shape/type inference.
                                              Useful if shape inference has been done. Defaults to False.
        op_block_list (List[str], optional): List of op types to leave as float32.
                                             Defaults to None, which will use `float16.DEFAULT_OP_BLOCK_LIST`.
        node_block_list (List[str], optional): List of node names to leave as float32. Defaults to None.
        force_fp16_initializers(bool): force converting all float initializers to float16.
                                       Default to false, which will convert only the one needed to avoid precision loss.
        force_fp16_inputs(Dict[str, List[int]]): Force the conversion of the inputs of some operators to float16, even if
                                                 this script's preference it to keep them in float32.
    Raises:
        ValueError: input type is not ModelProto.

    Returns:
        ModelProto: converted model.
    """
    assert min_positive_val >= 5.96e-08, (
        "invalid min_positive_val. smallest positive float16 value: subnormal 5.96e-08, and normalized 6.104e-05"
    )
    assert max_finite_val <= float(np.finfo(np.float16).max), "invalid max_finite_val. largest float16 value: 65504"

    force_fp16_inputs_dict = {} if force_fp16_inputs is None else force_fp16_inputs

    if isinstance(model, str):
        model_path = model
        if version.parse(onnx.__version__) >= version.parse("1.8.0") and not disable_shape_infer:
            # shape_infer_model_path should be in the same folder of model_path
            with tempfile.NamedTemporaryFile(dir=os.path.dirname(model_path)) as tmpfile:
                shape_infer_model_path = tmpfile.name
                # infer_shapes_path can be used for model >2GB, and infer_shapes cannot.
                infer_shapes_path(model_path, shape_infer_model_path)
                model = onnx.load(shape_infer_model_path)
                disable_shape_infer = True
        else:
            model = onnx.load(model_path)

    if not isinstance(model, ModelProto):
        raise ValueError(f"Expected an ONNX ModelProto but got {type(model)}")

    func_infer_shape = None
    if not disable_shape_infer and version.parse(onnx.__version__) >= version.parse("1.2.0"):
        try:
            func_infer_shape = infer_shapes
        finally:
            pass

    # create blocklists
    if op_block_list is None:
        op_block_list = DEFAULT_OP_BLOCK_LIST
    if node_block_list is None:
        node_block_list = []
    op_block_list = set(op_block_list)
    node_block_list = set(node_block_list)

    # Build opset-aware always_float_inputs: Resize input layout differs between opset 10 and 11+.
    # Opset 10: [X, scales] — scales at index 1 must stay float32.
    # Opset 11+: [X, roi, scales, sizes] — scales at index 2 must stay float32; roi (index 1) allows fp16.
    onnx_opset = max((o.version for o in model.opset_import if o.domain in ("", "ai.onnx")), default=11)
    always_float_inputs = dict(ALWAYS_FLOAT_INPUTS)
    if onnx_opset <= 10:
        always_float_inputs["Resize"] = [1]

    logger.debug(
        f"fp16 parameters: min_positive_val={min_positive_val} max_finite_val={max_finite_val} keep_io_types={keep_io_types} disable_shape_infer={disable_shape_infer} op_block_list={op_block_list} node_block_list={node_block_list} force_fp16_initializers={force_fp16_initializers}"
    )

    # create a queue for BFS
    queue = []
    value_info_list = []
    node_list = []

    # Some operators (Like Resize or GroupNorm) have data type fixed as float for some input.
    # When it is converted to float16, there are mixed types: some inputs are float32 and some are float16.
    # This list keeps track of such nodes that are not in block list.
    mixed_float_type_node_list = []

    # type inference on input model
    if func_infer_shape is not None:
        model = func_infer_shape(model)
    queue.append(model)
    name_mapping = {}
    graph_io_to_skip = set()
    io_casts = set()

    fp32_inputs = [n.name for n in model.graph.input if n.type.tensor_type.elem_type == TensorProto.FLOAT]
    fp32_outputs = [n.name for n in model.graph.output if n.type.tensor_type.elem_type == TensorProto.FLOAT]
    if isinstance(keep_io_types, list):
        fp32_inputs = [n for n in fp32_inputs if n in keep_io_types]
        fp32_outputs = [n for n in fp32_outputs if n in keep_io_types]
    elif not keep_io_types:
        fp32_inputs = []
        fp32_outputs = []

    for i, n in enumerate(model.graph.input):
        if n.name in fp32_inputs:
            output_name = "graph_input_cast_" + str(i)
            name_mapping[n.name] = output_name
            graph_io_to_skip.add(n.name)

            node_name = "graph_input_cast" + str(i)
            new_value_info = model.graph.value_info.add()
            new_value_info.CopyFrom(n)
            new_value_info.name = output_name
            new_value_info.type.tensor_type.elem_type = TensorProto.FLOAT16
            # add Cast node (from tensor(float) to tensor(float16) after graph input
            new_node = [helper.make_node("Cast", [n.name], [output_name], to=TensorProto.FLOAT16, name=node_name)]
            model.graph.node.extend(new_node)
            value_info_list.append(new_value_info)
            io_casts.add(node_name)

    for i, n in enumerate(model.graph.output):
        if n.name in fp32_outputs:
            input_name = "graph_output_cast_" + str(i)
            name_mapping[n.name] = input_name
            graph_io_to_skip.add(n.name)

            node_name = "graph_output_cast" + str(i)
            # add Cast node (from tensor(float16) to tensor(float) before graph output
            new_value_info = model.graph.value_info.add()
            new_value_info.CopyFrom(n)
            new_value_info.name = input_name
            new_value_info.type.tensor_type.elem_type = TensorProto.FLOAT16
            new_node = [helper.make_node("Cast", [input_name], [n.name], to=1, name=node_name)]
            model.graph.node.extend(new_node)
            value_info_list.append(new_value_info)
            io_casts.add(node_name)

    fp32_initializers: dict[str, InitializerTracker] = {}
    while queue:
        next_level = []
        for q in queue:
            # if q is model, push q.graph (GraphProto)
            if isinstance(q, ModelProto):
                next_level.append(q.graph)
            # if q is model.graph, push q.node.attribute (AttributeProto)
            if isinstance(q, GraphProto):
                for n in q.initializer:  # TensorProto type
                    if n.data_type == TensorProto.FLOAT:
                        assert n.name not in fp32_initializers
                        fp32_initializers[n.name] = InitializerTracker(n)

                for n in q.node:
                    # if n is in the block list (doesn't support float16), no conversion for the node,
                    # and save the node for further processing
                    if n.name in io_casts:
                        continue
                    for i in range(len(n.input)):
                        if n.input[i] in name_mapping:
                            n.input[i] = name_mapping[n.input[i]]
                    for i in range(len(n.output)):
                        if n.output[i] in name_mapping:
                            n.output[i] = name_mapping[n.output[i]]

                    is_node_blocked = n.op_type in op_block_list or n.name in node_block_list
                    for i, input_name in enumerate(n.input):
                        if input_name in fp32_initializers:
                            # For Resize/GroupNorm, only the first input can be float16
                            use_fp32_weight = is_node_blocked or (
                                i in always_float_inputs.get(n.op_type, [])
                                and i not in force_fp16_inputs_dict.get(n.op_type, [])
                            )
                            fp32_initializers[input_name].add_node(n, use_fp32_weight)

                    if is_node_blocked:
                        node_list.append(n)
                    else:
                        if n.op_type == "Cast":
                            for attr in n.attribute:
                                if attr.name == "to" and attr.i == TensorProto.FLOAT:
                                    attr.i = TensorProto.FLOAT16
                                    break

                        if n.op_type in [
                            "EyeLike",
                            "Multinomial",
                            "RandomNormal",
                            "RandomNormalLike",
                            "RandomUniform",
                            "RandomUniformLike",
                            "SequenceEmpty",
                            "Bernoulli",
                        ]:
                            has_dtype = False
                            for attr in n.attribute:
                                if attr.name == "dtype":
                                    has_dtype = True
                                    if attr.i == TensorProto.FLOAT:
                                        attr.i = TensorProto.FLOAT16

                            # The dtype attribute is optional and default is FLOAT in the following operators
                            # so we need add dtype attribute to specify the data type float16
                            if (n.op_type in ["RandomNormal", "RandomUniform", "SequenceEmpty"]) and not has_dtype:
                                n.attribute.extend([helper.make_attribute("dtype", TensorProto.FLOAT16)])

                        # For Resize/GroupNorm, attribute data type cannot be changed
                        if n.op_type not in always_float_inputs or n.op_type in force_fp16_inputs_dict:
                            for attr in n.attribute:
                                next_level.append(attr)  # noqa: PERF402
                        else:
                            mixed_float_type_node_list.append(n)

            # if q is model.graph.node.attribute, push q.g and q.graphs (GraphProto)
            # and process node.attribute.t and node.attribute.tensors (TensorProto)
            if isinstance(q, AttributeProto):
                next_level.append(q.g)
                for n in q.graphs:
                    next_level.append(n)  # noqa: PERF402
                q.t.CopyFrom(convert_tensor_float_to_float16(q.t, min_positive_val, max_finite_val))
                for n in q.tensors:
                    n = convert_tensor_float_to_float16(n, min_positive_val, max_finite_val)  # noqa: PLW2901
            # if q is graph, process input, output and value_info (ValueInfoProto)
            if isinstance(q, GraphProto):
                # Note that float initializers tracked by fp32_initializers will be processed later.
                # for all ValueInfoProto with tensor(float) type in input, output and value_info, convert them to
                # tensor(float16) except map and seq(map). And save them in value_info_list for further processing
                for n in itertools.chain(q.input, q.output, q.value_info):
                    if n.type.tensor_type.elem_type == TensorProto.FLOAT:
                        if n.name not in graph_io_to_skip:
                            n.type.tensor_type.elem_type = TensorProto.FLOAT16
                            value_info_list.append(n)
                    if n.type.HasField("sequence_type"):
                        if n.type.sequence_type.elem_type.tensor_type.elem_type == TensorProto.FLOAT:
                            if n.name not in graph_io_to_skip:
                                n.type.sequence_type.elem_type.tensor_type.elem_type = TensorProto.FLOAT16
                                value_info_list.append(n)

        queue = next_level

    for value in fp32_initializers.values():
        # By default, to avoid precision loss, do not convert an initializer to fp16 when it is used only by fp32 nodes.
        if force_fp16_initializers or value.fp16_nodes:
            value.initializer = convert_tensor_float_to_float16(value.initializer, min_positive_val, max_finite_val)
            value_info_list.append(make_value_info_from_tensor(value.initializer))
            if value.fp32_nodes and not force_fp16_initializers:
                logger.info(
                    f"initializer is used by both fp32 and fp16 nodes. Consider add these nodes to block list:{value.fp16_nodes}"
                )

    # Some operators have data type fixed as float for some input. Add a float16 to float cast for those inputs.
    for node in mixed_float_type_node_list:
        for i, input_name in enumerate(node.input):
            if i not in always_float_inputs[node.op_type] or i in force_fp16_inputs_dict.get(node.op_type, []):
                continue
            for value_info in value_info_list:
                if input_name == value_info.name:
                    # create new value_info for current node's new input name
                    new_value_info = model.graph.value_info.add()
                    new_value_info.CopyFrom(value_info)
                    output_name = input_name + "_cast_to_fp32"
                    new_value_info.name = output_name
                    new_value_info.type.tensor_type.elem_type = TensorProto.FLOAT
                    # add Cast node (from tensor(float16) to tensor(float) before current node
                    node_name = input_name + "_cast_to_fp32_node"
                    new_node = [helper.make_node("Cast", [input_name], [output_name], to=1, name=node_name)]
                    model.graph.node.extend(new_node)
                    # change current node's input name
                    node.input[i] = output_name
                    break

    accuracy_type = TensorProto.BFLOAT16 if use_bfloat16_as_blocked_nodes_dtype else TensorProto.FLOAT
    # process the nodes in block list that doesn't support tensor(float16)
    for node in node_list:
        # if input's name is in the value_info_list meaning input is tensor(float16) type,
        # insert a float16 to float Cast node before the node,
        # change current node's input name and create new value_info for the new name
        for i in range(len(node.input)):
            input_name = node.input[i]
            for value_info in value_info_list:
                if input_name == value_info.name:
                    # create new value_info for current node's new input name
                    new_value_info = model.graph.value_info.add()
                    new_value_info.CopyFrom(value_info)
                    output_name = input_name + "_cast_to_fp32"
                    new_value_info.name = output_name
                    new_value_info.type.tensor_type.elem_type = accuracy_type
                    # add Cast node (from tensor(float16) to tensor(float) before current node
                    node_name = input_name + "_cast_to_fp32_node"
                    new_node = [helper.make_node("Cast", [input_name], [output_name], to=accuracy_type, name=node_name)]
                    model.graph.node.extend(new_node)
                    # change current node's input name
                    node.input[i] = output_name
                    break
        # if output's name is in the value_info_list meaning output is tensor(float16) type, insert a float to
        # float16 Cast node after the node, change current node's output name and create new value_info for the new name
        for i in range(len(node.output)):
            output = node.output[i]
            for value_info in value_info_list:
                if output == value_info.name:
                    # create new value_info for current node's new output
                    new_value_info = model.graph.value_info.add()
                    new_value_info.CopyFrom(value_info)
                    output_cast_name = output + "_cast_to_fp16"
                    new_value_info.name = output_cast_name
                    new_value_info.type.tensor_type.elem_type = accuracy_type
                    # add Cast node (from tensor(float) to tensor(float16) after current node
                    node_name = output + "_cast_to_fp16_node"
                    new_node = [helper.make_node("Cast", [output_cast_name], [output], to=10, name=node_name)]
                    model.graph.node.extend(new_node)
                    # change current node's output name
                    node.output[i] = output_cast_name
                    break
    return model


def float_to_float16_max_diff(tensor, min_positive_val=5.96e-08, max_finite_val=65504.0):
    """Measure the maximum absolute difference after converting a float tensor to float16."""
    if not isinstance(tensor, TensorProto):
        raise ValueError(f"Expected input type is an ONNX TensorProto but got {type(tensor)}")
    if tensor.data_type != TensorProto.FLOAT:
        raise ValueError("Expected tensor data type is float.")

    float32_data = None
    if tensor.float_data:
        float32_data = np.array(tensor.float_data)

    if tensor.raw_data:
        float32_data = np.frombuffer(tensor.raw_data, dtype="float32")

    if float32_data is None:
        raise RuntimeError("external data not loaded!")

    float16_data = convert_np_to_float16(float32_data, min_positive_val, max_finite_val)
    return np.amax(np.abs(float32_data - np.float32(float16_data)))
