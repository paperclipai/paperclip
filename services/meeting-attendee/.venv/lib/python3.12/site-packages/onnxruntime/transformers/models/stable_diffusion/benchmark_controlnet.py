# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import gc
import importlib.util
import time
from statistics import mean

import torch
from demo_utils import PipelineInfo
from diffusers import (
    AutoencoderKL,
    ControlNetModel,
    DiffusionPipeline,
    EulerAncestralDiscreteScheduler,
    StableDiffusionXLControlNetPipeline,
)
from engine_builder import EngineType, get_engine_paths
from pipeline_stable_diffusion import StableDiffusionPipeline

"""
Benchmark script for SDXL-Turbo with control net for engines like PyTorch or Stable Fast.

Setup for Stable Fast (see https://github.com/chengzeyi/stable-fast/blob/main/README.md for more info):
    git clone https://github.com/chengzeyi/stable-fast.git
    cd stable-fast
    git submodule update --init
    pip3 install torch torchvision torchaudio ninja
    pip3 install -e '.[dev,xformers,triton,transformers,diffusers]' -v
    sudo apt install libgoogle-perftools-dev
    export LD_PRELOAD=/usr/lib/x86_64-linux-gnu/libtcmalloc.so
"""


def get_canny_image():
    import cv2  # noqa: PLC0415
    import numpy as np  # noqa: PLC0415
    from PIL import Image  # noqa: PLC0415

    # Test Image can be downloaded from https://hf.co/datasets/huggingface/documentation-images/resolve/main/diffusers/input_image_vermeer.png
    image = Image.open("input_image_vermeer.png").convert("RGB")

    image = np.array(image)
    image = cv2.Canny(image, 100, 200)
    image = image[:, :, None]
    image = np.concatenate([image, image, image], axis=2)
    return Image.fromarray(image)


def compile_stable_fast(pipeline, enable_cuda_graph=True):
    from sfast.compilers.stable_diffusion_pipeline_compiler import CompilationConfig, compile  # noqa: PLC0415

    config = CompilationConfig.Default()

    if importlib.util.find_spec("xformers") is not None:
        config.enable_xformers = True

    if importlib.util.find_spec("triton") is not None:
        config.enable_triton = True

    config.enable_cuda_graph = enable_cuda_graph

    pipeline = compile(pipeline, config)
    return pipeline


def compile_torch(pipeline, use_nhwc=False):
    if use_nhwc:
        pipeline.unet.to(memory_format=torch.channels_last)

    pipeline.unet = torch.compile(pipeline.unet, mode="reduce-overhead", fullgraph=True)

    if hasattr(pipeline, "controlnet"):
        if use_nhwc:
            pipeline.controlnet.to(memory_format=torch.channels_last)
        pipeline.controlnet = torch.compile(pipeline.controlnet, mode="reduce-overhead", fullgraph=True)
    return pipeline


def load_pipeline(name, engine, use_control_net=False, use_nhwc=False, enable_cuda_graph=True):
    gc.collect()
    torch.cuda.empty_cache()
    before_memory = torch.cuda.memory_allocated()

    scheduler = EulerAncestralDiscreteScheduler.from_pretrained(name, subfolder="scheduler")
    vae = AutoencoderKL.from_pretrained("madebyollin/sdxl-vae-fp16-fix", torch_dtype=torch.float16).to("cuda")

    if use_control_net:
        assert "xl" in name
        controlnet = ControlNetModel.from_pretrained("diffusers/controlnet-canny-sdxl-1.0", torch_dtype=torch.float16)
        pipeline = StableDiffusionXLControlNetPipeline.from_pretrained(
            name,
            controlnet=controlnet,
            vae=vae,
            scheduler=scheduler,
            variant="fp16",
            use_safetensors=True,
            torch_dtype=torch.float16,
        ).to("cuda")
    else:
        pipeline = DiffusionPipeline.from_pretrained(
            name,
            vae=vae,
            scheduler=scheduler,
            variant="fp16",
            use_safetensors=True,
            torch_dtype=torch.float16,
        ).to("cuda")
    pipeline.safety_checker = None

    gc.collect()
    after_memory = torch.cuda.memory_allocated()
    print(f"Loaded model with {after_memory - before_memory} bytes allocated")

    if engine == "stable_fast":
        pipeline = compile_stable_fast(pipeline, enable_cuda_graph=enable_cuda_graph)
    elif engine == "torch":
        pipeline = compile_torch(pipeline, use_nhwc=use_nhwc)

    pipeline.set_progress_bar_config(disable=True)
    return pipeline


