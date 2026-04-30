# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import json
from argparse import ArgumentParser

import onnx
from onnx import TensorProto, helper


def graph_topological_sort(graph):
    deps_count = [0] * len(graph.node)  # dependency count of each node
    deps_to_nodes = {}  # input to node indice
    sorted_nodes = []  # initialize sorted_nodes
    for node_idx, node in enumerate(graph.node):
        # CANNOT use len(node.input) directly because input can be optional
        deps_count[node_idx] = sum(1 for _ in node.input if _)
        if deps_count[node_idx] == 0:  # Constant doesn't depend on any inputs
            sorted_nodes.append(graph.node[node_idx])
            continue

        for input_name in node.input:
            if input_name not in deps_to_nodes:
                deps_to_nodes[input_name] = [node_idx]
            else:
                deps_to_nodes[input_name].append(node_idx)

    # Note: this logic only applies to top level graph since a sub graph could use intializer from parent graph
    initializer_names = [init.name for init in graph.initializer]
    graph_input_names = [input.name for input in graph.input]
    input_names = initializer_names + graph_input_names
    input_names.sort()
    prev_input_name = None
    for input_name in input_names:
        if prev_input_name == input_name:
            continue

        prev_input_name = input_name
        if input_name in deps_to_nodes:
            for node_idx in deps_to_nodes[input_name]:
                deps_count[node_idx] = deps_count[node_idx] - 1
                if deps_count[node_idx] == 0:
                    sorted_nodes.append(graph.node[node_idx])

    start = 0
    end = len(sorted_nodes)

    while start < end:
        for output in sorted_nodes[start].output:
            if output in deps_to_nodes:
                for node_idx in deps_to_nodes[output]:
                    deps_count[node_idx] = deps_count[node_idx] - 1
                    if deps_count[node_idx] == 0:
                        sorted_nodes.append(graph.node[node_idx])
                        end = end + 1
        start = start + 1

    assert end == len(graph.node), "Graph is not a DAG"
    graph.ClearField("node")
    graph.node.extend(sorted_nodes)


class QnnTensorStruct:
    def __init__(self):
        self.name = ""
        self.onnx_data_type = TensorProto.FLOAT
        self.dim = []


def qnn_data_type_to_onnx_data_type(qnn_data_type):
    # QNN_DATATYPE_UFIXED_POINT_8 QNN_DATATYPE_UINT_8
    if qnn_data_type == 0x0408 or qnn_data_type == 0x0108:
        return TensorProto.UINT8
    # QNN_DATATYPE_UFIXED_POINT_16 QNN_DATATYPE_UINT_16
    elif qnn_data_type == 0x0416 or qnn_data_type == 0x0116:
        return TensorProto.UINT16
    # QNN_DATATYPE_UFIXED_POINT_32 QNN_DATATYPE_UINT_32
    elif qnn_data_type == 0x0432 or qnn_data_type == 0x0132:
        return TensorProto.UINT32
    # QNN_DATATYPE_UINT_64
    elif qnn_data_type == 0x0164:
        return TensorProto.UINT64
    # QNN_DATATYPE_FIXED_POINT_8 QNN_DATATYPE_INT_8
    elif qnn_data_type == 0x0308 or qnn_data_type == 0x0008:
        return TensorProto.INT8
    # QNN_DATATYPE_FIXED_POINT_16 QNN_DATATYPE_INT_16
    elif qnn_data_type == 0x0316 or qnn_data_type == 0x0016:
        return TensorProto.INT16
    # QNN_DATATYPE_FIXED_POINT_32 QNN_DATATYPE_INT_32
    elif qnn_data_type == 0x0332 or qnn_data_type == 0x0032:
        return TensorProto.INT32
    # QNN_DATATYPE_INT_64
    elif qnn_data_type == 0x0064:
        return TensorProto.INT64
    # QNN_DATATYPE_FLOAT_16
    elif qnn_data_type == 0x0216:
        return TensorProto.FLOAT16
    # QNN_DATATYPE_FLOAT_32
    elif qnn_data_type == 0x0232:
        return TensorProto.FLOAT
    # QNN_DATATYPE_BOOL_8
    elif qnn_data_type == 0x0508:
        return TensorProto.BOOL
    else:
        return TensorProto.UNDEFINED


