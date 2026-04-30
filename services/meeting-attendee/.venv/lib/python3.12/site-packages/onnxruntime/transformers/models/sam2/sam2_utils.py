# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import logging
import os
import sys
from collections.abc import Mapping

import torch
from sam2.build_sam import build_sam2
from sam2.modeling.sam2_base import SAM2Base

logger = logging.getLogger(__name__)


def _get_model_cfg(model_type) -> str:
    assert model_type in ["sam2_hiera_tiny", "sam2_hiera_small", "sam2_hiera_large", "sam2_hiera_base_plus"]
    if model_type == "sam2_hiera_tiny":
        model_cfg = "sam2_hiera_t.yaml"
    elif model_type == "sam2_hiera_small":
        model_cfg = "sam2_hiera_s.yaml"
    elif model_type == "sam2_hiera_base_plus":
        model_cfg = "sam2_hiera_b+.yaml"
    else:
        model_cfg = "sam2_hiera_l.yaml"
    return model_cfg


def load_sam2_model(sam2_dir, model_type, device: str | torch.device = "cpu") -> SAM2Base:
    checkpoints_dir = os.path.join(sam2_dir, "checkpoints")
    sam2_config_dir = os.path.join(sam2_dir, "sam2_configs")
    if not os.path.exists(sam2_dir):
        raise FileNotFoundError(f"{sam2_dir} does not exist. Please specify --sam2_dir correctly.")

    if not os.path.exists(checkpoints_dir):
        raise FileNotFoundError(f"{checkpoints_dir} does not exist. Please specify --sam2_dir correctly.")

    if not os.path.exists(sam2_config_dir):
        raise FileNotFoundError(f"{sam2_config_dir} does not exist. Please specify --sam2_dir correctly.")

    checkpoint_path = os.path.join(checkpoints_dir, f"{model_type}.pt")
    if not os.path.exists(checkpoint_path):
        raise FileNotFoundError(f"{checkpoint_path} does not exist. Please download checkpoints under the directory.")

    if sam2_dir not in sys.path:
        sys.path.append(sam2_dir)

    model_cfg = _get_model_cfg(model_type)
    sam2_model = build_sam2(model_cfg, checkpoint_path, device=device)
    return sam2_model


def sam2_onnx_path(output_dir, model_type, component, multimask_output=False, suffix=""):
    if component == "image_encoder":
        return os.path.join(output_dir, f"{model_type}_image_encoder{suffix}.onnx")
    elif component == "mask_decoder":
        return os.path.join(output_dir, f"{model_type}_mask_decoder{suffix}.onnx")
    elif component == "prompt_encoder":
        return os.path.join(output_dir, f"{model_type}_prompt_encoder{suffix}.onnx")
    else:
        assert component == "image_decoder"
        return os.path.join(
            output_dir, f"{model_type}_image_decoder" + ("_multi" if multimask_output else "") + f"{suffix}.onnx"
        )


def encoder_shape_dict(batch_size: int, height: int, width: int) -> Mapping[str, list[int]]:
    assert height == 1024 and width == 1024, "Only 1024x1024 images are supported."
    return {
        "image": [batch_size, 3, height, width],
        "image_features_0": [batch_size, 32, height // 4, width // 4],
        "image_features_1": [batch_size, 64, height // 8, width // 8],
        "image_embeddings": [batch_size, 256, height // 16, width // 16],
    }


def decoder_shape_dict(
    original_image_height: int,
    original_image_width: int,
    num_labels: int = 1,
    max_points: int = 16,
    num_masks: int = 1,
) -> dict:
    height: int = 1024
    width: int = 1024
    return {
        "image_features_0": [1, 32, height // 4, width // 4],
        "image_features_1": [1, 64, height // 8, width // 8],
        "image_embeddings": [1, 256, height // 16, width // 16],
        "point_coords": [num_labels, max_points, 2],
        "point_labels": [num_labels, max_points],
        "input_masks": [num_labels, 1, height // 4, width // 4],
        "has_input_masks": [num_labels],
        "original_image_size": [2],
        "masks": [num_labels, num_masks, original_image_height, original_image_width],
        "iou_predictions": [num_labels, num_masks],
        "low_res_masks": [num_labels, num_masks, height // 4, width // 4],
    }


def compare_tensors_with_tolerance(
    name: str,
    tensor1: torch.Tensor,
    tensor2: torch.Tensor,
    atol=5e-3,
    rtol=1e-4,
    mismatch_percentage_tolerance=0.1,
) -> bool:
    assert tensor1.shape == tensor2.shape
    a = tensor1.clone().float()
    b = tensor2.clone().float()

    differences = torch.abs(a - b)
    mismatch_count = (differences > (rtol * torch.max(torch.abs(a), torch.abs(b)) + atol)).sum().item()

    total_elements = a.numel()
    mismatch_percentage = (mismatch_count / total_elements) * 100

    passed = mismatch_percentage < mismatch_percentage_tolerance

    log_func = logger.error if not passed else logger.info
    log_func(
        "%s: mismatched elements percentage %.2f (%d/%d). Verification %s (threshold=%.2f).",
        name,
        mismatch_percentage,
        mismatch_count,
        total_elements,
        "passed" if passed else "failed",
        mismatch_percentage_tolerance,
    )

    return passed


def random_sam2_input_image(batch_size=1, image_height=1024, image_width=1024) -> torch.Tensor:
    image = torch.randn(batch_size, 3, image_height, image_width, dtype=torch.float32).cpu()
    return image


def setup_logger(verbose=True):
    if verbose:
        logging.basicConfig(format="[%(filename)s:%(lineno)s - %(funcName)20s()] %(message)s")
        logging.getLogger().setLevel(logging.INFO)
    else:
        logging.basicConfig(format="[%(message)s")
        logging.getLogger().setLevel(logging.WARNING)
