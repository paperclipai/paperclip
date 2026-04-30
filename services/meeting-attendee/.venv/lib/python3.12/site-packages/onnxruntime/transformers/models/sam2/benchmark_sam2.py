# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

"""
Benchmark performance of SAM2 encoder with ORT or PyTorch. See benchmark_sam2.sh for usage.
"""

import argparse
import csv
import statistics
import time
from collections.abc import Mapping
from datetime import datetime

import torch
from image_decoder import SAM2ImageDecoder
from image_encoder import SAM2ImageEncoder
from sam2_utils import decoder_shape_dict, encoder_shape_dict, load_sam2_model

from onnxruntime import InferenceSession, SessionOptions, get_available_providers
from onnxruntime.transformers.io_binding_helper import CudaSession


class TestConfig:
    def __init__(
        self,
        model_type: str,
        onnx_path: str,
        sam2_dir: str,
        device: torch.device,
        component: str = "image_encoder",
        provider="CPUExecutionProvider",
        torch_compile_mode="max-autotune",
        batch_size: int = 1,
        height: int = 1024,
        width: int = 1024,
        num_labels: int = 1,
        num_points: int = 1,
        num_masks: int = 1,
        multi_mask_output: bool = False,
        use_tf32: bool = True,
        enable_cuda_graph: bool = False,
        dtype=torch.float32,
        prefer_nhwc: bool = False,
        warm_up: int = 5,
        enable_nvtx_profile: bool = False,
        enable_ort_profile: bool = False,
        enable_torch_profile: bool = False,
        repeats: int = 1000,
        verbose: bool = False,
    ):
        assert model_type in ["sam2_hiera_tiny", "sam2_hiera_small", "sam2_hiera_large", "sam2_hiera_base_plus"]
        assert height >= 160 and height <= 4096
        assert width >= 160 and width <= 4096

        self.model_type = model_type
        self.onnx_path = onnx_path
        self.sam2_dir = sam2_dir
        self.component = component
        self.provider = provider
        self.torch_compile_mode = torch_compile_mode
        self.batch_size = batch_size
        self.height = height
        self.width = width
        self.num_labels = num_labels
        self.num_points = num_points
        self.num_masks = num_masks
        self.multi_mask_output = multi_mask_output
        self.device = device
        self.use_tf32 = use_tf32
        self.enable_cuda_graph = enable_cuda_graph
        self.dtype = dtype
        self.prefer_nhwc = prefer_nhwc
        self.warm_up = warm_up
        self.enable_nvtx_profile = enable_nvtx_profile
        self.enable_ort_profile = enable_ort_profile
        self.enable_torch_profile = enable_torch_profile
        self.repeats = repeats
        self.verbose = verbose

        if self.component == "image_encoder":
            assert self.height == 1024 and self.width == 1024, "Only image size 1024x1024 is allowed for image encoder."

    def __repr__(self):
        return f"{vars(self)}"

    def shape_dict(self) -> Mapping[str, list[int]]:
        if self.component == "image_encoder":
            return encoder_shape_dict(self.batch_size, self.height, self.width)
        else:
            return decoder_shape_dict(self.height, self.width, self.num_labels, self.num_points, self.num_masks)

    def random_inputs(self) -> Mapping[str, torch.Tensor]:
        dtype = self.dtype
        if self.component == "image_encoder":
            return {"image": torch.randn(self.batch_size, 3, self.height, self.width, dtype=dtype, device=self.device)}
        else:
            return {
                "image_features_0": torch.rand(1, 32, 256, 256, dtype=dtype, device=self.device),
                "image_features_1": torch.rand(1, 64, 128, 128, dtype=dtype, device=self.device),
                "image_embeddings": torch.rand(1, 256, 64, 64, dtype=dtype, device=self.device),
                "point_coords": torch.randint(
                    0, 1024, (self.num_labels, self.num_points, 2), dtype=dtype, device=self.device
                ),
                "point_labels": torch.randint(
                    0, 1, (self.num_labels, self.num_points), dtype=torch.int32, device=self.device
                ),
                "input_masks": torch.zeros(self.num_labels, 1, 256, 256, dtype=dtype, device=self.device),
                "has_input_masks": torch.ones(self.num_labels, dtype=dtype, device=self.device),
                "original_image_size": torch.tensor([self.height, self.width], dtype=torch.int32, device=self.device),
            }