def parse_qnn_json_file(qnn_json_file_path, qnn_input_output_tensor_dic):
    with open(qnn_json_file_path) as qnn_json_file:
        qnn_json = json.load(qnn_json_file)
        assert "graph" in qnn_json, "QNN converted json file not valid. Can't find graph."
        assert "tensors" in qnn_json["graph"], "QNN converted json file not valid. Can't find tensors."
        for qnn_tensor_name, qnn_tensor_attribute in qnn_json["graph"]["tensors"].items():
            # type:0 - QNN input tensor, type:1 - QNN output tensor
            assert (
                "type" in qnn_tensor_attribute
                and "data_type" in qnn_tensor_attribute
                and "dims" in qnn_tensor_attribute
            ), "QNN converted json file not valid. Can't find some keys from tensors"
            if qnn_tensor_attribute["type"] == 0 or qnn_tensor_attribute["type"] == 1:
                qnn_tensor = QnnTensorStruct()
                qnn_tensor.name = qnn_tensor_name
                qnn_tensor.onnx_data_type = qnn_data_type_to_onnx_data_type(qnn_tensor_attribute["data_type"])
                qnn_tensor.dim = qnn_tensor_attribute["dims"]
                qnn_input_output_tensor_dic[qnn_tensor_name] = qnn_tensor

    assert len(qnn_input_output_tensor_dic) > 1, (
        "Converted QNN model not valid. It should have at least 1 input & 1 output."
    )


def compare_onnx_shape_with_qnn_shape(onnx_dims, qnn_dims):
    assert len(onnx_dims) == len(qnn_dims), "Onnx shape and Qnn shape has different rank."
    return all(onnx_dims[i].dim_value == qnn_dims[i] for i in range(len(onnx_dims)))


def gen_to_channel_first_perm(rank):
    assert rank > 2, "Shape rank should >2 for the Transpose node."
    perm = []
    perm.append(0)
    perm.append(rank - 1)
    for i in range(1, rank - 1):
        perm.append(i)  # noqa: PERF402

    return perm


def gen_to_channel_last_perm(rank):
    assert rank > 2, "Shape rank should >2 for the Transpose node."
    perm = []
    perm.append(0)
    for i in range(2, rank):
        perm.append(i)  # noqa: PERF402
    perm.append(1)

    return perm


