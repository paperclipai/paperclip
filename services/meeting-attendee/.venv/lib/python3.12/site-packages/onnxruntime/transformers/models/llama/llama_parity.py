# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
from __future__ import annotations

import argparse
import logging
import os
import time

import numpy as np
import packaging.version as pv
import torch
from benchmark_helper import setup_logger
from dist_settings import get_rank, get_size
from llama_inputs import (
    add_io_bindings_as_ortvalues,
    convert_inputs_for_ort,
    get_merged_sample_with_past_kv_inputs,
    get_sample_inputs,
    get_sample_with_past_kv_inputs,
    verify_ort_inputs,
)
from llama_torch import setup_torch_model
from models.torch_export_patches.cache_helper import make_dynamic_cache
from transformers import AutoConfig
from transformers import __version__ as transformers_version
from transformers.cache_utils import DynamicCache

import onnxruntime as ort

logger = logging.getLogger("")


def get_sequence_lengths(args: argparse.Namespace, config: AutoConfig):
    past_sequence_length, curr_sequence_length = (8, 1) if args.use_past_kv else (0, 8)
    max_sequence_length = config.max_position_embeddings
    return past_sequence_length, curr_sequence_length, max_sequence_length


def get_inputs(args: argparse.Namespace, config: AutoConfig):
    # Dummy values for parity
    world_size = get_size()
    batch_size = 2
    past_sequence_length, sequence_length, max_sequence_length = get_sequence_lengths(args, config)

    if args.merged:
        inputs = get_merged_sample_with_past_kv_inputs(
            config,
            args.device,
            batch_size,
            seq_len=sequence_length,
            past_seq_len=past_sequence_length,
            max_seq_len=max_sequence_length,
            use_fp16=args.use_fp16,
            use_buffer_share=args.use_buffer_share,
            return_dict=True,
            world_size=world_size,
        )
    elif args.use_past_kv:
        inputs = get_sample_with_past_kv_inputs(
            config,
            args.device,
            batch_size,
            sequence_length,
            use_fp16=args.use_fp16,
            return_dict=True,
            world_size=world_size,
        )
    else:
        inputs = get_sample_inputs(config, args.device, batch_size, sequence_length, return_dict=True)

    return inputs


def torch_deepcopy(value):
    if isinstance(value, (int, float, str)):
        return value
    if isinstance(value, tuple):
        return tuple(torch_deepcopy(v) for v in value)
    if isinstance(value, list):
        return [torch_deepcopy(v) for v in value]
    if isinstance(value, set):
        return {torch_deepcopy(v) for v in value}
    if isinstance(value, dict):
        return {k: torch_deepcopy(v) for k, v in value.items()}
    if isinstance(value, np.ndarray):
        return value.copy()
    if hasattr(value, "clone"):
        return value.clone()
    if isinstance(value, DynamicCache):
        return make_dynamic_cache(torch_deepcopy(list(zip(value.key_cache, value.value_cache, strict=False))))
    # We should have a code using serialization, deserialization assuming a model
    # cannot be exported without them.
    raise NotImplementedError(f"torch_deepcopy not implemented for type {type(value)}")


def verify_parity(
    args: argparse.Namespace,
    location: str,
    use_auth_token: bool,
    kv_cache_ortvalues: dict,
    pytorch_model: None | torch.nn.Module = None,
    config: None | AutoConfig = None,
):
    # If it's running in a machine where GPU memory < 36GB, it should unload the model in GPU in time and free the GPU memory for ORT.
    py_model = pytorch_model
    if py_model is None:
        config, py_model = setup_torch_model(
            args,
            location,
            use_auth_token,
            torch_dtype=(torch.float16 if args.use_fp16 else torch.float32),
            device=args.device,
        )

    inputs = get_inputs(args, config)

    if "past_key_values" in inputs and pv.Version(transformers_version) >= pv.Version("4.45"):
        # Using DynamicCache
        inputs["past_key_values"] = make_dynamic_cache(inputs["past_key_values"])

    # Run inference with PyTorch
    inputs_after_deepcopy = torch_deepcopy(inputs)
    if args.execution_provider != "cpu":
        torch.cuda.synchronize()
    start_time = time.time()
    # If there is a cache in the inputs, we need to make a copy as the model modifies them inplace.
    # DynamicCache inherits from torch.nn.Module in some version of transformers.
    # We need to make the copy manually.
    pt_outputs = py_model(**inputs_after_deepcopy).logits.detach().cpu().numpy()
    if args.execution_provider != "cpu":
        torch.cuda.synchronize()
    end_time = time.time()
    logger.info(f"PyTorch took {end_time - start_time} s")

    if args.small_gpu and py_model is not None:
        del py_model
        torch.cuda.empty_cache()

    # Run inference with ORT
    past_sequence_length, _, max_sequence_length = get_sequence_lengths(args, config)
    inputs = convert_inputs_for_ort(
        inputs,
        use_buffer_share=args.use_buffer_share,
        past_seq_len=past_sequence_length,
        max_seq_len=max_sequence_length,
    )

    ep = f"{args.execution_provider.upper()}ExecutionProvider"
    if ep == "CUDAExecutionProvider":
        ep = (ep, {"device_id": args.rank})
    ort_model = ort.InferenceSession(
        args.onnx_model_path,
        sess_options=ort.SessionOptions(),
        providers=[ep],
    )
    inputs = verify_ort_inputs(ort_model, inputs)

    # Add IO bindings for non-CPU execution providers
    if args.execution_provider != "cpu":
        io_binding, kv_cache_ortvalues = add_io_bindings_as_ortvalues(
            ort_model,
            ort_inputs=inputs,
            device=args.execution_provider,
            device_id=int(args.rank),
            use_buffer_share=args.use_buffer_share,
            kv_cache_ortvalues=kv_cache_ortvalues,
        )

        io_binding.synchronize_inputs()
        start_time = time.time()
        ort_model.run_with_iobinding(io_binding)
        io_binding.synchronize_outputs()
        end_time = time.time()

        ort_outputs = io_binding.copy_outputs_to_cpu()[0]  # Get logits
        del ort_model

    else:
        start_time = time.time()
        ort_outputs = ort_model.run(None, inputs)
        end_time = time.time()

        ort_outputs = ort_outputs[0]  # Get logits

    logger.info(f"ONNX Runtime took {end_time - start_time} s")

    # Compare PyTorch and ONNX Runtime accuracy
    tol = 2e1 if "int4" in args.onnx_model_path or "int8" in args.onnx_model_path else 5e-1
    parity = np.allclose(pt_outputs, ort_outputs, rtol=tol, atol=tol)
    logger.warning(f"Are PyTorch and ONNX Runtime results close? {parity}")
    if not parity:
        logger.warning(f"Max diff: {np.max(pt_outputs - ort_outputs)}")
    return kv_cache_ortvalues


