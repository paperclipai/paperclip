#!/usr/bin/env python3
"""Messlauf: Qwen-Image 2512 + Turbo-LoRA (2 Steps) auf dem laufenden ComfyUI.

Misst kalten Start (Modelle von Platte) und warmen Lauf (Modelle im Speicher).
"""
import json, time, urllib.request, urllib.error, uuid, sys

BASE = "http://127.0.0.1:8188"
UNET = "qwen_image_2512_fp8_e4m3fn.safetensors"
CLIP = "qwen_2.5_vl_7b_fp8_scaled.safetensors"
VAE = "qwen_image_vae.safetensors"
LORA = "Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors"
PROMPT = ("Ein Hirsch im Morgennebel auf einer Lichtung, fotorealistisch, "
          "kaltes Gegenlicht, feine Nebelschwaden, Tiefenschaerfe")


def get(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read())


def clip_type():
    info = get("/object_info/CLIPLoader")
    opts = info["CLIPLoader"]["input"]["required"]["type"][0]
    for cand in ("qwen_image", "qwen_image_edit", "qwen"):
        if cand in opts:
            return cand
    print("CLIPLoader-Typen:", opts)
    sys.exit("Kein qwen-Typ in CLIPLoader gefunden.")


def workflow(ctype, seed, width=1024, height=1024, steps=2):
    return {
        "1": {"class_type": "UNETLoader",
              "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader",
              "inputs": {"clip_name": CLIP, "type": ctype}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "LoraLoaderModelOnly",
              "inputs": {"model": ["1", 0], "lora_name": LORA, "strength_model": 1.0}},
        "5": {"class_type": "ModelSamplingAuraFlow",
              "inputs": {"model": ["4", 0], "shift": 3.1}},
        "6": {"class_type": "CLIPTextEncode",
              "inputs": {"text": PROMPT, "clip": ["2", 0]}},
        "7": {"class_type": "CLIPTextEncode",
              "inputs": {"text": "", "clip": ["2", 0]}},
        "8": {"class_type": "EmptySD3LatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "9": {"class_type": "KSampler",
              "inputs": {"model": ["5", 0], "seed": seed, "steps": steps, "cfg": 1.0,
                         "sampler_name": "euler", "scheduler": "simple",
                         "positive": ["6", 0], "negative": ["7", 0],
                         "latent_image": ["8", 0], "denoise": 1.0}},
        "10": {"class_type": "VAEDecode",
               "inputs": {"samples": ["9", 0], "vae": ["3", 0]}},
        "11": {"class_type": "SaveImage",
               "inputs": {"images": ["10", 0], "filename_prefix": "whitestag-bench"}},
    }


def run(ctype, seed, label):
    body = json.dumps({"prompt": workflow(ctype, seed),
                       "client_id": uuid.uuid4().hex}).encode()
    req = urllib.request.Request(BASE + "/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            pid = json.loads(r.read())["prompt_id"]
    except urllib.error.HTTPError as e:
        sys.exit(f"{label}: /prompt HTTP {e.code}: {e.read().decode()[:800]}")
    while time.time() - t0 < 900:
        time.sleep(2)
        hist = get(f"/history/{pid}")
        if pid not in hist:
            continue
        entry = hist[pid]
        st = entry.get("status", {})
        if st.get("completed"):
            dt = time.time() - t0
            imgs = [i for o in entry["outputs"].values() for i in o.get("images", [])]
            name = imgs[0]["filename"] if imgs else "?"
            print(f"{label}: {dt:.1f} s  -> {name}")
            return dt
        if st.get("status_str") == "error":
            sys.exit(f"{label}: Fehler {json.dumps(st)[:800]}")
    sys.exit(f"{label}: Zeitueberschreitung")


ct = clip_type()
print(f"CLIPLoader-Typ: {ct}")
cold = run(ct, 42, "kalt (Modelle von Platte)")
warm = run(ct, 43, "warm (Modelle im Speicher)")
print(f"\nErgebnis: kalt {cold:.1f} s, warm {warm:.1f} s")
