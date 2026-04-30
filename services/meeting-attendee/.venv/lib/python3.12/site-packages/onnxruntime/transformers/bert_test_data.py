# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# It is a tool to generate test data for a bert model.
# The test data can be used by onnxruntime_perf_test tool to evaluate the inference latency.

import argparse
import os
import random
from pathlib import Path

import numpy as np
from onnx import ModelProto, TensorProto, numpy_helper
from onnx_model import OnnxModel


def fake_input_ids_data(
    input_ids: TensorProto, batch_size: int, sequence_length: int, dictionary_size: int
) -> np.ndarray:
    """Create input tensor based on the graph input of input_ids

    Args:
        input_ids (TensorProto): graph input of the input_ids input tensor
        batch_size (int): batch size
        sequence_length (int): sequence length
        dictionary_size (int): vocabulary size of dictionary

    Returns:
        np.ndarray: the input tensor created
    """
    assert input_ids.type.tensor_type.elem_type in [
        TensorProto.FLOAT,
        TensorProto.INT32,
        TensorProto.INT64,
    ]

    data = np.random.randint(dictionary_size, size=(batch_size, sequence_length), dtype=np.int32)

    if input_ids.type.tensor_type.elem_type == TensorProto.FLOAT:
        data = np.float32(data)
    elif input_ids.type.tensor_type.elem_type == TensorProto.INT64:
        data = np.int64(data)

    return data


def fake_segment_ids_data(segment_ids: TensorProto, batch_size: int, sequence_length: int) -> np.ndarray:
    """Create input tensor based on the graph input of segment_ids

    Args:
        segment_ids (TensorProto): graph input of the token_type_ids input tensor
        batch_size (int): batch size
        sequence_length (int): sequence length

    Returns:
        np.ndarray: the input tensor created
    """
    assert segment_ids.type.tensor_type.elem_type in [
        TensorProto.FLOAT,
        TensorProto.INT32,
        TensorProto.INT64,
    ]

    data = np.zeros((batch_size, sequence_length), dtype=np.int32)

    if segment_ids.type.tensor_type.elem_type == TensorProto.FLOAT:
        data = np.float32(data)
    elif segment_ids.type.tensor_type.elem_type == TensorProto.INT64:
        data = np.int64(data)

    return data


def get_random_length(max_sequence_length: int, average_sequence_length: int):
    assert average_sequence_length >= 1 and average_sequence_length <= max_sequence_length

    # For uniform distribution, we find proper lower and upper bounds so that the average is in the middle.
    if 2 * average_sequence_length > max_sequence_length:
        return random.randint(2 * average_sequence_length - max_sequence_length, max_sequence_length)
    else:
        return random.randint(1, 2 * average_sequence_length - 1)


