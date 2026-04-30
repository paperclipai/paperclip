# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import json
from argparse import ArgumentParser

import onnx
from onnx import TensorProto, helper


class QnnTensorStruct:
    def __init__(
        self, name="", onnx_data_type=TensorProto.FLOAT, is_quantized=False, scale=0.0, offset=0, dim=None, id=None
    ):
        self.name = name
        self.onnx_data_type = onnx_data_type
        self.is_quantized = is_quantized
        self.scale = scale
        self.offset = offset
        self.dim = [] if dim is None else dim
        self.id = id


def is_quantized_data_type(qnn_data_type, is_converter_json):
    if is_converter_json:
        # QNN_DATATYPE_UFIXED_POINT_8 QNN_DATATYPE_UFIXED_POINT_16 QNN_DATATYPE_FIXED_POINT_8 QNN_DATATYPE_FIXED_POINT_16
        return qnn_data_type == 0x0408 or qnn_data_type == 0x0416 or qnn_data_type == 0x0308 or qnn_data_type == 0x0316
    else:
        return (
            qnn_data_type == "QNN_DATATYPE_UFIXED_POINT_8"
            or qnn_data_type == "QNN_DATATYPE_UFIXED_POINT_16"
            or qnn_data_type == "QNN_DATATYPE_FIXED_POINT_8"
            or qnn_data_type == "QNN_DATATYPE_FIXED_POINT_16"
        )


def qnn_data_type_to_onnx_data_type(qnn_data_type, is_converter_json):
    if is_converter_json:
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
    else:
        # QNN_DATATYPE_UFIXED_POINT_8 QNN_DATATYPE_UINT_8
        if qnn_data_type == "QNN_DATATYPE_UFIXED_POINT_8" or qnn_data_type == "QNN_DATATYPE_UINT_8":
            return TensorProto.UINT8
        # QNN_DATATYPE_UFIXED_POINT_16 QNN_DATATYPE_UINT_16
        elif qnn_data_type == "QNN_DATATYPE_UFIXED_POINT_16" or qnn_data_type == "QNN_DATATYPE_UINT_16":
            return TensorProto.UINT16
        # QNN_DATATYPE_UFIXED_POINT_32 QNN_DATATYPE_UINT_32
        elif qnn_data_type == "QNN_DATATYPE_UFIXED_POINT_32" or qnn_data_type == "QNN_DATATYPE_UINT_32":
            return TensorProto.UINT32
        # QNN_DATATYPE_UINT_64
        elif qnn_data_type == "QNN_DATATYPE_UINT_64":
            return TensorProto.UINT64
        # QNN_DATATYPE_FIXED_POINT_8 QNN_DATATYPE_INT_8
        elif qnn_data_type == "QNN_DATATYPE_FIXED_POINT_8" or qnn_data_type == "QNN_DATATYPE_INT_8":
            return TensorProto.INT8
        # QNN_DATATYPE_FIXED_POINT_16 QNN_DATATYPE_INT_16
        elif qnn_data_type == "QNN_DATATYPE_FIXED_POINT_16" or qnn_data_type == "QNN_DATATYPE_INT_16":
            return TensorProto.INT16
        # QNN_DATATYPE_FIXED_POINT_32 QNN_DATATYPE_INT_32
        elif qnn_data_type == "QNN_DATATYPE_FIXED_POINT_32" or qnn_data_type == "QNN_DATATYPE_INT_32":
            return TensorProto.INT32
        # QNN_DATATYPE_INT_64
        elif qnn_data_type == "QNN_DATATYPE_INT_64":
            return TensorProto.INT64
        # QNN_DATATYPE_FLOAT_16
        elif qnn_data_type == "QNN_DATATYPE_FLOAT_16":
            return TensorProto.FLOAT16
        # QNN_DATATYPE_FLOAT_32
        elif qnn_data_type == "QNN_DATATYPE_FLOAT_32":
            return TensorProto.FLOAT
        # QNN_DATATYPE_BOOL_8
        elif qnn_data_type == "QNN_DATATYPE_BOOL_8":
            return TensorProto.BOOL
        else:
            return TensorProto.UNDEFINED


