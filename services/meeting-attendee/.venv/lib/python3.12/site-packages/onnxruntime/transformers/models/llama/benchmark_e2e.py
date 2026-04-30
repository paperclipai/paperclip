# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

# This is an end-to-end benchmarking script for the Hugging Face LLaMA-2 model.
#
# Prerequisites:
# 1) Install `huggingface-cli`:
#
# $ pip install huggingface_hub
#
# 2) Authenticate with Hugging Face's CLI:
#
# $ huggingface-cli login
#
# 3) Accept Meta's license in Hugging Face to access the models at https://huggingface.co/meta-llama/
#
# 4) Install the latest ONNX Runtime version
#
# $ pip install onnxruntime-gpu
#
# 5) Install flash attention v2
#
# $ pip install flash-attn --no-build-isolation
#
# 6) Install bitsandbytes
#
# $ pip install bitsandbytes

from __future__ import annotations

import argparse
import datetime
import gc
import itertools
import json
import logging
import os
import textwrap
import time

import numpy as np
import pandas as pd
import torch
from benchmark_helper import setup_logger
from llama_inputs import add_io_bindings_as_tensors, get_initial_inputs_and_outputs
from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig

import onnxruntime as ort

logger = logging.getLogger(__name__)


def get_model(args: argparse.Namespace):
    if args.benchmark_type in {"pt-eager", "pt-compile"}:
        model = None
        if args.onnx_precision == "int4" and args.device == "cuda":
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_use_double_quant=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.float16,
            )

            model = AutoModelForCausalLM.from_pretrained(
                args.hf_dir_path if args.hf_dir_path != "" else args.model_name,
                cache_dir=args.cache_dir,
                torch_dtype=args.torch_dtype,
                use_auth_token=args.auth,
                trust_remote_code=args.trust,
                use_cache=True,
                attn_implementation="flash_attention_2",
                quantization_config=bnb_config,
                max_memory={args.device_id: "80GB"},
            )
        else:
            try:
                model = AutoModelForCausalLM.from_pretrained(
                    args.hf_dir_path if args.hf_dir_path != "" else args.model_name,
                    cache_dir=args.cache_dir,
                    torch_dtype=args.torch_dtype,
                    use_auth_token=args.auth,
                    trust_remote_code=args.trust,
                    use_cache=True,
                    attn_implementation=("flash_attention_2" if args.device == "cuda" else "sdpa"),
                ).to(args.target_device)
            except Exception as e:
                # When flash_attention or sdpa doesn't support a model, it throws an exception.
                # Rather than stopping a process, run as eager mode.
                print("Try to load a model using eager mode: ", e)
                model = AutoModelForCausalLM.from_pretrained(
                    args.hf_dir_path if args.hf_dir_path != "" else args.model_name,
                    cache_dir=args.cache_dir,
                    torch_dtype=args.torch_dtype,
                    use_auth_token=args.auth,
                    trust_remote_code=args.trust,
                    use_cache=True,
                    attn_implementation="eager",
                ).to(args.target_device)

        model.eval()

        if args.benchmark_type == "pt-compile":
            model = torch.compile(model)

    else:
        sess_options = ort.SessionOptions()
        ep = (
            ("CUDAExecutionProvider", {"device_id": args.device_id})
            if args.device == "cuda"
            else "CPUExecutionProvider"
        )
        model = ort.InferenceSession(args.onnx_model_path, sess_options=sess_options, providers=[ep])

    return model


def run_inference(args, model, runs, inputs, outputs):
    if args.benchmark_type == "pt-compile":
        with torch.no_grad():
            outputs = model(**inputs)

    # Synchronize inputs
    io_binding = None
    if args.benchmark_type in {"pt-eager", "pt-compile"}:
        if args.device != "cpu":
            torch.cuda.synchronize(args.target_device)
    else:
        io_binding = add_io_bindings_as_tensors(model, inputs, outputs, args.use_fp16, args.use_buffer_share)
        io_binding.synchronize_inputs()

    # Run inference
    start = time.perf_counter()
    for _ in range(runs):
        if args.benchmark_type in {"pt-eager", "pt-compile"}:
            with torch.no_grad():
                outputs = model(**inputs)
                if args.device != "cpu":
                    torch.cuda.synchronize(args.target_device)
        else:
            model.run_with_iobinding(io_binding)
            io_binding.synchronize_outputs()

    end = time.perf_counter()
    avg = (end - start) / runs
    return avg, outputs


