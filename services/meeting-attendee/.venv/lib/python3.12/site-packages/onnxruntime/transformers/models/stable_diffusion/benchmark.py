# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import argparse
import csv
import logging
import os
import statistics
import sys
import time
from pathlib import Path

# import torch before onnxruntime so that onnxruntime uses the cuDNN in the torch package.
import torch
from benchmark_helper import measure_memory

SD_MODELS = {
    "1.5": "runwayml/stable-diffusion-v1-5",
    "2.0": "stabilityai/stable-diffusion-2",
    "2.1": "stabilityai/stable-diffusion-2-1",
    "xl-1.0": "stabilityai/stable-diffusion-xl-refiner-1.0",
    "3.0M": "stabilityai/stable-diffusion-3-medium-diffusers",
    "3.5M": "stabilityai/stable-diffusion-3.5-medium",
    "3.5L": "stabilityai/stable-diffusion-3.5-large",
    "Flux.1S": "black-forest-labs/FLUX.1-schnell",
    "Flux.1D": "black-forest-labs/FLUX.1-dev",
}

PROVIDERS = {
    "cuda": "CUDAExecutionProvider",
    "migraphx": "MIGraphXExecutionProvider",
    "tensorrt": "TensorrtExecutionProvider",
}


def example_prompts():
    prompts = [
        "a photo of an astronaut riding a horse on mars",
        "cute grey cat with blue eyes, wearing a bowtie, acrylic painting",
        "a cute magical flying dog, fantasy art drawn by disney concept artists, highly detailed, digital painting",
        "an illustration of a house with large barn with many cute flower pots and beautiful blue sky scenery",
        "one apple sitting on a table, still life, reflective, full color photograph, centered, close-up product",
        "background texture of stones, masterpiece, artistic, stunning photo, award winner photo",
        "new international organic style house, tropical surroundings, architecture, 8k, hdr",
        "beautiful Renaissance Revival Estate, Hobbit-House, detailed painting, warm colors, 8k, trending on Artstation",
        "blue owl, big green eyes, portrait, intricate metal design, unreal engine, octane render, realistic",
        "delicate elvish moonstone necklace on a velvet background, symmetrical intricate motifs, leaves, flowers, 8k",
    ]

    negative_prompt = "bad composition, ugly, abnormal, malformed"

    return prompts, negative_prompt


def warmup_prompts():
    return "warm up", "bad"


def measure_gpu_memory(monitor_type, func, start_memory=None):
    return measure_memory(is_gpu=True, func=func, monitor_type=monitor_type, start_memory=start_memory)


def get_ort_pipeline(model_name: str, directory: str, provider, disable_safety_checker: bool):
    from diffusers import DDIMScheduler, OnnxStableDiffusionPipeline  # noqa: PLC0415

    import onnxruntime  # noqa: PLC0415

    if directory is not None:
        assert os.path.exists(directory)
        session_options = onnxruntime.SessionOptions()
        pipe = OnnxStableDiffusionPipeline.from_pretrained(
            directory,
            provider=provider,
            sess_options=session_options,
        )
    else:
        pipe = OnnxStableDiffusionPipeline.from_pretrained(
            model_name,
            revision="onnx",
            provider=provider,
            use_auth_token=True,
        )
    pipe.scheduler = DDIMScheduler.from_config(pipe.scheduler.config)
    pipe.set_progress_bar_config(disable=True)

    if disable_safety_checker:
        pipe.safety_checker = None
        pipe.feature_extractor = None

    return pipe


def get_torch_pipeline(model_name: str, disable_safety_checker: bool, enable_torch_compile: bool, use_xformers: bool):
    if "FLUX" in model_name:
        from diffusers import FluxPipeline  # noqa: PLC0415

        pipe = FluxPipeline.from_pretrained(model_name, torch_dtype=torch.bfloat16).to("cuda")
        if enable_torch_compile:
            pipe.transformer.to(memory_format=torch.channels_last)
            pipe.transformer = torch.compile(pipe.transformer, mode="max-autotune", fullgraph=True)
        return pipe

    if "stable-diffusion-3" in model_name:
        from diffusers import StableDiffusion3Pipeline  # noqa: PLC0415

        pipe = StableDiffusion3Pipeline.from_pretrained(model_name, torch_dtype=torch.bfloat16).to("cuda")
        if enable_torch_compile:
            pipe.transformer.to(memory_format=torch.channels_last)
            pipe.transformer = torch.compile(pipe.transformer, mode="max-autotune", fullgraph=True)
        return pipe

    from diffusers import DDIMScheduler, StableDiffusionPipeline  # noqa: PLC0415
    from torch import channels_last, float16  # noqa: PLC0415

    pipe = StableDiffusionPipeline.from_pretrained(model_name, torch_dtype=float16).to("cuda")

    pipe.unet.to(memory_format=channels_last)  # in-place operation

    if use_xformers:
        pipe.enable_xformers_memory_efficient_attention()

    if enable_torch_compile:
        pipe.unet = torch.compile(pipe.unet)
        pipe.vae = torch.compile(pipe.vae)
        pipe.text_encoder = torch.compile(pipe.text_encoder)
        print("Torch compiled unet, vae and text_encoder")

    pipe.scheduler = DDIMScheduler.from_config(pipe.scheduler.config)
    pipe.set_progress_bar_config(disable=True)

    if disable_safety_checker:
        pipe.safety_checker = None
        pipe.feature_extractor = None

    return pipe


