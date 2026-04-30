# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import logging

import numpy as np
import torch
from PIL.Image import Image
from sam2.modeling.sam2_base import SAM2Base
from sam2.sam2_image_predictor import SAM2ImagePredictor
from sam2_utils import decoder_shape_dict, encoder_shape_dict

from onnxruntime import InferenceSession
from onnxruntime.transformers.io_binding_helper import CudaSession

logger = logging.getLogger(__name__)


def create_ort_session(
    onnx_path: str,
    session_options=None,
    provider="CUDAExecutionProvider",
    enable_cuda_graph=False,
    use_tf32=True,
) -> InferenceSession:
    if provider == "CUDAExecutionProvider":
        device_id = torch.cuda.current_device()
        provider_options = CudaSession.get_cuda_provider_options(device_id, enable_cuda_graph)
        provider_options["use_tf32"] = int(use_tf32)
        providers = [(provider, provider_options), "CPUExecutionProvider"]
    else:
        providers = ["CPUExecutionProvider"]
    logger.info("Using providers: %s", providers)
    return InferenceSession(onnx_path, session_options, providers=providers)


def create_session(
    onnx_path: str,
    session_options=None,
    provider="CUDAExecutionProvider",
    device: str | torch.device = "cuda",
    enable_cuda_graph=False,
) -> CudaSession:
    ort_session = create_ort_session(
        onnx_path, session_options, provider, enable_cuda_graph=enable_cuda_graph, use_tf32=True
    )
    cuda_session = CudaSession(ort_session, device=torch.device(device), enable_cuda_graph=enable_cuda_graph)
    return cuda_session