def parse_qnn_converter_json_file(qnn_convert_json, qnn_input_tensor_dic, qnn_output_tensor_dic):
    is_qnn_converter_json = True
    for qnn_tensor_name, qnn_tensor_attribute in qnn_convert_json["graph"]["tensors"].items():
        # type:0 - QNN input tensor, type:1 - QNN output tensor
        assert (
            "type" in qnn_tensor_attribute
            and "data_type" in qnn_tensor_attribute
            and "dims" in qnn_tensor_attribute
            and "id" in qnn_tensor_attribute
            and "quant_params" in qnn_tensor_attribute
        ), "QNN converted json file not valid. Can't find some keys from tensors"

        # If tensor is not IO, ignore it
        if qnn_tensor_attribute["type"] not in [0, 1]:
            continue

        # Get all graph inputs & output
        qnn_tensor = QnnTensorStruct(
            name=qnn_tensor_name,
            onnx_data_type=qnn_data_type_to_onnx_data_type(qnn_tensor_attribute["data_type"], is_qnn_converter_json),
            is_quantized=is_quantized_data_type(qnn_tensor_attribute["data_type"], is_qnn_converter_json),
            dim=qnn_tensor_attribute["dims"],
            id=qnn_tensor_attribute["id"],
        )

        if (
            qnn_tensor_attribute["quant_params"]["definition"] == 1
            and qnn_tensor_attribute["quant_params"]["encoding"] == 0
        ):
            qnn_tensor.scale = qnn_tensor_attribute["quant_params"]["scale_offset"]["scale"]
            qnn_tensor.offset = -qnn_tensor_attribute["quant_params"]["scale_offset"]["offset"]

        if qnn_tensor_attribute["type"] == 0:
            qnn_input_tensor_dic[qnn_tensor_name] = qnn_tensor
        else:
            qnn_output_tensor_dic[qnn_tensor_name] = qnn_tensor

    assert len(qnn_input_tensor_dic) >= 1 and len(qnn_output_tensor_dic) >= 1, (
        "Converted QNN model not valid. It should have at least 1 input & 1 output."
    )