def get_image_filename_prefix(engine: str, model_name: str, batch_size: int, steps: int, disable_safety_checker: bool):
    short_model_name = model_name.split("/")[-1].replace("stable-diffusion-", "sd")
    return f"{engine}_{short_model_name}_b{batch_size}_s{steps}" + ("" if disable_safety_checker else "_safe")


def run_ort_pipeline(
    pipe,
    batch_size: int,
    image_filename_prefix: str,
    height,
    width,
    steps,
    num_prompts,
    batch_count,
    start_memory,
    memory_monitor_type,
    skip_warmup: bool = False,
):
    from diffusers import OnnxStableDiffusionPipeline  # noqa: PLC0415

    assert isinstance(pipe, OnnxStableDiffusionPipeline)

    prompts, negative_prompt = example_prompts()

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        pipe(
            prompt=[prompt] * batch_size,
            height=height,
            width=width,
            num_inference_steps=steps,
            negative_prompt=[negative] * batch_size,
        )

    # Run warm up, and measure GPU memory of two runs
    # cuDNN/MIOpen The first run has  algo search so it might need more memory)
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    latency_list = []
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        images = pipe(
            prompt=[prompt] * batch_size,
            height=height,
            width=width,
            num_inference_steps=steps,
            negative_prompt=[negative_prompt] * batch_size,
        ).images
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"Inference took {latency:.3f} seconds")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.jpg")

    from onnxruntime import __version__ as ort_version  # noqa: PLC0415

    return {
        "engine": "onnxruntime",
        "version": ort_version,
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
    }


def get_negative_prompt_kwargs(negative_prompt, use_num_images_per_prompt, is_flux, batch_size) -> dict:
    # Flux does not support negative prompt
    kwargs = (
        (
            {"negative_prompt": negative_prompt}
            if use_num_images_per_prompt
            else {"negative_prompt": [negative_prompt] * batch_size}
        )
        if not is_flux
        else {}
    )

    # Fix the random seed so that we can inspect the output quality easily.
    if torch.cuda.is_available():
        kwargs["generator"] = torch.Generator(device="cuda").manual_seed(123)

    return kwargs


def run_torch_pipeline(
    pipe,
    batch_size: int,
    image_filename_prefix: str,
    height,
    width,
    steps,
    num_prompts,
    batch_count,
    start_memory,
    memory_monitor_type,
    skip_warmup=False,
):
    prompts, negative_prompt = example_prompts()

    import diffusers  # noqa: PLC0415

    is_flux = isinstance(pipe, diffusers.FluxPipeline)

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        extra_kwargs = get_negative_prompt_kwargs(negative, False, is_flux, batch_size)
        pipe(prompt=[prompt] * batch_size, height=height, width=width, num_inference_steps=steps, **extra_kwargs)

    # Run warm up, and measure GPU memory of two runs (The first run has cuDNN algo search so it might need more memory)
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    torch.set_grad_enabled(False)

    latency_list = []
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        torch.cuda.synchronize()
        inference_start = time.time()
        extra_kwargs = get_negative_prompt_kwargs(negative_prompt, False, is_flux, batch_size)
        images = pipe(
            prompt=[prompt] * batch_size,
            height=height,
            width=width,
            num_inference_steps=steps,
            **extra_kwargs,
        ).images

        torch.cuda.synchronize()
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"Inference took {latency:.3f} seconds")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.jpg")

    return {
        "engine": "torch",
        "version": torch.__version__,
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
    }


def run_ort(
    model_name: str,
    directory: str,
    provider: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    tuning: bool,
    skip_warmup: bool = False,
):
    provider_and_options = provider
    if tuning and provider in ["CUDAExecutionProvider"]:
        provider_and_options = (provider, {"tunable_op_enable": 1, "tunable_op_tuning_enable": 1})

    load_start = time.time()
    pipe = get_ort_pipeline(model_name, directory, provider_and_options, disable_safety_checker)
    load_end = time.time()
    print(f"Model loading took {load_end - load_start} seconds")

    image_filename_prefix = get_image_filename_prefix("ort", model_name, batch_size, steps, disable_safety_checker)
    result = run_ort_pipeline(
        pipe,
        batch_size,
        image_filename_prefix,
        height,
        width,
        steps,
        num_prompts,
        batch_count,
        start_memory,
        memory_monitor_type,
        skip_warmup=skip_warmup,
    )

    result.update(
        {
            "model_name": model_name,
            "directory": directory,
            "provider": provider.replace("ExecutionProvider", ""),
            "disable_safety_checker": disable_safety_checker,
            "enable_cuda_graph": False,
        }
    )
    return result


