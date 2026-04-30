from pathlib import Path
import ctypes
import platform
import os

def get_library_path():
    ext = ".dll" if platform.system() == "Windows" else ".so" if platform.system() == "Linux" else ".dylib"
    lib_name = "espeak-ng" + ext if platform.system() == "Windows" else 'libespeak-ng' + ext
    return str(Path(__file__).parent / lib_name)

def get_data_path():
    data_path = Path(__file__).parent / 'espeak-ng-data'
    if not data_path.exists():
        raise RuntimeError(f'data path not exists at {data_path}')
    return str(data_path)

def load_library():
    """
    Load the shared library.
    """
    try:
        lib_path = get_library_path()
        lib = ctypes.CDLL(lib_path)
        return lib
    except OSError as e:
        print(f"Error loading shared library from {lib_path}: {e}")
        return None

def make_library_available():
    """
    Add the directory containing the shared library to the system's library path.
    """
    lib = get_library_path()
    lib_dir = str(Path(lib).parent)
    # Windows
    if platform.system() == "Windows":
        os.add_dll_directory(lib_dir)
    # Linux
    elif platform.system() == "Linux":
        os.environ["LD_LIBRARY_PATH"] = lib_dir + ":" + os.environ.get("LD_LIBRARY_PATH", "")
    # MacOS
    elif platform.system() == "Darwin":
        os.environ["DYLD_LIBRARY_PATH"] = lib_dir + ":" + os.environ.get("DYLD_LIBRARY_PATH", "")
    else:
        raise Exception(f"Unsupported platform: {platform.system()}")