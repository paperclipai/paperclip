# -------------------------------------------------------------------------
# Copyright (R) Microsoft Corporation.  All rights reserved.
# Licensed under the MIT License.
# --------------------------------------------------------------------------
import nvtx
from cuda import cudart


class NvtxHelper:
    def __init__(self, stages):
        self.stages = stages
        self.events = {}
        for stage in stages:
            for marker in ["start", "stop"]:
                self.events[stage + "-" + marker] = cudart.cudaEventCreate()[1]
        self.markers = {}

    def start_profile(self, stage, color="blue"):
        self.markers[stage] = nvtx.start_range(message=stage, color=color)
        event_name = stage + "-start"
        if event_name in self.events:
            cudart.cudaEventRecord(self.events[event_name], 0)

    def stop_profile(self, stage):
        event_name = stage + "-stop"
        if event_name in self.events:
            cudart.cudaEventRecord(self.events[event_name], 0)
        nvtx.end_range(self.markers[stage])

    def print_latency(self):
        for stage in self.stages:
            latency = cudart.cudaEventElapsedTime(self.events[f"{stage}-start"], self.events[f"{stage}-stop"])[1]
            print(f"{stage}: {latency:.2f} ms")
