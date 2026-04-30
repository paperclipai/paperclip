# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import argparse
import ast
import datetime
import gc
import logging
import os
import sys
import time

import numpy as np
import psutil
import torch
import whisper
from benchmark_helper import measure_memory, setup_logger
from onnxruntime_extensions import get_library_path
from optimum.onnxruntime import ORTModelForSpeechSeq2Seq
from torch.profiler import ProfilerActivity, profile, record_function
from tqdm import trange
from transformers import AutoModelForSpeechSeq2Seq, WhisperConfig, WhisperProcessor

import onnxruntime as ort

logger = logging.getLogger(__name__)


def get_inputs(args: argparse.Namespace):
    if args.benchmark_type not in {"hf-pt-eager", "hf-pt-compile", "hf-ort", "ort"}:
        raise Exception("Unable to auto-detect inputs for provided model")

    def load_via_ffmpeg():
        audio = whisper.load_audio(args.audio_path)
        audio = whisper.pad_or_trim(audio)
        return audio

    def load_via_numpy():
        with open(args.audio_path, "rb") as f:
            audio = np.asarray(list(f.read()), dtype=np.uint8)
            audio = np.array([audio])
        return audio

    inputs = {
        "max_length": args.max_length,
        "min_length": args.min_length,
        "num_beams": args.num_beams,
        "num_return_sequences": args.num_return_sequences,
        "length_penalty": args.length_penalty,
        "repetition_penalty": args.repetition_penalty,
    }
    if args.benchmark_type == "ort":
        # convert_to_onnx export or ONNX E2E solution created by Olive
        for k, v in inputs.items():
            inputs[k] = np.array([v], dtype=np.float32 if "penalty" in k else np.int32)
        if args.has_decoder_input_ids:
            inputs["decoder_input_ids"] = np.array([args.decoder_input_ids], dtype=np.int32)
        if args.has_logits_processor:
            inputs["logits_processor"] = np.array([args.logits_processor], dtype=np.int32)
        if args.has_temperature:
            inputs["temperature"] = np.array([args.temperature], dtype=np.float32)

    # Measure time taken to load audio file
    logger.info(f"Load audio: {args.audio_path}")
    load_audio_fn = lambda onnx_e2e: load_via_numpy() if onnx_e2e else load_via_ffmpeg()  # noqa: E731
    time_fn(args, load_audio_fn, args.has_audio_stream)
    audio_data = load_audio_fn(args.has_audio_stream)

    if args.has_audio_stream:
        # ONNX E2E solution created by Olive
        inputs["audio_stream"] = audio_data
        return inputs

    # Measure time taken to get input features
    logger.info("Feature extraction: ")
    return_type = "np" if args.benchmark_type == "ort" else "pt"
    processor_fn = lambda audio: args.processor.feature_extractor(  # noqa: E731
        [audio], return_tensors=return_type, sampling_rate=args.sampling_rate
    ).input_features
    time_fn(args, processor_fn, audio_data)
    input_features = processor_fn(audio_data)

    if args.benchmark_type == "ort":
        # convert_to_onnx export
        inputs["input_features"] = input_features
        return inputs

    inputs["inputs"] = input_features.to(
        dtype=torch.float16 if args.use_fp16 else torch.float32, device=args.target_device
    )
    inputs["no_repeat_ngram_size"] = args.no_repeat_ngram_size
    inputs["early_stopping"] = True
    inputs["use_cache"] = True

    if args.decoder_input_ids:
        inputs["forced_decoder_ids"] = args.decoder_input_ids

    return inputs


