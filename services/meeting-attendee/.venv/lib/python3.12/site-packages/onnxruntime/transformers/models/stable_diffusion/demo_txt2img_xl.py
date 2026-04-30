# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
# Modified from TensorRT demo diffusion, which has the following license:
#
# SPDX-FileCopyrightText: Copyright (c) 1993-2023 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# --------------------------------------------------------------------------

import logging

from cuda import cudart
from demo_utils import (
    add_controlnet_arguments,
    arg_parser,
    get_metadata,
    load_pipelines,
    parse_arguments,
    process_controlnet_arguments,
    repeat_prompt,
)


def run_pipelines(
    args, base, refiner, prompt, negative_prompt, controlnet_image=None, controlnet_scale=None, is_warm_up=False
):
    image_height = args.height
    image_width = args.width
    batch_size = len(prompt)
    base.load_resources(image_height, image_width, batch_size)
    if refiner:
        refiner.load_resources(image_height, image_width, batch_size)

    def run_base_and_refiner(warmup=False):
        images, base_perf = base.run(
            prompt,
            negative_prompt,
            image_height,
            image_width,
            denoising_steps=args.denoising_steps,
            guidance=args.guidance,
            seed=args.seed,
            controlnet_images=controlnet_image,
            controlnet_scales=controlnet_scale,
            show_latency=not warmup,
            output_type="latent" if refiner else "pil",
        )
        if refiner is None:
            return images, base_perf

        # Use same seed in base and refiner.
        seed = base.get_current_seed()

        images, refiner_perf = refiner.run(
            prompt,
            negative_prompt,
            image_height,
            image_width,
            denoising_steps=args.refiner_denoising_steps,
            image=images,
            strength=args.strength,
            guidance=args.refiner_guidance,
            seed=seed,
            show_latency=not warmup,
        )

        perf_data = None
        if base_perf and refiner_perf:
            perf_data = {"latency": base_perf["latency"] + refiner_perf["latency"]}
            perf_data.update({"base." + key: val for key, val in base_perf.items()})
            perf_data.update({"refiner." + key: val for key, val in refiner_perf.items()})

        return images, perf_data

    if not args.disable_cuda_graph:
        # inference once to get cuda graph
        _, _ = run_base_and_refiner(warmup=True)

    if args.num_warmup_runs > 0:
        print("[I] Warming up ..")
    for _ in range(args.num_warmup_runs):
        _, _ = run_base_and_refiner(warmup=True)

    if is_warm_up:
        return

    print("[I] Running StableDiffusion XL pipeline")
    if args.nvtx_profile:
        cudart.cudaProfilerStart()
    images, perf_data = run_base_and_refiner(warmup=False)
    if args.nvtx_profile:
        cudart.cudaProfilerStop()

    if refiner:
        print("|----------------|--------------|")
        print("| {:^14} | {:>9.2f} ms |".format("e2e", perf_data["latency"]))
        print("|----------------|--------------|")

    metadata = get_metadata(args, True)
    metadata.update({"base." + key: val for key, val in base.metadata().items()})
    if refiner:
        metadata.update({"refiner." + key: val for key, val in refiner.metadata().items()})
    if perf_data:
        metadata.update(perf_data)
    metadata["images"] = len(images)
    print(metadata)
    (refiner or base).save_images(images, prompt, negative_prompt, metadata)


def run_demo(args):
    """Run Stable Diffusion XL Base + Refiner together (known as ensemble of expert denoisers) to generate an image."""
    controlnet_image, controlnet_scale = process_controlnet_arguments(args)
    prompt, negative_prompt = repeat_prompt(args)
    batch_size = len(prompt)
    base, refiner = load_pipelines(args, batch_size)
    run_pipelines(args, base, refiner, prompt, negative_prompt, controlnet_image, controlnet_scale)
    base.teardown()
    if refiner:
        refiner.teardown()


