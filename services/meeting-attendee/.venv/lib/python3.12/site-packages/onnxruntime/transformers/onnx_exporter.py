# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------

import logging
import os
from pathlib import Path

import numpy
import torch
from affinity_helper import AffinitySetting
from benchmark_helper import OptimizerInfo, Precision, create_onnxruntime_session
from huggingface_models import MODEL_CLASSES
from quantize_helper import QuantizeHelper
from torch_onnx_export_helper import torch_onnx_export
from transformers import AutoConfig, AutoFeatureExtractor, AutoTokenizer, LxmertConfig, TransfoXLConfig

from onnxruntime.transformers.models.gpt2.gpt2_helper import (
    PRETRAINED_GPT2_MODELS,
    GPT2ModelNoPastState,
    TFGPT2ModelNoPastState,
)

os.environ["TF_CPP_MIN_LOG_LEVEL"] = "2"

logger = logging.getLogger(__name__)

# Workaround by replacing torch.triu using self-defined op
# Since torch.triu cannot be exported to ONNX. See https://github.com/pytorch/pytorch/issues/32968
torch_func = {"triu": torch.triu}


def triu_onnx(x, diagonal=0, out=None):
    assert out is None
    assert len(x.shape) == 2 and x.size(0) == x.size(1)

    torch_triu = torch_func["triu"]
    template = torch_triu(torch.ones((1024, 1024), dtype=torch.uint8), diagonal)
    mask = template[: x.size(0), : x.size(1)]
    return torch.where(mask.bool(), x, torch.zeros_like(x))


def replace_torch_functions():
    torch.triu = triu_onnx


def restore_torch_functions():
    torch.triu = torch_func["triu"]


def create_onnxruntime_input(vocab_size, batch_size, sequence_length, input_names, config, data_type=numpy.int64):
    if config.model_type in ["vit", "swin"]:
        input_ids = numpy.random.rand(batch_size, 3, config.image_size, config.image_size).astype(numpy.float32)
        inputs = {"pixel_values": input_ids}
        return inputs

    input_ids = numpy.random.randint(low=0, high=vocab_size - 1, size=(batch_size, sequence_length), dtype=data_type)
    inputs = {"input_ids": input_ids}

    if "attention_mask" in input_names:
        attention_mask = numpy.ones([batch_size, sequence_length], dtype=data_type)
        inputs["attention_mask"] = attention_mask

    if "token_type_ids" in input_names:
        segment_ids = numpy.zeros([batch_size, sequence_length], dtype=data_type)
        inputs["token_type_ids"] = segment_ids

    if config.is_encoder_decoder:
        inputs["decoder_input_ids"] = input_ids

    if isinstance(config, LxmertConfig):
        inputs["visual_feats"] = numpy.random.randn(1, 1, config.visual_feat_dim).astype(numpy.float32)
        inputs["visual_pos"] = numpy.random.randn(1, 1, config.visual_pos_dim).astype(numpy.float32)
    if isinstance(config, TransfoXLConfig):
        inputs["tf_transfo_xl_model/transformer/pos_emb/einsum/Einsum/inputs_1:0"] = numpy.zeros(
            [config.hidden_size], dtype=numpy.float32
        )
    return inputs


def filter_inputs(inputs, input_names):
    remaining_model_inputs = {}
    for input_name in input_names:
        if input_name in inputs:
            remaining_model_inputs[input_name] = inputs[input_name]
    return remaining_model_inputs


def flatten(inputs):
    return [[flatten(i) for i in inputs] if isinstance(inputs, (list, tuple)) else inputs]


def update_flatten_list(inputs, res_list):
    for i in inputs:
        res_list.append(i) if not isinstance(i, (list, tuple)) else update_flatten_list(i, res_list)
    return res_list