def get_prompt():
    return "little cute gremlin wearing a jacket, cinematic, vivid colors, intricate masterpiece, golden ratio, highly detailed"


def load_ort_cuda_pipeline(name, engine, use_control_net=False, enable_cuda_graph=True, work_dir="."):
    version = PipelineInfo.supported_models()[name]
    guidance_scale = 0.0
    pipeline_info = PipelineInfo(
        version,
        use_vae=True,
        use_fp16_vae=True,
        do_classifier_free_guidance=(guidance_scale > 1.0),
        controlnet=["canny"] if use_control_net else [],
    )

    engine_type = EngineType.ORT_CUDA if engine == "ort_cuda" else EngineType.ORT_TRT
    onnx_dir, engine_dir, output_dir, framework_model_dir, _ = get_engine_paths(
        work_dir=work_dir, pipeline_info=pipeline_info, engine_type=engine_type
    )

    pipeline = StableDiffusionPipeline(
        pipeline_info,
        scheduler="EulerA",
        max_batch_size=32,
        use_cuda_graph=enable_cuda_graph,
        framework_model_dir=framework_model_dir,
        output_dir=output_dir,
        engine_type=engine_type,
    )

    pipeline.backend.build_engines(
        engine_dir=engine_dir,
        framework_model_dir=framework_model_dir,
        onnx_dir=onnx_dir,
        device_id=torch.cuda.current_device(),
    )

    return pipeline


def test_ort_cuda(
    pipeline,
    batch_size=1,
    steps=4,
    control_image=None,
    warmup_runs=3,
    test_runs=10,
    seed=123,
    verbose=False,
    image_height=512,
    image_width=512,
):
    if batch_size > 4 and pipeline.pipeline_info.version == "xl-1.0":
        pipeline.backend.enable_vae_slicing()

    pipeline.load_resources(image_height, image_width, batch_size)

    warmup_prompt = "warm up"
    for _ in range(warmup_runs):
        images, _ = pipeline.run(
            [warmup_prompt] * batch_size,
            [""] * batch_size,
            image_height=image_height,
            image_width=image_width,
            denoising_steps=steps,
            guidance=0.0,
            seed=seed,
            controlnet_images=[control_image],
            controlnet_scales=torch.FloatTensor([0.5]),
            output_type="image",
        )
        assert len(images) == batch_size

    generator = torch.Generator(device="cuda")
    generator.manual_seed(seed)

    prompt = get_prompt()

    latency_list = []
    images = None
    for _ in range(test_runs):
        torch.cuda.synchronize()
        start_time = time.perf_counter()
        images, _ = pipeline.run(
            [prompt] * batch_size,
            [""] * batch_size,
            image_height=image_height,
            image_width=image_width,
            denoising_steps=steps,
            guidance=0.0,
            seed=seed,
            controlnet_images=[control_image],
            controlnet_scales=torch.FloatTensor([0.5]),
            output_type="pil",
        )
        torch.cuda.synchronize()
        seconds = time.perf_counter() - start_time
        latency_list.append(seconds)

    if verbose:
        print(latency_list)

    return images, latency_list


def test(pipeline, batch_size=1, steps=4, control_image=None, warmup_runs=3, test_runs=10, seed=123, verbose=False):
    control_net_args = {}
    if hasattr(pipeline, "controlnet"):
        control_net_args = {
            "image": control_image,
            "controlnet_conditioning_scale": 0.5,
        }

    warmup_prompt = "warm up"
    for _ in range(warmup_runs):
        images = pipeline(
            prompt=warmup_prompt,
            num_inference_steps=steps,
            num_images_per_prompt=batch_size,
            guidance_scale=0.0,
            **control_net_args,
        ).images
        assert len(images) == batch_size

    generator = torch.Generator(device="cuda")
    generator.manual_seed(seed)

    prompt = get_prompt()

    latency_list = []
    images = None
    for _ in range(test_runs):
        torch.cuda.synchronize()
        start_time = time.perf_counter()
        images = pipeline(
            prompt=prompt,
            num_inference_steps=steps,
            num_images_per_prompt=batch_size,
            guidance_scale=0.0,
            generator=generator,
            **control_net_args,
        ).images
        torch.cuda.synchronize()
        seconds = time.perf_counter() - start_time
        latency_list.append(seconds)

    if verbose:
        print(latency_list)

    return images, latency_list


