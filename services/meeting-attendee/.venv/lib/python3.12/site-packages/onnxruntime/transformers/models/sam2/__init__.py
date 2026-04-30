# -------------------------------------------------------------------------
# Copyright (c) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import os.path
import sys

sys.path.append(os.path.dirname(__file__))

transformers_dir = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", ".."))
if transformers_dir not in sys.path:
    sys.path.append(transformers_dir)