def build_dynamic_axes(example_inputs, outputs_flatten):
    sequence_length = example_inputs["input_ids"].shape[-1]

    dynamic_axes = {key: {0: "batch_size", 1: "seq_len"} for key in example_inputs}

    output_names = ["output_" + str(i + 1) for i in range(len(outputs_flatten))]
    for i, output_name in enumerate(output_names):
        dynamic_axes[output_name] = {0: "batch_size"}
        dims = outputs_flatten[i].shape
        for j, dim in enumerate(dims):
            if dim == sequence_length:
                dynamic_axes[output_name].update({j: "seq_len"})
    return dynamic_axes, output_names


def validate_onnx_model(
    onnx_model_path,
    example_inputs,
    example_outputs_flatten,
    use_gpu,
    fp16,
    output_names=None,
):
    test_session = create_onnxruntime_session(onnx_model_path, use_gpu, enable_all_optimization=False)
    if test_session is None:
        logger.error(f"{onnx_model_path} is an invalid ONNX model")
        return False

    logger.info(f"{onnx_model_path} is a valid ONNX model")

    # Compare the inference result with PyTorch or Tensorflow
    example_ort_inputs = {k: t.numpy() for k, t in example_inputs.items()}
    example_ort_outputs = test_session.run(output_names, example_ort_inputs)
    if len(example_outputs_flatten) != len(example_ort_outputs):
        logger.error(
            f"Number of output tensors expected {len(example_outputs_flatten)}, got {len(example_ort_outputs)}"
        )
        return False

    for i in range(len(example_outputs_flatten)):
        abs_diff = numpy.amax(numpy.abs(example_ort_outputs[i] - example_outputs_flatten[i].cpu().numpy()))
        if abs_diff > 1e-4:
            logger.info(f"Max absolute diff={abs_diff} for output tensor {i}")

        rtol = 5e-02 if fp16 else 1e-4
        atol = 1e-01 if fp16 else 1e-4
        if not numpy.allclose(
            example_ort_outputs[i],
            example_outputs_flatten[i].cpu().numpy(),
            rtol=rtol,
            atol=atol,
        ):
            logger.error(f"Output tensor {i} is not close: rtol={rtol}, atol={atol}")
            return False

    logger.info(f"inference result of onnxruntime is validated on {onnx_model_path}")
    return True


def get_onnx_file_path(
    onnx_dir: str,
    model_name: str,
    input_count: int,
    optimized_by_script: bool,
    use_gpu: bool,
    precision: Precision,
    optimized_by_onnxruntime: bool,
    use_external_data: bool,
):
    from re import sub  # noqa: PLC0415

    normalized_model_name = sub(r"[^a-zA-Z0-9_]", "_", model_name)

    if not optimized_by_script:
        filename = f"{normalized_model_name}_{input_count}"
    else:
        device = "gpu" if use_gpu else "cpu"
        filename = f"{normalized_model_name}_{input_count}_{precision}_{device}"

    if optimized_by_onnxruntime:
        filename += "_ort"

    directory = onnx_dir
    # ONNXRuntime will not write external data so the raw and optimized models shall be in same directory.
    if use_external_data and not optimized_by_onnxruntime:
        directory = os.path.join(onnx_dir, filename)
        if not os.path.exists(directory):
            os.makedirs(directory)

    return os.path.join(directory, f"{filename}.onnx")


def add_filename_suffix(file_path: str, suffix: str) -> str:
    """
    Append a suffix at the filename (before the extension).
    Args:
        path: pathlib.Path The actual path object we would like to add a suffix
        suffix: The suffix to add
    Returns: path with suffix appended at the end of the filename and before extension
    """
    path = Path(file_path)
    return str(path.parent.joinpath(path.stem + suffix).with_suffix(path.suffix))


def optimize_onnx_model_by_ort(onnx_model_path, ort_model_path, use_gpu, overwrite, model_fusion_statistics):
    if overwrite or not os.path.exists(ort_model_path):
        Path(ort_model_path).parent.mkdir(parents=True, exist_ok=True)
        from optimizer import get_fusion_statistics, optimize_by_onnxruntime  # noqa: PLC0415

        # Use onnxruntime to optimize model, which will be saved to *_ort.onnx
        _ = optimize_by_onnxruntime(
            onnx_model_path,
            use_gpu=use_gpu,
            optimized_model_path=ort_model_path,
            opt_level=99,
        )
        model_fusion_statistics[ort_model_path] = get_fusion_statistics(ort_model_path)
    else:
        logger.info(f"Skip optimization since model existed: {ort_model_path}")