def generate_wrapper_onnx_file(
    grap_name,
    model_file_name,
    qnn_input_tensor_dic,
    qnn_output_tensor_dic,
    disable_embed_mode,
    qnn_ctx_file,
    quantized_IO,
    qnn_sdk_version="unknown",
):
    graph_nodes = []
    ini_list = []
    value_infos = []

    model_inputs = []
    for qnn_input in sorted(qnn_input_tensor_dic.values(), key=lambda inp: inp.id):
        if qnn_input.is_quantized and not quantized_IO:
            q_scale_input_name = qnn_input.name + "_scale"
            q_offset_input_name = qnn_input.name + "_zp"
            q_scale = helper.make_tensor(q_scale_input_name, TensorProto.FLOAT, [], [qnn_input.scale])
            ini_list.append(q_scale)
            q_offset = helper.make_tensor(q_offset_input_name, qnn_input.onnx_data_type, [], [qnn_input.offset])
            ini_list.append(q_offset)
            input_name = qnn_input.name + "_dq"

            q_node = helper.make_node(
                "QuantizeLinear",
                name=qnn_input.name,
                inputs=[input_name, q_scale_input_name, q_offset_input_name],
                outputs=[qnn_input.name],
            )

            graph_nodes.append(q_node)
            model_inputs.append(helper.make_tensor_value_info(input_name, TensorProto.FLOAT, qnn_input.dim))
            value_infos.append(helper.make_tensor_value_info(qnn_input.name, qnn_input.onnx_data_type, qnn_input.dim))
        else:
            model_inputs.append(helper.make_tensor_value_info(qnn_input.name, qnn_input.onnx_data_type, qnn_input.dim))

    if disable_embed_mode:
        ep_cache_context_content = qnn_ctx_file
        ctx_embed_mode = 0
    else:
        with open(qnn_ctx_file, "rb") as file:
            ep_cache_context_content = file.read()
        ctx_embed_mode = 1

    qnn_ep_context_node = helper.make_node(
        "EPContext",
        name=grap_name,
        inputs=qnn_input_tensor_dic.keys(),
        outputs=qnn_output_tensor_dic.keys(),
        ep_cache_context=ep_cache_context_content,
        embed_mode=ctx_embed_mode,
        ep_sdk_version=qnn_sdk_version,
        source="Qnn",
        domain="com.microsoft",
    )
    graph_nodes.append(qnn_ep_context_node)

    model_outputs = []
    for qnn_output in sorted(qnn_output_tensor_dic.values(), key=lambda out: out.id):
        if qnn_output.is_quantized and not quantized_IO:
            dq_scale_input_name = qnn_output.name + "_scale"
            dq_offset_input_name = qnn_output.name + "_zp"
            dq_scale = helper.make_tensor(dq_scale_input_name, TensorProto.FLOAT, [], [qnn_output.scale])
            ini_list.append(dq_scale)
            dq_offset = helper.make_tensor(dq_offset_input_name, qnn_output.onnx_data_type, [], [qnn_output.offset])
            ini_list.append(dq_offset)
            output_name = qnn_output.name + "_dq"

            dq_node = helper.make_node(
                "DequantizeLinear",
                name=output_name,
                inputs=[qnn_output.name, dq_scale_input_name, dq_offset_input_name],
                outputs=[output_name],
            )

            graph_nodes.append(dq_node)
            model_outputs.append(helper.make_tensor_value_info(output_name, TensorProto.FLOAT, qnn_output.dim))
            value_infos.append(
                helper.make_tensor_value_info(qnn_output.name, qnn_output.onnx_data_type, qnn_output.dim)
            )
        else:
            model_outputs.append(
                helper.make_tensor_value_info(qnn_output.name, qnn_output.onnx_data_type, qnn_output.dim)
            )

    graph_def = helper.make_graph(graph_nodes, "qnn-onnx-model", model_inputs, model_outputs, ini_list, "", value_infos)

    model_def = helper.make_model(graph_def, producer_name="MS")

    onnx.save(model_def, model_file_name)


# parse Qnn graph from the json file that extracted from context binary file
def parse_qnn_graph(qnn_graph, qnn_input_tensor_dic, qnn_output_tensor_dic):
    is_qnn_converter_json = False
    graph_name = qnn_graph["info"]["graphName"]
    raw_inputs = qnn_graph["info"]["graphInputs"]
    raw_outputs = qnn_graph["info"]["graphOutputs"]

    for raw_input in raw_inputs:
        tensor_info = raw_input["info"]
        qnn_tensor = QnnTensorStruct()
        qnn_tensor.name = tensor_info["name"]
        qnn_tensor.onnx_data_type = qnn_data_type_to_onnx_data_type(tensor_info["dataType"], is_qnn_converter_json)
        qnn_tensor.is_quantized = is_quantized_data_type(tensor_info["dataType"], is_qnn_converter_json)
        qnn_tensor.dim = tensor_info["dimensions"]
        if (
            tensor_info["quantizeParams"]["definition"] == "QNN_DEFINITION_DEFINED"
            and tensor_info["quantizeParams"]["quantizationEncoding"] == "QNN_QUANTIZATION_ENCODING_SCALE_OFFSET"
        ):
            qnn_tensor.scale = tensor_info["quantizeParams"]["scaleOffset"]["scale"]
            qnn_tensor.offset = 0 - tensor_info["quantizeParams"]["scaleOffset"]["offset"]
        qnn_input_tensor_dic[qnn_tensor.name] = qnn_tensor

    for raw_output in raw_outputs:
        tensor_info = raw_output["info"]
        qnn_tensor = QnnTensorStruct()
        qnn_tensor.name = tensor_info["name"]
        qnn_tensor.onnx_data_type = qnn_data_type_to_onnx_data_type(tensor_info["dataType"], is_qnn_converter_json)
        qnn_tensor.is_quantized = is_quantized_data_type(tensor_info["dataType"], is_qnn_converter_json)
        qnn_tensor.dim = tensor_info["dimensions"]
        if (
            tensor_info["quantizeParams"]["definition"] == "QNN_DEFINITION_DEFINED"
            and tensor_info["quantizeParams"]["quantizationEncoding"] == "QNN_QUANTIZATION_ENCODING_SCALE_OFFSET"
        ):
            qnn_tensor.scale = tensor_info["quantizeParams"]["scaleOffset"]["scale"]
            qnn_tensor.offset = 0 - tensor_info["quantizeParams"]["scaleOffset"]["offset"]
        qnn_output_tensor_dic[qnn_tensor.name] = qnn_tensor

    assert len(qnn_input_tensor_dic) >= 1 and len(qnn_output_tensor_dic) >= 1, (
        "Converted QNN model not valid. It should have at least 1 input & 1 output."
    )

    return graph_name