def get_optimum_ort_pipeline(
    model_name: str,
    directory: str,
    provider="CUDAExecutionProvider",
    disable_safety_checker: bool = True,
    use_io_binding: bool = False,
):
    from optimum.onnxruntime import ORTPipelineForText2Image  # noqa: PLC0415

    if directory is not None and os.path.exists(directory):
        pipeline = ORTPipelineForText2Image.from_pretrained(directory, provider=provider, use_io_binding=use_io_binding)
    else:
        pipeline = ORTPipelineForText2Image.from_pretrained(
            model_name,
            export=True,
            provider=provider,
            use_io_binding=use_io_binding,
        )
        pipeline.save_pretrained(directory)

    if disable_safety_checker:
        pipeline.safety_checker = None
        pipeline.feature_extractor = None

    return pipeline


def run_optimum_ort_pipeline(
    pipe,
    batch_size: int,
    image_filename_prefix: str,
    height,
    width,
    steps,
    num_prompts,
    batch_count,
    start_memory,
    memory_monitor_type,
    use_num_images_per_prompt=False,
    skip_warmup=False,
):
    print("Pipeline type", type(pipe))
    from optimum.onnxruntime.modeling_diffusion import ORTFluxPipeline  # noqa: PLC0415

    is_flux = isinstance(pipe, ORTFluxPipeline)

    prompts, negative_prompt = example_prompts()

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        extra_kwargs = get_negative_prompt_kwargs(negative, use_num_images_per_prompt, is_flux, batch_size)
        if use_num_images_per_prompt:
            pipe(
                prompt=prompt,
                height=height,
                width=width,
                num_inference_steps=steps,
                num_images_per_prompt=batch_count,
                **extra_kwargs,
            )
        else:
            pipe(prompt=[prompt] * batch_size, height=height, width=width, num_inference_steps=steps, **extra_kwargs)

    # Run warm up, and measure GPU memory of two runs.
    # The first run has algo search for cuDNN/MIOpen, so it might need more memory.
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    extra_kwargs = get_negative_prompt_kwargs(negative_prompt, use_num_images_per_prompt, is_flux, batch_size)

    latency_list = []
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        if use_num_images_per_prompt:
            images = pipe(
                prompt=prompt,
                height=height,
                width=width,
                num_inference_steps=steps,
                num_images_per_prompt=batch_size,
                **extra_kwargs,
            ).images
        else:
            images = pipe(
                prompt=[prompt] * batch_size, height=height, width=width, num_inference_steps=steps, **extra_kwargs
            ).images
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"Inference took {latency:.3f} seconds")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.jpg")

    from onnxruntime import __version__ as ort_version  # noqa: PLC0415

    return {
        "engine": "optimum_ort",
        "version": ort_version,
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
    }


def run_optimum_ort(
    model_name: str,
    directory: str,
    provider: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    use_io_binding: bool = False,
    skip_warmup: bool = False,
):
    load_start = time.time()
    pipe = get_optimum_ort_pipeline(
        model_name, directory, provider, disable_safety_checker, use_io_binding=use_io_binding
    )
    load_end = time.time()
    print(f"Model loading took {load_end - load_start} seconds")

    full_model_name = model_name + "_" + Path(directory).name if directory else model_name
    image_filename_prefix = get_image_filename_prefix(
        "optimum", full_model_name, batch_size, steps, disable_safety_checker
    )
    result = run_optimum_ort_pipeline(
        pipe,
        batch_size,
        image_filename_prefix,
        height,
        width,
        steps,
        num_prompts,
        batch_count,
        start_memory,
        memory_monitor_type,
        skip_warmup=skip_warmup,
    )

    result.update(
        {
            "model_name": model_name,
            "directory": directory,
            "provider": provider.replace("ExecutionProvider", ""),
            "disable_safety_checker": disable_safety_checker,
            "enable_cuda_graph": False,
        }
    )
    return result