def get_model(args: argparse.Namespace):
    model, sess_options = None, None
    start_time, end_time = None, None

    # There are multiple sources that the model could come from:
    # 1) Benchmark Whisper from Hugging Face
    # 2) Benchmark Whisper ONNX model from Optimum export (without pre/post processing)
    # 3) Benchmark Whisper ONNX E2E model from Olive (with pre/post processing)

    if args.benchmark_type in {"hf-pt-eager", "hf-pt-compile"}:
        source = args.hf_pt_model_path if args.hf_pt_model_path else args.model_name
        start_time = time.time()
        model = AutoModelForSpeechSeq2Seq.from_pretrained(
            source,
            torch_dtype=torch.float16 if args.use_fp16 else torch.float32,
            use_cache=True,
        ).to(args.target_device)
        end_time = time.time()

        if args.benchmark_type == "hf-pt-compile":
            model = torch.compile(model)

    elif args.benchmark_type in {"hf-ort", "ort"}:
        sess_options = ort.SessionOptions()
        sess_options.enable_profiling = args.profile
        sess_options.register_custom_ops_library(get_library_path())
        if args.verbose:
            sess_options.log_verbosity_level = 1
            sess_options.log_severity_level = 1

    else:
        raise Exception(f"Cannot recognize {args.benchmark_type}")

    if args.benchmark_type == "hf-ort":
        # Optimum export
        provider = args.execution_provider[0] if type(args.execution_provider) is tuple else args.execution_provider
        provider_options = args.execution_provider[1] if type(args.execution_provider) is tuple else None

        start_time = time.time()
        model = ORTModelForSpeechSeq2Seq.from_pretrained(
            args.hf_ort_dir_path,
            provider=provider,
            provider_options=provider_options,
            session_options=sess_options,
            use_io_binding=True,  # Avoid memory copy overhead
        )
        end_time = time.time()

    if args.benchmark_type == "ort":
        # convert_to_onnx.py export
        logger.info(f"Loading model from {args.ort_model_path}")
        start_time = time.time()
        model = ort.InferenceSession(
            args.ort_model_path,
            sess_options,
            providers=[args.execution_provider],
        )
        end_time = time.time()

    logger.info(f"Loaded model in {end_time - start_time} s")

    return model


def time_fn(args, fn, inputs):
    warmup_inputs = inputs[0] if type(inputs) is tuple else inputs
    benchmark_inputs = inputs[1] if type(inputs) is tuple else inputs
    torch_device = torch.device(args.target_device)

    # Warm up
    warmup_range = (
        range(args.warmup_runs)
        if args.benchmark_type == "ort"
        else trange(args.warmup_runs, file=sys.stdout, desc="Warm up")
    )

    if args.verbose:
        outputs = fn(warmup_inputs)
        logger.info(outputs)

    for _ in warmup_range:
        fn(warmup_inputs)

    # Benchmark
    if args.device != "cpu":
        torch.cuda.synchronize(torch_device)
    start_time = time.time()

    bench_range = (
        range(args.num_runs)
        if args.benchmark_type == "ort"
        else trange(args.num_runs, file=sys.stdout, desc="Benchmark")
    )
    for _ in bench_range:
        fn(benchmark_inputs)

    if args.device != "cpu":
        torch.cuda.synchronize(torch_device)
    end_time = time.time()

    # Newline print after trange in order to print metrics on new lines without progress bar on same line
    if args.benchmark_type != "ort":
        logger.info("")

    batch_size = 1
    latency = (end_time - start_time) / args.num_runs
    throughput = batch_size / latency

    logger.info(f"Latency: {latency} s")
    logger.info(f"Throughput: {throughput} qps")
    return


def profile_fn(args, fn, inputs, inputs_type):
    # Filename prefix format:
    # "<benchmark-type>-<precision>-<device>_<inference-step>_<inputs-type>_<current-time>"
    prefix = f"{args.benchmark_type.lower()}-{args.precision}-{args.device}_{fn.__name__.replace('_', '-')}_{inputs_type}_{datetime.datetime.now():%Y-%m-%d_%H:%M:%S}"
    filename = None

    if args.benchmark_type in {"hf-pt-eager", "hf-pt-compile"}:
        # Profile PyTorch kernels
        with profile(  # noqa: SIM117
            activities=[ProfilerActivity.CPU, ProfilerActivity.CUDA], record_shapes=True, profile_memory=True
        ) as prof:
            with record_function("model_inference"):
                fn(inputs)
        prof_data = prof.key_averages(group_by_stack_n=5).table(sort_by=args.pt_filter_by, row_limit=args.pt_num_rows)

        filename = os.path.join(args.log_folder, f"{prefix}.log")
        with open(filename, "w") as f:
            f.write(prof_data)

    else:
        # Profile ORT kernels
        fn(inputs)

        # Set new log name for ORT profile log generated
        filename = f"{prefix}.json"

    return filename


