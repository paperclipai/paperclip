#!/usr/bin/env python3
"""
WSL2 patches for vLLM ROCm — applied at container startup.

Patch 1: Force is_rocm=True in platforms/__init__.py
  vLLM uses amdsmi to detect ROCm, but amdsmi requires /dev/kfd which
  doesn't exist in WSL2. Hardcoding is_rocm=True tells vLLM to use the
  ROCm platform without amdsmi detection.

Patch 2: Replace warning_once() in platforms/rocm.py with warning()
  _get_gcn_arch() catches amdsmi failures and calls logger.warning_once(),
  which imports from vllm.distributed (to check if it's the first rank).
  This triggers a circular import of current_platform while it's still
  being resolved — crashing on import. warning() is standard logging
  and has no such special import.

Patch 3: Wrap torch.cuda fallback in _get_gcn_arch()
  After amdsmi fails, vLLM falls back to torch.cuda.get_device_properties()
  to read gcnArchName. In WSL2 Docker, torch.cuda init also fails ("No HIP
  GPUs are available"). Return PYTORCH_ROCM_ARCH env var (gfx1100) instead.
"""
import os
import sys

vllm_dir = os.path.dirname(__import__('vllm').__file__)
print(f"vLLM dir: {vllm_dir}", flush=True)

# ---------------------------------------------------------------------------
# Patch 1: platforms/__init__.py — force ROCm platform
# ---------------------------------------------------------------------------
init_path = os.path.join(vllm_dir, 'platforms', '__init__.py')
with open(init_path) as f:
    code = f.read()
if 'is_rocm = False' in code:
    code = code.replace('is_rocm = False', 'is_rocm = True')
    with open(init_path, 'w') as f:
        f.write(code)
    print(f"Patch 1 applied: {init_path}", flush=True)
else:
    print(f"Patch 1 skipped (already applied or unexpected content): {init_path}", flush=True)

# ---------------------------------------------------------------------------
# Patch 2: platforms/rocm.py — fix circular import via warning_once
# ---------------------------------------------------------------------------
rocm_path = os.path.join(vllm_dir, 'platforms', 'rocm.py')
with open(rocm_path) as f:
    code = f.read()
if 'logger.warning_once(' in code:
    code = code.replace('logger.warning_once(', 'logger.warning(')
    with open(rocm_path, 'w') as f:
        f.write(code)
    print(f"Patch 2 applied: {rocm_path}", flush=True)
else:
    print(f"Patch 2 skipped (already applied or unexpected content): {rocm_path}", flush=True)

# ---------------------------------------------------------------------------
# Patch 3: platforms/rocm.py — fall back to PYTORCH_ROCM_ARCH env var
#   when torch.cuda is also unavailable (WSL2 Docker without /dev/kfd)
# ---------------------------------------------------------------------------
with open(rocm_path) as f:
    code = f.read()

OLD = '    # Ultimate fallback: use torch.cuda (will initialize CUDA)\n    return torch.cuda.get_device_properties("cuda").gcnArchName'
NEW = (
    '    # Ultimate fallback: use torch.cuda (will initialize CUDA)\n'
    '    try:\n'
    '        return torch.cuda.get_device_properties("cuda").gcnArchName\n'
    '    except Exception:\n'
    '        import os as _os\n'
    '        _arch = _os.environ.get("PYTORCH_ROCM_ARCH", "gfx1100")\n'
    '        logger.warning(\n'
    '            "torch.cuda fallback failed; using arch=%s from PYTORCH_ROCM_ARCH", _arch\n'
    '        )\n'
    '        return _arch'
)

if OLD in code:
    code = code.replace(OLD, NEW)
    with open(rocm_path, 'w') as f:
        f.write(code)
    print(f"Patch 3 applied: {rocm_path}", flush=True)
elif 'torch.cuda fallback failed' in code:
    print(f"Patch 3 skipped (already applied): {rocm_path}", flush=True)
else:
    print(f"Patch 3 WARN: target string not found — inspect rocm.py manually: {rocm_path}", flush=True)

print("All patches complete.", flush=True)