def fake_input_mask_data(
    input_mask: TensorProto,
    batch_size: int,
    sequence_length: int,
    average_sequence_length: int,
    random_sequence_length: bool,
    mask_type: int = 2,
) -> np.ndarray:
    """Create input tensor based on the graph input of segment_ids.

    Args:
        input_mask (TensorProto): graph input of the attention mask input tensor
        batch_size (int): batch size
        sequence_length (int): sequence length
        average_sequence_length (int): average sequence length excluding paddings
        random_sequence_length (bool): whether use uniform random number for sequence length
        mask_type (int): mask type - 1: mask index (sequence length excluding paddings). Shape is (batch_size).
                                     2: 2D attention mask. Shape is (batch_size, sequence_length).
                                     3: key len, cumulated lengths of query and key. Shape is (3 * batch_size + 2).

    Returns:
        np.ndarray: the input tensor created
    """

    assert input_mask.type.tensor_type.elem_type in [
        TensorProto.FLOAT,
        TensorProto.INT32,
        TensorProto.INT64,
    ]

    if mask_type == 1:  # sequence length excluding paddings
        data = np.ones((batch_size), dtype=np.int32)
        if random_sequence_length:
            for i in range(batch_size):
                data[i] = get_random_length(sequence_length, average_sequence_length)
        else:
            for i in range(batch_size):
                data[i] = average_sequence_length
    elif mask_type == 2:  # 2D attention mask
        data = np.zeros((batch_size, sequence_length), dtype=np.int32)
        if random_sequence_length:
            for i in range(batch_size):
                actual_seq_len = get_random_length(sequence_length, average_sequence_length)
                for j in range(actual_seq_len):
                    data[i, j] = 1
        else:
            temp = np.ones((batch_size, average_sequence_length), dtype=np.int32)
            data[: temp.shape[0], : temp.shape[1]] = temp
    else:
        assert mask_type == 3
        data = np.zeros((batch_size * 3 + 2), dtype=np.int32)
        if random_sequence_length:
            for i in range(batch_size):
                data[i] = get_random_length(sequence_length, average_sequence_length)

            for i in range(batch_size + 1):
                data[batch_size + i] = data[batch_size + i - 1] + data[i - 1] if i > 0 else 0
                data[2 * batch_size + 1 + i] = data[batch_size + i - 1] + data[i - 1] if i > 0 else 0
        else:
            for i in range(batch_size):
                data[i] = average_sequence_length
            for i in range(batch_size + 1):
                data[batch_size + i] = i * average_sequence_length
                data[2 * batch_size + 1 + i] = i * average_sequence_length

    if input_mask.type.tensor_type.elem_type == TensorProto.FLOAT:
        data = np.float32(data)
    elif input_mask.type.tensor_type.elem_type == TensorProto.INT64:
        data = np.int64(data)

    return data


def output_test_data(directory: str, inputs: dict[str, np.ndarray]):
    """Output input tensors of test data to a directory

    Args:
        directory (str): path of a directory
        inputs (Dict[str, np.ndarray]): map from input name to value
    """
    if not os.path.exists(directory):
        try:
            os.mkdir(directory)
        except OSError:
            print(f"Creation of the directory {directory} failed")
        else:
            print(f"Successfully created the directory {directory} ")
    else:
        print(f"Warning: directory {directory} existed. Files will be overwritten.")

    for index, (name, data) in enumerate(inputs.items()):
        tensor = numpy_helper.from_array(data, name)
        with open(os.path.join(directory, f"input_{index}.pb"), "wb") as file:
            file.write(tensor.SerializeToString())


def fake_test_data(
    batch_size: int,
    sequence_length: int,
    test_cases: int,
    dictionary_size: int,
    verbose: bool,
    random_seed: int,
    input_ids: TensorProto,
    segment_ids: TensorProto,
    input_mask: TensorProto,
    average_sequence_length: int,
    random_sequence_length: bool,
    mask_type: int,
):
    """Create given number of input data for testing

    Args:
        batch_size (int): batch size
        sequence_length (int): sequence length
        test_cases (int): number of test cases
        dictionary_size (int): vocabulary size of dictionary for input_ids
        verbose (bool): print more information or not
        random_seed (int): random seed
        input_ids (TensorProto): graph input of input IDs
        segment_ids (TensorProto): graph input of token type IDs
        input_mask (TensorProto): graph input of attention mask
        average_sequence_length (int): average sequence length excluding paddings
        random_sequence_length (bool): whether use uniform random number for sequence length
        mask_type (int): mask type 1 is mask index; 2 is 2D mask; 3 is key len, cumulated lengths of query and key

    Returns:
        List[Dict[str,numpy.ndarray]]: list of test cases, where each test case is a dictionary
                                       with input name as key and a tensor as value
    """
    assert input_ids is not None

    np.random.seed(random_seed)
    random.seed(random_seed)

    all_inputs = []
    for _test_case in range(test_cases):
        input_1 = fake_input_ids_data(input_ids, batch_size, sequence_length, dictionary_size)
        inputs = {input_ids.name: input_1}

        if segment_ids:
            inputs[segment_ids.name] = fake_segment_ids_data(segment_ids, batch_size, sequence_length)

        if input_mask:
            inputs[input_mask.name] = fake_input_mask_data(
                input_mask, batch_size, sequence_length, average_sequence_length, random_sequence_length, mask_type
            )

        if verbose and len(all_inputs) == 0:
            print("Example inputs", inputs)
        all_inputs.append(inputs)
    return all_inputs