def get_args(argv: list[str]):
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-m",
        "--model_name",
        required=False,
        help="Model name in Hugging Face",
    )

    parser.add_argument(
        "-t",
        "--torch_model_directory",
        required=False,
        default=os.path.join("."),
        help="Path to folder containing PyTorch model and associated files if saved on disk",
    )

    parser.add_argument(
        "-o",
        "--onnx_model_path",
        required=True,
        default=os.path.join("."),
        help="Path to ONNX model (with external data files saved in the same folder as the model)",
    )

    parser.add_argument(
        "-ep",
        "--execution_provider",
        required=False,
        default="cpu",
        choices=["cpu", "cuda"],
        help="Execution provider to verify parity with",
    )

    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Print verbose logs",
    )
    parser.set_defaults(verbose=False)

    parser.add_argument(
        "-p",
        "--use_past_kv",
        action="store_true",
        help="Use past key and past value as inputs to the model. Necessary for decoder_with_past_model.onnx models.",
    )
    parser.set_defaults(use_past_kv=False)

    parser.add_argument(
        "-g",
        "--use_buffer_share",
        action="store_true",
        help="Use if model has GroupQueryAttention and you want to enable past-present buffer sharing",
    )
    parser.set_defaults(use_buffer_share=False)

    parser.add_argument(
        "--merged",
        action="store_true",
        help="Use merged model (i.e. decoder_merged_model.onnx).",
    )
    parser.set_defaults(merged=False)

    parser.add_argument(
        "-fp",
        "--precision",
        required=True,
        choices=["int4", "int8", "fp16", "fp32"],
        help="Precision of model",
    )

    parser.add_argument(
        "--cache_dir",
        required=False,
        type=str,
        default="./model_cache",
        help="model cache dir to override default HF cache dir to avoid overflood the /home dir",
    )

    # The argument is used for CI mainly, because the CI machine has 24G GPU memory at most.
    parser.add_argument(
        "--small_gpu",
        action="store_true",
        help="Load the llama in GPU every time for parity_check if it's running in a machine which GPU memory < 36GB. ",
    )

    args = parser.parse_args() if argv == [] else parser.parse_args(argv)

    # Use FP32 precision for FP32, INT8, INT4 CPU models, use FP16 precision for FP16 and INT4 GPU models
    args.precision = (
        "fp32"
        if args.precision in {"int8", "fp32"} or (args.precision == "int4" and args.execution_provider == "cpu")
        else "fp16"
    )
    return args


def main(argv: list[str] = []):  # noqa: B006
    args = get_args(argv)
    setup_logger(args.verbose)
    logger.info(f"Arguments: {args}")
    rank = get_rank()

    # Load model and config
    setattr(args, "use_fp16", args.precision == "fp16")  # noqa: B010
    args.rank = rank
    setattr(args, "device_name", "cpu" if args.execution_provider == "cpu" else f"cuda:{rank}")  # noqa: B010
    setattr(args, "device", torch.device(args.device_name))  # noqa: B010
    use_auth_token = args.torch_model_directory == os.path.join(".")
    location = args.model_name if use_auth_token else args.torch_model_directory

    kv_cache_ortvalues = {}
    if not args.merged:
        verify_parity(args, location, use_auth_token, kv_cache_ortvalues)
    else:
        config = llama = None
        if not args.small_gpu:
            config, llama = setup_torch_model(
                args,
                location,
                use_auth_token,
                torch_dtype=(torch.float16 if args.use_fp16 else torch.float32),
                device=args.device,
            )

        # Verify prompt processing in merged model (decoder_model.onnx)
        args.use_past_kv = False
        kv_cache_ortvalues = verify_parity(
            args, location, use_auth_token, kv_cache_ortvalues, pytorch_model=llama, config=config
        )

        # Verify token generation in merged model (decoder_with_past_model.onnx)
        args.use_past_kv = True
        verify_parity(args, location, use_auth_token, kv_cache_ortvalues, pytorch_model=llama, config=config)


if __name__ == "__main__":
    seed = 2
    np.random.seed(seed)
    torch.manual_seed(seed)
    main()