def run_ort_trt_static(
    work_dir: str,
    version: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    max_batch_size: int,
    nvtx_profile: bool = False,
    use_cuda_graph: bool = True,
):
    print("[I] Initializing ORT TensorRT EP accelerated StableDiffusionXL txt2img pipeline (static input shape)")

    # Register TensorRT plugins
    from trt_utilities import init_trt_plugins  # noqa: PLC0415

    init_trt_plugins()

    assert batch_size <= max_batch_size

    from diffusion_models import PipelineInfo  # noqa: PLC0415

    pipeline_info = PipelineInfo(version)
    short_name = pipeline_info.short_name()

    from engine_builder import EngineType, get_engine_paths  # noqa: PLC0415
    from pipeline_stable_diffusion import StableDiffusionPipeline  # noqa: PLC0415

    engine_type = EngineType.ORT_TRT
    onnx_dir, engine_dir, output_dir, framework_model_dir, _ = get_engine_paths(work_dir, pipeline_info, engine_type)

    # Initialize pipeline
    pipeline = StableDiffusionPipeline(
        pipeline_info,
        scheduler="DDIM",
        output_dir=output_dir,
        verbose=False,
        nvtx_profile=nvtx_profile,
        max_batch_size=max_batch_size,
        use_cuda_graph=use_cuda_graph,
        framework_model_dir=framework_model_dir,
        engine_type=engine_type,
    )

    # Load TensorRT engines and pytorch modules
    pipeline.backend.build_engines(
        engine_dir,
        framework_model_dir,
        onnx_dir,
        17,
        opt_image_height=height,
        opt_image_width=width,
        opt_batch_size=batch_size,
        static_batch=True,
        static_image_shape=True,
        max_workspace_size=0,
        device_id=torch.cuda.current_device(),
    )

    # Here we use static batch and image size, so the resource allocation only need done once.
    # For dynamic batch and image size, some cost (like memory allocation) shall be included in latency.
    pipeline.load_resources(height, width, batch_size)

    def warmup():
        prompt, negative = warmup_prompts()
        pipeline.run([prompt] * batch_size, [negative] * batch_size, height, width, denoising_steps=steps)

    # Run warm up, and measure GPU memory of two runs
    # The first run has algo search so it might need more memory
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    image_filename_prefix = get_image_filename_prefix("ort_trt", short_name, batch_size, steps, disable_safety_checker)

    latency_list = []
    prompts, negative_prompt = example_prompts()
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        # Use warmup mode here since non-warmup mode will save image to disk.
        images, pipeline_time = pipeline.run(
            [prompt] * batch_size,
            [negative_prompt] * batch_size,
            height,
            width,
            denoising_steps=steps,
            guidance=7.5,
            seed=123,
        )
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"End2End took {latency:.3f} seconds. Inference latency: {pipeline_time}")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.jpg")

    pipeline.teardown()

    from tensorrt import __version__ as trt_version  # noqa: PLC0415

    from onnxruntime import __version__ as ort_version  # noqa: PLC0415

    return {
        "model_name": pipeline_info.name(),
        "engine": "onnxruntime",
        "version": ort_version,
        "provider": f"tensorrt({trt_version})",
        "directory": engine_dir,
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
        "disable_safety_checker": disable_safety_checker,
        "enable_cuda_graph": use_cuda_graph,
    }


def run_tensorrt_static(
    work_dir: str,
    version: str,
    model_name: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    max_batch_size: int,
    nvtx_profile: bool = False,
    use_cuda_graph: bool = True,
    skip_warmup: bool = False,
):
    print("[I] Initializing TensorRT accelerated StableDiffusionXL txt2img pipeline (static input shape)")

    from cuda import cudart  # noqa: PLC0415

    # Register TensorRT plugins
    from trt_utilities import init_trt_plugins  # noqa: PLC0415

    init_trt_plugins()

    assert batch_size <= max_batch_size

    from diffusion_models import PipelineInfo  # noqa: PLC0415

    pipeline_info = PipelineInfo(version)

    from engine_builder import EngineType, get_engine_paths  # noqa: PLC0415
    from pipeline_stable_diffusion import StableDiffusionPipeline  # noqa: PLC0415

    engine_type = EngineType.TRT
    onnx_dir, engine_dir, output_dir, framework_model_dir, timing_cache = get_engine_paths(
        work_dir, pipeline_info, engine_type
    )

    # Initialize pipeline
    pipeline = StableDiffusionPipeline(
        pipeline_info,
        scheduler="DDIM",
        output_dir=output_dir,
        verbose=False,
        nvtx_profile=nvtx_profile,
        max_batch_size=max_batch_size,
        use_cuda_graph=True,
        engine_type=engine_type,
    )

    # Load TensorRT engines and pytorch modules
    pipeline.backend.load_engines(
        engine_dir=engine_dir,
        framework_model_dir=framework_model_dir,
        onnx_dir=onnx_dir,
        onnx_opset=17,
        opt_batch_size=batch_size,
        opt_image_height=height,
        opt_image_width=width,
        static_batch=True,
        static_shape=True,
        enable_all_tactics=False,
        timing_cache=timing_cache,
    )

    # activate engines
    max_device_memory = max(pipeline.backend.max_device_memory(), pipeline.backend.max_device_memory())
    _, shared_device_memory = cudart.cudaMalloc(max_device_memory)
    pipeline.backend.activate_engines(shared_device_memory)

    # Here we use static batch and image size, so the resource allocation only need done once.
    # For dynamic batch and image size, some cost (like memory allocation) shall be included in latency.
    pipeline.load_resources(height, width, batch_size)

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        pipeline.run([prompt] * batch_size, [negative] * batch_size, height, width, denoising_steps=steps)

    # Run warm up, and measure GPU memory of two runs
    # The first run has algo search so it might need more memory
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    image_filename_prefix = get_image_filename_prefix("trt", model_name, batch_size, steps, disable_safety_checker)

    latency_list = []
    prompts, negative_prompt = example_prompts()
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        # Use warmup mode here since non-warmup mode will save image to disk.
        images, pipeline_time = pipeline.run(
            [prompt] * batch_size,
            [negative_prompt] * batch_size,
            height,
            width,
            denoising_steps=steps,
            seed=123,
        )
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"End2End took {latency:.3f} seconds. Inference latency: {pipeline_time}")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.jpg")

    pipeline.teardown()

    import tensorrt as trt  # noqa: PLC0415

    return {
        "engine": "tensorrt",
        "version": trt.__version__,
        "provider": "default",
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
        "enable_cuda_graph": use_cuda_graph,
    }