def create_ort_session(config: TestConfig, session_options=None) -> InferenceSession:
    if config.verbose:
        print(f"create session for {vars(config)}")

    if config.provider == "CUDAExecutionProvider":
        device_id = torch.cuda.current_device() if isinstance(config.device, str) else config.device.index
        provider_options = CudaSession.get_cuda_provider_options(device_id, config.enable_cuda_graph)
        provider_options["use_tf32"] = int(config.use_tf32)
        if config.prefer_nhwc:
            provider_options["prefer_nhwc"] = 1
        providers = [(config.provider, provider_options), "CPUExecutionProvider"]
    else:
        providers = ["CPUExecutionProvider"]

    ort_session = InferenceSession(config.onnx_path, session_options, providers=providers)
    return ort_session


def create_session(config: TestConfig, session_options=None) -> CudaSession:
    ort_session = create_ort_session(config, session_options)
    cuda_session = CudaSession(ort_session, config.device, config.enable_cuda_graph)
    cuda_session.allocate_buffers(config.shape_dict())
    return cuda_session


class OrtTestSession:
    """A wrapper of ORT session to test relevance and performance."""

    def __init__(self, config: TestConfig, session_options=None):
        self.ort_session = create_session(config, session_options)
        self.feed_dict = config.random_inputs()

    def infer(self):
        return self.ort_session.infer(self.feed_dict)


def measure_latency(cuda_session: CudaSession, input_dict):
    start = time.time()
    _ = cuda_session.infer(input_dict)
    end = time.time()
    return end - start