class SAM2ImageOnnxPredictor(SAM2ImagePredictor):
    def __init__(
        self,
        sam_model: SAM2Base,
        image_encoder_onnx_path: str = "",
        image_decoder_onnx_path: str = "",
        image_decoder_multi_onnx_path: str = "",
        provider: str = "CUDAExecutionProvider",
        device: str | torch.device = "cuda",
        onnx_dtype: torch.dtype = torch.float32,
        mask_threshold=0.0,
        max_hole_area=0.0,
        max_sprinkle_area=0.0,
        **kwargs,
    ) -> None:
        """
        Uses SAM-2 to compute the image embedding for an image, and then allow mask prediction given prompts.

        Arguments:
          sam_model (SAM2Base): The model to use for mask prediction.
          onnx_directory (str): The path of the directory that contains encoder and decoder onnx models.
          onnx_dtype (torch.dtype): The data type to use for ONNX inputs.
          mask_threshold (float): The threshold to convert mask logits to binary masks. Default is 0.0.
          max_hole_area (float): If max_hole_area > 0, we fill small holes in up to
                                 the maximum area of max_hole_area in low_res_masks.
          max_sprinkle_area (float): If max_sprinkle_area > 0, we remove small sprinkles up to
                                     the maximum area of max_sprinkle_area in low_res_masks.
        """
        super().__init__(
            sam_model, mask_threshold=mask_threshold, max_hole_area=max_hole_area, max_sprinkle_area=max_sprinkle_area
        )

        logger.debug("self.device=%s, device=%s", self.device, device)

        # This model is exported by image_encoder.py.
        self.encoder_session = create_session(
            image_encoder_onnx_path,
            session_options=None,
            provider=provider,
            device=device,
            enable_cuda_graph=False,
        )
        self.onnx_dtype = onnx_dtype

        # This model is exported by image_decoder.py. It outputs only one mask.
        self.decoder_session = create_session(
            image_decoder_onnx_path,
            session_options=None,
            provider=provider,
            device=device,
            enable_cuda_graph=False,
        )

        # This model is exported by image_decoder.py. It outputs multiple (3) masks.
        self.decoder_session_multi_out = create_session(
            image_decoder_multi_onnx_path,
            session_options=None,
            provider=provider,
            device=device,
            enable_cuda_graph=False,
        )

    @torch.no_grad()
    def set_image(self, image: np.ndarray | Image):
        """
        Calculates the image embeddings for the provided image.

        Arguments:
          image (np.ndarray or PIL Image): The input image to embed in RGB format.
              The image should be in HWC format if np.ndarray, or WHC format if PIL Image with pixel values in [0, 255].
        """
        self.reset_predictor()
        # Transform the image to the form expected by the model
        if isinstance(image, np.ndarray):
            # For numpy array image, we assume (HxWxC) format.
            self._orig_hw = [image.shape[:2]]
        elif isinstance(image, Image):
            w, h = image.size
            self._orig_hw = [(h, w)]
        else:
            raise NotImplementedError("Image format not supported")

        input_image = self._transforms(image)
        input_image = input_image[None, ...].to(self.device)

        assert len(input_image.shape) == 4 and input_image.shape[1] == 3, (
            f"input_image must be of size 1x3xHxW, got {input_image.shape}"
        )

        # Computing image embeddings for the provided image
        io_shapes = encoder_shape_dict(batch_size=1, height=input_image.shape[2], width=input_image.shape[3])
        self.encoder_session.allocate_buffers(io_shapes)

        feed_dict = {"image": input_image.to(self.onnx_dtype).to(self.device)}

        for key, value in feed_dict.items():
            logger.debug(f"{key}: {value.shape}, {value.dtype}")
        logger.debug(f"encoder onnx: {self.encoder_session.ort_session._model_path}")

        ort_outputs = self.encoder_session.infer(feed_dict)

        self._features = {
            "image_embed": ort_outputs["image_embeddings"],
            "high_res_feats": [ort_outputs[f"image_features_{i}"] for i in range(2)],
        }
        self._is_image_set = True
        logging.info("Image embeddings computed.")

    @torch.no_grad()
    def _predict(
        self,
        point_coords: torch.Tensor | None,
        point_labels: torch.Tensor | None,
        boxes: torch.Tensor | None = None,
        mask_input: torch.Tensor | None = None,
        multimask_output: bool = True,
        return_logits: bool = False,
        img_idx: int = -1,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """
        Predict masks for the given input prompts, using the currently set image.
        Input prompts are batched torch tensors and are expected to already be
        transformed to the input frame using SAM2Transforms.

        Arguments:
          point_coords (torch.Tensor or None): A BxNx2 array of point prompts to the
            model. Each point is in (X,Y) in pixels.
          point_labels (torch.Tensor or None): A BxN array of labels for the
            point prompts. 1 indicates a foreground point and 0 indicates a
            background point.
          boxes (np.ndarray or None): A Bx4 array given a box prompt to the
            model, in XYXY format.
          mask_input (np.ndarray): A low resolution mask input to the model, typically
            coming from a previous prediction iteration. Has form Bx1xHxW, where
            for SAM, H=W=256. Masks returned by a previous iteration of the
            predict method do not need further transformation.
          multimask_output (bool): If true, the model will return three masks.
            For ambiguous input prompts (such as a single click), this will often
            produce better masks than a single prediction. If only a single
            mask is needed, the model's predicted quality score can be used
            to select the best mask. For non-ambiguous prompts, such as multiple
            input prompts, multimask_output=False can give better results.
          return_logits (bool): If true, returns un-thresholded masks logits
            instead of a binary mask.

        Returns:
          (torch.Tensor): The output masks in BxCxHxW format, where C is the
            number of masks, and (H, W) is the original image size.
          (torch.Tensor): An array of shape BxC containing the model's
            predictions for the quality of each mask.
          (torch.Tensor): An array of shape BxCxHxW, where C is the number
            of masks and H=W=256. These low res logits can be passed to
            a subsequent iteration as mask input.
        """
        assert not return_logits  # onnx model is exported for returning bool masks.

        if not self._is_image_set:
            raise RuntimeError("An image must be set with .set_image(...) before mask prediction.")

        if point_coords is not None:
            concat_points = (point_coords, point_labels)
        else:
            concat_points = None

        # Embed prompts
        if boxes is not None:
            box_coords = boxes.reshape(-1, 2, 2)
            box_labels = torch.tensor([[2, 3]], dtype=torch.int, device=boxes.device)
            box_labels = box_labels.repeat(boxes.size(0), 1)
            # we merge "boxes" and "points" into a single "concat_points" input (where
            # boxes are added at the beginning) to sam_prompt_encoder
            if concat_points is not None:
                concat_coords = torch.cat([box_coords, concat_points[0]], dim=1)
                concat_labels = torch.cat([box_labels, concat_points[1]], dim=1)
                concat_points = (concat_coords, concat_labels)
            else:
                concat_points = (box_coords, box_labels)

        assert concat_points is not None
        num_labels = concat_points[0].shape[0]
        shape_dict = decoder_shape_dict(
            original_image_height=self._orig_hw[img_idx][0],
            original_image_width=self._orig_hw[img_idx][1],
            num_labels=num_labels,
            max_points=concat_points[0].shape[1],
            num_masks=3 if multimask_output else 1,
        )
        if multimask_output:
            decoder_session = self.decoder_session_multi_out
        else:
            decoder_session = self.decoder_session

        decoder_session.allocate_buffers(shape_dict)

        image_features_0 = self._features["high_res_feats"][0][img_idx].unsqueeze(0)
        image_features_1 = self._features["high_res_feats"][1][img_idx].unsqueeze(0)
        image_embeddings = self._features["image_embed"][img_idx].unsqueeze(0)

        if mask_input is None:
            input_masks = torch.zeros(num_labels, 1, 256, 256, dtype=self.onnx_dtype, device=self.device)
            has_input_masks = torch.zeros(num_labels, dtype=self.onnx_dtype, device=self.device)
        else:
            input_masks = mask_input[img_idx].unsqueeze(0).repeat(num_labels, 1, 1, 1)
            has_input_masks = torch.ones(num_labels, dtype=self.onnx_dtype, device=self.device)

        feed_dict = {
            "image_embeddings": image_embeddings.contiguous().to(dtype=self.onnx_dtype).to(self.device),
            "image_features_0": image_features_0.contiguous().to(dtype=self.onnx_dtype).to(self.device),
            "image_features_1": image_features_1.contiguous().to(dtype=self.onnx_dtype).to(self.device),
            "point_coords": concat_points[0].to(dtype=self.onnx_dtype).to(self.device),
            "point_labels": concat_points[1].to(dtype=torch.int32).to(self.device),
            "input_masks": input_masks.to(dtype=self.onnx_dtype).to(self.device),
            "has_input_masks": has_input_masks.to(dtype=self.onnx_dtype).to(self.device),
            "original_image_size": torch.tensor(self._orig_hw[img_idx], dtype=torch.int32, device=self.device),
        }

        for key, value in feed_dict.items():
            logger.debug(f"{key}: {value.shape}, {value.dtype}")
        logger.debug(f"decoder onnx: {self.decoder_session.ort_session._model_path}")

        ort_outputs = decoder_session.infer(feed_dict)

        masks = ort_outputs["masks"]
        iou_predictions = ort_outputs["iou_predictions"]
        low_res_masks = ort_outputs["low_res_masks"]

        return torch.Tensor(masks), torch.Tensor(iou_predictions), torch.Tensor(low_res_masks)
