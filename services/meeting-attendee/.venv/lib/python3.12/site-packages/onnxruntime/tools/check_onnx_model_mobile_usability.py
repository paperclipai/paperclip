# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import argparse
import logging
import pathlib

# need this before the mobile helper imports for some reason
logging.basicConfig(format="%(levelname)s:  %(message)s")

from .mobile_helpers import usability_checker  # noqa: E402


def check_usability():
    parser = argparse.ArgumentParser(
        description="""Analyze an ONNX model to determine how well it will work in mobile scenarios.""",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--log_level", choices=["debug", "info"], default="info", help="Logging level")
    parser.add_argument("model_path", help="Path to ONNX model to check", type=pathlib.Path)

    args = parser.parse_args()
    logger = logging.getLogger("check_usability")

    if args.log_level == "debug":
        logger.setLevel(logging.DEBUG)
    elif args.log_level == "info":
        logger.setLevel(logging.INFO)
    elif args.log_level == "warning":
        logger.setLevel(logging.WARNING)
    else:
        logger.setLevel(logging.ERROR)

    try_eps = usability_checker.analyze_model(args.model_path, skip_optimize=False, logger=logger)

    if try_eps:
        logger.info(
            "As NNAPI or CoreML may provide benefits with this model it is recommended to compare the "
            "performance of the model using the NNAPI EP on Android, and the CoreML EP on iOS, "
            "against the performance using the CPU EP."
        )
    else:
        logger.info("For optimal performance the model should be used with the CPU EP. ")


if __name__ == "__main__":
    check_usability()
