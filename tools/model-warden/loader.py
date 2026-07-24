def set_preferred_cmd(device_id):
    return ["lms", "link", "set-preferred-device", device_id]

def load_cmd(entry):
    cmd = ["lms", "load", entry["load_key"]]
    if entry.get("ctx") is not None:
        cmd += ["-c", str(entry["ctx"])]
    if entry.get("parallel") is not None:
        cmd += ["--parallel", str(entry["parallel"])]
    cmd.append("-y")
    return cmd
