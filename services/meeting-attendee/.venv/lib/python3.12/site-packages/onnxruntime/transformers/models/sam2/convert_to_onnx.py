# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import argparse
import os
import pathlib
import sys

import torch
from image_decoder import export_decoder_onnx, test_decoder_onnx
from image_encoder import export_image_encoder_onnx, test_image_encoder_onnx
from mask_decoder import export_mask_decoder_onnx, test_mask_decoder_onnx
from prompt_encoder import export_prompt_encoder_onnx, test_prompt_encoder_onnx
from sam2_demo import run_demo, show_all_images
from sam2_utils import load_sam2_model, sam2_onnx_path, setup_logger


def parse_arguments():
    parser = argparse.ArgumentParser(description="Export SAM2 models to ONNX")

    parser.add_argument(
        "--model_type",
        required=False,
        type=str,
        choices=["sam2_hiera_tiny", "sam2_hiera_small", "sam2_hiera_large", "sam2_hiera_base_plus"],
        default="sam2_hiera_large",
        help="The model type to export",
    )

    parser.add_argument(
        "--components",
        required=False,
        nargs="+",
        choices=["image_encoder", "mask_decoder", "prompt_encoder", "image_decoder"],
        default=["image_encoder", "image_decoder"],
        help="Type of ONNX models to export. "
        "Note that image_decoder is a combination of prompt_encoder and mask_decoder",
    )

    parser.add_argument(
        "--output_dir",
        type=str,
        help="The output directory for the ONNX models",
        default="sam2_onnx_models",
    )

    parser.add_argument(
        "--dynamic_batch_axes",
        required=False,
        default=False,
        action="store_true",
        help="Export image_encoder with dynamic batch axes",
    )

    parser.add_argument(
        "--multimask_output",
        required=False,
        default=False,
        action="store_true",
        help="Export mask_decoder or image_decoder with multimask_output",
    )

    parser.add_argument(
        "--disable_dynamic_multimask_via_stability",
        required=False,
        action="store_true",
        help="Disable mask_decoder dynamic_multimask_via_stability, and output first mask only."
        "This option will be ignored when multimask_output is True",
    )

    parser.add_argument(
        "--sam2_dir",
        required=False,
        type=str,
        default="./segment-anything-2",
        help="The directory of segment-anything-2 git repository",
    )

    parser.add_argument(
        "--overwrite",
        required=False,
        default=False,
        action="store_true",
        help="Overwrite onnx model file if exists.",
    )

    parser.add_argument(
        "--demo",
        required=False,
        default=False,
        action="store_true",
        help="Run demo with the exported ONNX models.",
    )

    parser.add_argument(
        "--optimize",
        required=False,
        default=False,
        action="store_true",
        help="Optimize onnx models",
    )

    parser.add_argument(
        "--dtype", required=False, choices=["fp32", "fp16"], default="fp32", help="Data type for inference."
    )

    parser.add_argument(
        "--use_gpu",
        required=False,
        default=False,
        action="store_true",
        help="Optimize onnx models for GPU",
    )

    parser.add_argument(
        "--dynamo",
        required=False,
        default=False,
        action="store_true",
        help="Use dynamo for exporting onnx model. Only image_encoder supports dynamo right now.",
    )

    parser.add_argument(
        "--verbose",
        required=False,
        default=False,
        action="store_true",
        help="Print verbose information",
    )

    args = parser.parse_args()
    return args


def optimize_sam2_model(onnx_model_path, optimized_model_path, float16: bool, use_gpu: bool):
    print(f"Optimizing {onnx_model_path} to {optimized_model_path} with float16={float16} and use_gpu={use_gpu}...")

    # Import from source directory.
    transformers_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    if transformers_dir not in sys.path:
        sys.path.insert(0, transformers_dir)
    from optimizer import optimize_model  # noqa: PLC0415

    optimized_model = optimize_model(onnx_model_path, model_type="sam2", opt_level=1, use_gpu=use_gpu)
    if float16:
        optimized_model.convert_float_to_float16(keep_io_types=False)
    optimized_model.save_model_to_file(optimized_model_path)