def measure_fn(args, fn, inputs):
    # Measure CPU usage
    pid = os.getpid()
    process = psutil.Process(pid)
    process.cpu_percent(interval=0.1)

    fn(inputs)
    logger.info(f"CPU usage: {process.cpu_percent(interval=None)}%")

    # Measure memory usage
    gc.collect()
    torch.cuda.empty_cache()
    measure_memory(is_gpu=(args.device != "cpu"), func=lambda: fn(inputs), monitor_type=args.monitor_type)

    # Flush output so memory usage is printed
    sys.stdout.flush()


def run_hf_inference(args, inputs, model):
    # Inference steps to measure
    def get_pred_ids(inputs):
        # Inference pass with predicted token ids generation
        predicted_ids = model.generate(**inputs)
        return predicted_ids

    def gen_and_dec(inputs):
        # Inference pass with generation and decoding
        predicted_ids = get_pred_ids(inputs)
        transcription = []
        for _ in range(args.num_return_sequences):
            transcription.append(args.processor.batch_decode(predicted_ids, skip_special_tokens=True)[0])
        return predicted_ids, transcription

    # Examples of other inference steps that can be measured:
    # To use, uncomment the function and assign it to `generate_fn`

    # def get_logits(inputs):
    #     # Inference pass without decoding
    #     outputs = model(**inputs)
    #     return outputs

    generate_fn = gen_and_dec

    if args.benchmark_type == "hf-pt-compile":
        # Run forward pass once with each set of inputs to process through Dynamo
        generate_fn(inputs)

    if args.profile:
        new_logname = profile_fn(args, generate_fn, inputs, "gen-and-dec")
        if args.benchmark_type == "hf-ort":
            # Rename log files per model component and turn profiling off to stop appending to log
            new_prefix = new_logname[: -len(".json")]

            old_logname = model.encoder.session.end_profiling()
            new_logname = new_prefix + "-encoder.json"
            if os.path.isfile(old_logname):
                logger.warning(f"Renaming {old_logname} to {new_logname}")
                os.rename(old_logname, os.path.join(args.log_folder, new_logname))

            old_logname = model.decoder.session.end_profiling()
            new_logname = new_prefix + "-decoder.json"
            if os.path.isfile(old_logname):
                logger.warning(f"Renaming {old_logname} to {new_logname}")
                os.rename(old_logname, os.path.join(args.log_folder, new_logname))

            old_logname = model.decoder_with_past.session.end_profiling()
            new_logname = new_prefix + "-decoder-with-past.json"
            if os.path.isfile(old_logname):
                logger.warning(f"Renaming {old_logname} to {new_logname}")
                os.rename(old_logname, os.path.join(args.log_folder, new_logname))

        return

    # PyTorch evaluations
    logger.info("\nEvaluating PyTorch...")
    time_fn(args, generate_fn, inputs)
    predicted_ids, transcription = generate_fn(inputs)
    logger.info(f"Generated token length: {len(predicted_ids[0])} tokens")
    logger.info(f"Transcription: {transcription[0]}")
    measure_fn(args, generate_fn, inputs)


