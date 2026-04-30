# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import argparse
import logging
import os
import sys

from utils import (
    chain_enc_dec_with_beamsearch,
    export_summarization_edinit,
    export_summarization_enc_dec_past,
    onnx_inference,
)

# GLOBAL ENVS
logging.basicConfig(
    format="%(asctime)s | %(levelname)s | %(name)s |  [%(filename)s:%(lineno)d] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=os.environ.get("LOGLEVEL", "INFO").upper(),
    stream=sys.stdout,
)
logger = logging.getLogger("generate")


def print_args(args):
    for arg in vars(args):
        logger.info(f"{arg}: {getattr(args, arg)}")


def user_command():
    parent_parser = argparse.ArgumentParser(add_help=False)
    parent_parser.add_argument("--max_length", type=int, default=20, help="default to 20")
    parent_parser.add_argument("--min_length", type=int, default=0, help="default to 0")
    parent_parser.add_argument("-o", "--output", type=str, default="onnx_models", help="default name is onnx_models.")
    parent_parser.add_argument("-i", "--input_text", type=str, default=None, help="input text")
    parent_parser.add_argument("-s", "--spm_path", type=str, default=None, help="tokenizer model from sentencepice")
    parent_parser.add_argument("-v", "--vocab_path", type=str, help="vocab dictionary")
    parent_parser.add_argument("-b", "--num_beams", type=int, default=5, help="default to 5")
    parent_parser.add_argument("--repetition_penalty", type=float, default=1.0, help="default to 1.0")
    parent_parser.add_argument("--no_repeat_ngram_size", type=int, default=3, help="default to 3")
    parent_parser.add_argument("--early_stopping", type=bool, default=False, help="default to False")
    parent_parser.add_argument("--opset_version", type=int, default=14, help="minimum is 14")

    parent_parser.add_argument("--no_encoder", action="store_true")
    parent_parser.add_argument("--no_decoder", action="store_true")
    parent_parser.add_argument("--no_chain", action="store_true")
    parent_parser.add_argument("--no_inference", action="store_true")

    required_args = parent_parser.add_argument_group("required input arguments")
    required_args.add_argument(
        "-m",
        "--model_dir",
        type=str,
        required=True,
        help="The directory contains input huggingface model. \
                               An official model like facebook/bart-base is also acceptable.",
    )

    print_args(parent_parser.parse_args())
    return parent_parser.parse_args()


if __name__ == "__main__":
    args = user_command()
    if args.opset_version < 14:
        raise ValueError(f"The minimum supported opset version is 14! The given one was {args.opset_version}.")

    isExist = os.path.exists(args.output)  # noqa: N816
    if not isExist:
        os.makedirs(args.output)

    # beam search op only supports CPU for now
    args.device = "cpu"
    logger.info("ENV: CPU ...")

    if not args.input_text:
        args.input_text = (
            "PG&E stated it scheduled the blackouts in response to forecasts for high winds "
            "amid dry conditions. The aim is to reduce the risk of wildfires. Nearly 800 thousand customers were "
            "scheduled to be affected by the shutoffs which were expected to last through at least midday tomorrow."
        )

    if not args.no_encoder:
        logger.info("========== EXPORTING ENCODER ==========")
        export_summarization_edinit.export_encoder(args)
    if not args.no_decoder:
        logger.info("========== EXPORTING DECODER ==========")
        export_summarization_enc_dec_past.export_decoder(args)
    if not args.no_chain:
        logger.info("========== CONVERTING MODELS ==========")
        chain_enc_dec_with_beamsearch.convert_model(args)
    if not args.no_inference:
        logger.info("========== INFERENCING WITH ONNX MODEL ==========")
        onnx_inference.run_inference(args)
