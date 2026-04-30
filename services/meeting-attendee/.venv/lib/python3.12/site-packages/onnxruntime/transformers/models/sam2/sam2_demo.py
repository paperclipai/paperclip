# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import os

import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np
import torch
from matplotlib.patches import Rectangle
from PIL import Image
from sam2.sam2_image_predictor import SAM2ImagePredictor
from sam2_image_onnx_predictor import SAM2ImageOnnxPredictor
from sam2_utils import load_sam2_model

import onnxruntime


def show_mask(mask, ax, random_color=False, borders=True):
    if random_color:
        color = np.concatenate([np.random.random(3), np.array([0.6])], axis=0)
    else:
        color = np.array([30 / 255, 144 / 255, 255 / 255, 0.6])
    h, w = mask.shape[-2:]
    mask = mask.astype(np.uint8)
    mask_image = mask.reshape(h, w, 1) * color.reshape(1, 1, -1)
    if borders:
        import cv2  # noqa: PLC0415

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        # Try to smooth contours
        contours = [cv2.approxPolyDP(contour, epsilon=0.01, closed=True) for contour in contours]
        mask_image = cv2.drawContours(mask_image, contours, -1, (1, 1, 1, 0.5), thickness=2)
    ax.imshow(mask_image)


def show_points(coords, labels, ax, marker_size=375):
    pos_points = coords[labels == 1]
    neg_points = coords[labels == 0]
    ax.scatter(
        pos_points[:, 0], pos_points[:, 1], color="green", marker="*", s=marker_size, edgecolor="white", linewidth=1.25
    )
    ax.scatter(
        neg_points[:, 0], neg_points[:, 1], color="red", marker="*", s=marker_size, edgecolor="white", linewidth=1.25
    )


def show_box(box, ax):
    x0, y0 = box[0], box[1]
    w, h = box[2] - box[0], box[3] - box[1]
    ax.add_patch(Rectangle((x0, y0), w, h, edgecolor="green", facecolor=(0, 0, 0, 0), lw=2))


def show_masks(
    image,
    masks,
    scores,
    point_coords=None,
    box_coords=None,
    input_labels=None,
    borders=True,
    output_image_file_prefix=None,
    image_files=None,
):
    for i, (mask, score) in enumerate(zip(masks, scores, strict=False)):
        plt.figure(figsize=(10, 10))
        plt.imshow(image)
        show_mask(mask, plt.gca(), borders=borders)
        if point_coords is not None:
            assert input_labels is not None
            show_points(point_coords, input_labels, plt.gca())

        if box_coords is not None:
            show_box(box_coords, plt.gca())

        if len(scores) > 1:
            plt.title(f"Mask {i + 1}, Score: {score:.3f}", fontsize=18)

        plt.axis("off")
        if output_image_file_prefix:
            filename = f"{output_image_file_prefix}_{i}.png"
            if os.path.exists(filename):
                os.remove(filename)
            plt.savefig(filename, format="png", bbox_inches="tight", pad_inches=0)
            if isinstance(image_files, list):
                image_files.append(filename)
        plt.show(block=False)
        plt.close()


def get_predictor(
    sam2_dir: str,
    device: str | torch.device,
    dtype: torch.dtype,
    model_type="sam2_hiera_large",
    engine="torch",
    image_encoder_onnx_path: str = "",
    image_decoder_onnx_path: str = "",
    image_decoder_multi_onnx_path: str = "",
    provider: str = "CUDAExecutionProvider",
):
    sam2_model = load_sam2_model(sam2_dir, model_type, device=device)
    if engine == "torch":
        predictor = SAM2ImagePredictor(sam2_model)
    else:
        predictor = SAM2ImageOnnxPredictor(
            sam2_model,
            image_encoder_onnx_path=image_encoder_onnx_path,
            image_decoder_onnx_path=image_decoder_onnx_path,
            image_decoder_multi_onnx_path=image_decoder_multi_onnx_path,
            provider=provider,
            device=device,
            onnx_dtype=dtype,
        )
    return predictor