# Onnxruntime QNN EP can support context binary file generated by QNN tool chain. However QNN generated context binary file
# uses channel last data layout and 8 bits or 16 bits for input and output.
# This script gets the QNN model input & output information from QNN converted model_net.json file, compare them with Onnx model
# and inserts Cast, Transpose nodes to Onnx model if required
def main():
    parser = ArgumentParser(
        "Insert Cast, Transpose nodes into Onnx model to make it aligned with QNN generated context binary."
    )
    parser.add_argument("-m", "--onnx_model", help="Required. Path to Onnx model file.", required=True, type=str)
    parser.add_argument(
        "-q", "--qnn_json", help="Required. Path to Qnn converted model_net.json file.", required=True, type=str
    )
    args = parser.parse_args()

    # Parse Qnn model_net.json file to get the graph input output information
    qnn_input_output_tensor_dic = {}
    parse_qnn_json_file(args.qnn_json, qnn_input_output_tensor_dic)

    model = onnx.load(args.onnx_model)

    nodes_to_add = []
    # Tranch the tensor name change to update the consumer nodes
    graph_input_output_name_dic = {}
    for graph_input in model.graph.input:
        if graph_input.name in qnn_input_output_tensor_dic:
            input_name_fater_node_insert = graph_input.name
            qnn_input_tensor = qnn_input_output_tensor_dic[graph_input.name]
            # Insert Cast node if Onnx input and Qnn input has different data type
            if graph_input.type.tensor_type.elem_type != qnn_input_tensor.onnx_data_type:
                # Insert Cast node
                cast_input_name = input_name_fater_node_insert
                cast_output_name = cast_input_name + "_qnn_cast"
                input_cast_node = helper.make_node(
                    "Cast",
                    name=cast_output_name,
                    inputs=[cast_input_name],
                    outputs=[cast_output_name],
                    to=graph_input.type.tensor_type.elem_type,
                )
                # Change input data type to Qnn input data type
                graph_input.type.tensor_type.elem_type = qnn_input_tensor.onnx_data_type
                nodes_to_add.extend([input_cast_node])
                input_name_fater_node_insert = cast_output_name
                graph_input_output_name_dic[graph_input.name] = cast_output_name

            if not compare_onnx_shape_with_qnn_shape(graph_input.type.tensor_type.shape.dim, qnn_input_tensor.dim):
                # Add Transpose node (channel last to channel first)
                transpose_perm = gen_to_channel_first_perm(len(graph_input.type.tensor_type.shape.dim))
                transpose_input_name = input_name_fater_node_insert
                transpose_output_name = transpose_input_name + "_qnn_trans"
                input_transpose_node = helper.make_node(
                    "Transpose",
                    name=transpose_output_name,
                    inputs=[transpose_input_name],
                    outputs=[transpose_output_name],
                    perm=transpose_perm,
                )
                nodes_to_add.extend([input_transpose_node])
                graph_input_output_name_dic[graph_input.name] = transpose_output_name

                # Change input shape to Qnn input shape
                for i in range(len(graph_input.type.tensor_type.shape.dim)):
                    graph_input.type.tensor_type.shape.dim[i].dim_value = qnn_input_tensor.dim[i]
        else:
            raise AssertionError("Error: Onnx model input: " + graph_input.name + " not exist from QNN model input.")

    for graph_output in model.graph.output:
        if graph_output.name in qnn_input_output_tensor_dic:
            output_name_after_node_insert = graph_output.name
            # Insert Cast node if Onnx input and Qnn input has idfferent data type
            qnn_output_tensor = qnn_input_output_tensor_dic[graph_output.name]
            if graph_output.type.tensor_type.elem_type != qnn_output_tensor.onnx_data_type:
                # Insert Cast node
                cast_output_name = output_name_after_node_insert
                cast_input_name = cast_output_name + "_qnn_cast"
                output_cast_node = helper.make_node(
                    "Cast",
                    name=cast_input_name,
                    inputs=[cast_input_name],
                    outputs=[cast_output_name],
                    to=qnn_output_tensor.onnx_data_type,
                )
                # Change output data type to Onn output data type
                graph_output.type.tensor_type.elem_type = qnn_output_tensor.onnx_data_type
                nodes_to_add.extend([output_cast_node])
                output_name_after_node_insert = cast_input_name
                graph_input_output_name_dic[graph_output.name] = cast_input_name

            if not compare_onnx_shape_with_qnn_shape(graph_output.type.tensor_type.shape.dim, qnn_output_tensor.dim):
                # Add Transpose node (channel first to channel last)
                transpose_perm = gen_to_channel_last_perm(len(graph_output.type.tensor_type.shape.dim))
                transpose_output_name = output_name_after_node_insert
                transpose_input_name = transpose_output_name + "_qnn_trans"
                output_transpose_node = helper.make_node(
                    "Transpose",
                    name=transpose_input_name,
                    inputs=[transpose_input_name],
                    outputs=[transpose_output_name],
                    perm=transpose_perm,
                )
                nodes_to_add.extend([output_transpose_node])
                graph_input_output_name_dic[graph_output.name] = transpose_input_name

                # Change output shape to Qnn output shape
                for i in range(len(graph_output.type.tensor_type.shape.dim)):
                    graph_output.type.tensor_type.shape.dim[i].dim_value = qnn_input_output_tensor_dic[
                        graph_output.name
                    ].dim[i]
        else:
            raise AssertionError("Error: Onnx model output: " + graph_output.name + " not exist from QNN model output.")

    for node in model.graph.node:
        for node_input_index, node_input in enumerate(node.input):
            # update consumer node for graph inputs to connect to inserted node
            if node_input in graph_input_output_name_dic:
                node.input[node_input_index] = graph_input_output_name_dic[node_input]

        for node_output_index, node_output in enumerate(node.output):
            # update producer node for graph outputs to connect to inserted node
            if node_output in graph_input_output_name_dic:
                node.output[node_output_index] = graph_input_output_name_dic[node_output]

    model.graph.node.extend(nodes_to_add)
    graph_topological_sort(model.graph)

    # Add extra parameter all_tensors_to_one_file=False, size_threshold=5000 if the model exceeds protobuf 2GB limit e.g below
    # onnx.save(model, args.onnx_model.replace(".onnx", "_add_trans.onnx"), all_tensors_to_one_file=False, size_threshold=5000)
    onnx.save(model, args.onnx_model.replace(".onnx", "_add_trans.onnx"))


if __name__ == "__main__":
    main()