def generate_test_data(
    batch_size: int,
    sequence_length: int,
    test_cases: int,
    seed: int,
    verbose: bool,
    input_ids: TensorProto,
    segment_ids: TensorProto,
    input_mask: TensorProto,
    average_sequence_length: int,
    random_sequence_length: bool,
    mask_type: int,
    dictionary_size: int = 10000,
):
    """Create given number of input data for testing

    Args:
        batch_size (int): batch size
        sequence_length (int): sequence length
        test_cases (int): number of test cases
        seed (int): random seed
        verbose (bool): print more information or not
        input_ids (TensorProto): graph input of input IDs
        segment_ids (TensorProto): graph input of token type IDs
        input_mask (TensorProto): graph input of attention mask
        average_sequence_length (int): average sequence length excluding paddings
        random_sequence_length (bool): whether use uniform random number for sequence length
        mask_type (int): mask type 1 is mask index; 2 is 2D mask; 3 is key len, cumulated lengths of query and key

    Returns:
        List[Dict[str,numpy.ndarray]]: list of test cases, where each test case is a dictionary
                                       with input name as key and a tensor as value
    """
    all_inputs = fake_test_data(
        batch_size,
        sequence_length,
        test_cases,
        dictionary_size,
        verbose,
        seed,
        input_ids,
        segment_ids,
        input_mask,
        average_sequence_length,
        random_sequence_length,
        mask_type,
    )
    if len(all_inputs) != test_cases:
        print("Failed to create test data for test.")
    return all_inputs


def get_graph_input_from_embed_node(onnx_model, embed_node, input_index):
    if input_index >= len(embed_node.input):
        return None

    input = embed_node.input[input_index]
    graph_input = onnx_model.find_graph_input(input)
    if graph_input is None:
        parent_node = onnx_model.get_parent(embed_node, input_index)
        if parent_node is not None and parent_node.op_type == "Cast":
            graph_input = onnx_model.find_graph_input(parent_node.input[0])
    return graph_input


def find_bert_inputs(
    onnx_model: OnnxModel,
    input_ids_name: str | None = None,
    segment_ids_name: str | None = None,
    input_mask_name: str | None = None,
) -> tuple[np.ndarray | None, np.ndarray | None, np.ndarray | None]:
    """Find graph inputs for BERT model.
    First, we will deduce inputs from EmbedLayerNormalization node.
    If not found, we will guess the meaning of graph inputs based on naming.

    Args:
        onnx_model (OnnxModel): onnx model object
        input_ids_name (str, optional): Name of graph input for input IDs. Defaults to None.
        segment_ids_name (str, optional): Name of graph input for segment IDs. Defaults to None.
        input_mask_name (str, optional): Name of graph input for attention mask. Defaults to None.

    Raises:
        ValueError: Graph does not have input named of input_ids_name or segment_ids_name or input_mask_name
        ValueError: Expected graph input number does not match with specified input_ids_name, segment_ids_name
                    and input_mask_name

    Returns:
        Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]: input tensors of input_ids,
                                                                                 segment_ids and input_mask
    """

    graph_inputs = onnx_model.get_graph_inputs_excluding_initializers()

    if input_ids_name is not None:
        input_ids = onnx_model.find_graph_input(input_ids_name)
        if input_ids is None:
            raise ValueError(f"Graph does not have input named {input_ids_name}")

        segment_ids = None
        if segment_ids_name:
            segment_ids = onnx_model.find_graph_input(segment_ids_name)
            if segment_ids is None:
                raise ValueError(f"Graph does not have input named {segment_ids_name}")

        input_mask = None
        if input_mask_name:
            input_mask = onnx_model.find_graph_input(input_mask_name)
            if input_mask is None:
                raise ValueError(f"Graph does not have input named {input_mask_name}")

        expected_inputs = 1 + (1 if segment_ids else 0) + (1 if input_mask else 0)
        if len(graph_inputs) != expected_inputs:
            raise ValueError(f"Expect the graph to have {expected_inputs} inputs. Got {len(graph_inputs)}")

        return input_ids, segment_ids, input_mask

    if len(graph_inputs) != 3:
        raise ValueError(f"Expect the graph to have 3 inputs. Got {len(graph_inputs)}")

    embed_nodes = onnx_model.get_nodes_by_op_type("EmbedLayerNormalization")
    if len(embed_nodes) == 1:
        embed_node = embed_nodes[0]
        input_ids = get_graph_input_from_embed_node(onnx_model, embed_node, 0)
        segment_ids = get_graph_input_from_embed_node(onnx_model, embed_node, 1)
        input_mask = get_graph_input_from_embed_node(onnx_model, embed_node, 7)

        if input_mask is None:
            for input in graph_inputs:
                input_name_lower = input.name.lower()
                if "mask" in input_name_lower:
                    input_mask = input
        if input_mask is None:
            raise ValueError("Failed to find attention mask input")

        return input_ids, segment_ids, input_mask

    # Try guess the inputs based on naming.
    input_ids = None
    segment_ids = None
    input_mask = None
    for input in graph_inputs:
        input_name_lower = input.name.lower()
        if "mask" in input_name_lower:  # matches input with name like "attention_mask" or "input_mask"
            input_mask = input
        elif (
            "token" in input_name_lower or "segment" in input_name_lower
        ):  # matches input with name like "segment_ids" or "token_type_ids"
            segment_ids = input
        else:
            input_ids = input

    if input_ids and segment_ids and input_mask:
        return input_ids, segment_ids, input_mask

    raise ValueError("Fail to assign 3 inputs. You might try rename the graph inputs.")


