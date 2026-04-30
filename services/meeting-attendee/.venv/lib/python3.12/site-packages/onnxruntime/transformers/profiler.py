import argparse
import os

import numpy
import psutil
from onnx import TensorProto

"""
This profiler tool could run a transformer model and print out the kernel time spent on each Node of the model.
Example of profiling of longformer model:
    python profiler.py --model longformer-base-4096_fp32.onnx --batch_size 1 --sequence_length 4096 --global_length 8 --samples 1000 --thread_num 8 --dummy_inputs longformer --use_gpu
Example of importing profile result file from onnxruntime_perf_test:
    python profiler.py --input profile_2021-10-25_12-02-41.json
"""


def parse_arguments(argv=None):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-i",
        "--input",
        required=False,
        type=str,
        help="Set the input file for reading the profile results",
    )

    parser.add_argument(
        "-m",
        "--model",
        required=False,
        type=str,
        help="onnx model path to run profiling. Required when --input is not specified.",
    )

    parser.add_argument(
        "-b",
        "--batch_size",
        required=False,
        type=int,
        default=1,
        help="batch size of input",
    )

    parser.add_argument(
        "-s",
        "--sequence_length",
        required=False,
        type=int,
        default=32,
        help="sequence length of input",
    )

    parser.add_argument(
        "--past_sequence_length",
        required=False,
        type=int,
        default=1,
        help="past sequence length for gpt2",
    )

    parser.add_argument(
        "--global_length",
        required=False,
        type=int,
        default=1,
        help="number of global tokens for longformer",
    )

    parser.add_argument(
        "--samples",
        required=False,
        type=int,
        default=1000,
        help="number of samples to test. Set it large enough to reduce the variance of performance result.",
    )

    parser.add_argument(
        "--threshold",
        required=False,
        type=float,
        default=0.01,
        help="Threshold of run time ratio among all nodes. Nodes with larger ratio will show in top expensive nodes.",
    )

    parser.add_argument(
        "--thread_num",
        required=False,
        type=int,
        default=-1,
        help="number of threads to use",
    )

    parser.add_argument(
        "--input_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for input IDs, for bert",
    )
    parser.add_argument(
        "--segment_ids_name",
        required=False,
        type=str,
        default=None,
        help="input name for segment IDs, for bert",
    )
    parser.add_argument(
        "--input_mask_name",
        required=False,
        type=str,
        default=None,
        help="input name for attention mask, for bert",
    )

    parser.add_argument(
        "--dummy_inputs",
        required=False,
        default="default",
        choices=["bert", "gpt2", "longformer", "default"],
        help="Type of model inputs. The default will create dummy inputs with ones.",
    )

    parser.add_argument("-g", "--use_gpu", required=False, action="store_true", help="use GPU")
    parser.set_defaults(use_gpu=False)

    parser.add_argument(
        "--provider",
        required=False,
        type=str,
        default="cuda",
        help="Execution provider to use",
    )

    parser.add_argument(
        "--basic_optimization",
        required=False,
        action="store_true",
        help="Enable only basic graph optimizations. By default, all optimizations are enabled in OnnxRuntime",
    )
    parser.set_defaults(basic_optimization=False)

    parser.add_argument(
        "--kernel_time_only",
        required=False,
        action="store_true",
        help="Only include the kernel time and no fence time",
    )
    parser.set_defaults(kernel_time_only=False)

    parser.add_argument("-v", "--verbose", required=False, action="store_true")
    parser.set_defaults(verbose=False)

    return parser.parse_args(argv)


def run_profile(onnx_model_path, use_gpu, provider, basic_optimization, thread_num, all_inputs):
    from benchmark_helper import create_onnxruntime_session  # noqa: PLC0415

    session = create_onnxruntime_session(
        onnx_model_path,
        use_gpu,
        provider,
        enable_all_optimization=not basic_optimization,
        num_threads=thread_num,
        enable_profiling=True,
    )

    for inputs in all_inputs:
        _ = session.run(None, inputs)

    profile_file = session.end_profiling()
    return profile_file


def get_dim_from_type_proto(dim):
    return getattr(dim, dim.WhichOneof("value")) if type(dim.WhichOneof("value")) == str else None  # noqa: E721


