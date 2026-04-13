# vLLM Setup — Gemma 4 26B-A4B (AMD ROCm / WSL2)

Serves `google/gemma-4-26B-A4B-it` via OpenAI-compatible API on port 8000.
Runs locally using AMD Radeon RX 7900 XTX (RDNA3/gfx1100) via Docker on WSL2.

Accessible from paperclip-server as `http://host.docker.internal:8000/v1`.

## Prerequisites (one-time, in WSL2)

ROCm must be installed in WSL2 and `/dev/dxg` must be accessible:

```bash
# 1. Install ROCm in WSL2 (Ubuntu 22.04 recommended — 24.04 has known issues)
wget https://repo.radeon.com/amdgpu-install/7.2.1/ubuntu/noble/amdgpu-install_7.2.1.70201-1_all.deb
sudo apt install ./amdgpu-install_7.2.1.70201-1_all.deb
sudo apt update && sudo apt install rocm
sudo usermod -a -G render,video $LOGNAME

# 2. Restart WSL2 (from PowerShell)
wsl --shutdown

# 3. Verify GPU visible
rocminfo | grep gfx1100       # should show your GPU
ls /dev/dxg                    # must exist (WSL2 AMD device)
```

## Start vLLM

```bash
# From C:\Users\User\paperclip\docker\vllm\  (or /mnt/c/... in WSL2)
export HF_TOKEN=your_hf_token_here

docker compose up -d
docker compose logs -f vllm    # watch startup — first run downloads model (~50GB)
```

## Verify

```bash
curl http://localhost:8000/health
curl http://localhost:8000/v1/models
```

## Internal URL (from paperclip-server container)

```
http://host.docker.internal:8000/v1
```

## Anvil harness config (~/.paperclip/harness/config.toml)

```toml
[provider]
backend = "vllm"
model = "google/gemma-4-26B-A4B-it"
max_tokens = 32768
base_url = "http://host.docker.internal:8000/v1"
```

## Key parameters

| Parameter | Value | Notes |
|---|---|---|
| Image | `vllm/vllm-openai-rocm:gemma4` | Gemma4-specific ROCm build |
| Device (WSL2) | `/dev/dxg` | WSL2 AMD path — not `/dev/kfd` |
| VLLM_USE_TRITON_FLASH_ATTN | `0` | Required: Triton FA buggy on RDNA3 |
| HSA_OVERRIDE_GFX_VERSION | not set | Not needed for discrete RX 7900 XTX (gfx1100 officially supported) |
| PYTORCH_ROCM_ARCH | `gfx1100` | Explicit RDNA3 target |
| GPU_MAX_HW_QUEUES | `1` | Stability on RDNA3 |
| max_model_len | `32768` | Total context window (input+output) |
| max_tokens (requests) | `32768` | Output budget per request |
| dtype | `float16` | Saves ~10% VRAM vs bfloat16 |
| gpu_memory_utilization | `0.90` | ~21.6 GB of 24 GB VRAM |
| tool-call-parser | `gemma4` | Required for tool calling |
| reasoning-parser | `gemma4` | Strips internal reasoning from output |

## Troubleshooting

| Issue | Fix |
|---|---|
| `/dev/dxg` not found | ROCm not installed in WSL2 — follow Prerequisites above |
| `UnspecifiedPlatform` error | AMD SMI missing — handled by entrypoint (`pip install /opt/rocm/share/amd_smi`) |
| OOM at 32768 | Reduce `--max-model-len 16384` in docker-compose.yml command |
| Model crashes on start | Disable AMD Instant Replay in Adrenalin settings |
| GPU not detected | May need `sed` platform patch — see KB: `topics/ml-infra/vllm-rocm-amd` |
| Structured output broken | Known bug: `--reasoning-parser gemma4` disables xgrammar when `enable_thinking=false` (vllm#39130) |

## Known RDNA3 Limitations

- No FP8 quantization (requires MI300+)
- No bitsandbytes quantization
- No multi-GPU (WSL2 Microsoft limitation)
- Triton Flash Attention buggy — disabled via `VLLM_USE_TRITON_FLASH_ATTN=0`