def main():
    args = parse_arguments()

    sam2_model = load_sam2_model(args.sam2_dir, args.model_type, device="cpu")

    pathlib.Path(args.output_dir).mkdir(parents=True, exist_ok=True)

    for component in args.components:
        onnx_model_path = sam2_onnx_path(args.output_dir, args.model_type, component, args.multimask_output)
        if component == "image_encoder":
            if args.overwrite or not os.path.exists(onnx_model_path):
                export_image_encoder_onnx(
                    sam2_model, onnx_model_path, args.dynamic_batch_axes, args.verbose, args.dynamo
                )
                test_image_encoder_onnx(sam2_model, onnx_model_path, dynamic_batch_axes=args.dynamic_batch_axes)

        elif component == "mask_decoder":
            if args.overwrite or not os.path.exists(onnx_model_path):
                export_mask_decoder_onnx(
                    sam2_model,
                    onnx_model_path,
                    args.multimask_output,
                    not args.disable_dynamic_multimask_via_stability,
                    args.verbose,
                )
                test_mask_decoder_onnx(
                    sam2_model,
                    onnx_model_path,
                    args.multimask_output,
                    not args.disable_dynamic_multimask_via_stability,
                )
        elif component == "prompt_encoder":
            if args.overwrite or not os.path.exists(onnx_model_path):
                export_prompt_encoder_onnx(sam2_model, onnx_model_path)
                test_prompt_encoder_onnx(sam2_model, onnx_model_path)
        else:
            assert component == "image_decoder"
            if args.overwrite or not os.path.exists(onnx_model_path):
                export_decoder_onnx(sam2_model, onnx_model_path, args.multimask_output)
                test_decoder_onnx(sam2_model, onnx_model_path, args.multimask_output)

    suffix = ""
    convert_to_fp16 = args.dtype == "fp16"
    if args.optimize:
        suffix = f"_{args.dtype}_" + ("gpu" if args.use_gpu else "cpu")
        for component in args.components:
            onnx_model_path = sam2_onnx_path(args.output_dir, args.model_type, component, args.multimask_output)
            optimized_model_path = sam2_onnx_path(
                args.output_dir, args.model_type, component, args.multimask_output, suffix
            )
            optimize_sam2_model(onnx_model_path, optimized_model_path, convert_to_fp16, args.use_gpu)

    if args.demo:
        # Export required ONNX models for demo if not already exported.
        image_encoder_onnx_path = sam2_onnx_path(
            args.output_dir, args.model_type, "image_encoder", args.multimask_output
        )
        if not os.path.exists(image_encoder_onnx_path):
            export_image_encoder_onnx(sam2_model, image_encoder_onnx_path, args.dynamic_batch_axes, args.verbose)

        image_decoder_onnx_path = sam2_onnx_path(args.output_dir, args.model_type, "image_decoder", False)
        if not os.path.exists(image_decoder_onnx_path):
            export_decoder_onnx(sam2_model, image_decoder_onnx_path, False)

        image_decoder_multi_onnx_path = sam2_onnx_path(args.output_dir, args.model_type, "image_decoder", True)
        if not os.path.exists(image_decoder_multi_onnx_path):
            export_decoder_onnx(sam2_model, image_decoder_multi_onnx_path, True)

        dtype = torch.float32 if args.dtype == "fp32" else torch.float16
        if suffix:
            optimized_image_encoder_onnx_path = image_encoder_onnx_path.replace(".onnx", f"{suffix}.onnx")
            if not os.path.exists(optimized_image_encoder_onnx_path):
                optimize_sam2_model(
                    image_encoder_onnx_path, optimized_image_encoder_onnx_path, convert_to_fp16, args.use_gpu
                )

            optimized_image_decoder_onnx_path = image_decoder_onnx_path.replace(".onnx", f"{suffix}.onnx")
            if not os.path.exists(optimized_image_decoder_onnx_path):
                optimize_sam2_model(
                    image_decoder_onnx_path, optimized_image_decoder_onnx_path, convert_to_fp16, args.use_gpu
                )

            optimized_image_decoder_multi_onnx_path = image_decoder_multi_onnx_path.replace(".onnx", f"{suffix}.onnx")
            if not os.path.exists(optimized_image_decoder_multi_onnx_path):
                optimize_sam2_model(
                    image_decoder_multi_onnx_path,
                    optimized_image_decoder_multi_onnx_path,
                    convert_to_fp16,
                    args.use_gpu,
                )

            # Use optimized models to run demo.
            image_encoder_onnx_path = optimized_image_encoder_onnx_path
            image_decoder_onnx_path = optimized_image_decoder_onnx_path
            image_decoder_multi_onnx_path = optimized_image_decoder_multi_onnx_path

        ort_image_files = run_demo(
            args.sam2_dir,
            args.model_type,
            engine="ort",
            dtype=dtype,
            image_encoder_onnx_path=image_encoder_onnx_path,
            image_decoder_onnx_path=image_decoder_onnx_path,
            image_decoder_multi_onnx_path=image_decoder_multi_onnx_path,
            use_gpu=args.use_gpu,
        )
        print("demo output files for ONNX Runtime:", ort_image_files)

        # Get results from torch engine to compare.
        torch_image_files = run_demo(args.sam2_dir, args.model_type, engine="torch", dtype=dtype, use_gpu=args.use_gpu)
        print("demo output files for PyTorch:", torch_image_files)

        show_all_images(ort_image_files, torch_image_files, suffix)
        print(f"Combined demo output: sam2_demo{suffix}.png")


if __name__ == "__main__":
    setup_logger(verbose=False)
    with torch.no_grad():
        main()