def run_ort_inference(args, inputs, model):
    def prepare_ort_inputs(inputs, warmup=False):
        # Check that all model inputs will be provided
        model_inputs = {model_input.name for model_input in model.get_inputs()}
        user_inputs = set(inputs.keys())
        missing_inputs = model_inputs - user_inputs
        if len(missing_inputs):
            logger.error(f"The following model inputs are missing: {missing_inputs}")
            raise Exception("There are missing inputs to the model. Please add them and try again.")

        # Remove unnecessary inputs from model inputs
        unnecessary_inputs = user_inputs - model_inputs
        if len(unnecessary_inputs):
            for unnecessary_input in unnecessary_inputs:
                logger.info(f"Removing unnecessary input '{unnecessary_input}' from user provided inputs")
                del inputs[unnecessary_input]

        # Add IO bindings for non-CPU execution providers
        if args.device != "cpu":
            io_binding = model.io_binding()
            for k, v in inputs.items():
                io_binding.bind_cpu_input(k, v)
            for output in model.get_outputs():
                io_binding.bind_output(output.name, device_type=args.device, device_id=args.device_id)
            return io_binding

        return inputs

    def with_io_binding(io_binding):
        # Inference pass with IO binding
        model.run_with_iobinding(io_binding)
        return io_binding

    def without_io_binding(inputs):
        # Inference pass without IO binding
        outputs = model.run(None, inputs)
        return outputs

    def handle_output(output):
        if args.eos_token_id in output:
            first_end = np.where(output == args.eos_token_id)[0][0]
            return output[: first_end + 1]

        return output

    generate_fn = with_io_binding if args.device != "cpu" else without_io_binding
    ort_inputs = prepare_ort_inputs(inputs)

    if args.profile:
        new_logname = profile_fn(args, generate_fn, ort_inputs, "e2e")

        # Turn profiling off to stop appending to log file
        old_logname = model.end_profiling()
        logger.warning(f"Renaming {old_logname} to {new_logname}")
        os.rename(old_logname, os.path.join(args.log_folder, new_logname))

        return

    # ORT evaluation
    logger.info("\nEvaluating ONNX Runtime...")
    ort_evaluate_inputs = ort_inputs

    time_fn(args, generate_fn, ort_evaluate_inputs)
    ort_outputs = generate_fn(ort_inputs)
    if args.device != "cpu":
        ort_outputs = ort_outputs.copy_outputs_to_cpu()
    ort_outputs = ort_outputs[0]

    if args.has_audio_stream:
        # ONNX E2E model from Olive produces transcribed output
        logger.info(f"Transcription: {ort_outputs[0][0]}")
    else:
        # convert_to_onnx model produces generated ids
        actual_output = handle_output(ort_outputs[0][0])
        logger.info(f"Generated token length: {len(actual_output)} tokens")
        transcription = args.processor.batch_decode(ort_outputs[0], skip_special_tokens=True)[0]
        # print to stdout as the output for comparison
        print(f"{transcription}")

    measure_fn(args, generate_fn, ort_inputs)


def run_inference(args, inputs, model):
    if args.benchmark_type in {"hf-pt-eager", "hf-pt-compile", "hf-ort"}:
        run_hf_inference(args, inputs, model)
    elif args.benchmark_type == "ort":
        run_ort_inference(args, inputs, model)
    else:
        raise Exception(f"Cannot recognize {args.benchmark_type}")


