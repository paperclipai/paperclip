# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import pathlib
import typing

from ..logger import get_logger
from .operator_type_usage_processors import OperatorTypeUsageManager
from .ort_model_processor import OrtFormatModelProcessor

log = get_logger("ort_format_model.utils")


def _extract_ops_and_types_from_ort_models(model_files: typing.Iterable[pathlib.Path], enable_type_reduction: bool):
    required_ops = {}
    op_type_usage_manager = OperatorTypeUsageManager() if enable_type_reduction else None

    for model_file in model_files:
        if not model_file.is_file():
            raise ValueError(f"Path is not a file: '{model_file}'")
        model_processor = OrtFormatModelProcessor(str(model_file), required_ops, op_type_usage_manager)
        model_processor.process()  # this updates required_ops and op_type_processors

    return required_ops, op_type_usage_manager


def create_config_from_models(
    model_files: typing.Iterable[pathlib.Path], output_file: pathlib.Path, enable_type_reduction: bool
):
    """
    Create a configuration file with required operators and optionally required types.
    :param model_files: Model files to use to generate the configuration file.
    :param output_file: File to write configuration to.
    :param enable_type_reduction: Include required type information for individual operators in the configuration.
    """

    required_ops, op_type_processors = _extract_ops_and_types_from_ort_models(model_files, enable_type_reduction)

    output_file.parent.mkdir(parents=True, exist_ok=True)

    with open(output_file, "w") as out:
        out.write("# Generated from model/s:\n")
        out.writelines(f"# - {model_file}\n" for model_file in sorted(model_files))

        for domain in sorted(required_ops.keys()):
            for opset in sorted(required_ops[domain].keys()):
                ops = required_ops[domain][opset]
                if ops:
                    out.write(f"{domain};{opset};")
                    if enable_type_reduction:
                        # type string is empty if op hasn't been seen
                        entries = [
                            "{}{}".format(op, op_type_processors.get_config_entry(domain, op) or "")
                            for op in sorted(ops)
                        ]
                    else:
                        entries = sorted(ops)

                    out.write("{}\n".format(",".join(entries)))

    log.info("Created config in %s", output_file)