def optimize_onnx_model(
    onnx_model_path,
    optimized_model_path,
    model_type,
    num_attention_heads,
    hidden_size,
    use_gpu,
    precision,
    use_raw_attention_mask,
    overwrite,
    model_fusion_statistics,
    use_external_data_format,
    optimization_options=None,
):
    if overwrite or not os.path.exists(optimized_model_path):
        Path(optimized_model_path).parent.mkdir(parents=True, exist_ok=True)

        from fusion_options import FusionOptions  # noqa: PLC0415
        from optimizer import optimize_model  # noqa: PLC0415

        if optimization_options is None:
            optimization_options = FusionOptions(model_type)
        optimization_options.use_raw_attention_mask(use_raw_attention_mask)
        if precision == Precision.FLOAT16:
            optimization_options.enable_gelu_approximation = True
        if precision == Precision.INT8:
            optimization_options.enable_embed_layer_norm = False

        # For swin models, the num_attention_heads is a list, which isn't supported yet, so set to 0 for now
        if model_type == "swin":
            num_attention_heads = 0
            hidden_size = 0

        # Use script to optimize model.
        # Use opt_level <= 1 for models to be converted to fp16, because some fused op (like FusedGemm) has only fp32 and no fp16.
        # It is better to be conservative so we use opt_level=0 here, in case MemcpyFromHost is added to the graph by OnnxRuntime.
        opt_model = optimize_model(
            onnx_model_path,
            model_type,
            num_heads=num_attention_heads,
            hidden_size=hidden_size,
            opt_level=0,
            optimization_options=optimization_options,
            use_gpu=use_gpu,
            only_onnxruntime=False,
        )
        if model_type == "bert_keras" or model_type == "bert_tf":
            opt_model.use_dynamic_axes()

        model_fusion_statistics[optimized_model_path] = opt_model.get_fused_operator_statistics()

        if precision == Precision.FLOAT16:
            opt_model.convert_float_to_float16(keep_io_types=True)

        opt_model.save_model_to_file(optimized_model_path, use_external_data_format)
    else:
        logger.info(f"Skip optimization since model existed: {optimized_model_path}")


def modelclass_dispatcher(model_name, custom_model_class):
    if custom_model_class is not None:
        if custom_model_class in MODEL_CLASSES:
            return custom_model_class
        else:
            raise Exception("Valid model class: " + " ".join(MODEL_CLASSES))

    if model_name in PRETRAINED_GPT2_MODELS:
        return "GPT2ModelNoPastState"

    import re  # noqa: PLC0415

    if re.search("-squad$", model_name) is not None:
        return "AutoModelForQuestionAnswering"
    elif re.search("-mprc$", model_name) is not None:
        return "AutoModelForSequenceClassification"
    elif re.search("gpt2", model_name) is not None:
        return "AutoModelWithLMHead"

    return "AutoModel"


def load_pretrained_model(model_name, config, cache_dir, custom_model_class, is_tf_model=False):
    model_class_name = modelclass_dispatcher(model_name, custom_model_class)

    if model_class_name == "GPT2ModelNoPastState":
        if is_tf_model:
            return TFGPT2ModelNoPastState.from_pretrained(model_name, config=config, cache_dir=cache_dir)
        else:
            return GPT2ModelNoPastState.from_pretrained(model_name, config=config, cache_dir=cache_dir)

    if is_tf_model:
        model_class_name = "TF" + model_class_name

    transformers_module = __import__("transformers", fromlist=[model_class_name])
    logger.info(f"Model class name: {model_class_name}")
    model_class = getattr(transformers_module, model_class_name)

    return model_class.from_pretrained(model_name, config=config, cache_dir=cache_dir)