def parse_args():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-bt",
        "--benchmark-type",
        type=str,
        required=True,
        choices=["hf-pt-eager", "hf-pt-compile", "hf-ort", "ort"],
    )

    parser.add_argument(
        "-m",
        "--model-name",
        type=str,
        required=True,
        help="Hugging Face name of model (e.g. 'openai/whisper-large-v2')",
    )
    parser.add_argument(
        "-p",
        "--precision",
        type=str,
        required=True,
        default="fp32",
        choices=["int4", "int8", "fp16", "fp32"],
        help="Precision for model. For ONNX models, the model's precision should be set before running this script.",
    )

    parser.add_argument(
        "--hf-pt-model-path",
        type=str,
        default="",
        help="Path to directory containing all PyTorch files (e.g. tokenizer, PyTorch model)",
    )
    parser.add_argument(
        "--hf-ort-dir-path",
        type=str,
        default="",
        help="Path to directory containing all ONNX files (e.g. tokenizer, encoder, decoder, decoder_with_past)",
    )
    parser.add_argument(
        "--ort-model-path",
        type=str,
        default="",
        help="Path to ONNX model",
    )

    # Args for running and evaluating the model
    parser.add_argument("-a", "--audio-path", type=str, required=True, help="Path to audio file for E2E evaluation")
    parser.add_argument(
        "-d",
        "--device",
        type=str,
        default="cuda" if torch.cuda.is_available() else "cpu",
        choices=["cpu", "cuda"],
    )
    parser.add_argument("-id", "--device-id", type=int, default=0)
    parser.add_argument("-w", "--warmup-runs", type=int, default=5)
    parser.add_argument("-n", "--num-runs", type=int, default=10)
    parser.add_argument("--seed", type=int, default=2)

    # Optional args:
    parser.add_argument("--sampling-rate", type=int, default=16000, help="Sampling rate for audio (in Hz)")

    # Args for decoding logic
    # Required args:
    parser.add_argument("--max-length", type=int, default=448)
    parser.add_argument("--min-length", type=int, default=0)
    parser.add_argument("--num-beams", type=int, default=1)
    parser.add_argument("--num-return-sequences", type=int, default=1)
    parser.add_argument("--length-penalty", type=float, default=1.0)
    parser.add_argument("--repetition-penalty", type=float, default=1.0)
    parser.add_argument("--no-repeat-ngram-size", type=int, default=3)

    # Optional args for E2E solution:
    parser.add_argument(
        "--decoder-input-ids",
        type=str,
        default="[]",
        help="The forced decoder ids for generation. Format is [start token, timestamp token, language token, task token]. Default is [start token]. See `decoder_input_ids` in https://github.com/microsoft/Olive/tree/main/examples/whisper for details.",
    )
    parser.add_argument(
        "--logits-processor",
        type=int,
        default=1,
        help="Whether to use timestamps logits processor or not (0 for false, 1 for true).",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=1.0,
        help="Temperature value for generation.",
    )

    # Args for accessing detailed info
    parser.add_argument("--profile", default=False, action="store_true")
    parser.add_argument(
        "--pt-filter-by", type=str, default="self_cpu_time_total", help="What to filter PyTorch profiler by"
    )
    parser.add_argument("--pt-num-rows", type=int, default=1000, help="Number of rows for PyTorch profiler to display")
    parser.add_argument("--verbose", default=False, action="store_true")
    parser.add_argument("--log-folder", type=str, default=os.path.join("."), help="Folder to cache log files")

    args = parser.parse_args()

    # Set seed properties
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)

    args.monitor_type = args.device
    # Set runtime properties
    if "ort" in args.benchmark_type:
        args.execution_provider = f"{args.device.upper()}ExecutionProvider"
        if args.execution_provider == "CUDAExecutionProvider":
            args.execution_provider = (args.execution_provider, {"device_id": args.device_id})

    # Check that model paths have been specified for any benchmarking with ORT
    if args.benchmark_type == "hf-ort":
        assert args.hf_ort_dir_path, "Please specify a path to `--hf-ort-dir-path`"
    if args.benchmark_type == "ort":
        assert args.ort_model_path, "Please specify a path to `--ort-model-path`"

    # Convert decoder_input_ids string to list of ids
    # (e.g. "[1, 50257]" for Hugging Face or "[50257]" for ORT)
    args.decoder_input_ids = ast.literal_eval(args.decoder_input_ids)

    return args


def main():
    args = parse_args()
    setup_logger(args.verbose)
    logger.info(args.__dict__)
    torch.backends.cudnn.benchmark = True

    config = WhisperConfig.from_pretrained(args.model_name)
    processor = WhisperProcessor.from_pretrained(args.model_name)
    target_device = f"cuda:{args.device_id}" if args.device != "cpu" else args.device
    use_fp16 = args.precision == "fp16" or (args.precision in {"int8", "int4"} and args.device != "cpu")

    setattr(args, "processor", processor)  # noqa: B010
    setattr(args, "target_device", target_device)  # noqa: B010
    setattr(args, "use_fp16", use_fp16)  # noqa: B010
    setattr(args, "has_audio_stream", False)  # noqa: B010
    setattr(args, "eos_token_id", config.eos_token_id)  # noqa: B010

    logger.info(f"Forced decoder prompt ids: {args.decoder_input_ids}")

    # Measure cost to transcribe audio
    model = get_model(args)
    if args.benchmark_type == "ort":
        # Check for optional inputs that could have been added during export
        ort_model_inputs = {model_input.name for model_input in model.get_inputs()}
        args.has_audio_stream = "audio_stream" in ort_model_inputs
        setattr(args, "has_decoder_input_ids", "decoder_input_ids" in ort_model_inputs)  # noqa: B010
        setattr(args, "has_logits_processor", "logits_processor" in ort_model_inputs)  # noqa: B010
        setattr(args, "has_temperature", "temperature" in ort_model_inputs)  # noqa: B010

        if args.decoder_input_ids == []:
            args.decoder_input_ids = [config.decoder_start_token_id]

    inputs = get_inputs(args)
    run_inference(args, inputs, model)


if __name__ == "__main__":
    main()