def run_tensorrt_static_xl(
    work_dir: str,
    version: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    max_batch_size: int,
    nvtx_profile: bool = False,
    use_cuda_graph=True,
    skip_warmup: bool = False,
):
    print("[I] Initializing TensorRT accelerated StableDiffusionXL txt2img pipeline (static input shape)")

    import tensorrt as trt  # noqa: PLC0415
    from cuda import cudart  # noqa: PLC0415
    from trt_utilities import init_trt_plugins  # noqa: PLC0415

    # Validate image dimensions
    image_height = height
    image_width = width
    if image_height % 8 != 0 or image_width % 8 != 0:
        raise ValueError(
            f"Image height and width have to be divisible by 8 but specified as: {image_height} and {image_width}."
        )

    # Register TensorRT plugins
    init_trt_plugins()

    assert batch_size <= max_batch_size

    from diffusion_models import PipelineInfo  # noqa: PLC0415
    from engine_builder import EngineType, get_engine_paths  # noqa: PLC0415

    def init_pipeline(pipeline_class, pipeline_info):
        engine_type = EngineType.TRT

        onnx_dir, engine_dir, output_dir, framework_model_dir, timing_cache = get_engine_paths(
            work_dir, pipeline_info, engine_type
        )

        # Initialize pipeline
        pipeline = pipeline_class(
            pipeline_info,
            scheduler="DDIM",
            output_dir=output_dir,
            verbose=False,
            nvtx_profile=nvtx_profile,
            max_batch_size=max_batch_size,
            use_cuda_graph=use_cuda_graph,
            framework_model_dir=framework_model_dir,
            engine_type=engine_type,
        )

        pipeline.backend.load_engines(
            engine_dir=engine_dir,
            framework_model_dir=framework_model_dir,
            onnx_dir=onnx_dir,
            onnx_opset=17,
            opt_batch_size=batch_size,
            opt_image_height=height,
            opt_image_width=width,
            static_batch=True,
            static_shape=True,
            enable_all_tactics=False,
            timing_cache=timing_cache,
        )
        return pipeline

    from pipeline_stable_diffusion import StableDiffusionPipeline  # noqa: PLC0415

    pipeline_info = PipelineInfo(version)
    pipeline = init_pipeline(StableDiffusionPipeline, pipeline_info)

    max_device_memory = max(pipeline.backend.max_device_memory(), pipeline.backend.max_device_memory())
    _, shared_device_memory = cudart.cudaMalloc(max_device_memory)
    pipeline.backend.activate_engines(shared_device_memory)

    # Here we use static batch and image size, so the resource allocation only need done once.
    # For dynamic batch and image size, some cost (like memory allocation) shall be included in latency.
    pipeline.load_resources(image_height, image_width, batch_size)

    def run_sd_xl_inference(prompt, negative_prompt, seed=None):
        return pipeline.run(
            prompt,
            negative_prompt,
            image_height,
            image_width,
            denoising_steps=steps,
            guidance=5.0,
            seed=seed,
        )

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        run_sd_xl_inference([prompt] * batch_size, [negative] * batch_size)

    # Run warm up, and measure GPU memory of two runs
    # The first run has algo search so it might need more memory
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    model_name = pipeline_info.name()
    image_filename_prefix = get_image_filename_prefix("trt", model_name, batch_size, steps, disable_safety_checker)

    latency_list = []
    prompts, negative_prompt = example_prompts()
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        # Use warmup mode here since non-warmup mode will save image to disk.
        images, pipeline_time = run_sd_xl_inference([prompt] * batch_size, [negative_prompt] * batch_size, seed=123)
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"End2End took {latency:.3f} seconds. Inference latency: {pipeline_time}")
        for k, image in enumerate(images):
            image.save(f"{image_filename_prefix}_{i}_{k}.png")

    pipeline.teardown()

    return {
        "model_name": model_name,
        "engine": "tensorrt",
        "version": trt.__version__,
        "provider": "default",
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
        "enable_cuda_graph": use_cuda_graph,
    }


