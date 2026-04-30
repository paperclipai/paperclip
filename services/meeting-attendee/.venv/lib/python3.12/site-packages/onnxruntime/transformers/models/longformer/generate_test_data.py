# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

# Generate test data for a longformer model, so that we can use onnxruntime_perf_test.exe to evaluate the inference latency.

import argparse
import os
import random
from pathlib import Path

import numpy as np
from bert_test_data import fake_input_ids_data, fake_input_mask_data, output_test_data
from onnx import ModelProto, TensorProto
from onnx_model import OnnxModel


def parse_arguments():
    parser = argparse.ArgumentParser()

    parser.add_argument("--model", required=True, type=str, help="bert onnx model path.")

    parser.add_argument(
        "--output_dir",
        required=False,
        type=str,
        default=None,
        help="output test data path. If not specified, .",
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
        "--global_tokens",
        required=False,
        type=int,
        default=10,
        help="number of global tokens",
    )

    parser.add_argument(
        "--input_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for input ids",
    )

    parser.add_argument(
        "--input_mask_name",
        required=False,
        type=str,
        default=None,
        help="input name for attention mask",
    )

    parser.add_argument(
        "--global_mask_name",
        required=False,
        type=str,
        default=None,
        help="input name for global attention mask",
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

    args = parser.parse_args()
    return args


def get_longformer_inputs(onnx_file, input_ids_name=None, input_mask_name=None, global_mask_name=None):
    """
    Get graph inputs for longformer model.
    """
    model = ModelProto()
    with open(onnx_file, "rb") as f:
        model.ParseFromString(f.read())

    onnx_model = OnnxModel(model)
    graph_inputs = onnx_model.get_graph_inputs_excluding_initializers()

    if input_ids_name is not None:
        input_ids = onnx_model.find_graph_input(input_ids_name)
        if input_ids is None:
            raise ValueError(f"Graph does not have input named {input_ids_name}")

        input_mask = None
        if input_mask_name:
            input_mask = onnx_model.find_graph_input(input_mask_name)
            if input_mask is None:
                raise ValueError(f"Graph does not have input named {input_mask_name}")

        global_mask = None
        if global_mask_name:
            global_mask = onnx_model.find_graph_input(global_mask_name)
            if global_mask is None:
                raise ValueError(f"Graph does not have input named {global_mask_name}")

        expected_inputs = 1 + (1 if input_mask else 0) + (1 if global_mask else 0)
        if len(graph_inputs) != expected_inputs:
            raise ValueError(f"Expect the graph to have {expected_inputs} inputs. Got {len(graph_inputs)}")

        return input_ids, input_mask, global_mask

    if len(graph_inputs) != 3:
        raise ValueError(f"Expect the graph to have 3 inputs. Got {len(graph_inputs)}")

    # Try guess the inputs based on naming.
    input_ids = None
    input_mask = None
    global_mask = None
    for input in graph_inputs:
        input_name_lower = input.name.lower()
        if "global" in input_name_lower:
            global_mask = input
        elif "mask" in input_name_lower:
            input_mask = input
        else:
            input_ids = input

    if input_ids and input_mask and global_mask:
        return input_ids, input_mask, global_mask

    raise ValueError("Fail to assign 3 inputs. You might try rename the graph inputs.")


def fake_global_mask_data(global_mask, batch_size, sequence_length, num_global_tokens):
    """
    Fake data based on the graph input of segment_ids.
    Args:
        segment_ids (TensorProto): graph input of input tensor.
    Returns:
        data (np.array): the data for input tensor
    """
    data_type = global_mask.type.tensor_type.elem_type
    assert data_type in [TensorProto.FLOAT, TensorProto.INT32, TensorProto.INT64]

    if num_global_tokens > 0:
        assert num_global_tokens <= sequence_length
        data = np.zeros((batch_size, sequence_length), dtype=np.int32)
        temp = np.ones((batch_size, num_global_tokens), dtype=np.int32)
        data[: temp.shape[0], : temp.shape[1]] = temp
    else:
        data = np.zeros((batch_size, sequence_length), dtype=np.int32)

    if data_type == TensorProto.FLOAT:
        data = np.float32(data)
    elif data_type == TensorProto.INT64:
        data = np.int64(data)

    return data


def fake_test_data(
    batch_size,
    sequence_length,
    test_cases,
    dictionary_size,
    verbose,
    random_seed,
    input_ids,
    input_mask,
    global_mask,
    num_global_tokens,
    average_sequence_length,
    random_sequence_length,
):
    """
    Generate fake input data for test.
    """
    assert input_ids is not None

    np.random.seed(random_seed)
    random.seed(random_seed)

    all_inputs = []
    for _ in range(test_cases):
        input_1 = fake_input_ids_data(input_ids, batch_size, sequence_length, dictionary_size)
        inputs = {input_ids.name: input_1}

        if input_mask:
            inputs[input_mask.name] = fake_input_mask_data(
                input_mask, batch_size, sequence_length, average_sequence_length, random_sequence_length
            )

        if global_mask:
            inputs[global_mask.name] = fake_global_mask_data(
                global_mask, batch_size, sequence_length, num_global_tokens
            )

        if verbose and len(all_inputs) == 0:
            print("Example inputs", inputs)
        all_inputs.append(inputs)

    return all_inputs


def generate_test_data(
    batch_size,
    sequence_length,
    test_cases,
    seed,
    verbose,
    input_ids,
    input_mask,
    global_mask,
    num_global_tokens,
    average_sequence_length,
    random_sequence_length,
):
    dictionary_size = 10000
    all_inputs = fake_test_data(
        batch_size,
        sequence_length,
        test_cases,
        dictionary_size,
        verbose,
        seed,
        input_ids,
        input_mask,
        global_mask,
        num_global_tokens,
        average_sequence_length,
        random_sequence_length,
    )
    if len(all_inputs) != test_cases:
        print("Failed to create test data for test.")
    return all_inputs


def create_longformer_test_data(
    model,
    output_dir,
    batch_size,
    sequence_length,
    test_cases,
    seed,
    verbose,
    input_ids_name,
    input_mask_name,
    global_mask_name,
    num_global_tokens,
    average_sequence_length,
    random_sequence_length,
):
    input_ids, input_mask, global_mask = get_longformer_inputs(model, input_ids_name, input_mask_name, global_mask_name)
    all_inputs = generate_test_data(
        batch_size,
        sequence_length,
        test_cases,
        seed,
        verbose,
        input_ids,
        input_mask,
        global_mask,
        num_global_tokens,
        average_sequence_length,
        random_sequence_length,
    )

    for i, inputs in enumerate(all_inputs):
        output_test_data(output_dir, i, inputs)


def main():
    args = parse_arguments()

    output_dir = args.output_dir
    if output_dir is None:
        # Default output directory is a sub-directory under the directory of model.
        output_dir = os.path.join(
            Path(args.model).parent,
            f"b{args.batch_size}_s{args.sequence_length}_g{args.global_tokens}",
        )

    if output_dir is not None:
        # create the output directory if not existed
        path = Path(output_dir)
        path.mkdir(parents=True, exist_ok=True)
    else:
        print("Directory existed. test data files will be overwritten.")

    if args.average_sequence_length <= 0:
        args.average_sequence_length = args.sequence_length

    create_longformer_test_data(
        args.model,
        output_dir,
        args.batch_size,
        args.sequence_length,
        args.samples,
        args.seed,
        args.verbose,
        args.input_ids_name,
        args.input_mask_name,
        args.global_mask_name,
        args.global_tokens,
        args.average_sequence_length,
    )

    print("Test data is saved to directory:", output_dir)


if __name__ == "__main__":
    main()