def prepare_model_for_inference(args, model, config, tokenizer, prompt_length, prompt):
    clear_cache()
    inputs, outputs = get_initial_inputs_and_outputs(
        config, tokenizer, prompt_length, prompt, args.target_device, args.use_fp16, args.use_buffer_share, args.engine
    )
    _, outputs = run_inference(args, model, args.warmup_runs, inputs, outputs)
    return inputs, outputs


def clear_cache():
    gc.collect()
    torch.cuda.empty_cache()


def save_results(results, filename, gen_length):
    df = pd.DataFrame(
        results,
        columns=[
            "Batch Size",
            "Prompt Length",
            "Prompt Processing Latency (ms)",
            "Prompt Processing Throughput (tps)",
            "Sampling Latency (ms)",
            "Sampling Throughput (tps)",
            "First Token Generated Latency (ms)",
            "First Token Generated Throughput (tps)",
            f"Average Latency of First {gen_length // 2} Tokens Generated (ms)",
            f"Average Throughput of First {gen_length // 2} Tokens Generated (tps)",
            f"Average Latency of First {gen_length} Tokens Generated (ms)",
            f"Average Throughput of First {gen_length} Tokens Generated (tps)",
            "Wall-Clock Latency (s)",
            "Wall-Clock Throughput (tps)",
        ],
    )

    df.to_csv(filename, index=False)
    logger.info(f"Results saved in {filename}!")


def get_args():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-bt",
        "--benchmark-type",
        type=str,
        required=True,
        choices=["pt-eager", "pt-compile", "ort"],
    )

    parser.add_argument(
        "-m",
        "--model-name",
        type=str,
        required=False,
        help="Hugging Face name of model (e.g. 'meta-llama/Llama-2-7b-hf')",
    )

    parser.add_argument(
        "-a",
        "--auth",
        default=False,
        action="store_true",
        help="Use Hugging Face authentication token to access model",
    )

    parser.add_argument(
        "-t",
        "--trust",
        default=False,
        action="store_true",
        help="Whether or not to allow for custom models defined on the Hugging Face Hub in their own modeling files",
    )

    parser.add_argument(
        "-c",
        "--cache-dir",
        type=str,
        default=os.path.join(".", "model_cache"),
        help="Path to directory containing all Hugging Face files (e.g. config, tokenizer, PyTorch model). Use when loading model as `AutoModel.from_pretrained(model_name, cache_dir=cache_dir)`.",
    )

    parser.add_argument(
        "--hf-dir-path",
        type=str,
        default="",
        help="Path to directory containing all Hugging Face files (e.g. config, tokenizer, PyTorch model). Use when loading model as `AutoModel.from_pretrained(folder_path)`.",
    )

    parser.add_argument(
        "-o",
        "--onnx-model-path",
        required=False,
        help="Path to ONNX model",
    )

    parser.add_argument(
        "-f",
        "--prompts-file",
        required=True,
        default=os.path.join(".", "models", "llama", "prompts.json"),
        help="JSON file containing entries in the format 'prompt length: prompt' where prompt length = tokenized length of prompt",
    )

    parser.add_argument(
        "--use_buffer_share",
        default=False,
        action="store_true",
        help="Use when GroupQueryAttention (GQA) is in ONNX model",
    )

    (
        parser.add_argument(
            "--anomaly-filtering",
            default=False,
            action="store_true",
            help="Use this flag to filter anomaly accelerator times for tokens generated. \
              This may give more accurate latency and throughput metrics for tokens generated. \
              Wall-clock metrics are still reported with anomaly times though.",
        ),
    )

    parser.add_argument(
        "-b",
        "--batch-sizes",
        default="1 2",
    )

    parser.add_argument(
        "-s",
        "--prompt-lengths",
        default="16 64 256 1024",
    )

    parser.add_argument(
        "-p",
        "--precision",
        required=True,
        type=str,
        default="fp32",
        choices=["int4", "int8", "fp16", "fp32"],
        help="Precision for model. For ONNX models, the model's precision should be set before running this script.",
    )

    parser.add_argument(
        "-g",
        "--generation-length",
        type=int,
        default=256,
        help="Number of new tokens to generate",
    )

    parser.add_argument(
        "-d",
        "--device",
        type=str,
        default="cuda" if torch.cuda.is_available() else "cpu",
        choices=["cpu", "cuda"],
    )

    parser.add_argument("-id", "--device-id", type=int, default=0)
    parser.add_argument("-w", "--warmup-runs", type=int, default=5)
    parser.add_argument("-n", "--num-runs", type=int, default=100)
    parser.add_argument("--seed", type=int, default=2)

    args = parser.parse_args()

    # Set seed properties
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    # Set runtime properties
    if "ort" in args.benchmark_type:
        setattr(args, "execution_provider", f"{args.device.upper()}ExecutionProvider")  # noqa: B010
        if args.execution_provider == "CUDAExecutionProvider":
            args.execution_provider = (args.execution_provider, {"device_id": args.device_id})

    # Check that paths have been specified for any benchmarking with ORT
    if args.benchmark_type == "ort":
        assert args.onnx_model_path, "Please specify a path to `--onnx-model-path`"

    args.batch_sizes = args.batch_sizes.split(" ")
    args.prompt_lengths = args.prompt_lengths.split(" ")

    # Use FP32 precision for FP32, INT8, INT4 CPU models, use FP16 precision for FP16 and INT4 GPU models
    setattr(args, "onnx_precision", args.precision)  # noqa: B010
    args.precision = (
        "fp32" if args.precision in {"int8", "fp32"} or (args.precision == "int4" and args.device == "cpu") else "fp16"
    )

    target_device = f"cuda:{args.device_id}" if args.device != "cpu" else args.device
    torch_dtype = torch.float16 if args.precision == "fp16" else torch.float32
    engine = "ort" if args.benchmark_type == "ort" else "pt"
    setattr(args, "target_device", target_device)  # noqa: B010
    setattr(args, "torch_dtype", torch_dtype)  # noqa: B010
    setattr(args, "engine", engine)  # noqa: B010
    setattr(args, "use_fp16", args.precision == "fp16")  # noqa: B010

    args.use_buffer_share = args.use_buffer_share and engine == "ort"

    return args