def run_ort_trt_xl(
    work_dir: str,
    version: str,
    batch_size: int,
    disable_safety_checker: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    max_batch_size: int,
    nvtx_profile: bool = False,
    use_cuda_graph=True,
    skip_warmup: bool = False,
):
    from demo_utils import initialize_pipeline  # noqa: PLC0415
    from engine_builder import EngineType  # noqa: PLC0415

    pipeline = initialize_pipeline(
        version=version,
        engine_type=EngineType.ORT_TRT,
        work_dir=work_dir,
        height=height,
        width=width,
        use_cuda_graph=use_cuda_graph,
        max_batch_size=max_batch_size,
        opt_batch_size=batch_size,
    )

    assert batch_size <= max_batch_size

    pipeline.load_resources(height, width, batch_size)

    def run_sd_xl_inference(prompt, negative_prompt, seed=None):
        return pipeline.run(
            prompt,
            negative_prompt,
            height,
            width,
            denoising_steps=steps,
            guidance=5.0,
            seed=seed,
        )

    def warmup():
        if skip_warmup:
            return
        prompt, negative = warmup_prompts()
        run_sd_xl_inference([prompt] * batch_size, [negative] * batch_size)

    # Run warm up, and measure GPU memory of two runs
    # The first run has algo search so it might need more memory
    first_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)
    second_run_memory = measure_gpu_memory(memory_monitor_type, warmup, start_memory)

    warmup()

    model_name = pipeline.pipeline_info.name()
    image_filename_prefix = get_image_filename_prefix("ort_trt", model_name, batch_size, steps, disable_safety_checker)

    latency_list = []
    prompts, negative_prompt = example_prompts()
    for i, prompt in enumerate(prompts):
        if i >= num_prompts:
            break
        inference_start = time.time()
        # Use warmup mode here since non-warmup mode will save image to disk.
        images, pipeline_time = run_sd_xl_inference([prompt] * batch_size, [negative_prompt] * batch_size, seed=123)
        inference_end = time.time()
        latency = inference_end - inference_start
        latency_list.append(latency)
        print(f"End2End took {latency:.3f} seconds. Inference latency: {pipeline_time}")
        for k, image in enumerate(images):
            filename = f"{image_filename_prefix}_{i}_{k}.png"
            image.save(filename)
            print("Image saved to", filename)

    pipeline.teardown()

    from tensorrt import __version__ as trt_version  # noqa: PLC0415

    from onnxruntime import __version__ as ort_version  # noqa: PLC0415

    return {
        "model_name": model_name,
        "engine": "onnxruntime",
        "version": ort_version,
        "provider": f"tensorrt{trt_version})",
        "height": height,
        "width": width,
        "steps": steps,
        "batch_size": batch_size,
        "batch_count": batch_count,
        "num_prompts": num_prompts,
        "average_latency": sum(latency_list) / len(latency_list),
        "median_latency": statistics.median(latency_list),
        "first_run_memory_MB": first_run_memory,
        "second_run_memory_MB": second_run_memory,
        "enable_cuda_graph": use_cuda_graph,
    }


def run_torch(
    model_name: str,
    batch_size: int,
    disable_safety_checker: bool,
    enable_torch_compile: bool,
    use_xformers: bool,
    height: int,
    width: int,
    steps: int,
    num_prompts: int,
    batch_count: int,
    start_memory,
    memory_monitor_type,
    skip_warmup: bool = True,
):
    torch.backends.cudnn.enabled = True
    torch.backends.cudnn.benchmark = True

    torch.set_grad_enabled(False)

    load_start = time.time()
    pipe = get_torch_pipeline(model_name, disable_safety_checker, enable_torch_compile, use_xformers)
    load_end = time.time()
    print(f"Model loading took {load_end - load_start} seconds")

    image_filename_prefix = get_image_filename_prefix("torch", model_name, batch_size, steps, disable_safety_checker)

    if not enable_torch_compile:
        with torch.inference_mode():
            result = run_torch_pipeline(
                pipe,
                batch_size,
                image_filename_prefix,
                height,
                width,
                steps,
                num_prompts,
                batch_count,
                start_memory,
                memory_monitor_type,
                skip_warmup=skip_warmup,
            )
    else:
        result = run_torch_pipeline(
            pipe,
            batch_size,
            image_filename_prefix,
            height,
            width,
            steps,
            num_prompts,
            batch_count,
            start_memory,
            memory_monitor_type,
            skip_warmup=skip_warmup,
        )

    result.update(
        {
            "model_name": model_name,
            "directory": None,
            "provider": "compile" if enable_torch_compile else "xformers" if use_xformers else "default",
            "disable_safety_checker": disable_safety_checker,
            "enable_cuda_graph": False,
        }
    )
    return result