def run_torch(config: TestConfig):
    device_type = config.device.type
    is_cuda = device_type == "cuda"

    # Turn on TF32 for Ampere GPUs which could help when data type is float32.
    if is_cuda and torch.cuda.get_device_properties(0).major >= 8 and config.use_tf32:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    enabled_auto_cast = is_cuda and config.dtype != torch.float32
    ort_inputs = config.random_inputs()

    with torch.inference_mode(), torch.autocast(device_type=device_type, dtype=config.dtype, enabled=enabled_auto_cast):
        sam2_model = load_sam2_model(config.sam2_dir, config.model_type, device=config.device)
        if config.component == "image_encoder":
            if is_cuda and config.torch_compile_mode != "none":
                sam2_model.image_encoder.forward = torch.compile(
                    sam2_model.image_encoder.forward,
                    mode=config.torch_compile_mode,  # "reduce-overhead" if you want to reduce latency of first run.
                    fullgraph=True,
                    dynamic=False,
                )

            image_shape = config.shape_dict()["image"]
            img = torch.randn(image_shape).to(device=config.device, dtype=config.dtype)
            sam2_encoder = SAM2ImageEncoder(sam2_model)

            if is_cuda and config.torch_compile_mode != "none":
                print(f"Running warm up. It will take a while since torch compile mode is {config.torch_compile_mode}.")

            for _ in range(config.warm_up):
                _image_features_0, _image_features_1, _image_embeddings = sam2_encoder(img)

            if is_cuda and config.enable_nvtx_profile:
                import nvtx  # noqa: PLC0415
                from cuda import cudart  # noqa: PLC0415

                cudart.cudaProfilerStart()
                print("Start nvtx profiling on encoder ...")
                with nvtx.annotate("one_run"):
                    sam2_encoder(img, enable_nvtx_profile=True)
                cudart.cudaProfilerStop()

            if is_cuda and config.enable_torch_profile:
                with torch.profiler.profile(
                    activities=[torch.profiler.ProfilerActivity.CPU, torch.profiler.ProfilerActivity.CUDA],
                    record_shapes=True,
                ) as prof:
                    print("Start torch profiling on encoder ...")
                    with torch.profiler.record_function("encoder"):
                        sam2_encoder(img)
                print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=10))
                prof.export_chrome_trace("torch_image_encoder.json")

            if config.repeats == 0:
                return

            print(f"Start {config.repeats} runs of performance tests...")
            start = time.time()
            for _ in range(config.repeats):
                _image_features_0, _image_features_1, _image_embeddings = sam2_encoder(img)
                if is_cuda:
                    torch.cuda.synchronize()
        else:
            torch_inputs = (
                ort_inputs["image_features_0"],
                ort_inputs["image_features_1"],
                ort_inputs["image_embeddings"],
                ort_inputs["point_coords"],
                ort_inputs["point_labels"],
                ort_inputs["input_masks"],
                ort_inputs["has_input_masks"],
                ort_inputs["original_image_size"],
            )

            sam2_decoder = SAM2ImageDecoder(
                sam2_model,
                multimask_output=config.multi_mask_output,
            )

            if is_cuda and config.torch_compile_mode != "none":
                sam2_decoder.forward = torch.compile(
                    sam2_decoder.forward,
                    mode=config.torch_compile_mode,
                    fullgraph=True,
                    dynamic=False,
                )

            # warm up
            for _ in range(config.warm_up):
                _masks, _iou_predictions, _low_res_masks = sam2_decoder(*torch_inputs)

            if is_cuda and config.enable_nvtx_profile:
                import nvtx  # noqa: PLC0415
                from cuda import cudart  # noqa: PLC0415

                cudart.cudaProfilerStart()
                print("Start nvtx profiling on decoder...")
                with nvtx.annotate("one_run"):
                    sam2_decoder(*torch_inputs, enable_nvtx_profile=True)
                cudart.cudaProfilerStop()

            if is_cuda and config.enable_torch_profile:
                with torch.profiler.profile(
                    activities=[torch.profiler.ProfilerActivity.CPU, torch.profiler.ProfilerActivity.CUDA],
                    record_shapes=True,
                ) as prof:
                    print("Start torch profiling on decoder ...")
                    with torch.profiler.record_function("decoder"):
                        sam2_decoder(*torch_inputs)
                print(prof.key_averages().table(sort_by="cuda_time_total", row_limit=10))
                prof.export_chrome_trace("torch_image_decoder.json")

            if config.repeats == 0:
                return

            print(f"Start {config.repeats} runs of performance tests...")
            start = time.time()
            for _ in range(config.repeats):
                _masks, _iou_predictions, _low_res_masks = sam2_decoder(*torch_inputs)
                if is_cuda:
                    torch.cuda.synchronize()

        end = time.time()
        return (end - start) / config.repeats


