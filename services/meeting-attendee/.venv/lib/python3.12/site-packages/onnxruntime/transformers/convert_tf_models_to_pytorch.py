# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------

import glob
import os

import requests

TFMODELS = {
    "bert-base-uncased": (
        "bert",
        "BertConfig",
        "",
        "https://storage.googleapis.com/bert_models/2018_10_18/uncased_L-12_H-768_A-12.zip",
    ),
    "bert-base-cased": (
        "bert",
        "BertConfig",
        "",
        "https://storage.googleapis.com/bert_models/2019_05_30/wwm_cased_L-24_H-1024_A-16.zip",
    ),
    "bert-large-uncased": (
        "bert",
        "BertConfig",
        "",
        "https://storage.googleapis.com/bert_models/2018_10_18/uncased_L-24_H-1024_A-16.zip",
    ),
    "albert-base": (
        "albert",
        "AlbertConfig",
        "",
        "https://storage.googleapis.com/albert_models/albert_base_v1.tar.gz",
    ),
    "albert-large": (
        "albert",
        "AlbertConfig",
        "",
        "https://storage.googleapis.com/albert_models/albert_large_v1.tar.gz",
    ),
    "gpt-2-117M": (
        "gpt2",
        "GPT2Config",
        "GPT2Model",
        "https://storage.googleapis.com/gpt-2/models/117M",
    ),
    "gpt-2-124M": (
        "gpt2",
        "GPT2Config",
        "GPT2Model",
        "https://storage.googleapis.com/gpt-2/models/124M",
    ),
}


def download_compressed_file(tf_ckpt_url, ckpt_dir):
    r = requests.get(tf_ckpt_url)
    compressed_file_name = tf_ckpt_url.split("/")[-1]
    compressed_file_dir = os.path.join(ckpt_dir, compressed_file_name)
    with open(compressed_file_dir, "wb") as f:
        f.write(r.content)
    return compressed_file_dir


def get_ckpt_prefix_path(ckpt_dir):
    # get prefix
    sub_folder_dir = None
    for o in os.listdir(ckpt_dir):
        sub_folder_dir = os.path.join(ckpt_dir, o)
        break
    if os.path.isfile(sub_folder_dir):
        sub_folder_dir = ckpt_dir
    unique_file_name = str(glob.glob(sub_folder_dir + "/*data-00000-of-00001"))
    prefix = (unique_file_name.rpartition(".")[0]).split("/")[-1]

    return os.path.join(sub_folder_dir, prefix)


def download_tf_checkpoint(model_name, tf_models_dir="tf_models"):
    import pathlib  # noqa: PLC0415

    base_dir = os.path.join(pathlib.Path(__file__).parent.absolute(), tf_models_dir)
    ckpt_dir = os.path.join(base_dir, model_name)

    if not os.path.exists(ckpt_dir):
        os.makedirs(ckpt_dir)

    tf_ckpt_url = TFMODELS[model_name][3]

    import re  # noqa: PLC0415

    if re.search(".zip$", tf_ckpt_url) is not None:
        zip_dir = download_compressed_file(tf_ckpt_url, ckpt_dir)

        # unzip file
        import zipfile  # noqa: PLC0415

        with zipfile.ZipFile(zip_dir, "r") as zip_ref:
            zip_ref.extractall(ckpt_dir)
            os.remove(zip_dir)

        return get_ckpt_prefix_path(ckpt_dir)

    elif re.search(".tar.gz$", tf_ckpt_url) is not None:
        tar_dir = download_compressed_file(tf_ckpt_url, ckpt_dir)

        # untar file
        import tarfile  # noqa: PLC0415

        with tarfile.open(tar_dir, "r") as tar_ref:
            tar_ref.extractall(ckpt_dir)
            os.remove(tar_dir)

        return get_ckpt_prefix_path(ckpt_dir)

    else:
        for filename in [
            "checkpoint",
            "model.ckpt.data-00000-of-00001",
            "model.ckpt.index",
            "model.ckpt.meta",
        ]:
            r = requests.get(tf_ckpt_url + "/" + filename)
            with open(os.path.join(ckpt_dir, filename), "wb") as f:
                f.write(r.content)

        return get_ckpt_prefix_path(ckpt_dir)


def init_pytorch_model(model_name, tf_checkpoint_path):
    config_name = TFMODELS[model_name][1]
    config_module = __import__("transformers", fromlist=[config_name])
    model_config = getattr(config_module, config_name)

    parent_path = tf_checkpoint_path.rpartition("/")[0]
    config_path = glob.glob(parent_path + "/*config.json")
    config = model_config() if len(config_path) == 0 else model_config.from_json_file(str(config_path[0]))

    if not TFMODELS[model_name][2]:
        from transformers import AutoModelForPreTraining  # noqa: PLC0415

        init_model = AutoModelForPreTraining.from_config(config)
    else:
        model_categroy_name = TFMODELS[model_name][2]
        module = __import__("transformers", fromlist=[model_categroy_name])
        model_categroy = getattr(module, model_categroy_name)
        init_model = model_categroy(config)
    return config, init_model


def convert_tf_checkpoint_to_pytorch(model_name, config, init_model, tf_checkpoint_path, is_tf2):
    load_tf_weight_func_name = "load_tf_weights_in_" + TFMODELS[model_name][0]

    module = __import__("transformers", fromlist=[load_tf_weight_func_name])

    if is_tf2 is False:
        load_tf_weight_func = getattr(module, load_tf_weight_func_name)
    else:
        if TFMODELS[model_name][0] != "bert":
            raise NotImplementedError("Only support tf2 ckeckpoint for Bert model")
        from transformers import convert_bert_original_tf2_checkpoint_to_pytorch  # noqa: PLC0415

        load_tf_weight_func = convert_bert_original_tf2_checkpoint_to_pytorch.load_tf2_weights_in_bert

    # Expect transformers team will unify the order of signature in the future
    model = (
        load_tf_weight_func(init_model, config, tf_checkpoint_path)
        if is_tf2 is False
        else load_tf_weight_func(init_model, tf_checkpoint_path, config)
    )
    model.eval()
    return model


def tf2pt_pipeline(model_name, is_tf2=False):
    if model_name not in TFMODELS:
        raise NotImplementedError(model_name + " not implemented")
    tf_checkpoint_path = download_tf_checkpoint(model_name)
    config, init_model = init_pytorch_model(model_name, tf_checkpoint_path)
    model = convert_tf_checkpoint_to_pytorch(model_name, config, init_model, tf_checkpoint_path, is_tf2)
    # Could then use the model in Benchmark
    return config, model


def tf2pt_pipeline_test():
    # For test on linux only
    import logging  # noqa: PLC0415

    import torch  # noqa: PLC0415

    logger = logging.getLogger("")
    for model_name in TFMODELS:
        config, model = tf2pt_pipeline(model_name)
        assert config.model_type is TFMODELS[model_name][0]

        input = torch.randint(low=0, high=config.vocab_size - 1, size=(4, 128), dtype=torch.long)
        try:
            model(input)
        except RuntimeError as e:
            logger.exception(e)


if __name__ == "__main__":
    tf2pt_pipeline_test()