def get_shape_from_type_proto(type_proto):
    return [get_dim_from_type_proto(d) for d in type_proto.tensor_type.shape.dim]


def create_dummy_inputs(onnx_model, batch_size, sequence_length, samples):
    """Create dummy inputs for ONNX model.

    Args:
        onnx_model (OnnxModel): ONNX model
        batch_size (int): batch size
        sequence_length (int): sequence length
        samples (int): number of samples

    Returns:
        List[Dict]: list of inputs
    """
    dummy_inputs = {}
    for graph_input in onnx_model.get_graph_inputs_excluding_initializers():
        shape = get_shape_from_type_proto(graph_input.type)
        symbol_dims = []
        for i, dim in enumerate(shape):
            if isinstance(dim, str):
                symbol_dims.append(i)

        # allowed symbolic dimensions: batch_size and sequence_length
        if len(symbol_dims) > 2:
            return None
        if len(symbol_dims) > 0:
            shape[symbol_dims[0]] = batch_size
        if len(symbol_dims) > 1:
            shape[symbol_dims[1]] = sequence_length

        elem_type = graph_input.type.tensor_type.elem_type
        assert elem_type in [TensorProto.FLOAT, TensorProto.INT32, TensorProto.INT64]
        data_type = (
            numpy.float32
            if elem_type == TensorProto.FLOAT
            else (numpy.int64 if elem_type == TensorProto.INT64 else numpy.int32)
        )
        data = numpy.ones(shape, dtype=data_type)
        dummy_inputs[graph_input.name] = data

    all_inputs = [dummy_inputs for _ in range(samples)]
    return all_inputs


def create_bert_inputs(
    onnx_model,
    batch_size,
    sequence_length,
    samples,
    input_ids_name=None,
    segment_ids_name=None,
    input_mask_name=None,
):
    """Create dummy inputs for BERT model.

    Args:
        onnx_model (OnnxModel): ONNX model
        batch_size (int): batch size
        sequence_length (int): sequence length
        samples (int): number of samples
        input_ids_name (str, optional): Name of graph input for input IDs. Defaults to None.
        segment_ids_name (str, optional): Name of graph input for segment IDs. Defaults to None.
        input_mask_name (str, optional): Name of graph input for attention mask. Defaults to None.

    Returns:
        List[Dict]: list of inputs
    """
    from bert_test_data import find_bert_inputs, generate_test_data  # noqa: PLC0415

    input_ids, segment_ids, input_mask = find_bert_inputs(onnx_model, input_ids_name, segment_ids_name, input_mask_name)
    all_inputs = generate_test_data(
        batch_size,
        sequence_length,
        test_cases=samples,
        seed=123,
        verbose=False,
        input_ids=input_ids,
        segment_ids=segment_ids,
        input_mask=input_mask,
        random_mask_length=False,
    )

    return all_inputs


def create_gpt2_inputs(onnx_model, batch_size, sequence_length, past_sequence_length, samples):
    """Create dummy inputs for GPT-2 model.

    Args:
        onnx_model (OnnxModel): ONNX model
        batch_size (int): batch size
        sequence_length (int): sequence length
        past_sequence_length (int): past sequence length
        samples (int): number of samples

    Raises:
        RuntimeError: symbolic is not supported. Use the tool convert_to_onnx.py to export ONNX model instead.

    Returns:
        List[Dict]: list of inputs
    """
    # The symbolic names shall be same as those used in Gpt2Helper.export_onnx(...) function.
    symbols = {
        "batch_size": batch_size,
        "seq_len": sequence_length,
        "past_seq_len": past_sequence_length,
        "total_seq_len": sequence_length + past_sequence_length,
    }

    dummy_inputs = {}
    for graph_input in onnx_model.get_graph_inputs_excluding_initializers():
        shape = get_shape_from_type_proto(graph_input.type)
        for i, dim in enumerate(shape):
            if isinstance(dim, str):
                if dim not in symbols:
                    raise RuntimeError(f"symbol is not supported: {dim}")
                else:
                    shape[i] = symbols[dim]

        elem_type = graph_input.type.tensor_type.elem_type
        assert elem_type in [TensorProto.FLOAT, TensorProto.INT32, TensorProto.INT64]
        data_type = (
            numpy.float32
            if elem_type == TensorProto.FLOAT
            else (numpy.int64 if elem_type == TensorProto.INT64 else numpy.int32)
        )
        data = numpy.ones(shape, dtype=data_type)
        dummy_inputs[graph_input.name] = data

    all_inputs = [dummy_inputs for _ in range(samples)]
    return all_inputs


