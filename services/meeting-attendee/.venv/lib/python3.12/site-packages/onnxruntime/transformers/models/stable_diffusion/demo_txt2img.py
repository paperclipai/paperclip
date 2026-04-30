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


def main(args):
    controlnet_images, controlnet_scale = process_controlnet_arguments(args)

    pipeline, refiner = load_pipelines(args)
    assert refiner is None

    prompt, negative_prompt = repeat_prompt(args)
    batch_size = len(prompt)
    pipeline.load_resources(args.height, args.width, batch_size)

    def run_inference(warmup=False):
        return pipeline.run(
            prompt,
            negative_prompt,
            args.height,
            args.width,
            denoising_steps=args.denoising_steps,
            guidance=args.guidance,
            seed=args.seed,
            controlnet_images=controlnet_images,
            controlnet_scales=controlnet_scale,
            show_latency=not warmup,
            output_type="pil",
            deterministic=args.deterministic,
        )

    if not args.disable_cuda_graph:
        # inference once to get cuda graph
        _, _ = run_inference(warmup=True)

    print("[I] Warming up ..")
    for _ in range(args.num_warmup_runs):
        _, _ = run_inference(warmup=True)

    print("[I] Running StableDiffusion pipeline")
    if args.nvtx_profile:
        cudart.cudaProfilerStart()
    images, perf_data = run_inference(warmup=False)
    if args.nvtx_profile:
        cudart.cudaProfilerStop()

    metadata = get_metadata(args, False)
    metadata.update(pipeline.metadata())
    if perf_data:
        metadata.update(perf_data)
    metadata["images"] = len(images)
    print(metadata)
    pipeline.save_images(images, prompt, negative_prompt, metadata)

    pipeline.teardown()


if __name__ == "__main__":
    logging.basicConfig(format="%(funcName)20s: %(message)s", level=logging.INFO)

    parser = arg_parser("Options for Stable Diffusion Demo")
    add_controlnet_arguments(parser)
    args = parse_arguments(is_xl=False, parser=parser)

    if args.user_compute_stream:
        import torch

        s = torch.cuda.Stream()
        with torch.cuda.stream(s):
            main(args)
    else:
        main(args)