def run_dynamic_shape_demo(args):
    """
    Run demo of generating images with different settings with ORT CUDA provider.
    Try "python demo_txt2img_xl.py --max-cuda-graphs 3 --user-compute-stream" to see the effect of multiple CUDA graphs.
    """
    args.engine = "ORT_CUDA"
    base, refiner = load_pipelines(args, 1)

    prompts = [
        "starry night over Golden Gate Bridge by van gogh",
        "beautiful photograph of Mt. Fuji during cherry blossom",
        "little cute gremlin sitting on a bed, cinematic",
        "cute grey cat with blue eyes, wearing a bowtie, acrylic painting",
        "beautiful Renaissance Revival Estate, Hobbit-House, detailed painting, warm colors, 8k, trending on Artstation",
        "blue owl, big green eyes, portrait, intricate metal design, unreal engine, octane render, realistic",
        "An astronaut riding a rainbow unicorn, cinematic, dramatic",
        "close-up photography of old man standing in the rain at night, in a street lit by lamps, leica 35mm",
    ]

    # batch size, height, width, scheduler, steps, prompt, seed, guidance, refiner scheduler, refiner steps, refiner strength
    configs = [
        (1, 832, 1216, "UniPC", 8, prompts[0], None, 5.0, "UniPC", 10, 0.3),
        (1, 1024, 1024, "DDIM", 24, prompts[1], None, 5.0, "DDIM", 30, 0.3),
        (1, 1216, 832, "EulerA", 16, prompts[2], 1716921396712843, 5.0, "EulerA", 10, 0.3),
        (1, 1344, 768, "EulerA", 24, prompts[3], 123698071912362, 5.0, "EulerA", 20, 0.3),
        (2, 640, 1536, "UniPC", 16, prompts[4], 4312973633252712, 5.0, "UniPC", 10, 0.3),
        (2, 1152, 896, "DDIM", 24, prompts[5], 1964684802882906, 5.0, "UniPC", 20, 0.3),
    ]

    # In testing LCM, refiner is disabled so the settings of refiner is not used.
    if args.lcm:
        configs = [
            (1, 1024, 1024, "LCM", 8, prompts[6], None, 1.0, "UniPC", 20, 0.3),
            (1, 1216, 832, "LCM", 6, prompts[7], 1337, 1.0, "UniPC", 20, 0.3),
        ]

    # Warm up each combination of (batch size, height, width) once before serving.
    args.prompt = ["warm up"]
    args.num_warmup_runs = 1
    for batch_size, height, width, _, _, _, _, _, _, _, _ in configs:
        args.batch_size = batch_size
        args.height = height
        args.width = width
        print(f"\nWarm up batch_size={batch_size}, height={height}, width={width}")
        prompt, negative_prompt = repeat_prompt(args)
        run_pipelines(args, base, refiner, prompt, negative_prompt, is_warm_up=True)

    # Run pipeline on a list of prompts.
    args.num_warmup_runs = 0
    for (
        batch_size,
        height,
        width,
        scheduler,
        steps,
        example_prompt,
        seed,
        guidance,
        refiner_scheduler,
        refiner_denoising_steps,
        strength,
    ) in configs:
        args.prompt = [example_prompt]
        args.batch_size = batch_size
        args.height = height
        args.width = width
        args.scheduler = scheduler
        args.denoising_steps = steps
        args.seed = seed
        args.guidance = guidance
        args.refiner_scheduler = refiner_scheduler
        args.refiner_denoising_steps = refiner_denoising_steps
        args.strength = strength
        base.set_scheduler(scheduler)
        if refiner:
            refiner.set_scheduler(refiner_scheduler)
        prompt, negative_prompt = repeat_prompt(args)
        run_pipelines(args, base, refiner, prompt, negative_prompt, is_warm_up=False)

    base.teardown()
    if refiner:
        refiner.teardown()


def run_turbo_demo(args):
    """Run demo of generating images with test prompts with ORT CUDA provider."""
    args.engine = "ORT_CUDA"
    base, refiner = load_pipelines(args, 1)

    from datasets import load_dataset  # noqa: PLC0415

    dataset = load_dataset("Gustavosta/Stable-Diffusion-Prompts")
    num_rows = dataset["test"].num_rows
    batch_size = args.batch_size
    num_batch = int(num_rows / batch_size)
    args.batch_size = 1
    for i in range(num_batch):
        args.prompt = [dataset["test"][i]["Prompt"] for i in range(i * batch_size, (i + 1) * batch_size)]
        base.set_scheduler(args.scheduler)
        if refiner:
            refiner.set_scheduler(args.refiner_scheduler)
        prompt, negative_prompt = repeat_prompt(args)
        run_pipelines(args, base, refiner, prompt, negative_prompt, is_warm_up=False)

    base.teardown()
    if refiner:
        refiner.teardown()


def main(args):
    no_prompt = isinstance(args.prompt, list) and len(args.prompt) == 1 and not args.prompt[0]
    if no_prompt:
        if args.version == "xl-turbo":
            run_turbo_demo(args)
        else:
            run_dynamic_shape_demo(args)
    else:
        run_demo(args)


if __name__ == "__main__":
    logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO)

    parser = arg_parser("Options for Stable Diffusion XL Demo")
    add_controlnet_arguments(parser)
    args = parse_arguments(is_xl=True, parser=parser)

    if args.user_compute_stream:
        import torch

        s = torch.cuda.Stream()
        with torch.cuda.stream(s):
            main(args)
    else:
        main(args)