def get_bert_inputs(
    onnx_file: str,
    input_ids_name: str | None = None,
    segment_ids_name: str | None = None,
    input_mask_name: str | None = None,
) -> tuple[np.ndarray | None, np.ndarray | None, np.ndarray | None]:
    """Find graph inputs for BERT model.
    First, we will deduce inputs from EmbedLayerNormalization node.
    If not found, we will guess the meaning of graph inputs based on naming.

    Args:
        onnx_file (str): onnx model path
        input_ids_name (str, optional): Name of graph input for input IDs. Defaults to None.
        segment_ids_name (str, optional): Name of graph input for segment IDs. Defaults to None.
        input_mask_name (str, optional): Name of graph input for attention mask. Defaults to None.

    Returns:
        Tuple[Optional[np.ndarray], Optional[np.ndarray], Optional[np.ndarray]]: input tensors of input_ids,
                                                                                 segment_ids and input_mask
    """
    model = ModelProto()
    with open(onnx_file, "rb") as file:
        model.ParseFromString(file.read())

    onnx_model = OnnxModel(model)
    return find_bert_inputs(onnx_model, input_ids_name, segment_ids_name, input_mask_name)


def parse_arguments():
    parser = argparse.ArgumentParser()

    parser.add_argument("--model", required=True, type=str, help="bert onnx model path.")

    parser.add_argument(
        "--output_dir",
        required=False,
        type=str,
        default=None,
        help="output test data path. Default is current directory.",
    )

    parser.add_argument("--batch_size", required=False, type=int, default=1, help="batch size of input")

    parser.add_argument(
        "--sequence_length",
        required=False,
        type=int,
        default=128,
        help="maximum sequence length of input",
    )

    parser.add_argument(
        "--input_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for input ids",
    )
    parser.add_argument(
        "--segment_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for segment ids",
    )
    parser.add_argument(
        "--input_mask_name",
        required=False,
        type=str,
        default=None,
        help="input name for attention mask",
    )

    parser.add_argument(
        "--samples",
        required=False,
        type=int,
        default=1,
        help="number of test cases to be generated",
    )

    parser.add_argument("--seed", required=False, type=int, default=3, help="random seed")

    parser.add_argument(
        "--verbose",
        required=False,
        action="store_true",
        help="print verbose information",
    )
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "--only_input_tensors",
        required=False,
        action="store_true",
        help="only save input tensors and no output tensors",
    )
    parser.set_defaults(only_input_tensors=False)

    parser.add_argument(
        "-a",
        "--average_sequence_length",
        default=-1,
        type=int,
        help="average sequence length excluding padding",
    )

    parser.add_argument(
        "-r",
        "--random_sequence_length",
        required=False,
        action="store_true",
        help="use uniform random instead of fixed sequence length",
    )
    parser.set_defaults(random_sequence_length=False)

    parser.add_argument(
        "--mask_type",
        required=False,
        type=int,
        default=2,
        help="mask type: (1: mask index, 2: raw 2D mask, 3: key lengths, cumulated lengths of query and key)",
    )

    args = parser.parse_args()
    return args