def load_pt_model(model_name, model_class, cache_dir, config_modifier):
    config = AutoConfig.from_pretrained(model_name, cache_dir=cache_dir)
    if hasattr(config, "return_dict"):
        config.return_dict = False

    config_modifier.modify(config)

    model = load_pretrained_model(model_name, config=config, cache_dir=cache_dir, custom_model_class=model_class)

    return config, model


def load_tf_model(model_name, model_class, cache_dir, config_modifier):
    config = AutoConfig.from_pretrained(model_name, cache_dir=cache_dir)

    config_modifier.modify(config)
    # Loading tf model from transformers limits the cpu affinity to {0} when KMP_AFFINITY is set
    # Restore the affinity after model loading for expected ORT performance
    affinity_setting = AffinitySetting()
    affinity_setting.get_affinity()
    model = load_pretrained_model(
        model_name,
        config=config,
        cache_dir=cache_dir,
        custom_model_class=model_class,
        is_tf_model=True,
    )
    affinity_setting.set_affinity()

    return config, model


# For test only
def load_pt_model_from_tf(model_name):
    # Note that we could get pt model from tf, but model source and its structure in this case is different from directly using
    # load_pt_model() and load_tf_model() even with the same name. Therefore it should not be used for comparing with them
    from convert_tf_models_to_pytorch import tf2pt_pipeline  # noqa: PLC0415

    config, model = tf2pt_pipeline(model_name)

    return config, model


def validate_and_optimize_onnx(
    model_name,
    use_external_data_format,
    model_type,
    onnx_dir,
    input_names,
    use_gpu,
    precision,
    optimize_info,
    validate_onnx,
    use_raw_attention_mask,
    overwrite,
    config,
    model_fusion_statistics,
    onnx_model_path,
    example_inputs,
    example_outputs_flatten,
    output_names,
    fusion_options,
):
    is_valid_onnx_model = True
    if validate_onnx:
        is_valid_onnx_model = validate_onnx_model(
            onnx_model_path,
            example_inputs,
            example_outputs_flatten,
            use_gpu,
            False,
            output_names,
        )
    if optimize_info.name == OptimizerInfo.NOOPT.name:
        return onnx_model_path, is_valid_onnx_model, config.vocab_size

    if (
        optimize_info.name == OptimizerInfo.BYSCRIPT.name
        or precision == Precision.FLOAT16
        or precision == Precision.INT8
    ):  # Use script (optimizer.py) to optimize
        optimized_model_path = get_onnx_file_path(
            onnx_dir,
            model_name,
            len(input_names),
            True,
            use_gpu,
            precision,
            False,
            use_external_data_format,
        )
        optimize_onnx_model(
            onnx_model_path,
            optimized_model_path,
            model_type,
            config.num_attention_heads,
            config.hidden_size,
            use_gpu,
            precision,
            use_raw_attention_mask,
            overwrite,
            model_fusion_statistics,
            use_external_data_format,
            fusion_options,
        )

        onnx_model_path = optimized_model_path
        if validate_onnx:
            is_valid_onnx_model = validate_onnx_model(
                onnx_model_path,
                example_inputs,
                example_outputs_flatten,
                use_gpu,
                precision == Precision.FLOAT16,
                output_names,
            )

        if precision == Precision.INT8:
            logger.info(f"Quantizing model: {onnx_model_path}")
            QuantizeHelper.quantize_onnx_model(onnx_model_path, onnx_model_path, use_external_data_format)
            logger.info(f"Finished quantizing model: {onnx_model_path}")

    if optimize_info.name == OptimizerInfo.BYORT.name:  # Use OnnxRuntime to optimize
        if is_valid_onnx_model:
            ort_model_path = add_filename_suffix(onnx_model_path, "_ort")
            optimize_onnx_model_by_ort(
                onnx_model_path,
                ort_model_path,
                use_gpu,
                overwrite,
                model_fusion_statistics,
            )

    return (
        onnx_model_path,
        is_valid_onnx_model,
        config.num_labels if model_type in ["vit", "swin"] else config.vocab_size,
    )