def main():
    args = get_args()
    setup_logger(False)
    logger.info(args.__dict__)

    # Get prompts and prompt sizes
    size_to_prompt = None
    with open(args.prompts_file) as f:
        size_to_prompt = json.load(f, object_hook=lambda d: {int(k): v for k, v in d.items()})

    # Get config, tokenizer, and model
    config = AutoConfig.from_pretrained(
        args.hf_dir_path if args.hf_dir_path != "" else args.model_name,
        cache_dir=args.cache_dir,
        use_auth_token=args.auth,
        trust_remote_code=args.trust,
    )
    tokenizer = AutoTokenizer.from_pretrained(
        args.hf_dir_path if args.hf_dir_path != "" else args.model_name,
        cache_dir=args.cache_dir,
        use_auth_token=args.auth,
        trust_remote_code=args.trust,
    )
    model = get_model(args)

    all_csv_metrics = []
    for batch_size, prompt_length in itertools.product(args.batch_sizes, args.prompt_lengths):
        batch_size, prompt_length = int(batch_size), int(prompt_length)  # noqa: PLW2901
        logger.info(f"Running batch size = {batch_size}, prompt length = {prompt_length}")
        clear_cache()
        max_length = prompt_length + args.generation_length

        if prompt_length not in size_to_prompt:
            raise NotImplementedError(
                textwrap.dedent(
                    f"""
                                A prompt of size {prompt_length} was not found in '{args.prompts_file}'. There are a couple of solutions to fix this.
                                1) You can change one of the keys in '{args.prompts_file}' to be {prompt_length}.
                                    If {prompt_length} < actual prompt's length, the benchmark E2E tool will repeat the first word in the prompt until {prompt_length} = actual prompt's length.
                                    If {prompt_length} > actual prompt's length, the benchmark E2E tool will automatically trim the actual prompt's length so that {prompt_length} = actual prompt's length.
                                2) You can add a new key-value entry in '{args.prompts_file}' of the form '{prompt_length}': 'your prompt goes here'.
                """
                )
            )
        prompt = [size_to_prompt[prompt_length]] * batch_size
        csv_metrics = [batch_size, prompt_length]

        try:
            # Measure prompt processing
            logger.info("Measuring prompt processing...")
            inputs, outputs = prepare_model_for_inference(args, model, config, tokenizer, prompt_length, prompt)
            accelerator_prompt_latency_s, outputs = run_inference(args, model, args.num_runs, inputs, outputs)

            # Calculate prompt metrics
            accelerator_prompt_latency_ms = accelerator_prompt_latency_s * 1000
            accelerator_prompt_thrpt = batch_size * (prompt_length / accelerator_prompt_latency_s)
            logger.info(f"Average Latency of Prompt Processing: {accelerator_prompt_latency_ms} ms")
            logger.info(
                f"Average Throughput of Prompt Processing: {batch_size * (prompt_length / accelerator_prompt_latency_s)} tps"
            )
            csv_metrics.extend([accelerator_prompt_latency_ms, accelerator_prompt_thrpt])

            # Measure token generation
            logger.info("Measuring token generation...")
            clear_cache()
            inputs, outputs = prepare_model_for_inference(args, model, config, tokenizer, prompt_length, prompt)

            all_token_ids = inputs["input_ids"].clone()
            current_length = all_token_ids.shape[-1]
            num_heads = config.num_key_value_heads
            head_size = (
                config.head_dim if hasattr(config, "head_dim") else config.hidden_size // config.num_attention_heads
            )

            has_eos = torch.zeros(batch_size, device=args.target_device, dtype=torch.bool)

            # 0th entry will have prompt accelerator time, 1st entry onwards will have token generation accelerator time
            accelerator_times = []
            sampling_times = []  # cost to sample after each model run

            wall_clock_start_time = time.perf_counter()
            while current_length <= max_length:
                # Run inference
                accelerator_time_latency_s, outputs = run_inference(args, model, 1, inputs, outputs)
                accelerator_times.append(accelerator_time_latency_s)

                # Sample with argmax (greedy search)
                sampling_start_time = time.perf_counter()
                if outputs["logits"].shape[1] > 1:
                    prompt_end_indices = inputs["attention_mask"].sum(1) - 1
                    idxs = (
                        prompt_end_indices.unsqueeze(dim=1)
                        .repeat(1, config.vocab_size)
                        .view(batch_size, 1, config.vocab_size)
                    )
                    next_token_logits = torch.gather(outputs["logits"], 1, idxs).squeeze()
                else:
                    next_token_logits = outputs["logits"][:, -1, :]
                next_tokens = torch.argmax(next_token_logits, dim=-1)

                # Check if we previously reached EOS token id or if generated token id is EOS token id
                has_eos = has_eos | next_tokens == tokenizer.eos_token_id

                # Determine which new tokens to add to list of all token ids
                # Add EOS token ids for batch entries that ended early (ragged batching scenario where some batch entries ended early and some haven't)
                tokens_to_add = next_tokens.masked_fill(has_eos, tokenizer.eos_token_id).reshape([batch_size, 1])
                sampling_end_time = time.perf_counter()
                sampling_times.append(sampling_end_time - sampling_start_time)

                all_token_ids = torch.cat([all_token_ids, tokens_to_add], dim=-1)
                current_length += 1

                # Update inputs for next inference run
                inputs["input_ids"] = tokens_to_add
                inputs["attention_mask"] = torch.cat(
                    [inputs["attention_mask"], (~has_eos).to(torch.int64).reshape(batch_size, 1)], 1
                )
                if "position_ids" in inputs:
                    inputs["position_ids"] = torch.max(inputs["position_ids"], dim=1)[0].reshape(batch_size, 1) + 1

                # Set logits to zeros for next inference run and re-use memory buffer
                if outputs["logits"].shape[1] != 1:
                    outputs["logits"] = outputs["logits"][:, :1, :].contiguous()
                outputs["logits"].zero_()

                # Update KV caches for next inference run
                if args.engine == "pt":
                    # Update KV caches for PyTorch
                    inputs["past_key_values"] = outputs["past_key_values"]
                elif not args.use_buffer_share:
                    # Update KV caches for ONNX Runtime if buffer sharing is not used
                    for i in range(config.num_hidden_layers):
                        inputs[f"past_key_values.{i}.key"] = outputs[f"present.{i}.key"]
                        inputs[f"past_key_values.{i}.value"] = outputs[f"present.{i}.value"]

                    new_sequence_length = inputs["attention_mask"].shape[1]
                    for i in range(config.num_hidden_layers):
                        present_key = torch.zeros(
                            batch_size,
                            num_heads,
                            new_sequence_length,
                            head_size,
                            device=args.target_device,
                            dtype=args.torch_dtype,
                        )
                        present_value = torch.zeros(
                            batch_size,
                            num_heads,
                            new_sequence_length,
                            head_size,
                            device=args.target_device,
                            dtype=args.torch_dtype,
                        )
                        outputs.update(
                            {
                                f"present.{i}.key": present_key.contiguous(),
                                f"present.{i}.value": present_value.contiguous(),
                            }
                        )

            wall_clock_end_time = time.perf_counter()

            # Filter out any anomaly accelerator times (e.g. for `torch.compile`)
            accelerator_times.pop(0)  # Remove prompt processing time
            if args.anomaly_filtering:
                anomaly_threshold_factor = 10
                min_time_s = min(accelerator_times)
                orig_size = len(accelerator_times)
                accelerator_times = list(
                    filter(lambda acc_time: acc_time < anomaly_threshold_factor * min_time_s, accelerator_times)
                )
                new_size = len(accelerator_times)
                logger.info(
                    f"Filtered out {orig_size - new_size} anomaly accelerator times that are {anomaly_threshold_factor}x greater than {min_time_s * 1000} ms..."
                )

            #######################################################
            # Calculate sampling and first token generated metrics
            #######################################################

            # Calculate sampling metrics
            avg_sampling_latency_s = sum(sampling_times) / len(sampling_times)
            avg_sampling_latency_ms = avg_sampling_latency_s * 1000
            avg_sampling_thrpt = batch_size * (1 / avg_sampling_latency_s)
            logger.info(f"Average Latency of Sampling: {avg_sampling_latency_ms} ms")
            logger.info(f"Average Throughput of Sampling: {avg_sampling_thrpt} tps")

            # Calculate first token generated metrics
            first_token_latency_s = accelerator_times[0]
            first_token_latency_ms = first_token_latency_s * 1000
            first_token_thrpt = batch_size * (1 / first_token_latency_s)
            logger.info(f"Latency of First Token Generated: {first_token_latency_ms} ms")
            logger.info(f"Throughput of First Token Generated: {first_token_thrpt} tps")

            ####################################################
            # Calculate first `halfway` token generated metrics
            ####################################################

            halfway = args.generation_length // 2
            halfway_token_latency_s = sum(accelerator_times[:halfway]) / len(accelerator_times[:halfway])
            halfway_token_latency_ms = halfway_token_latency_s * 1000
            halfway_token_thrpt = batch_size * (1 / halfway_token_latency_s)
            logger.info(f"Average Latency of First {halfway} Tokens Generated: {halfway_token_latency_ms} ms")
            logger.info(f"Average Throughput of First {halfway} Tokens Generated: {halfway_token_thrpt} tps")

            #########################################
            # Calculate all tokens generated metrics
            #########################################

            all_token_latency_s = sum(accelerator_times) / len(accelerator_times)
            all_token_latency_ms = all_token_latency_s * 1000
            all_token_thrpt = batch_size * (1 / all_token_latency_s)
            logger.info(
                f"Average Latency of First {args.generation_length} Tokens Generated: {all_token_latency_ms} ms"
            )
            logger.info(f"Average Throughput of First {args.generation_length} Tokens Generated: {all_token_thrpt} tps")

            ###############################
            # Calculate wall clock metrics
            ###############################

            wall_clock_latency_s = wall_clock_end_time - wall_clock_start_time
            wall_clock_thrpt = batch_size * ((prompt_length + args.generation_length) / wall_clock_latency_s)
            logger.info(f"Wall-Clock Latency: {wall_clock_latency_s} s")
            logger.info(
                f"Wall-Clock Throughput: {batch_size * ((prompt_length + args.generation_length) / wall_clock_latency_s)} tps"
            )

            # Add metrics to CSV
            logger.info("Adding results to CSV")
            csv_metrics.extend(
                [
                    avg_sampling_latency_ms,
                    avg_sampling_thrpt,
                    first_token_latency_ms,
                    first_token_thrpt,
                    halfway_token_latency_ms,
                    halfway_token_thrpt,
                    all_token_latency_ms,
                    all_token_thrpt,
                    wall_clock_latency_s,
                    wall_clock_thrpt,
                ]
            )
            all_csv_metrics.append(csv_metrics)

        except Exception as e:
            logger.info(f"Could not benchmark at batch size = {batch_size}, prompt length = {prompt_length} - {e}")

    filename = f"benchmark_{args.engine}_e2e_{datetime.datetime.now():%Y-%m-%d_%H:%M:%S}.csv"
    save_results(all_csv_metrics, filename, args.generation_length)


if __name__ == "__main__":
    main()