def run_test(
    args: argparse.Namespace,
    csv_writer: csv.DictWriter | None = None,
):
    use_gpu: bool = args.use_gpu
    enable_cuda_graph: bool = args.use_cuda_graph
    repeats: int = args.repeats

    if use_gpu:
        device_id = torch.cuda.current_device()
        device = torch.device("cuda", device_id)
        provider = "CUDAExecutionProvider"
    else:
        device_id = 0
        device = torch.device("cpu")
        enable_cuda_graph = False
        provider = "CPUExecutionProvider"

    dtypes = {"fp32": torch.float32, "fp16": torch.float16, "bf16": torch.bfloat16}
    config = TestConfig(
        model_type=args.model_type,
        onnx_path=args.onnx_path,
        sam2_dir=args.sam2_dir,
        component=args.component,
        provider=provider,
        batch_size=args.batch_size,
        height=args.height,
        width=args.width,
        device=device,
        use_tf32=True,
        enable_cuda_graph=enable_cuda_graph,
        dtype=dtypes[args.dtype],
        prefer_nhwc=args.prefer_nhwc,
        repeats=args.repeats,
        warm_up=args.warm_up,
        enable_nvtx_profile=args.enable_nvtx_profile,
        enable_ort_profile=args.enable_ort_profile,
        enable_torch_profile=args.enable_torch_profile,
        torch_compile_mode=args.torch_compile_mode,
        verbose=False,
    )

    if args.engine == "ort":
        sess_options = SessionOptions()
        sess_options.intra_op_num_threads = args.intra_op_num_threads
        if config.enable_ort_profile:
            sess_options.enable_profiling = True
            sess_options.log_severity_level = 4
            sess_options.log_verbosity_level = 0

        session = create_session(config, sess_options)
        input_dict = config.random_inputs()

        # warm up session
        try:
            for _ in range(config.warm_up):
                _ = measure_latency(session, input_dict)
        except Exception as e:
            print(f"Failed to run {config=}. Exception: {e}")
            return

        if config.enable_nvtx_profile:
            import nvtx  # noqa: PLC0415
            from cuda import cudart  # noqa: PLC0415

            cudart.cudaProfilerStart()
            with nvtx.annotate("one_run"):
                _ = session.infer(input_dict)
            cudart.cudaProfilerStop()

        if config.enable_ort_profile:
            session.ort_session.end_profiling()

        if repeats == 0:
            return

        latency_list = []
        for _ in range(repeats):
            latency = measure_latency(session, input_dict)
            latency_list.append(latency)
        average_latency = statistics.mean(latency_list)

        del session
    else:  # torch
        with torch.no_grad():
            try:
                average_latency = run_torch(config)
            except Exception as e:
                print(f"Failed to run {config=}. Exception: {e}")
                return

        if repeats == 0:
            return

    engine = args.engine + ":" + ("cuda" if use_gpu else "cpu")
    row = {
        "model_type": args.model_type,
        "component": args.component,
        "dtype": args.dtype,
        "use_gpu": use_gpu,
        "enable_cuda_graph": enable_cuda_graph,
        "prefer_nhwc": config.prefer_nhwc,
        "use_tf32": config.use_tf32,
        "batch_size": args.batch_size,
        "height": args.height,
        "width": args.width,
        "multi_mask_output": args.multimask_output,
        "num_labels": config.num_labels,
        "num_points": config.num_points,
        "num_masks": config.num_masks,
        "intra_op_num_threads": args.intra_op_num_threads,
        "warm_up": config.warm_up,
        "repeats": repeats,
        "enable_nvtx_profile": args.enable_nvtx_profile,
        "torch_compile_mode": args.torch_compile_mode,
        "engine": engine,
        "average_latency": average_latency,
    }

    if csv_writer is not None:
        csv_writer.writerow(row)

    print(f"{vars(config)}")
    print(f"{row}")


def run_perf_test(args):
    features = "gpu" if args.use_gpu else "cpu"
    csv_filename = "benchmark_sam_{}_{}_{}.csv".format(
        features,
        args.engine,
        datetime.now().strftime("%Y%m%d-%H%M%S"),
    )
    with open(csv_filename, mode="a", newline="") as csv_file:
        column_names = [
            "model_type",
            "component",
            "dtype",
            "use_gpu",
            "enable_cuda_graph",
            "prefer_nhwc",
            "use_tf32",
            "batch_size",
            "height",
            "width",
            "multi_mask_output",
            "num_labels",
            "num_points",
            "num_masks",
            "intra_op_num_threads",
            "warm_up",
            "repeats",
            "enable_nvtx_profile",
            "torch_compile_mode",
            "engine",
            "average_latency",
        ]
        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()

        run_test(args, csv_writer)