def export_onnx_model_from_pt(
    model_name,
    opset_version,
    use_external_data_format,
    model_type,
    model_class,
    config_modifier,
    cache_dir,
    onnx_dir,
    input_names,
    use_gpu,
    precision,
    optimizer_info,
    validate_onnx,
    use_raw_attention_mask,
    overwrite,
    model_fusion_statistics,
    fusion_options,
):
    config, model = load_pt_model(model_name, model_class, cache_dir, config_modifier)
    # config, model = load_pt_model_from_tf(model_name)
    model.cpu()

    example_inputs = None
    max_input_size = None

    if model_type in ["vit", "swin"]:
        image_processor = AutoFeatureExtractor.from_pretrained(model_name, cache_dir=cache_dir)
        data = numpy.random.randint(
            low=0, high=256, size=config.image_size * config.image_size * 3, dtype=numpy.uint8
        ).reshape(config.image_size, config.image_size, 3)

        example_inputs = image_processor(data, return_tensors="pt")
    else:
        tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir=cache_dir)
        max_input_size = tokenizer.model_max_length
        example_inputs = tokenizer.encode_plus("This is a sample input", return_tensors="pt")

    example_inputs = filter_inputs(example_inputs, input_names)

    example_outputs = model(**example_inputs)

    assert isinstance(example_outputs, (list, tuple)), f"type of output is not list or tuple: {type(example_outputs)}"

    # Flatten is needed for gpt2 and distilgpt2.
    example_outputs_flatten = flatten(example_outputs)
    example_outputs_flatten = update_flatten_list(example_outputs_flatten, [])

    onnx_model_path = get_onnx_file_path(
        onnx_dir,
        model_name,
        len(input_names),
        False,
        use_gpu,
        precision,
        False,
        use_external_data_format,
    )

    if overwrite or not os.path.exists(onnx_model_path):
        logger.info(f"Exporting ONNX model to {onnx_model_path}")
        Path(onnx_model_path).parent.mkdir(parents=True, exist_ok=True)

        dynamic_axes = None
        output_names = None

        if model_type in ["vit", "swin"]:
            dynamic_axes, output_names = {key: {0: "pixel_values"} for key in example_inputs}, ["logits"]
        else:
            dynamic_axes, output_names = build_dynamic_axes(example_inputs, example_outputs_flatten)

        replace_torch_functions()
        torch_onnx_export(
            model=model,
            args=tuple(example_inputs.values()),
            f=onnx_model_path,
            input_names=list(example_inputs.keys()),
            output_names=output_names,
            dynamic_axes=dynamic_axes,
            do_constant_folding=True,
            opset_version=opset_version,
            use_external_data_format=use_external_data_format,
        )
        restore_torch_functions()
    else:
        logger.info(f"Skip export since model existed: {onnx_model_path}")

    onnx_model_file, is_valid_onnx_model, vocab_size = validate_and_optimize_onnx(
        model_name,
        use_external_data_format,
        model_type,
        onnx_dir,
        input_names,
        use_gpu,
        precision,
        optimizer_info,
        validate_onnx,
        use_raw_attention_mask,
        overwrite,
        config,
        model_fusion_statistics,
        onnx_model_path,
        example_inputs,
        example_outputs_flatten,
        None,
        fusion_options,
    )

    return onnx_model_file, is_valid_onnx_model, vocab_size, max_input_size


