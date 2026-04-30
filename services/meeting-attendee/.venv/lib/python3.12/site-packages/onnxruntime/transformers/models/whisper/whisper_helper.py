# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.  See License.txt in the project root for
# license information.
# --------------------------------------------------------------------------
import json
import logging
import os
from pathlib import Path

import numpy as np
import torch
from convert_generation import add_cache_indirection_to_mha, add_output_qk_to_mha, fix_past_sequence_length
from optimizer import optimize_model
from transformers import AutoTokenizer, WhisperConfig, WhisperForConditionalGeneration, WhisperProcessor
from whisper_decoder import WhisperDecoder
from whisper_encoder import WhisperEncoder
from whisper_encoder_decoder_init import WhisperEncoderDecoderInit
from whisper_jump_times import WhisperJumpTimes

from onnxruntime import InferenceSession

logger = logging.getLogger(__name__)

PRETRAINED_WHISPER_MODELS = [
    "whisper-tiny",
    "whisper-tiny.en",
    "whisper-base",
    "whisper-base.en",
    "whisper-small",
    "whisper-small.en",
    "whisper-medium",
    "whisper-medium.en",
    "whisper-large",
    "whisper-large-v2",
    "whisper-large-v3",
    "whisper-large-v3-turbo",
]


class WhisperHelper:
    @staticmethod
    def get_onnx_path(
        output_dir: str,
        model_name_or_path: str,
        suffix: str = "",
        new_folder: bool = False,
    ) -> str:
        """Build onnx path

        Args:
            output_dir (str): output directory
            model_name_or_path (str): pretrained model name, or path to the model checkpoint
            suffix (str, optional): suffix like "_encoder" or "_decoder_fp16" will be appended to file name. Defaults to None.
            new_folder (bool, optional): create a new directory for the model. Defaults to False.
        Returns:
            str: path of onnx model
        """
        model_name = model_name_or_path
        if os.path.isdir(model_name_or_path):
            model_name = Path(model_name_or_path).parts[-1]
        else:
            model_name = model_name.split("/")[-1]

        model_name += suffix

        directory = os.path.join(output_dir, model_name) if new_folder else output_dir
        return os.path.join(directory, model_name + ".onnx")

    @staticmethod
    def save_processing(
        model_name_or_path: str,
        provider: str,
        separate_encoder_and_decoder_init: bool,
        use_decoder_masked_mha: bool,
        output_qk: bool,
        encoder_path: str,
        decoder_path: str,
        output_dir: str,
        cache_dir: str,
    ) -> None:
        config = WhisperConfig.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        config.save_pretrained(output_dir)

        tokenizer = AutoTokenizer.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        tokenizer.save_pretrained(output_dir)

        processor = WhisperProcessor.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        processor.save_pretrained(output_dir)

        # Return early since the next files are for ONNX Runtime GenAI
        if separate_encoder_and_decoder_init:
            return

        audio_processor_cfg = {
            "feature_extraction": {
                "sequence": [
                    {"operation": {"name": "audio_decoder", "type": "AudioDecoder"}},
                    {
                        "operation": {
                            "name": "STFT",
                            "type": "STFTNorm",
                            "attrs": {
                                "n_fft": 400,
                                "frame_length": 400,
                                "hop_length": 160,
                                "_comment": [
                                    0.0,
                                    0.0000616908073425293,
                                    0.0002467334270477295,
                                    0.0005550682544708252,
                                    0.000986635684967041,
                                    0.0015413463115692139,
                                    0.0022190213203430176,
                                    0.0030195116996765137,
                                    0.003942638635635376,
                                    0.004988163709640503,
                                    0.006155818700790405,
                                    0.007445335388183594,
                                    0.008856385946273804,
                                    0.010388582944869995,
                                    0.012041628360748291,
                                    0.013815045356750488,
                                    0.01570841670036316,
                                    0.01772129535675049,
                                    0.019853144884109497,
                                    0.022103488445281982,
                                    0.02447172999382019,
                                    0.026957333087921143,
                                    0.029559612274169922,
                                    0.03227800130844116,
                                    0.03511175513267517,
                                    0.03806024789810181,
                                    0.0411226749420166,
                                    0.044298380613327026,
                                    0.04758647084236145,
                                    0.05098623037338257,
                                    0.05449673533439636,
                                    0.058117181062698364,
                                    0.06184667348861694,
                                    0.0656842589378357,
                                    0.06962898373603821,
                                    0.07367992401123047,
                                    0.0778360664844513,
                                    0.08209633827209473,
                                    0.08645972609519958,
                                    0.09092515707015991,
                                    0.09549149870872498,
                                    0.10015767812728882,
                                    0.10492250323295593,
                                    0.1097848117351532,
                                    0.11474338173866272,
                                    0.11979702115058899,
                                    0.12494447827339172,
                                    0.13018447160720825,
                                    0.1355157196521759,
                                    0.14093685150146484,
                                    0.1464466154575348,
                                    0.15204361081123352,
                                    0.1577264666557312,
                                    0.16349375247955322,
                                    0.16934409737586975,
                                    0.1752760112285614,
                                    0.18128803372383118,
                                    0.18737870454788208,
                                    0.19354650378227234,
                                    0.1997898817062378,
                                    0.20610737800598145,
                                    0.21249738335609436,
                                    0.21895831823349,
                                    0.2254886031150818,
                                    0.23208662867546082,
                                    0.23875075578689575,
                                    0.24547931551933289,
                                    0.2522706985473633,
                                    0.25912320613861084,
                                    0.26603513956069946,
                                    0.27300477027893066,
                                    0.2800304591655731,
                                    0.2871103882789612,
                                    0.29424285888671875,
                                    0.30142611265182495,
                                    0.30865830183029175,
                                    0.31593772768974304,
                                    0.3232625722885132,
                                    0.3306310474872589,
                                    0.3380413055419922,
                                    0.34549152851104736,
                                    0.352979838848114,
                                    0.3605044484138489,
                                    0.3680635094642639,
                                    0.37565508484840393,
                                    0.38327735662460327,
                                    0.3909284174442291,
                                    0.39860638976097107,
                                    0.4063093662261963,
                                    0.41403549909591675,
                                    0.42178282141685486,
                                    0.4295494258403778,
                                    0.43733343482017517,
                                    0.44513291120529175,
                                    0.45294591784477234,
                                    0.46077051758766174,
                                    0.46860480308532715,
                                    0.4764467775821686,
                                    0.4842946231365204,
                                    0.492146372795105,
                                    0.5,
                                    0.5078536868095398,
                                    0.515705406665802,
                                    0.5235532522201538,
                                    0.5313953161239624,
                                    0.5392295718193054,
                                    0.5470541715621948,
                                    0.5548672080039978,
                                    0.562666654586792,
                                    0.5704506635665894,
                                    0.5782172679901123,
                                    0.5859646201133728,
                                    0.5936906933784485,
                                    0.6013936996459961,
                                    0.609071671962738,
                                    0.6167227625846863,
                                    0.6243450045585632,
                                    0.6319366097450256,
                                    0.6394955515861511,
                                    0.6470202207565308,
                                    0.6545085310935974,
                                    0.6619587540626526,
                                    0.6693689823150635,
                                    0.6767374277114868,
                                    0.6840623021125793,
                                    0.691341757774353,
                                    0.6985740065574646,
                                    0.7057572603225708,
                                    0.7128896713256836,
                                    0.719969630241394,
                                    0.7269952893257141,
                                    0.7339649796485901,
                                    0.7408769130706787,
                                    0.7477294206619263,
                                    0.7545207738876343,
                                    0.761249303817749,
                                    0.7679134607315063,
                                    0.774511456489563,
                                    0.7810417413711548,
                                    0.7875027060508728,
                                    0.7938927412033081,
                                    0.800210177898407,
                                    0.8064535856246948,
                                    0.8126214146614075,
                                    0.8187121152877808,
                                    0.8247240781784058,
                                    0.8306560516357422,
                                    0.8365063667297363,
                                    0.8422735929489136,
                                    0.8479564785957336,
                                    0.8535534143447876,
                                    0.8590631484985352,
                                    0.8644843101501465,
                                    0.8698155879974365,
                                    0.8750555515289307,
                                    0.8802030086517334,
                                    0.8852566480636597,
                                    0.8902152180671692,
                                    0.8950775265693665,
                                    0.899842381477356,
                                    0.9045084714889526,
                                    0.9090749025344849,
                                    0.9135403037071228,
                                    0.9179036617279053,
                                    0.9221639633178711,
                                    0.9263200759887695,
                                    0.9303710460662842,
                                    0.9343158006668091,
                                    0.9381533861160278,
                                    0.941882848739624,
                                    0.945503294467926,
                                    0.9490138292312622,
                                    0.9524135589599609,
                                    0.9557017087936401,
                                    0.9588773250579834,
                                    0.961939811706543,
                                    0.9648882746696472,
                                    0.9677220582962036,
                                    0.9704403877258301,
                                    0.9730427265167236,
                                    0.9755282998085022,
                                    0.9778965711593628,
                                    0.9801468849182129,
                                    0.9822787046432495,
                                    0.9842916131019592,
                                    0.9861849546432495,
                                    0.9879584312438965,
                                    0.9896113872528076,
                                    0.9911436438560486,
                                    0.9925546646118164,
                                    0.9938441514968872,
                                    0.9950118064880371,
                                    0.996057391166687,
                                    0.9969804883003235,
                                    0.997780978679657,
                                    0.9984586238861084,
                                    0.999013364315033,
                                    0.9994449615478516,
                                    0.9997532367706299,
                                    0.9999383091926575,
                                    1,
                                    0.9999383091926575,
                                    0.9997532367706299,
                                    0.9994449615478516,
                                    0.999013364315033,
                                    0.9984586238861084,
                                    0.997780978679657,
                                    0.9969804286956787,
                                    0.9960573315620422,
                                    0.9950118064880371,
                                    0.9938441514968872,
                                    0.9925546646118164,
                                    0.9911435842514038,
                                    0.9896113872528076,
                                    0.9879583716392517,
                                    0.9861849546432495,
                                    0.9842915534973145,
                                    0.9822787046432495,
                                    0.9801468253135681,
                                    0.9778964519500732,
                                    0.9755282402038574,
                                    0.9730426073074341,
                                    0.9704403877258301,
                                    0.9677219390869141,
                                    0.9648882150650024,
                                    0.9619396924972534,
                                    0.9588772654533386,
                                    0.9557015895843506,
                                    0.9524134397506714,
                                    0.9490137100219727,
                                    0.9455032348632812,
                                    0.9418827295303345,
                                    0.9381532669067383,
                                    0.9343156814575195,
                                    0.9303709268569946,
                                    0.9263200759887695,
                                    0.9221639633178711,
                                    0.9179036617279053,
                                    0.913540244102478,
                                    0.9090747833251953,
                                    0.9045084714889526,
                                    0.8998422622680664,
                                    0.8950774669647217,
                                    0.8902151584625244,
                                    0.8852565884590149,
                                    0.8802029490470886,
                                    0.8750554919242859,
                                    0.869815468788147,
                                    0.8644842505455017,
                                    0.8590630888938904,
                                    0.853553295135498,
                                    0.8479562997817993,
                                    0.842273473739624,
                                    0.836506187915802,
                                    0.8306558728218079,
                                    0.8247239589691162,
                                    0.8187118768692017,
                                    0.8126212358474731,
                                    0.8064534664154053,
                                    0.8002099990844727,
                                    0.793892502784729,
                                    0.7875025272369385,
                                    0.7810416221618652,
                                    0.7745113372802734,
                                    0.767913281917572,
                                    0.7612491846084595,
                                    0.7545205950737,
                                    0.7477291822433472,
                                    0.7408767342567444,
                                    0.7339648008346558,
                                    0.7269951105117798,
                                    0.7199694514274597,
                                    0.7128894925117493,
                                    0.7057570219039917,
                                    0.6985738277435303,
                                    0.6913415789604187,
                                    0.684062123298645,
                                    0.6767372488975525,
                                    0.6693688035011292,
                                    0.6619585752487183,
                                    0.6545083522796631,
                                    0.6470199823379517,
                                    0.6394953727722168,
                                    0.6319363117218018,
                                    0.6243447661399841,
                                    0.6167224645614624,
                                    0.6090714335441589,
                                    0.601393461227417,
                                    0.5936904549598694,
                                    0.5859643220901489,
                                    0.5782170295715332,
                                    0.5704504251480103,
                                    0.5626664161682129,
                                    0.5548669099807739,
                                    0.5470539331436157,
                                    0.5392293334007263,
                                    0.5313950181007385,
                                    0.5235530138015747,
                                    0.5157051682472229,
                                    0.507853627204895,
                                    0.5,
                                    0.4921463429927826,
                                    0.484294593334198,
                                    0.4764467477798462,
                                    0.46860471367836,
                                    0.4607704281806946,
                                    0.4529458284378052,
                                    0.4451328217983246,
                                    0.437333345413208,
                                    0.42954933643341064,
                                    0.4217827320098877,
                                    0.4140354096889496,
                                    0.4063093066215515,
                                    0.3986063003540039,
                                    0.39092832803726196,
                                    0.3832772672176361,
                                    0.37565499544143677,
                                    0.36806342005729675,
                                    0.3605043888092041,
                                    0.35297977924346924,
                                    0.3454914391040802,
                                    0.338041216135025,
                                    0.33063095808029175,
                                    0.3232625126838684,
                                    0.3159376382827759,
                                    0.3086581826210022,
                                    0.3014259934425354,
                                    0.2942427396774292,
                                    0.28711026906967163,
                                    0.2800303101539612,
                                    0.2730046510696411,
                                    0.2660350203514099,
                                    0.2591230869293213,
                                    0.25227057933807373,
                                    0.24547919631004333,
                                    0.2387506067752838,
                                    0.23208650946617126,
                                    0.22548848390579224,
                                    0.21895819902420044,
                                    0.2124972641468048,
                                    0.2061072587966919,
                                    0.19978976249694824,
                                    0.1935463547706604,
                                    0.18737855553627014,
                                    0.18128788471221924,
                                    0.17527586221694946,
                                    0.1693439483642578,
                                    0.16349363327026367,
                                    0.15772631764411926,
                                    0.15204349160194397,
                                    0.14644649624824524,
                                    0.1409367322921753,
                                    0.13551557064056396,
                                    0.1301843225955963,
                                    0.12494435906410217,
                                    0.11979690194129944,
                                    0.11474326252937317,
                                    0.10978469252586365,
                                    0.10492238402366638,
                                    0.10015755891799927,
                                    0.09549137949943542,
                                    0.09092503786087036,
                                    0.08645960688591003,
                                    0.08209621906280518,
                                    0.07783591747283936,
                                    0.07367980480194092,
                                    0.06962886452674866,
                                    0.06568413972854614,
                                    0.06184655427932739,
                                    0.0581170916557312,
                                    0.0544966459274292,
                                    0.05098611116409302,
                                    0.04758638143539429,
                                    0.044298261404037476,
                                    0.04112258553504944,
                                    0.038060128688812256,
                                    0.03511166572570801,
                                    0.03227788209915161,
                                    0.02955952286720276,
                                    0.02695724368095398,
                                    0.024471670389175415,
                                    0.02210339903831482,
                                    0.01985308527946472,
                                    0.017721205949783325,
                                    0.015708357095718384,
                                    0.0138150155544281,
                                    0.012041598558425903,
                                    0.010388582944869995,
                                    0.008856356143951416,
                                    0.007445335388183594,
                                    0.006155818700790405,
                                    0.004988163709640503,
                                    0.003942638635635376,
                                    0.0030195116996765137,
                                    0.0022190213203430176,
                                    0.0015413165092468262,
                                    0.000986635684967041,
                                    0.0005550682544708252,
                                    0.0002467334270477295,
                                    0.0000616908073425293,
                                ],
                            },
                        }
                    },
                    {
                        "operation": {
                            "name": "log_mel_spectrogram",
                            "type": "LogMelSpectrum",
                            "attrs": {"chunk_size": 30, "hop_length": 160, "n_fft": 400, "n_mel": config.num_mel_bins},
                        }
                    },
                ]
            }
        }
        audio_processor_json = json.dumps(audio_processor_cfg, indent=4)

        with open(os.path.join(output_dir, "audio_processor_config.json"), "w") as f:
            f.write(audio_processor_json)

        provider_options = [] if "cpu" in provider else [{f"{provider}": {}}]
        genai_config = {
            "model": {
                "bos_token_id": config.bos_token_id,
                "context_length": config.max_length,
                "decoder": {
                    "session_options": {
                        "log_id": "onnxruntime-genai",
                        "provider_options": provider_options,
                    },
                    "filename": os.path.basename(decoder_path),
                    "head_size": config.d_model // config.decoder_attention_heads,
                    "hidden_size": config.d_model,
                    "inputs": {
                        "input_ids": "input_ids",
                        "past_key_names": "past_key_self_%d",
                        "past_value_names": "past_value_self_%d",
                        "cross_past_key_names": "past_key_cross_%d",
                        "cross_past_value_names": "past_value_cross_%d",
                    },
                    "outputs": {
                        "logits": "logits",
                        "present_key_names": "present_key_self_%d",
                        "present_value_names": "present_value_self_%d",
                    },
                    "num_attention_heads": config.decoder_attention_heads,
                    "num_hidden_layers": config.decoder_layers,
                    "num_key_value_heads": config.decoder_attention_heads,
                },
                "encoder": {
                    "session_options": {
                        "log_id": "onnxruntime-genai",
                        "provider_options": provider_options,
                    },
                    "filename": os.path.basename(encoder_path),
                    "head_size": config.d_model // config.encoder_attention_heads,
                    "hidden_size": config.d_model,
                    "inputs": {"audio_features": "audio_features"},
                    "outputs": {
                        "encoder_hidden_states": "encoder_hidden_states",
                        "cross_present_key_names": "present_key_cross_%d",
                        "cross_present_value_names": "present_value_cross_%d",
                    },
                    "num_attention_heads": config.encoder_attention_heads,
                    "num_hidden_layers": config.encoder_layers,
                    "num_key_value_heads": config.encoder_attention_heads,
                },
                "eos_token_id": config.eos_token_id,
                "pad_token_id": config.pad_token_id,
                "type": "whisper",
                "vocab_size": config.vocab_size,
            },
            "search": {
                "diversity_penalty": 0.0,
                "do_sample": False,
                "early_stopping": True,
                "length_penalty": 1.0,
                "max_length": config.max_length,
                "min_length": 0,
                "no_repeat_ngram_size": 0,
                "num_beams": 1,
                "num_return_sequences": 1,
                "past_present_share_buffer": use_decoder_masked_mha,
                "repetition_penalty": 1.0,
                "temperature": 1.0,
                "top_k": 1,
                "top_p": 1.0,
            },
        }

        # Requirements for the DMMHA kernel:
        # - Buffer sharing = true
        # - New input: past_sequence_length
        # - New input: cache_indirection
        # Otherwise, buffer sharing should be false and the new inputs should not be added
        # for beam search to work in ORT GenAI.
        if use_decoder_masked_mha:
            genai_config["model"]["decoder"]["inputs"].update(
                {
                    "past_sequence_length": "past_sequence_length",
                    "cache_indirection": "cache_indirection",
                }
            )

        if output_qk:
            genai_config["model"]["decoder"]["outputs"].update(
                {
                    "output_cross_qk_names": "output_cross_qk_%d",
                }
            )

        with open(os.path.join(output_dir, "genai_config.json"), "w") as f:
            json.dump(genai_config, f, indent=4)

    @staticmethod
    def load_model(
        model_name_or_path: str,
        model_impl: str,
        cache_dir: str,
        device: torch.device,
        dtype: torch.dtype,
        merge_encoder_and_decoder_init: bool = True,
        no_beam_search_op: bool = False,
        output_qk: bool = False,
    ) -> dict[str, torch.nn.Module]:
        """Load model given a pretrained name or path, then build models for ONNX conversion.

        Args:
            model_name_or_path (str): pretrained model name or path
            model_impl (str): library to load model from
            cache_dir (str): cache directory
            device (torch.device): device to run the model
            dtype (torch.dtype): dtype to run the model
            merge_encoder_and_decoder_init (bool, optional): Whether merge encoder and decoder initialization into one ONNX model. Defaults to True.
            no_beam_search_op (bool, optional): Whether to use beam search op or not. Defaults to False.
            output_qk (bool, optional): Whether to output QKs to calculate batched jump times for word-level timestamps. Defaults to False.
        Returns:
            Dict[str, torch.nn.Module]: mapping from name to modules for ONNX conversion.
        """
        # Load PyTorch model
        if model_impl == "hf":
            # Load from Hugging Face
            model = WhisperForConditionalGeneration.from_pretrained(
                model_name_or_path, cache_dir=cache_dir, attn_implementation="eager"
            )
        else:
            # Load from OpenAI
            import whisper  # noqa: PLC0415

            if not os.path.exists(model_name_or_path):
                name_or_path = model_name_or_path.split("/")[-1][8:]
            else:
                name_or_path = model_name_or_path
            model = whisper.load_model(name_or_path, device, download_root=cache_dir, in_memory=True)

        # Set PyTorch model properties
        model.eval().to(device=device)
        if model_impl == "hf":
            model.to(dtype=dtype)
        config = WhisperConfig.from_pretrained(model_name_or_path, cache_dir=cache_dir)

        # Load each component of PyTorch model
        decoder = WhisperDecoder(config, model, model_impl, no_beam_search_op).eval()
        components = {"decoder": decoder}
        if merge_encoder_and_decoder_init:
            encoder_decoder_init = WhisperEncoderDecoderInit(config, model, model_impl, no_beam_search_op).eval()
            components.update({"encoder": encoder_decoder_init})
        else:
            encoder = WhisperEncoder(config, model, model_impl).eval()
            components.update({"encoder": encoder, "decoder_init": decoder})

        if output_qk:
            batched_jump_times = WhisperJumpTimes(config, device, cache_dir).eval()
            components.update({"jump_times": batched_jump_times})
        return components

    @staticmethod
    def export_onnx(
        model: WhisperEncoder | WhisperEncoderDecoderInit | WhisperDecoder,
        onnx_model_path: str,
        provider: str,
        verbose: bool,
        use_external_data_format: bool,
        use_fp16_inputs: bool,
        use_int32_inputs: bool,
        use_encoder_hidden_states: bool,
        use_kv_cache_inputs: bool,
    ):
        """Export model component to ONNX

        Args:
            model (class): PyTorch class to export
            onnx_model_path (str): path to save ONNX model
            provider (str): provider to use for verifying parity on ONNX model
            verbose (bool): print verbose information.
            use_external_data_format (bool): use external data format or not.
            use_fp16_inputs (bool): use float16 inputs for the audio_features, encoder_hidden_states, logits, and KV caches.
            use_int32_inputs (bool): use int32 inputs for the decoder_input_ids.
            use_encoder_hidden_states (bool): use encoder_hidden_states as model input for decoder-init/decoder-without-past models.
            use_kv_cache_inputs (bool): use KV caches as model inputs for decoder-with-past models.
        """
        if isinstance(model, WhisperEncoder):
            model.export_onnx(
                onnx_model_path,
                provider,
                verbose,
                use_external_data_format,
                use_fp16_inputs,
            )
        elif isinstance(model, WhisperEncoderDecoderInit):
            model.export_onnx(
                onnx_model_path,
                provider,
                verbose,
                use_external_data_format,
                use_fp16_inputs,
                use_int32_inputs,
            )
        elif isinstance(model, WhisperDecoder):
            model.export_onnx(
                onnx_model_path,
                provider,
                verbose,
                use_external_data_format,
                use_fp16_inputs,
                use_int32_inputs,
                use_encoder_hidden_states,
                use_kv_cache_inputs,
            )
        elif isinstance(model, WhisperJumpTimes):
            model.export_onnx(
                onnx_model_path,
                provider,
                verbose,
                use_external_data_format,
                use_fp16_inputs,
                use_int32_inputs,
            )
        else:
            raise ValueError(f"Unknown instance for model detected: {type(model)}")

    @staticmethod
    def optimize_onnx(
        onnx_model_path: str,
        optimized_model_path: str,
        is_float16: bool,
        num_attention_heads: int,
        hidden_size: int,
        num_decoder_layers: int,
        use_external_data_format: bool = False,
        use_gpu: bool = False,
        provider: str = "cpu",
        is_decoder: bool = False,
        no_beam_search_op: bool = False,
        use_decoder_masked_mha: bool = False,
        output_qk: bool = False,
    ):
        """Optimize ONNX model with an option to convert it to use mixed precision."""

        from fusion_options import FusionOptions  # noqa: PLC0415

        optimization_options = FusionOptions("bart")
        optimization_options.use_multi_head_attention = True
        optimization_options.disable_multi_head_attention_bias = False

        m = optimize_model(
            onnx_model_path,
            model_type="bart",
            num_heads=num_attention_heads,
            hidden_size=hidden_size,
            opt_level=0,
            optimization_options=optimization_options,
            use_gpu=use_gpu,
            only_onnxruntime=False,
        )

        # Add `past_sequence_length`, `cache_indirection`, and `output_qk` to `MultiHeadAttention` ops
        if is_decoder and no_beam_search_op:
            if use_decoder_masked_mha:
                # FP16 CUDA, FP32 CUDA, and FP32 CPU use the `DecoderMaskedMultiHeadAttention` kernel
                # via `MultiHeadAttention`, which requires the `past_sequence_length` and
                # `cache_indirection` inputs
                m, past_seq_len_name = fix_past_sequence_length(m)
                m = add_cache_indirection_to_mha(m, past_seq_len_name)

            if output_qk:
                m = add_output_qk_to_mha(m, skip_node_idxs=list(range(0, 2 * num_decoder_layers, 2)))

        m.save_model_to_file(optimized_model_path, use_external_data_format, all_tensors_to_one_file=True)

    @staticmethod
    def pt_transcription_for_verify_onnx(
        processor: WhisperProcessor,
        pt_model: torch.nn.Module,
        device: torch.device,
        batch_size: int = 1,
        prompt_mode: bool = False,
    ):
        # Try to import `datasets` pip package
        try:
            from datasets import load_dataset  # noqa: PLC0415
        except Exception as e:
            logger.error(f"An error occurred while importing `datasets`: {e}", exc_info=True)  # noqa: G201
            install_cmd = "pip install datasets"
            logger.warning(f"Could not import `datasets`. Attempting to install `datasets` via `{install_cmd}`.")
            os.system(install_cmd)

        from datasets import load_dataset  # noqa: PLC0415

        ds = load_dataset("hf-internal-testing/librispeech_asr_dummy", "clean", split="validation")
        input_features_ = []
        if batch_size == 1:
            input_features = processor([ds[0]["audio"]["array"]], return_tensors="pt").input_features
        else:
            input_features_ = [
                processor([ds[3]["audio"]["array"]], return_tensors="pt").input_features,
                processor([ds[3]["audio"]["array"]], return_tensors="pt").input_features,
            ]
            assert len(input_features_) == batch_size
            input_features = torch.cat((input_features_[0], input_features_[1]))

        max_length, min_length, num_beams, num_return_sequences = 30, 0, 1, 1
        length_penalty, repetition_penalty = 1.0, 1.0
        inputs = {
            "input_features": input_features.to(device),
            "max_length": max_length,
            "min_length": min_length,
            "num_beams": num_beams,
            "num_return_sequences": num_return_sequences,
            "length_penalty": length_penalty,
            "repetition_penalty": repetition_penalty,
            "early_stopping": True,
            "use_cache": True,
        }

        if prompt_mode:
            prompts = ["John has doubts", "Maria has grave doubts"]
            prompt_ids = [processor.get_prompt_ids(p) for p in prompts]
            pt_transcription = []
            pt_outputs = []
            # The looping for model.generate is necessary here due to the limitation as per
            # https://huggingface.co/docs/transformers/model_doc/whisper#transformers.WhisperForConditionalGeneration.generate.prompt_ids
            # prompt_ids input requires a tensor of rank 1
            for i in range(batch_size):
                inputs["prompt_ids"] = torch.from_numpy(prompt_ids[i]).to(device=device)
                inputs["input_features"] = input_features_[i].to(device)
                pt_output = pt_model.generate(**inputs).detach().cpu().numpy()
                pt_outputs.append(pt_output)
                pt_transcription.append(processor.batch_decode(pt_output, skip_special_tokens=True)[0])
            inputs["input_features"] = input_features
            del inputs["prompt_ids"]
        else:
            prompt_ids = []
            pt_outputs = pt_model.generate(**inputs).detach().cpu().numpy()
            pt_transcription = [processor.batch_decode(pt_outputs, skip_special_tokens=True)[0]]
            pt_outputs = list(pt_outputs)
        del inputs["early_stopping"]
        del inputs["use_cache"]
        return inputs, pt_transcription, pt_outputs, prompt_ids

    @staticmethod
    def select_transcription_options(
        batch_size: int,
        prompt_mode: bool,
    ):
        if batch_size > 1 and prompt_mode:
            expected_transcription_no_comma_prompt1 = " John has doubts whether Sir Frederick Layton's work is really Greek after all and can discover in it but little of Rocky I"
            expected_transcription_misspelled_prompt1 = " John has doubts whether Sir Frederick Latins work is really Greek after all and can discover in it but little of Rocky I"
            expected_transcription_no_comma_prompt2 = " Maria has grave doubts whether Sir Frederick Layton's work is really Greek after all and can discover in it but little of Rocky"
            expected_transcription_misspelled_prompt2 = " Maria has grave doubts whether Sir Frederick Latins work is really Greek after all and can discover in it but little of Rocky I"
            expected_transcription_options = {
                expected_transcription_no_comma_prompt1,
                expected_transcription_no_comma_prompt2,
                expected_transcription_misspelled_prompt1,
                expected_transcription_misspelled_prompt2,
            }
        else:
            expected_transcription_no_comma = (
                " Mr. Quilter is the apostle of the middle classes and we are glad to welcome his gospel."
            )
            expected_transcription_with_comma = (
                " Mr. Quilter is the apostle of the middle classes, and we are glad to welcome his gospel."
            )
            expected_transcription_with_quote_and_comma = (
                ' "Mr. Quilter is the apostle of the middle classes, and we are glad to welcome his gospel.'
            )
            expected_transcription_options = {
                expected_transcription_no_comma,
                expected_transcription_with_comma,
                expected_transcription_with_quote_and_comma,
            }
        return expected_transcription_options

    @staticmethod
    def get_outputs(
        pt_outputs: np.ndarray,
        ort_outputs: np.ndarray,
        i: int,
    ):
        """Get PyTorch and ONNX Runtime output token ids at index i"""
        pt_output, ort_output = pt_outputs[i], ort_outputs[i]
        pt_shape, ort_shape = pt_output.shape, ort_output.shape

        # Hugging Face impl. + Beam Search op: PyTorch = (26,) and ORT = (30,)
        # OpenAI impl. + Beam Search op: PyTorch = (1, 30) and ORT = (30,)
        if pt_shape != ort_shape:
            if len(pt_shape) > 1:
                pt_output = pt_output[0]
                pt_shape = pt_output.shape
            if len(ort_shape) > 1:
                ort_output = ort_output[0]
                ort_shape = ort_output.shape
            if pt_shape[0] != ort_shape[0]:
                min_len = min(pt_shape[0], ort_shape[0])
                pt_output = pt_output[:min_len]
                ort_output = ort_output[:min_len]

        assert pt_output.shape == ort_output.shape
        return pt_output, ort_output

    @staticmethod
    def verify_onnx(
        model_name_or_path: str,
        cache_dir: str,
        ort_session: InferenceSession,
        device: torch.device,
        batch_size: int = 1,
        prompt_mode: bool = False,
    ):
        """Compare the result from PyTorch and ONNX Runtime to verify the ONNX model is good."""
        pt_model = WhisperForConditionalGeneration.from_pretrained(
            model_name_or_path, cache_dir=cache_dir, attn_implementation="eager"
        ).to(device)
        processor = WhisperProcessor.from_pretrained(model_name_or_path, cache_dir=cache_dir)
        config = WhisperConfig.from_pretrained(model_name_or_path, cache_dir=cache_dir)

        inputs, pt_transcription, pt_outputs, decoder_prompt_ids = WhisperHelper.pt_transcription_for_verify_onnx(
            processor,
            pt_model,
            device,
            batch_size=batch_size,
            prompt_mode=prompt_mode,
        )

        start_id = [config.decoder_start_token_id]  # ex: [50258]
        prompt_ids = processor.get_decoder_prompt_ids(language="english", task="transcribe")
        prompt_ids = [token[1] for token in prompt_ids]  # ex: [50259, 50358, 50363]
        forced_decoder_ids = start_id + prompt_ids  # ex: [50258, 50259, 50358, 50363]

        ort_names = [entry.name for entry in ort_session.get_inputs()]
        ort_dtypes = [entry.type for entry in ort_session.get_inputs()]
        ort_to_np = {
            "tensor(float)": np.float32,
            "tensor(float16)": np.float16,
            "tensor(int64)": np.int64,
            "tensor(int32)": np.int32,
            "tensor(int8)": np.int8,
            "tensor(uint8)": np.uint8,
        }

        use_extra_decoding_ids = "extra_decoding_ids" in ort_names
        for name, dtype in zip(ort_names, ort_dtypes, strict=False):
            if name == "input_features":
                inputs[name] = inputs[name].detach().cpu().numpy()
            elif name == "vocab_mask":
                inputs[name] = np.ones(config.vocab_size, dtype=ort_to_np[dtype])
            elif name == "prefix_vocab_mask":
                inputs[name] = np.ones((batch_size, config.vocab_size), dtype=ort_to_np[dtype])
            elif name == "decoder_input_ids":
                if not prompt_mode:
                    raw_input_ids = [start_id] if use_extra_decoding_ids else [forced_decoder_ids]
                    inputs[name] = np.array(raw_input_ids, dtype=ort_to_np[dtype])
                else:
                    # This logic handles the scenario for when prompts are not of the same size
                    # For example if our prompt ids are [p1_id_1, p1_id_2] and [p2_id_1]
                    # The final decoder_input_ids will look as such after padding
                    # [prev_token, p1_id_1, p1_id_2, start_token, lang_token, transcribe_token]
                    # [prev_token, p2_id_1, PAD_TOKEN, start_token, lang_token, transcribe_token]
                    ort_prompts = []
                    for i in range(batch_size):
                        ort_prompts.append(decoder_prompt_ids[i].tolist())
                    max_len = max(len(p) for p in ort_prompts)
                    padded_prompts = []
                    for p in ort_prompts:
                        padded_prompt = [*p, *([config.pad_token_id] * (max_len - len(p)))]
                        padded_prompts.append(padded_prompt + forced_decoder_ids)
                    inputs[name] = np.array(padded_prompts, dtype=ort_to_np[dtype])
            elif name == "logits_processor":
                inputs[name] = np.array([1], dtype=ort_to_np[dtype])
            elif name == "cross_qk_layer_head":
                inputs[name] = np.array([[0, 0]], dtype=ort_to_np[dtype])
            elif name == "extra_decoding_ids":
                inputs[name] = np.repeat(np.array([prompt_ids], dtype=ort_to_np[dtype]), batch_size, 0)
            elif name == "temperature":
                inputs[name] = np.array([1.0], dtype=ort_to_np[dtype])
            else:
                inputs[name] = np.array([inputs[name]], dtype=ort_to_np[dtype])

        ort_outputs = ort_session.run(None, inputs)[0][:, 0, :]
        ort_transcription = processor.batch_decode(ort_outputs, skip_special_tokens=True)
        expected_transcription_options = WhisperHelper.select_transcription_options(batch_size, prompt_mode)

        parity = 1
        for i in range(batch_size):
            pt_output, ort_output = WhisperHelper.get_outputs(pt_outputs, ort_outputs, i)

            # Check if token ids match
            parity *= np.allclose(pt_output, ort_output)

            # Check if transcribed outputs match
            parity *= (
                pt_transcription[i] in expected_transcription_options
                and ort_transcription[i] in expected_transcription_options
            )
        max_diff = 0

        if not parity:
            for i in range(batch_size):
                pt_output, ort_output = WhisperHelper.get_outputs(pt_outputs, ort_outputs, i)
                diff = pt_output - ort_output

                max_diff_i = max(diff.min(), diff.max(), key=abs)
                max_diff = max(max_diff, max_diff_i)

        if max_diff != 0:
            logger.warning(f"PyTorch outputs: {pt_transcription}")
            logger.warning(f"ONNX Runtime outputs: {ort_transcription}")

        return 0