def create_longformer_inputs(onnx_model, batch_size, sequence_length, global_length, samples):
    """Create dummy inputs for Longformer model.

    Args:
        onnx_model (OnnxModel): ONNX model
        batch_size (int): batch size
        sequence_length (int): sequence length
        global_length (int): number of global tokens
        samples (int): number of samples

    Raises:
        RuntimeError: symbolic is not supported. Use the tool convert_longformer_to_onnx.py to export ONNX model instead.

    Returns:
        List[Dict]: list of inputs
    """
    symbols = {"batch_size": batch_size, "sequence_length": sequence_length}

    dummy_inputs = {}
    for graph_input in onnx_model.get_graph_inputs_excluding_initializers():
        shape = get_shape_from_type_proto(graph_input.type)
        for i, dim in enumerate(shape):
            if isinstance(dim, str):
                if dim not in symbols:
                    raise RuntimeError(f"symbol is not supported: {dim}")
                else:
                    shape[i] = symbols[dim]

        elem_type = graph_input.type.tensor_type.elem_type
        assert elem_type in [TensorProto.FLOAT, TensorProto.INT32, TensorProto.INT64]
        data_type = (
            numpy.float32
            if elem_type == TensorProto.FLOAT
            else (numpy.int64 if elem_type == TensorProto.INT64 else numpy.int32)
        )

        if "global" in graph_input.name:
            data = numpy.zeros(shape, dtype=data_type)
            data[:, :global_length] = 1
        else:
            data = numpy.ones(shape, dtype=data_type)
        dummy_inputs[graph_input.name] = data

    all_inputs = [dummy_inputs for _ in range(samples)]
    return all_inputs


def run(args):
    num_threads = args.thread_num if args.thread_num > 0 else psutil.cpu_count(logical=False)

    # Set OMP environment variable before importing onnxruntime. Needed for cpu only, and no impact for onnxruntime-gpu package.
    if "OMP_NUM_THREADS" not in os.environ:
        os.environ["OMP_NUM_THREADS"] = str(num_threads)

    from onnx import load  # noqa: PLC0415
    from onnx_model import OnnxModel  # noqa: PLC0415

    onnx_model = OnnxModel(load(args.model))

    all_inputs = None
    if args.dummy_inputs == "bert":
        all_inputs = create_bert_inputs(
            onnx_model,
            args.batch_size,
            args.sequence_length,
            args.samples,
            args.input_ids_name,
            args.segment_ids_name,
            args.input_mask_name,
        )
    elif args.dummy_inputs == "gpt2":
        all_inputs = create_gpt2_inputs(
            onnx_model,
            args.batch_size,
            args.sequence_length,
            args.past_sequence_length,
            args.samples,
        )
    elif args.dummy_inputs == "longformer":
        all_inputs = create_longformer_inputs(
            onnx_model,
            args.batch_size,
            args.sequence_length,
            args.global_length,
            args.samples,
        )
    else:  # default
        all_inputs = create_dummy_inputs(onnx_model, args.batch_size, args.sequence_length, args.samples)

    profile_file = run_profile(
        args.model,
        args.use_gpu,
        args.provider,
        args.basic_optimization,
        args.thread_num,
        all_inputs,
    )

    return profile_file


if __name__ == "__main__":
    arguments = parse_arguments()
    print("Arguments", arguments)

    from benchmark_helper import setup_logger

    setup_logger(arguments.verbose)

    if not arguments.input:
        assert arguments.model, "requires either --model to run profiling or --input to read profiling results"
        profile_file = run(arguments)
    else:
        profile_file = arguments.input
    from profile_result_processor import process_results

    results = process_results(profile_file, arguments)

    for line in results:
        print(line)