def export_onnx_model_from_tf(
    model_name,
    opset_version,
    use_external_data_format,
    model_type,
    model_class,
    config_modifier,
    cache_dir,
    onnx_dir,
    input_names,
    use_gpu,
    precision,
    optimizer_info,
    validate_onnx,
    use_raw_attention_mask,
    overwrite,
    model_fusion_statistics,
    fusion_options,
):
    # Use CPU to export
    import tensorflow as tf  # noqa: PLC0415

    tf.config.set_visible_devices([], "GPU")

    tokenizer = AutoTokenizer.from_pretrained(model_name, cache_dir=cache_dir)
    # Fix "Using pad_token, but it is not set yet" error.
    if tokenizer.pad_token is None:
        tokenizer.add_special_tokens({"pad_token": "[PAD]"})
    max_input_size = tokenizer.model_max_length

    config, model = load_tf_model(model_name, model_class, cache_dir, config_modifier)
    model.resize_token_embeddings(len(tokenizer))

    example_inputs = tokenizer.encode_plus(
        "This is a sample input",
        return_tensors="tf",
        max_length=max_input_size,
        padding="max_length",
        truncation=True,
    )
    example_inputs = filter_inputs(example_inputs, input_names)

    if config.is_encoder_decoder:
        example_inputs["decoder_input_ids"] = tokenizer.encode_plus(
            "This is a sample input",
            return_tensors="tf",
            max_length=max_input_size,
            padding="max_length",
            truncation=True,
        ).input_ids
    if model_name == "unc-nlp/lxmert-base-uncased":
        example_inputs["visual_feats"] = tf.random.normal([1, 1, config.visual_feat_dim])
        example_inputs["visual_pos"] = tf.random.normal([1, 1, config.visual_pos_dim])

    try:
        # Use no past state for these models
        if config.use_cache:
            config.use_cache = False
    except Exception:
        pass

    example_outputs = model(example_inputs, training=False)
    output_names = None

    # For xlnet models, only compare the last_hidden_state output.
    if model_name == "xlnet-base-cased" or model_name == "xlnet-large-cased":
        output_names = ["last_hidden_state"]
        example_outputs = example_outputs["last_hidden_state"]

    # Flatten is needed for gpt2 and distilgpt2. Output name sorting is needed for tf2onnx outputs to match onnx outputs.
    from tensorflow.python.util import nest  # noqa: PLC0415

    example_outputs_flatten = nest.flatten(example_outputs)

    onnx_model_path = get_onnx_file_path(
        onnx_dir,
        model_name,
        len(input_names),
        False,
        use_gpu,
        precision,
        False,
        use_external_data_format,
    )
    tf_internal_model_path = onnx_model_path[:-5] if use_external_data_format else onnx_model_path

    if overwrite or not os.path.exists(tf_internal_model_path):
        logger.info(f"Exporting ONNX model to {onnx_model_path}")
        if not use_external_data_format:
            Path(tf_internal_model_path).parent.mkdir(parents=True, exist_ok=True)

        import zipfile  # noqa: PLC0415

        import tf2onnx  # noqa: PLC0415

        tf2onnx.logging.set_level(tf2onnx.logging.ERROR)
        specs = []
        for name, value in example_inputs.items():
            dims = [None] * len(value.shape)
            specs.append(tf.TensorSpec(tuple(dims), value.dtype, name=name))
        _, _ = tf2onnx.convert.from_keras(
            model,
            input_signature=tuple(specs),
            opset=opset_version,
            large_model=use_external_data_format,
            output_path=tf_internal_model_path,
        )
        if use_external_data_format:
            # need to unpack the zip for run_onnxruntime()
            with zipfile.ZipFile(tf_internal_model_path, "r") as z:
                z.extractall(os.path.dirname(tf_internal_model_path))
            tf_internal_model_path = os.path.join(os.path.dirname(tf_internal_model_path), "__MODEL_PROTO.onnx")
            if os.path.exists(onnx_model_path):
                os.remove(onnx_model_path)
            os.rename(tf_internal_model_path, onnx_model_path)

    else:
        logger.info(f"Skip export since model existed: {onnx_model_path}")

    model_type = model_type + "_tf"
    optimized_onnx_path, is_valid_onnx_model, vocab_size = validate_and_optimize_onnx(
        model_name,
        use_external_data_format,
        model_type,
        onnx_dir,
        input_names,
        use_gpu,
        precision,
        optimizer_info,
        validate_onnx,
        use_raw_attention_mask,
        overwrite,
        config,
        model_fusion_statistics,
        onnx_model_path,
        example_inputs,
        example_outputs_flatten,
        output_names,
        fusion_options,
    )

    return (
        optimized_onnx_path,
        is_valid_onnx_model,
        vocab_size,
        max_input_size,
    )