def create_and_save_test_data(
    model: str,
    output_dir: str,
    batch_size: int,
    sequence_length: int,
    test_cases: int,
    seed: int,
    verbose: bool,
    input_ids_name: str | None,
    segment_ids_name: str | None,
    input_mask_name: str | None,
    only_input_tensors: bool,
    average_sequence_length: int,
    random_sequence_length: bool,
    mask_type: int,
):
    """Create test data for a model, and save test data to a directory.

    Args:
        model (str): path of ONNX bert model
        output_dir (str): output directory
        batch_size (int): batch size
        sequence_length (int): sequence length
        test_cases (int): number of test cases
        seed (int): random seed
        verbose (bool): whether print more information
        input_ids_name (str): graph input name of input_ids
        segment_ids_name (str): graph input name of segment_ids
        input_mask_name (str): graph input name of input_mask
        only_input_tensors (bool): only save input tensors,
        average_sequence_length (int): average sequence length excluding paddings
        random_sequence_length (bool): whether use uniform random number for sequence length
        mask_type(int): mask type
    """
    input_ids, segment_ids, input_mask = get_bert_inputs(model, input_ids_name, segment_ids_name, input_mask_name)

    all_inputs = generate_test_data(
        batch_size,
        sequence_length,
        test_cases,
        seed,
        verbose,
        input_ids,
        segment_ids,
        input_mask,
        average_sequence_length,
        random_sequence_length,
        mask_type,
    )

    for i, inputs in enumerate(all_inputs):
        directory = os.path.join(output_dir, "test_data_set_" + str(i))
        output_test_data(directory, inputs)

    if only_input_tensors:
        return

    import onnxruntime  # noqa: PLC0415

    providers = (
        ["CUDAExecutionProvider", "CPUExecutionProvider"]
        if "CUDAExecutionProvider" in onnxruntime.get_available_providers()
        else ["CPUExecutionProvider"]
    )
    session = onnxruntime.InferenceSession(model, providers=providers)
    output_names = [output.name for output in session.get_outputs()]

    for i, inputs in enumerate(all_inputs):
        directory = os.path.join(output_dir, "test_data_set_" + str(i))
        result = session.run(output_names, inputs)
        for i, output_name in enumerate(output_names):  # noqa: PLW2901
            tensor_result = numpy_helper.from_array(np.asarray(result[i]), output_name)
            with open(os.path.join(directory, f"output_{i}.pb"), "wb") as file:
                file.write(tensor_result.SerializeToString())


def main():
    args = parse_arguments()

    if args.average_sequence_length <= 0:
        args.average_sequence_length = args.sequence_length

    output_dir = args.output_dir
    if output_dir is None:
        # Default output directory is a sub-directory under the directory of model.
        p = Path(args.model)
        output_dir = os.path.join(p.parent, f"batch_{args.batch_size}_seq_{args.sequence_length}")

    if output_dir is not None:
        # create the output directory if not existed
        path = Path(output_dir)
        path.mkdir(parents=True, exist_ok=True)
    else:
        print("Directory existed. test data files will be overwritten.")

    create_and_save_test_data(
        args.model,
        output_dir,
        args.batch_size,
        args.sequence_length,
        args.samples,
        args.seed,
        args.verbose,
        args.input_ids_name,
        args.segment_ids_name,
        args.input_mask_name,
        args.only_input_tensors,
        args.average_sequence_length,
        args.random_sequence_length,
        args.mask_type,
    )

    print("Test data is saved to directory:", output_dir)


if __name__ == "__main__":
    main()