def run_demo(
    sam2_dir: str,
    model_type: str = "sam2_hiera_large",
    engine: str = "torch",
    dtype: torch.dtype = torch.float32,
    image_encoder_onnx_path: str = "",
    image_decoder_onnx_path: str = "",
    image_decoder_multi_onnx_path: str = "",
    use_gpu: bool = True,
    enable_batch: bool = False,
):
    if use_gpu:
        assert torch.cuda.is_available()
        assert "CUDAExecutionProvider" in onnxruntime.get_available_providers()
        provider = "CUDAExecutionProvider"
    else:
        provider = "CPUExecutionProvider"

    device = torch.device("cuda" if use_gpu else "cpu")

    if use_gpu and engine == "torch" and torch.cuda.get_device_properties(0).major >= 8:
        # Turn on tfloat32 for Ampere GPUs.
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    np.random.seed(3)
    image = Image.open("truck.jpg")
    image = np.array(image.convert("RGB"))

    predictor = get_predictor(
        sam2_dir,
        device,
        dtype,
        model_type,
        engine,
        image_encoder_onnx_path,
        image_decoder_onnx_path,
        image_decoder_multi_onnx_path,
        provider=provider,
    )

    predictor.set_image(image)
    prefix = f"sam2_demo_{engine}_"

    #  The model returns masks, quality predictions for those masks,
    #     and low resolution mask logits that can be passed to the next iteration of prediction.
    #  With multimask_output=True (the default setting), SAM 2 outputs 3 masks, where
    #     scores gives the model's own estimation of the quality of these masks.
    #  For ambiguous prompts such as a single point, it is recommended to use multimask_output=True
    #     even if only a single mask is desired;
    input_point = np.array([[500, 375]])
    input_label = np.array([1])
    masks, scores, logits = predictor.predict(
        point_coords=input_point,
        point_labels=input_label,
        multimask_output=True,
    )

    sorted_ind = np.argsort(scores)[::-1]
    masks = masks[sorted_ind]
    scores = scores[sorted_ind]
    logits = logits[sorted_ind]

    image_files = []
    show_masks(
        image,
        masks,
        scores,
        point_coords=input_point,
        input_labels=input_label,
        borders=True,
        output_image_file_prefix=prefix + "multimask",
        image_files=image_files,
    )

    # Multiple points.
    input_point = np.array([[500, 375], [1125, 625]])
    input_label = np.array([1, 1])
    mask_input = logits[np.argmax(scores), :, :]  # Choose the model's best mask
    masks, scores, _ = predictor.predict(
        point_coords=input_point,
        point_labels=input_label,
        mask_input=mask_input[None, :, :],
        multimask_output=False,
    )
    show_masks(
        image,
        masks,
        scores,
        point_coords=input_point,
        input_labels=input_label,
        output_image_file_prefix=prefix + "multi_points",
        image_files=image_files,
    )

    # Specify a window and a background point.
    input_point = np.array([[500, 375], [1125, 625]])
    input_label = np.array([1, 0])
    mask_input = logits[np.argmax(scores), :, :]  # Choose the model's best mask
    masks, scores, _ = predictor.predict(
        point_coords=input_point,
        point_labels=input_label,
        mask_input=mask_input[None, :, :],
        multimask_output=False,
    )
    show_masks(
        image,
        masks,
        scores,
        point_coords=input_point,
        input_labels=input_label,
        output_image_file_prefix=prefix + "background_point",
        image_files=image_files,
    )

    # Take a box as input
    input_box = np.array([425, 600, 700, 875])
    masks, scores, _ = predictor.predict(
        point_coords=None,
        point_labels=None,
        box=input_box[None, :],
        multimask_output=False,
    )
    show_masks(
        image,
        masks,
        scores,
        box_coords=input_box,
        output_image_file_prefix=prefix + "box",
        image_files=image_files,
    )

    # Combining points and boxes
    input_box = np.array([425, 600, 700, 875])
    input_point = np.array([[575, 750]])
    input_label = np.array([0])

    masks, scores, logits = predictor.predict(
        point_coords=input_point,
        point_labels=input_label,
        box=input_box,
        multimask_output=False,
    )
    show_masks(
        image,
        masks,
        scores,
        box_coords=input_box,
        point_coords=input_point,
        input_labels=input_label,
        output_image_file_prefix=prefix + "box_and_point",
        image_files=image_files,
    )

    # TODO: support batched prompt inputs
    if enable_batch:
        input_boxes = np.array(
            [
                [75, 275, 1725, 850],
                [425, 600, 700, 875],
                [1375, 550, 1650, 800],
                [1240, 675, 1400, 750],
            ]
        )
        masks, scores, _ = predictor.predict(
            point_coords=None,
            point_labels=None,
            box=input_boxes,
            multimask_output=False,
        )
        plt.figure(figsize=(10, 10))
        plt.imshow(image)
        for mask in masks:
            show_mask(mask.squeeze(0), plt.gca(), random_color=True)
        for box in input_boxes:
            show_box(box, plt.gca())
        plt.axis("off")
        plt.show()
        plt.savefig(prefix + "batch_prompt.png")
        image_files.append(prefix + "batch_prompt.png")
    return image_files


def show_all_images(left_images, right_images, suffix=""):
    # Show images in two rows since display screen is horizontal in most cases.
    fig, axes = plt.subplots(nrows=2, ncols=len(left_images), figsize=(19.20, 10.80))
    for i, (left_img_path, right_img_path) in enumerate(zip(left_images, right_images, strict=False)):
        left_img = mpimg.imread(left_img_path)
        right_img = mpimg.imread(right_img_path)

        axes[0, i].imshow(left_img)
        axes[0, i].set_title(left_img_path.replace("sam2_demo_", "").replace(".png", ""), fontsize=10)
        axes[0, i].axis("off")
        axes[0, i].set_aspect(left_img.shape[1] / left_img.shape[0])

        axes[1, i].imshow(right_img)
        axes[1, i].set_title(right_img_path.replace("sam2_demo_", "").replace(".png", ""), fontsize=10)
        axes[1, i].axis("off")
        axes[1, i].set_aspect(right_img.shape[1] / right_img.shape[0])

    plt.tight_layout()
    plt.savefig(f"sam2_demo{suffix}.png", format="png", bbox_inches="tight", dpi=1000)
    plt.show()