def parse_arguments():
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "-e",
        "--engine",
        required=False,
        type=str,
        default="onnxruntime",
        choices=["onnxruntime", "optimum", "torch", "tensorrt"],
        help="Engines to benchmark. Default is onnxruntime.",
    )

    parser.add_argument(
        "-r",
        "--provider",
        required=False,
        type=str,
        default="cuda",
        choices=list(PROVIDERS.keys()),
        help="Provider to benchmark. Default is CUDAExecutionProvider.",
    )

    parser.add_argument(
        "-t",
        "--tuning",
        action="store_true",
        help="Enable TunableOp and tuning. This will incur longer warmup latency.",
    )

    parser.add_argument(
        "-v",
        "--version",
        required=False,
        type=str,
        choices=list(SD_MODELS.keys()),
        default="1.5",
        help="Stable diffusion version like 1.5, 2.0 or 2.1. Default is 1.5.",
    )

    parser.add_argument(
        "-p",
        "--pipeline",
        required=False,
        type=str,
        default=None,
        help="Directory of saved onnx pipeline. It could be the output directory of optimize_pipeline.py.",
    )

    parser.add_argument(
        "-w",
        "--work_dir",
        required=False,
        type=str,
        default=".",
        help="Root directory to save exported onnx models, built engines etc.",
    )

    parser.add_argument(
        "--enable_safety_checker",
        required=False,
        action="store_true",
        help="Enable safety checker",
    )
    parser.set_defaults(enable_safety_checker=False)

    parser.add_argument(
        "--enable_torch_compile",
        required=False,
        action="store_true",
        help="Enable compile unet for PyTorch 2.0",
    )
    parser.set_defaults(enable_torch_compile=False)

    parser.add_argument(
        "--use_xformers",
        required=False,
        action="store_true",
        help="Use xformers for PyTorch",
    )
    parser.set_defaults(use_xformers=False)

    parser.add_argument(
        "--use_io_binding",
        required=False,
        action="store_true",
        help="Use I/O Binding for Optimum.",
    )
    parser.set_defaults(use_io_binding=False)

    parser.add_argument(
        "--skip_warmup",
        required=False,
        action="store_true",
        help="No warmup.",
    )
    parser.set_defaults(skip_warmup=False)

    parser.add_argument(
        "-b",
        "--batch_size",
        type=int,
        default=1,
        choices=[1, 2, 3, 4, 8, 10, 16, 32],
        help="Number of images per batch. Default is 1.",
    )

    parser.add_argument(
        "--height",
        required=False,
        type=int,
        default=512,
        help="Output image height. Default is 512.",
    )

    parser.add_argument(
        "--width",
        required=False,
        type=int,
        default=512,
        help="Output image width. Default is 512.",
    )

    parser.add_argument(
        "-s",
        "--steps",
        required=False,
        type=int,
        default=50,
        help="Number of steps. Default is 50.",
    )

    parser.add_argument(
        "-n",
        "--num_prompts",
        required=False,
        type=int,
        default=10,
        help="Number of prompts. Default is 10.",
    )

    parser.add_argument(
        "-c",
        "--batch_count",
        required=False,
        type=int,
        choices=range(1, 11),
        default=5,
        help="Number of batches to test. Default is 5.",
    )

    parser.add_argument(
        "-m",
        "--max_trt_batch_size",
        required=False,
        type=int,
        choices=range(1, 16),
        default=4,
        help="Maximum batch size for TensorRT. Change the value may trigger TensorRT engine rebuild. Default is 4.",
    )

    parser.add_argument(
        "-g",
        "--enable_cuda_graph",
        required=False,
        action="store_true",
        help="Enable Cuda Graph. Requires onnxruntime >= 1.16",
    )
    parser.set_defaults(enable_cuda_graph=False)

    args = parser.parse_args()

    return args


def print_loaded_libraries(cuda_related_only=True):
    import psutil  # noqa: PLC0415

    p = psutil.Process(os.getpid())
    for lib in p.memory_maps():
        if (not cuda_related_only) or any(x in lib.path for x in ("libcu", "libnv", "tensorrt")):
            print(lib.path)