def arguments():
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(description="Benchmark Stable Diffusion pipeline (optional control net for SDXL)")
    parser.add_argument(
        "--engine",
        type=str,
        default="torch",
        choices=["torch", "stable_fast", "ort_cuda", "ort_trt"],
        help="Backend engine: torch, stable_fast or ort_cuda",
    )

    parser.add_argument(
        "--name",
        type=str,
        choices=list(PipelineInfo.supported_models().keys()),
        default="stabilityai/sdxl-turbo",
        help="Stable diffusion model name. Default is stabilityai/sdxl-turbo",
    )

    parser.add_argument(
        "--work-dir",
        type=str,
        default=".",
        help="working directory for ort_cuda or ort_trt",
    )

    parser.add_argument(
        "--use_control_net",
        action="store_true",
        help="Use control net diffusers/controlnet-canny-sdxl-1.0",
    )

    parser.add_argument(
        "--batch_size",
        type=int,
        default=1,
        help="Batch size",
    )

    parser.add_argument(
        "--steps",
        type=int,
        default=1,
        help="Denoising steps",
    )

    parser.add_argument(
        "--warmup_runs",
        type=int,
        default=3,
        help="Number of warmup runs before measurement",
    )

    parser.add_argument(
        "--use_nhwc",
        action="store_true",
        help="use channel last format for torch compile",
    )

    parser.add_argument(
        "--enable_cuda_graph",
        action="store_true",
        help="enable cuda graph for stable fast",
    )

    parser.add_argument(
        "--verbose",
        action="store_true",
        help="print more information",
    )

    args = parser.parse_args()
    return args


def main():
    args = arguments()

    with torch.no_grad():
        if args.engine == "ort_cuda":
            pipeline = load_ort_cuda_pipeline(
                args.name,
                args.engine,
                use_control_net=args.use_control_net,
                enable_cuda_graph=args.enable_cuda_graph,
                work_dir=args.work_dir,
            )
        else:
            pipeline = load_pipeline(
                args.name,
                args.engine,
                use_control_net=args.use_control_net,
                use_nhwc=args.use_nhwc,
                enable_cuda_graph=args.enable_cuda_graph,
            )

        canny_image = get_canny_image()

        if args.engine == "ort_cuda":
            images, latency_list = test_ort_cuda(
                pipeline,
                args.batch_size,
                args.steps,
                control_image=canny_image,
                warmup_runs=args.warmup_runs,
                verbose=args.verbose,
            )
        elif args.engine == "stable_fast":
            from sfast.utils.compute_precision import low_compute_precision  # noqa: PLC0415

            with low_compute_precision():
                images, latency_list = test(
                    pipeline,
                    args.batch_size,
                    args.steps,
                    control_image=canny_image,
                    warmup_runs=args.warmup_runs,
                    verbose=args.verbose,
                )
        else:
            images, latency_list = test(
                pipeline,
                args.batch_size,
                args.steps,
                control_image=canny_image,
                warmup_runs=args.warmup_runs,
                verbose=args.verbose,
            )

        # Save the first output image to inspect the result.
        if images:
            images[0].save(
                f"{args.engine}_{args.name.replace('/', '_')}_{args.batch_size}_{args.steps}_c{int(args.use_control_net)}.png"
            )

        result = {
            "engine": args.engine,
            "batch_size": args.batch_size,
            "steps": args.steps,
            "control_net": args.use_control_net,
            "nhwc": args.use_nhwc,
            "enable_cuda_graph": args.enable_cuda_graph,
            "average_latency_in_ms": mean(latency_list) * 1000,
        }
        print(result)


main()
