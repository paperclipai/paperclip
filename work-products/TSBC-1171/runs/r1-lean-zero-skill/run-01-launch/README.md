# TSBC-1176 run 01 launch packet

This directory is the served-tree recovery packet for the clean Hermes run.

Contents:
- `candidate.md` -> pinned TSBC-1171 lean zero-skill candidate
- `prereg.json` -> pinned preregistration
- `suite.json` -> frozen 10-case development suite
- `launch-contract.json` -> exact run contract written by `launch_tsbc_1176_run01.py`

Execution lane contract:
- Route only through `hermes_local`.
- Use `desiredSkills=[]` and fresh session state for each scored run.
- Reuse the clean-profile evidence anchored at `/Users/glad0s/.paperclip/instances/default/companies/e212ce50-b524-408c-b3d4-0c6108d8c2e2/work-products/TSBC-1153/hermes-clean-profile-v2/manifest.json`.

Launcher: `work-products/TSBC-1230/launch_tsbc_1176_run01.py`
Contract: `work-products/TSBC-1230/TSBC-1230-launch-contract.json`