def main():
    args = parse_arguments()
    print(args)

    if args.engine == "onnxruntime":
        if args.version in ["2.1"]:
            # Set a flag to avoid overflow in attention, which causes black image output in SD 2.1 model.
            # The environment variables shall be set before the first run of Attention or MultiHeadAttention operator.
            os.environ["ORT_DISABLE_TRT_FLASH_ATTENTION"] = "1"

        from packaging import version  # noqa: PLC0415

        from onnxruntime import __version__ as ort_version  # noqa: PLC0415

        if version.parse(ort_version) == version.parse("1.16.0"):
            # ORT 1.16 has a bug that might trigger Attention RuntimeError when latest fusion script is applied on clip model.
            # The walkaround is to enable fused causal attention, or disable Attention fusion for clip model.
            os.environ["ORT_ENABLE_FUSED_CAUSAL_ATTENTION"] = "1"

        if args.enable_cuda_graph:
            if not (args.engine == "onnxruntime" and args.provider in ["cuda", "tensorrt"] and args.pipeline is None):
                raise ValueError("The stable diffusion pipeline does not support CUDA graph.")

            if version.parse(ort_version) < version.parse("1.16"):
                raise ValueError("CUDA graph requires ONNX Runtime 1.16 or later")

    logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO, force=True)

    memory_monitor_type = "cuda"

    start_memory = measure_gpu_memory(memory_monitor_type, None)
    print("GPU memory used before loading models:", start_memory)

    sd_model = SD_MODELS[args.version]
    provider = PROVIDERS[args.provider]
    if args.engine == "onnxruntime" and args.provider == "tensorrt":
        if "xl" in args.version:
            print("Testing Txt2ImgXLPipeline with static input shape. Backend is ORT TensorRT EP.")
            result = run_ort_trt_xl(
                work_dir=args.work_dir,
                version=args.version,
                batch_size=args.batch_size,
                disable_safety_checker=True,
                height=args.height,
                width=args.width,
                steps=args.steps,
                num_prompts=args.num_prompts,
                batch_count=args.batch_count,
                start_memory=start_memory,
                memory_monitor_type=memory_monitor_type,
                max_batch_size=args.max_trt_batch_size,
                nvtx_profile=False,
                use_cuda_graph=args.enable_cuda_graph,
                skip_warmup=args.skip_warmup,
            )
        else:
            print("Testing Txt2ImgPipeline with static input shape. Backend is ORT TensorRT EP.")
            result = run_ort_trt_static(
                work_dir=args.work_dir,
                version=args.version,
                batch_size=args.batch_size,
                disable_safety_checker=not args.enable_safety_checker,
                height=args.height,
                width=args.width,
                steps=args.steps,
                num_prompts=args.num_prompts,
                batch_count=args.batch_count,
                start_memory=start_memory,
                memory_monitor_type=memory_monitor_type,
                max_batch_size=args.max_trt_batch_size,
                nvtx_profile=False,
                use_cuda_graph=args.enable_cuda_graph,
                skip_warmup=args.skip_warmup,
            )
    elif args.engine == "optimum" and provider == "CUDAExecutionProvider":
        if "xl" in args.version:
            os.environ["ORT_ENABLE_FUSED_CAUSAL_ATTENTION"] = "1"

        result = run_optimum_ort(
            model_name=sd_model,
            directory=args.pipeline,
            provider=provider,
            batch_size=args.batch_size,
            disable_safety_checker=not args.enable_safety_checker,
            height=args.height,
            width=args.width,
            steps=args.steps,
            num_prompts=args.num_prompts,
            batch_count=args.batch_count,
            start_memory=start_memory,
            memory_monitor_type=memory_monitor_type,
            use_io_binding=args.use_io_binding,
            skip_warmup=args.skip_warmup,
        )
    elif args.engine == "onnxruntime":
        assert args.pipeline and os.path.isdir(args.pipeline), (
            "--pipeline should be specified for the directory of ONNX models"
        )
        print(f"Testing diffusers StableDiffusionPipeline with {provider} provider and tuning={args.tuning}")
        result = run_ort(
            model_name=sd_model,
            directory=args.pipeline,
            provider=provider,
            batch_size=args.batch_size,
            disable_safety_checker=not args.enable_safety_checker,
            height=args.height,
            width=args.width,
            steps=args.steps,
            num_prompts=args.num_prompts,
            batch_count=args.batch_count,
            start_memory=start_memory,
            memory_monitor_type=memory_monitor_type,
            tuning=args.tuning,
            skip_warmup=args.skip_warmup,
        )
    elif args.engine == "tensorrt" and "xl" in args.version:
        print("Testing Txt2ImgXLPipeline with static input shape. Backend is TensorRT.")
        result = run_tensorrt_static_xl(
            work_dir=args.work_dir,
            version=args.version,
            batch_size=args.batch_size,
            disable_safety_checker=True,
            height=args.height,
            width=args.width,
            steps=args.steps,
            num_prompts=args.num_prompts,
            batch_count=args.batch_count,
            start_memory=start_memory,
            memory_monitor_type=memory_monitor_type,
            max_batch_size=args.max_trt_batch_size,
            nvtx_profile=False,
            use_cuda_graph=args.enable_cuda_graph,
            skip_warmup=args.skip_warmup,
        )
    elif args.engine == "tensorrt":
        print("Testing Txt2ImgPipeline with static input shape. Backend is TensorRT.")
        result = run_tensorrt_static(
            work_dir=args.work_dir,
            version=args.version,
            model_name=sd_model,
            batch_size=args.batch_size,
            disable_safety_checker=True,
            height=args.height,
            width=args.width,
            steps=args.steps,
            num_prompts=args.num_prompts,
            batch_count=args.batch_count,
            start_memory=start_memory,
            memory_monitor_type=memory_monitor_type,
            max_batch_size=args.max_trt_batch_size,
            nvtx_profile=False,
            use_cuda_graph=args.enable_cuda_graph,
            skip_warmup=args.skip_warmup,
        )
    else:
        print(
            f"Testing Txt2ImgPipeline with dynamic input shape. Backend is PyTorch: compile={args.enable_torch_compile}, xformers={args.use_xformers}."
        )
        result = run_torch(
            model_name=sd_model,
            batch_size=args.batch_size,
            disable_safety_checker=not args.enable_safety_checker,
            enable_torch_compile=args.enable_torch_compile,
            use_xformers=args.use_xformers,
            height=args.height,
            width=args.width,
            steps=args.steps,
            num_prompts=args.num_prompts,
            batch_count=args.batch_count,
            start_memory=start_memory,
            memory_monitor_type=memory_monitor_type,
            skip_warmup=args.skip_warmup,
        )

    print(result)

    with open("benchmark_result.csv", mode="a", newline="") as csv_file:
        column_names = [
            "model_name",
            "directory",
            "engine",
            "version",
            "provider",
            "disable_safety_checker",
            "height",
            "width",
            "steps",
            "batch_size",
            "batch_count",
            "num_prompts",
            "average_latency",
            "median_latency",
            "first_run_memory_MB",
            "second_run_memory_MB",
            "enable_cuda_graph",
        ]
        csv_writer = csv.DictWriter(csv_file, fieldnames=column_names)
        csv_writer.writeheader()
        csv_writer.writerow(result)

    # Show loaded DLLs when steps == 1 for debugging purpose.
    if args.steps == 1:
        print_loaded_libraries(args.provider in ["cuda", "tensorrt"])


if __name__ == "__main__":
    import traceback

    try:
        main()
    except Exception:
        traceback.print_exception(*sys.exc_info())