def _parse_arguments():
    parser = argparse.ArgumentParser(description="Benchmark SMA2 for ONNX Runtime and PyTorch.")

    parser.add_argument(
        "--component",
        required=False,
        choices=["image_encoder", "image_decoder"],
        default="image_encoder",
        help="component to benchmark. Choices are image_encoder and image_decoder.",
    )

    parser.add_argument(
        "--dtype", required=False, choices=["fp32", "fp16", "bf16"], default="fp32", help="Data type for inference."
    )

    parser.add_argument(
        "--use_gpu",
        required=False,
        action="store_true",
        help="Use GPU for inference.",
    )
    parser.set_defaults(use_gpu=False)

    parser.add_argument(
        "--use_cuda_graph",
        required=False,
        action="store_true",
        help="Use cuda graph in onnxruntime.",
    )
    parser.set_defaults(use_cuda_graph=False)

    parser.add_argument(
        "--intra_op_num_threads",
        required=False,
        type=int,
        choices=[0, 1, 2, 4, 8, 16],
        default=0,
        help="intra_op_num_threads for onnxruntime. ",
    )

    parser.add_argument(
        "--batch_size",
        required=False,
        type=int,
        default=1,
        help="batch size",
    )

    parser.add_argument(
        "--height",
        required=False,
        type=int,
        default=1024,
        help="image height",
    )

    parser.add_argument(
        "--width",
        required=False,
        type=int,
        default=1024,
        help="image width",
    )

    parser.add_argument(
        "--repeats",
        required=False,
        type=int,
        default=1000,
        help="number of repeats for performance test. Default is 1000.",
    )

    parser.add_argument(
        "--warm_up",
        required=False,
        type=int,
        default=5,
        help="number of runs for warm up. Default is 5.",
    )

    parser.add_argument(
        "--engine",
        required=False,
        type=str,
        default="ort",
        choices=["ort", "torch"],
        help="engine for inference",
    )

    parser.add_argument(
        "--multimask_output",
        required=False,
        default=False,
        action="store_true",
        help="Export mask_decoder or image_decoder with multimask_output",
    )

    parser.add_argument(
        "--prefer_nhwc",
        required=False,
        default=False,
        action="store_true",
        help="Use prefer_nhwc=1 provider option for CUDAExecutionProvider",
    )

    parser.add_argument(
        "--enable_nvtx_profile",
        required=False,
        default=False,
        action="store_true",
        help="Enable nvtx profiling. It will add an extra run for profiling before performance test.",
    )

    parser.add_argument(
        "--enable_ort_profile",
        required=False,
        default=False,
        action="store_true",
        help="Enable ORT profiling.",
    )

    parser.add_argument(
        "--enable_torch_profile",
        required=False,
        default=False,
        action="store_true",
        help="Enable PyTorch profiling. It will add an extra run for profiling before performance test.",
    )

    parser.add_argument(
        "--model_type",
        required=False,
        type=str,
        default="sam2_hiera_large",
        choices=["sam2_hiera_tiny", "sam2_hiera_small", "sam2_hiera_large", "sam2_hiera_base_plus"],
        help="sam2 model name",
    )

    parser.add_argument(
        "--sam2_dir",
        required=False,
        type=str,
        default="./segment-anything-2",
        help="The directory of segment-anything-2 git root directory",
    )

    parser.add_argument(
        "--onnx_path",
        required=False,
        type=str,
        default="./sam2_onnx_models/sam2_hiera_large_image_encoder.onnx",
        help="path of onnx model",
    )

    parser.add_argument(
        "--torch_compile_mode",
        required=False,
        type=str,
        default=None,
        choices=["reduce-overhead", "max-autotune", "max-autotune-no-cudagraphs", "none"],
        help="torch compile mode. none will disable torch compile.",
    )

    args = parser.parse_args()

    return args


if __name__ == "__main__":
    args = _parse_arguments()
    print(f"arguments:{args}")

    if args.torch_compile_mode is None:
        # image decoder will fail with compile modes other than "none".
        args.torch_compile_mode = "max-autotune" if args.component == "image_encoder" else "none"

    if args.use_gpu:
        assert torch.cuda.is_available()
        if args.engine == "ort":
            assert "CUDAExecutionProvider" in get_available_providers()
            args.enable_torch_profile = False
    else:
        # Only support cuda profiling for now.
        assert not args.enable_nvtx_profile
        assert not args.enable_torch_profile

    if args.enable_nvtx_profile or args.enable_torch_profile:
        run_test(args)
    else:
        run_perf_test(args)