# Onnxruntime QNN EP can support context binary file generated by QNN tool chain. However QNN generated context binary file
# uses channel last data layout and 8 bits or 16 bits for input and output.
# This script gets the QNN model input & output information from QNN converted model_net.json file, compare them with Onnx model
# and inserts Cast, Transpose nodes to Onnx model if required
def main():
    parser = ArgumentParser("Generate Onnx model which includes the QNN context binary.")
    parser.add_argument("-b", "--qnn_bin", help="Required. Path to Qnn context binary file.", required=True, type=str)
    parser.add_argument(
        "-q", "--qnn_json", help="Required. Path to Qnn converted model_net.json file.", required=True, type=str
    )
    parser.add_argument(
        "--disable_embed_mode",
        action="store_true",
        default=False,
        help="Set embed_mode=1 which mean embed Qnn context binary into the onnx model. Otherwise, set context binary file path in the onnx model",
    )
    parser.add_argument(
        "--quantized_IO",
        action="store_true",
        default=False,
        help="QNN converted context binary use quantized data as graph inputs and outputs. Will keep it if quantized_IO=True, otherwise, will insert Q and DQ nodes accordingly to make the graph inputs & outputs as float32 data type.",
    )
    args = parser.parse_args()

    # Parse Qnn model_net.json file to get the graph input output information

    with open(args.qnn_json) as qnn_json_file:
        qnn_json_obj = json.load(qnn_json_file)
        if "graph" in qnn_json_obj and "tensors" in qnn_json_obj["graph"]:
            print("This json file is from Qnn converter")
            qnn_input_tensor_dic = {}
            qnn_output_tensor_dic = {}
            parse_qnn_converter_json_file(qnn_json_obj, qnn_input_tensor_dic, qnn_output_tensor_dic)

            generate_wrapper_onnx_file(
                "QnnContext",
                args.qnn_json.replace(".json", "_qnn_ctx.onnx"),
                qnn_input_tensor_dic,
                qnn_output_tensor_dic,
                args.disable_embed_mode,
                args.qnn_bin,
                args.quantized_IO,
            )
        elif "info" in qnn_json_obj and "graphs" in qnn_json_obj["info"]:
            print("This json file is extracted from QNN context binary file")
            qnn_version = qnn_json_obj["info"]["buildId"]
            for qnn_graph in qnn_json_obj["info"]["graphs"]:
                qnn_input_tensor_dic = {}
                qnn_output_tensor_dic = {}
                graph_name = parse_qnn_graph(qnn_graph, qnn_input_tensor_dic, qnn_output_tensor_dic)

                ctx_file_name = graph_name + "_qnn_ctx.onnx"
                if not args.quantized_IO:
                    ctx_file_name = ctx_file_name.replace(".onnx", "_fp32_io.onnx")

                generate_wrapper_onnx_file(
                    graph_name,
                    ctx_file_name,
                    qnn_input_tensor_dic,
                    qnn_output_tensor_dic,
                    args.disable_embed_mode,
                    args.qnn_bin,
                    args.quantized_IO,
                    qnn_version,
                )
        else:
            print("json file unrecoginized.")


if __name__ == "__main__":
    main()
