"""python-soundfile is an audio library based on libsndfile, CFFI and NumPy.

Sound files can be read or written directly using the functions
`read()` and `write()`.
To read a sound file in a block-wise fashion, use `blocks()`.
Alternatively, sound files can be opened as `SoundFile` objects.

For further information, see https://python-soundfile.readthedocs.io/.

"""
__version__ = "0.13.1"

import os as _os
import sys as _sys
from os import SEEK_SET, SEEK_CUR, SEEK_END
from ctypes.util import find_library as _find_library
from _soundfile import ffi as _ffi

try:
    _unicode = unicode  # doesn't exist in Python 3.x
except NameError:
    _unicode = str


_str_types = {
    'title':       0x01,
    'copyright':   0x02,
    'software':    0x03,
    'artist':      0x04,
    'comment':     0x05,
    'date':        0x06,
    'album':       0x07,
    'license':     0x08,
    'tracknumber': 0x09,
    'genre':       0x10,
}

_formats = {
    'WAV':   0x010000,  # Microsoft WAV format (little endian default).
    'AIFF':  0x020000,  # Apple/SGI AIFF format (big endian).
    'AU':    0x030000,  # Sun/NeXT AU format (big endian).
    'RAW':   0x040000,  # RAW PCM data.
    'PAF':   0x050000,  # Ensoniq PARIS file format.
    'SVX':   0x060000,  # Amiga IFF / SVX8 / SV16 format.
    'NIST':  0x070000,  # Sphere NIST format.
    'VOC':   0x080000,  # VOC files.
    'IRCAM': 0x0A0000,  # Berkeley/IRCAM/CARL
    'W64':   0x0B0000,  # Sonic Foundry's 64 bit RIFF/WAV
    'MAT4':  0x0C0000,  # Matlab (tm) V4.2 / GNU Octave 2.0
    'MAT5':  0x0D0000,  # Matlab (tm) V5.0 / GNU Octave 2.1
    'PVF':   0x0E0000,  # Portable Voice Format
    'XI':    0x0F0000,  # Fasttracker 2 Extended Instrument
    'HTK':   0x100000,  # HMM Tool Kit format
    'SDS':   0x110000,  # Midi Sample Dump Standard
    'AVR':   0x120000,  # Audio Visual Research
    'WAVEX': 0x130000,  # MS WAVE with WAVEFORMATEX
    'SD2':   0x160000,  # Sound Designer 2
    'FLAC':  0x170000,  # FLAC lossless file format
    'CAF':   0x180000,  # Core Audio File format
    'WVE':   0x190000,  # Psion WVE format
    'OGG':   0x200000,  # Xiph OGG container
    'MPC2K': 0x210000,  # Akai MPC 2000 sampler
    'RF64':  0x220000,  # RF64 WAV file
    'MP3':   0x230000,  # MPEG-1/2 audio stream
}

_subtypes = {
    'PCM_S8':         0x0001,  # Signed 8 bit data
    'PCM_16':         0x0002,  # Signed 16 bit data
    'PCM_24':         0x0003,  # Signed 24 bit data
    'PCM_32':         0x0004,  # Signed 32 bit data
    'PCM_U8':         0x0005,  # Unsigned 8 bit data (WAV and RAW only)
    'FLOAT':          0x0006,  # 32 bit float data
    'DOUBLE':         0x0007,  # 64 bit float data
    'ULAW':           0x0010,  # U-Law encoded.
    'ALAW':           0x0011,  # A-Law encoded.
    'IMA_ADPCM':      0x0012,  # IMA ADPCM.
    'MS_ADPCM':       0x0013,  # Microsoft ADPCM.
    'GSM610':         0x0020,  # GSM 6.10 encoding.
    'VOX_ADPCM':      0x0021,  # OKI / Dialogix ADPCM
    'NMS_ADPCM_16':   0x0022,  # 16kbs NMS G721-variant encoding.
    'NMS_ADPCM_24':   0x0023,  # 24kbs NMS G721-variant encoding.
    'NMS_ADPCM_32':   0x0024,  # 32kbs NMS G721-variant encoding.
    'G721_32':        0x0030,  # 32kbs G721 ADPCM encoding.
    'G723_24':        0x0031,  # 24kbs G723 ADPCM encoding.
    'G723_40':        0x0032,  # 40kbs G723 ADPCM encoding.
    'DWVW_12':        0x0040,  # 12 bit Delta Width Variable Word encoding.
    'DWVW_16':        0x0041,  # 16 bit Delta Width Variable Word encoding.
    'DWVW_24':        0x0042,  # 24 bit Delta Width Variable Word encoding.
    'DWVW_N':         0x0043,  # N bit Delta Width Variable Word encoding.
    'DPCM_8':         0x0050,  # 8 bit differential PCM (XI only)
    'DPCM_16':        0x0051,  # 16 bit differential PCM (XI only)
    'VORBIS':         0x0060,  # Xiph Vorbis encoding.
    'OPUS':           0x0064,  # Xiph/Skype Opus encoding.
    'ALAC_16':        0x0070,  # Apple Lossless Audio Codec (16 bit).
    'ALAC_20':        0x0071,  # Apple Lossless Audio Codec (20 bit).
    'ALAC_24':        0x0072,  # Apple Lossless Audio Codec (24 bit).
    'ALAC_32':        0x0073,  # Apple Lossless Audio Codec (32 bit).
    'MPEG_LAYER_I':   0x0080,  # MPEG-1 Audio Layer I.
    'MPEG_LAYER_II':  0x0081,  # MPEG-1 Audio Layer II.
    'MPEG_LAYER_III': 0x0082,  # MPEG-2 Audio Layer III.
}

_endians = {
    'FILE':   0x00000000,  # Default file endian-ness.
    'LITTLE': 0x10000000,  # Force little endian-ness.
    'BIG':    0x20000000,  # Force big endian-ness.
    'CPU':    0x30000000,  # Force CPU endian-ness.
}

# libsndfile doesn't specify default subtypes, these are somehow arbitrary:
_default_subtypes = {
    'WAV':   'PCM_16',
    'AIFF':  'PCM_16',
    'AU':    'PCM_16',
    # 'RAW':  # subtype must be explicit!
    'PAF':   'PCM_16',
    'SVX':   'PCM_16',
    'NIST':  'PCM_16',
    'VOC':   'PCM_16',
    'IRCAM': 'PCM_16',
    'W64':   'PCM_16',
    'MAT4':  'DOUBLE',
    'MAT5':  'DOUBLE',
    'PVF':   'PCM_16',
    'XI':    'DPCM_16',
    'HTK':   'PCM_16',
    'SDS':   'PCM_16',
    'AVR':   'PCM_16',
    'WAVEX': 'PCM_16',
    'SD2':   'PCM_16',
    'FLAC':  'PCM_16',
    'CAF':   'PCM_16',
    'WVE':   'ALAW',
    'OGG':   'VORBIS',
    'MPC2K': 'PCM_16',
    'RF64':  'PCM_16',
    'MP3':   'MPEG_LAYER_III',
}

_ffi_types = {
    'float64': 'double',
    'float32': 'float',
    'int32': 'int',
    'int16': 'short'
}

_bitrate_modes = {
    'CONSTANT': 0,
    'AVERAGE': 1,
    'VARIABLE': 2,
}

try:  # packaged lib (in _soundfile_data which should be on python path)
    if _sys.platform == 'darwin':
        from platform import machine as _machine
        _packaged_libname = 'libsndfile_' + _machine() + '.dylib'
    elif _sys.platform == 'win32':
        from platform import architecture as _architecture
        from platform import machine as _machine
        # this check can not be completed correctly: for x64 binaries running on
        # arm64 Windows report the same values as arm64 binaries. For now, neither
        # numpy nor cffi are available for arm64, so we can safely assume we're
        # in x86 land:
        if _architecture()[0] == '64bit':
            _packaged_libname = 'libsndfile_x64.dll'
        elif _architecture()[0] == '32bit':
            _packaged_libname = 'libsndfile_x86.dll'
        else:
            raise OSError('no packaged library for Windows {} {}'
                          .format(_architecture(), _machine()))
    elif _sys.platform == 'linux':
        from platform import machine as _machine
        if _machine() in ["aarch64", "aarch64_be", "armv8b", "armv8l"]:
            _packaged_libname = 'libsndfile_arm64.so'
        else:
            _packaged_libname = 'libsndfile_' + _machine() + '.so'
    else:
        raise OSError('no packaged library for this platform')

    import _soundfile_data  # ImportError if this doesn't exist
    _path = _os.path.dirname(_soundfile_data.__file__)  # TypeError if __file__ is None
    _full_path = _os.path.join(_path, _packaged_libname)
    _snd = _ffi.dlopen(_full_path)  # OSError if file doesn't exist or can't be loaded

except (OSError, ImportError, TypeError):
    try:  # system-wide libsndfile:
        _libname = _find_library('sndfile')
        if _libname is None:
            raise OSError('sndfile library not found using ctypes.util.find_library')
        _snd = _ffi.dlopen(_libname)

    except OSError:
        # Try explicit file name, if the general does not work (e.g. on nixos)
        if _sys.platform == 'darwin':
            _explicit_libname = 'libsndfile.dylib'
        elif _sys.platform == 'win32':
            _explicit_libname = 'libsndfile.dll'
        elif _sys.platform == 'linux':
            _explicit_libname = 'libsndfile.so'
        else:
            raise

        # Homebrew on Apple M1 uses a `/opt/homebrew/lib` instead of
        # `/usr/local/lib`. We are making sure we pick that up.
        from platform import machine as _machine
        if _sys.platform == 'darwin' and _machine() == 'arm64':
            _hbrew_path = '/opt/homebrew/lib/' if _os.path.isdir('/opt/homebrew/lib/') \
                else '/usr/local/lib/'
            _snd = _ffi.dlopen(_os.path.join(_hbrew_path, _explicit_libname))
        else:
            _snd = _ffi.dlopen(_explicit_libname)

__libsndfile_version__ = _ffi.string(_snd.sf_version_string()).decode('utf-8', 'replace')
if __libsndfile_version__.startswith('libsndfile-'):
    __libsndfile_version__ = __libsndfile_version__[len('libsndfile-'):]


def read(file, frames=-1, start=0, stop=None, dtype='float64', always_2d=False,
         fill_value=None, out=None, samplerate=None, channels=None,
         format=None, subtype=None, endian=None, closefd=True):
    """Provide audio data from a sound file as NumPy array.

    By default, the whole file is read from the beginning, but the
    position to start reading can be specified with *start* and the
    number of frames to read can be specified with *frames*.
    Alternatively, a range can be specified with *start* and *stop*.

    If there is less data left in the file than requested, the rest of
    the frames are filled with *fill_value*.
    If no *fill_value* is specified, a smaller array is returned.

    Parameters
    ----------
    file : str or int or file-like object
        The file to read from.  See `SoundFile` for details.
    frames : int, optional
        The number of frames to read. If *frames* is negative, the whole
        rest of the file is read.  Not allowed if *stop* is given.
    start : int, optional
        Where to start reading.  A negative value counts from the end.
    stop : int, optional
        The index after the last frame to be read.  A negative value
        counts from the end.  Not allowed if *frames* is given.
    dtype : {'float64', 'float32', 'int32', 'int16'}, optional
        Data type of the returned array, by default ``'float64'``.
        Floating point audio data is typically in the range from
        ``-1.0`` to ``1.0``.  Integer data is in the range from
        ``-2**15`` to ``2**15-1`` for ``'int16'`` and from ``-2**31`` to
        ``2**31-1`` for ``'int32'``.

        .. note:: Reading int values from a float file will *not*
            scale the data to [-1.0, 1.0). If the file contains
            ``np.array([42.6], dtype='float32')``, you will read
            ``np.array([43], dtype='int32')`` for ``dtype='int32'``.

    Returns
    -------
    audiodata : `numpy.ndarray` or type(out)
        A two-dimensional (frames x channels) NumPy array is returned.
        If the sound file has only one channel, a one-dimensional array
        is returned.  Use ``always_2d=True`` to return a two-dimensional
        array anyway.

        If *out* was specified, it is returned.  If *out* has more
        frames than available in the file (or if *frames* is smaller
        than the length of *out*) and no *fill_value* is given, then
        only a part of *out* is overwritten and a view containing all
        valid frames is returned.
    samplerate : int
        The sample rate of the audio file.

    Other Parameters
    ----------------
    always_2d : bool, optional
        By default, reading a mono sound file will return a
        one-dimensional array.  With ``always_2d=True``, audio data is
        always returned as a two-dimensional array, even if the audio
        file has only one channel.
    fill_value : float, optional
        If more frames are requested than available in the file, the
        rest of the output is be filled with *fill_value*.  If
        *fill_value* is not specified, a smaller array is returned.
    out : `numpy.ndarray` or subclass, optional
        If *out* is specified, the data is written into the given array
        instead of creating a new array.  In this case, the arguments
        *dtype* and *always_2d* are silently ignored!  If *frames* is
        not given, it is obtained from the length of *out*.
    samplerate, channels, format, subtype, endian, closefd
        See `SoundFile`.

    Examples
    --------
    >>> import soundfile as sf
    >>> data, samplerate = sf.read('stereo_file.wav')
    >>> data
    array([[ 0.71329652,  0.06294799],
           [-0.26450912, -0.38874483],
           ...
           [ 0.67398441, -0.11516333]])
    >>> samplerate
    44100

    """
    with SoundFile(file, 'r', samplerate, channels,
                   subtype, endian, format, closefd) as f:
        frames = f._prepare_read(start, stop, frames)
        data = f.read(frames, dtype, always_2d, fill_value, out)
    return data, f.samplerate


def write(file, data, samplerate, subtype=None, endian=None, format=None,
          closefd=True, compression_level=None, bitrate_mode=None):
    """Write data to a sound file.

    .. note:: If *file* exists, it will be truncated and overwritten!

    Parameters
    ----------
    file : str or int or file-like object
        The file to write to.  See `SoundFile` for details.
    data : array_like
        The data to write.  Usually two-dimensional (frames x channels),
        but one-dimensional *data* can be used for mono files.
        Only the data types ``'float64'``, ``'float32'``, ``'int32'``
        and ``'int16'`` are supported.

        .. note:: The data type of *data* does **not** select the data
                  type of the written file. Audio data will be
                  converted to the given *subtype*. Writing int values
                  to a float file will *not* scale the values to
                  [-1.0, 1.0). If you write the value ``np.array([42],
                  dtype='int32')``, to a ``subtype='FLOAT'`` file, the
                  file will then contain ``np.array([42.],
                  dtype='float32')``.

    samplerate : int
        The sample rate of the audio data.
    subtype : str, optional
        See `default_subtype()` for the default value and
        `available_subtypes()` for all possible values.

    Other Parameters
    ----------------
    format, endian, closefd, compression_level, bitrate_mode
        See `SoundFile`.

    Examples
    --------
    Write 10 frames of random data to a new file:

    >>> import numpy as np
    >>> import soundfile as sf
    >>> sf.write('stereo_file.wav', np.random.randn(10, 2), 44100, 'PCM_24')

    """
    import numpy as np
    data = np.asarray(data)
    if data.ndim == 1:
        channels = 1
    else:
        channels = data.shape[1]
    with SoundFile(file, 'w', samplerate, channels,
                   subtype, endian, format, closefd,
                   compression_level, bitrate_mode) as f:
        f.write(data)


def blocks(file, blocksize=None, overlap=0, frames=-1, start=0, stop=None,
           dtype='float64', always_2d=False, fill_value=None, out=None,
           samplerate=None, channels=None,
           format=None, subtype=None, endian=None, closefd=True):
    """Return a generator for block-wise reading.

    By default, iteration starts at the beginning and stops at the end
    of the file.  Use *start* to start at a later position and *frames*
    or *stop* to stop earlier.

    If you stop iterating over the generator before it's exhausted,
    the sound file is not closed. This is normally not a problem
    because the file is opened in read-only mode. To close the file
    properly, the generator's ``close()`` method can be called.

    Parameters
    ----------
    file : str or int or file-like object
        The file to read from.  See `SoundFile` for details.
    blocksize : int
        The number of frames to read per block.
        Either this or *out* must be given.
    overlap : int, optional
        The number of frames to rewind between each block.

    Yields
    ------
    `numpy.ndarray` or type(out)
        Blocks of audio data.
        If *out* was given, and the requested frames are not an integer
        multiple of the length of *out*, and no *fill_value* was given,
        the last block will be a smaller view into *out*.

    Other Parameters
    ----------------
    frames, start, stop
        See `read()`.
    dtype : {'float64', 'float32', 'int32', 'int16'}, optional
        See `read()`.
    always_2d, fill_value, out
        See `read()`.
    samplerate, channels, format, subtype, endian, closefd
        See `SoundFile`.

    Examples
    --------
    >>> import soundfile as sf
    >>> for block in sf.blocks('stereo_file.wav', blocksize=1024):
    >>>     pass  # do something with 'block'

    """
    with SoundFile(file, 'r', samplerate, channels,
                   subtype, endian, format, closefd) as f:
        frames = f._prepare_read(start, stop, frames)
        for block in f.blocks(blocksize, overlap, frames,
                              dtype, always_2d, fill_value, out):
            yield block


class _SoundFileInfo(object):
    """Information about a SoundFile"""

    def __init__(self, file, verbose):
        self.verbose = verbose
        with SoundFile(file) as f:
            self.name = f.name
            self.samplerate = f.samplerate
            self.channels = f.channels
            self.frames = f.frames
            self.duration = float(self.frames)/f.samplerate
            self.format = f.format
            self.subtype = f.subtype
            self.endian = f.endian
            self.format_info = f.format_info
            self.subtype_info = f.subtype_info
            self.sections = f.sections
            self.extra_info = f.extra_info

    @property
    def _duration_str(self):
        hours, rest = divmod(self.duration, 3600)
        minutes, seconds = divmod(rest, 60)
        if hours >= 1:
            duration = "{0:.0g}:{1:02.0g}:{2:05.3f} h".format(hours, minutes, seconds)
        elif minutes >= 1:
            duration = "{0:02.0g}:{1:05.3f} min".format(minutes, seconds)
        elif seconds <= 1:
            duration = "{0:d} samples".format(self.frames)
        else:
            duration = "{0:.3f} s".format(seconds)
        return duration

    def __repr__(self):
        info = "\n".join(
            ["{0.name}",
             "samplerate: {0.samplerate} Hz",
             "channels: {0.channels}",
             "duration: {0._duration_str}",
             "format: {0.format_info} [{0.format}]",
             "subtype: {0.subtype_info} [{0.subtype}]"])
        if self.verbose:
            info += "\n".join(
                ["\nendian: {0.endian}",
                 "sections: {0.sections}",
                 "frames: {0.frames}",
                 'extra_info: """',
                 '    {1}"""'])
        indented_extra_info = ("\n"+" "*4).join(self.extra_info.split("\n"))
        return info.format(self, indented_extra_info)


def info(file, verbose=False):
    """Returns an object with information about a `SoundFile`.

    Parameters
    ----------
    verbose : bool
        Whether to print additional information.
    """
    return _SoundFileInfo(file, verbose)


def available_formats():
    """Return a dictionary of available major formats.

    Examples
    --------
    >>> import soundfile as sf
    >>> sf.available_formats()
    {'FLAC': 'FLAC (FLAC Lossless Audio Codec)',
     'OGG': 'OGG (OGG Container format)',
     'WAV': 'WAV (Microsoft)',
     'AIFF': 'AIFF (Apple/SGI)',
     ...
     'WAVEX': 'WAVEX (Microsoft)',
     'RAW': 'RAW (header-less)',
     'MAT5': 'MAT5 (GNU Octave 2.1 / Matlab 5.0)'}

    """
    return dict(_available_formats_helper(_snd.SFC_GET_FORMAT_MAJOR_COUNT,
                                          _snd.SFC_GET_FORMAT_MAJOR))


def available_subtypes(format=None):
    """Return a dictionary of available subtypes.

    Parameters
    ----------
    format : str
        If given, only compatible subtypes are returned.

    Examples
    --------
    >>> import soundfile as sf
    >>> sf.available_subtypes('FLAC')
    {'PCM_24': 'Signed 24 bit PCM',
     'PCM_16': 'Signed 16 bit PCM',
     'PCM_S8': 'Signed 8 bit PCM'}

    """
    subtypes = _available_formats_helper(_snd.SFC_GET_FORMAT_SUBTYPE_COUNT,
                                         _snd.SFC_GET_FORMAT_SUBTYPE)
    return dict((subtype, name) for subtype, name in subtypes
                if format is None or check_format(format, subtype))


def check_format(format, subtype=None, endian=None):
    """Check if the combination of format/subtype/endian is valid.

    Examples
    --------
    >>> import soundfile as sf
    >>> sf.check_format('WAV', 'PCM_24')
    True
    >>> sf.check_format('FLAC', 'VORBIS')
    False

    """
    try:
        return bool(_format_int(format, subtype, endian))
    except (ValueError, TypeError):
        return False


def default_subtype(format):
    """Return the default subtype for a given format.

    Examples
    --------
    >>> import soundfile as sf
    >>> sf.default_subtype('WAV')
    'PCM_16'
    >>> sf.default_subtype('MAT5')
    'DOUBLE'

    """
    _check_format(format)
    return _default_subtypes.get(format.upper())


class SoundFile(object):
    """A sound file.

    For more documentation see the __init__() docstring (which is also
    used for the online documentation (https://python-soundfile.readthedocs.io/).

    """

    def __init__(self, file, mode='r', samplerate=None, channels=None,
                 subtype=None, endian=None, format=None, closefd=True,
                 compression_level=None, bitrate_mode=None):
        """Open a sound file.

        If a file is opened with `mode` ``'r'`` (the default) or
        ``'r+'``, no sample rate, channels or file format need to be
        given because the information is obtained from the file. An
        exception is the ``'RAW'`` data format, which always requires
        these data points.

        File formats consist of three case-insensitive strings:

        * a *major format* which is by default obtained from the
          extension of the file name (if known) and which can be
          forced with the format argument (e.g. ``format='WAVEX'``).
        * a *subtype*, e.g. ``'PCM_24'``. Most major formats have a
          default subtype which is used if no subtype is specified.
        * an *endian-ness*, which doesn't have to be specified at all in
          most cases.

        A `SoundFile` object is a *context manager*, which means
        if used in a "with" statement, `close()` is automatically
        called when reaching the end of the code block inside the "with"
        statement.

        Parameters
        ----------
        file : str or int or file-like object
            The file to open.  This can be a file name, a file
            descriptor or a Python file object (or a similar object with
            the methods ``read()``/``readinto()``, ``write()``,
            ``seek()`` and ``tell()``).
        mode : {'r', 'r+', 'w', 'w+', 'x', 'x+'}, optional
            Open mode.  Has to begin with one of these three characters:
            ``'r'`` for reading, ``'w'`` for writing (truncates *file*)
            or ``'x'`` for writing (raises an error if *file* already
            exists).  Additionally, it may contain ``'+'`` to open
            *file* for both reading and writing.
            The character ``'b'`` for *binary mode* is implied because
            all sound files have to be opened in this mode.
            If *file* is a file descriptor or a file-like object,
            ``'w'`` doesn't truncate and ``'x'`` doesn't raise an error.
        samplerate : int
            The sample rate of the file.  If `mode` contains ``'r'``,
            this is obtained from the file (except for ``'RAW'`` files).
        channels : int
            The number of channels of the file.
            If `mode` contains ``'r'``, this is obtained from the file
            (except for ``'RAW'`` files).
        subtype : str, sometimes optional
            The subtype of the sound file.  If `mode` contains ``'r'``,
            this is obtained from the file (except for ``'RAW'``
            files), if not, the default value depends on the selected
            `format` (see `default_subtype()`).
            See `available_subtypes()` for all possible subtypes for
            a given `format`.
        endian : {'FILE', 'LITTLE', 'BIG', 'CPU'}, sometimes optional
            The endian-ness of the sound file.  If `mode` contains
            ``'r'``, this is obtained from the file (except for
            ``'RAW'`` files), if not, the default value is ``'FILE'``,
            which is correct in most cases.
        format : str, sometimes optional
            The major format of the sound file.  If `mode` contains
            ``'r'``, this is obtained from the file (except for
            ``'RAW'`` files), if not, the default value is determined
            from the file extension.  See `available_formats()` for
            all possible values.
        closefd : bool, optional
            Whether to close the file descriptor on `close()`. Only
            applicable if the *file* argument is a file descriptor.
        compression_level : float, optional
            The compression level on 'write()'. The compression level
            should be between 0.0 (minimum compression level) and 1.0
            (highest compression level).
            See `libsndfile document <https://github.com/libsndfile/libsndfile/blob/c81375f070f3c6764969a738eacded64f53a076e/docs/command.md>`__.
        bitrate_mode : {'CONSTANT', 'AVERAGE', 'VARIABLE'}, optional
            The bitrate mode on 'write()'. 
            See `libsndfile document <https://github.com/libsndfile/libsndfile/blob/c81375f070f3c6764969a738eacded64f53a076e/docs/command.md>`__.

        Examples
        --------
        >>> from soundfile import SoundFile

        Open an existing file for reading:

        >>> myfile = SoundFile('existing_file.wav')
        >>> # do something with myfile
        >>> myfile.close()

        Create a new sound file for reading and writing using a with
        statement:

        >>> with SoundFile('new_file.wav', 'x+', 44100, 2) as myfile:
        >>>     # do something with myfile
        >>>     # ...
        >>>     assert not myfile.closed
        >>>     # myfile.close() is called automatically at the end
        >>> assert myfile.closed

        """
        # resolve PathLike objects (see PEP519 for details):
        # can be replaced with _os.fspath(file) for Python >= 3.6
        file = file.__fspath__() if hasattr(file, '__fspath__') else file
        self._name = file
        if mode is None:
            mode = getattr(file, 'mode', None)
        mode_int = _check_mode(mode)
        self._mode = mode
        self._compression_level = compression_level
        self._bitrate_mode = bitrate_mode
        self._info = _create_info_struct(file, mode, samplerate, channels,
                                         format, subtype, endian)
        self._file = self._open(file, mode_int, closefd)
        if set(mode).issuperset('r+') and self.seekable():
            # Move write position to 0 (like in Python file objects)
            self.seek(0)
        _snd.sf_command(self._file, _snd.SFC_SET_CLIPPING, _ffi.NULL,
                        _snd.SF_TRUE)
        
        # set compression setting
        if self._compression_level is not None:
            # needs to be called before set_bitrate_mode
            self._set_compression_level(self._compression_level)
            if self._bitrate_mode is not None:
                self._set_bitrate_mode(self._bitrate_mode)

    name = property(lambda self: self._name)
    """The file name of the sound file."""
    mode = property(lambda self: self._mode)
    """The open mode the sound file was opened with."""
    samplerate = property(lambda self: self._info.samplerate)
    """The sample rate of the sound file."""
    frames = property(lambda self: self._info.frames)
    """The number of frames in the sound file."""
    channels = property(lambda self: self._info.channels)
    """The number of channels in the sound file."""
    format = property(
        lambda self: _format_str(self._info.format & _snd.SF_FORMAT_TYPEMASK))
    """The major format of the sound file."""
    subtype = property(
        lambda self: _format_str(self._info.format & _snd.SF_FORMAT_SUBMASK))
    """The subtype of data in the the sound file."""
    endian = property(
        lambda self: _format_str(self._info.format & _snd.SF_FORMAT_ENDMASK))
    """The endian-ness of the data in the sound file."""
    format_info = property(
        lambda self: _format_info(self._info.format &
                                  _snd.SF_FORMAT_TYPEMASK)[1])
    """A description of the major format of the sound file."""
    subtype_info = property(
        lambda self: _format_info(self._info.format &
                                  _snd.SF_FORMAT_SUBMASK)[1])
    """A description of the subtype of the sound file."""
    sections = property(lambda self: self._info.sections)
    """The number of sections of the sound file."""
    closed = property(lambda self: self._file is None)
    """Whether the sound file is closed or not."""
    _errorcode = property(lambda self: _snd.sf_error(self._file))
    """A pending sndfile error code."""
    compression_level = property(lambda self: self._compression_level)
    """The compression level on 'write()'"""
    bitrate_mode = property(lambda self: self._bitrate_mode)
    """The bitrate mode on 'write()'"""

    @property
    def extra_info(self):
        """Retrieve the log string generated when opening the file."""
        info = _ffi.new("char[]", 2**14)
        _snd.sf_command(self._file, _snd.SFC_GET_LOG_INFO,
                        info, _ffi.sizeof(info))
        return _ffi.string(info).decode('utf-8', 'replace')

    # avoid confusion if something goes wrong before assigning self._file:
    _file = None

    def __repr__(self):
        compression_setting = (", compression_level={0}".format(self.compression_level) 
                               if self.compression_level is not None else "")
        compression_setting += (", bitrate_mode='{0}'".format(self.bitrate_mode) 
                                if self.bitrate_mode is not None else "")
        return ("SoundFile({0.name!r}, mode={0.mode!r}, "
                "samplerate={0.samplerate}, channels={0.channels}, "
                "format={0.format!r}, subtype={0.subtype!r}, "
                "endian={0.endian!r}{1})".format(self, compression_setting))

    def __del__(self):
        self.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __setattr__(self, name, value):
        """Write text meta-data in the sound file through properties."""
        if name in _str_types:
            self._check_if_closed()
            err = _snd.sf_set_string(self._file, _str_types[name],
                                     value.encode())
            _error_check(err)
        else:
            object.__setattr__(self, name, value)

    def __getattr__(self, name):
        """Read text meta-data in the sound file through properties."""
        if name in _str_types:
            self._check_if_closed()
            data = _snd.sf_get_string(self._file, _str_types[name])
            return _ffi.string(data).decode('utf-8', 'replace') if data else ""
        else:
            raise AttributeError(
                "'SoundFile' object has no attribute {0!r}".format(name))

    def __len__(self):
        # Note: This is deprecated and will be removed at some point,
        # see https://github.com/bastibe/python-soundfile/issues/199
        return self._info.frames

    def __bool__(self):
        # Note: This is temporary until __len__ is removed, afterwards it
        # can (and should) be removed without change of behavior
        return True

    def __nonzero__(self):
        # Note: This is only for compatibility with Python 2 and it shall be
        # removed at the same time as __bool__().
        return self.__bool__()

    def seekable(self):
        """Return True if the file supports seeking."""
        return self._info.seekable == _snd.SF_TRUE

    def seek(self, frames, whence=SEEK_SET):
        """Set the read/write position.

        Parameters
        ----------
        frames : int
            The frame index or offset to seek.
        whence : {SEEK_SET, SEEK_CUR, SEEK_END}, optional
            By default (``whence=SEEK_SET``), *frames* are counted from
            the beginning of the file.
            ``whence=SEEK_CUR`` seeks from the current position
            (positive and negative values are allowed for *frames*).
            ``whence=SEEK_END`` seeks from the end (use negative value
            for *frames*).

        Returns
        -------
        int
            The new absolute read/write position in frames.

        Examples
        --------
        >>> from soundfile import SoundFile, SEEK_END
        >>> myfile = SoundFile('stereo_file.wav')

        Seek to the beginning of the file:

        >>> myfile.seek(0)
        0

        Seek to the end of the file:

        >>> myfile.seek(0, SEEK_END)
        44100  # this is the file length

        """
        self._check_if_closed()
        position = _snd.sf_seek(self._file, frames, whence)
        _error_check(self._errorcode)
        return position

    def tell(self):
        """Return the current read/write position."""
        return self.seek(0, SEEK_CUR)

    def read(self, frames=-1, dtype='float64', always_2d=False,
             fill_value=None, out=None):
        """Read from the file and return data as NumPy array.

        Reads the given number of frames in the given data format
        starting at the current read/write position.  This advances the
        read/write position by the same number of frames.
        By default, all frames from the current read/write position to
        the end of the file are returned.
        Use `seek()` to move the current read/write position.

        Parameters
        ----------
        frames : int, optional
            The number of frames to read. If ``frames < 0``, the whole
            rest of the file is read.
        dtype : {'float64', 'float32', 'int32', 'int16'}, optional
            Data type of the returned array, by default ``'float64'``.
            Floating point audio data is typically in the range from
            ``-1.0`` to ``1.0``. Integer data is in the range from
            ``-2**15`` to ``2**15-1`` for ``'int16'`` and from
            ``-2**31`` to ``2**31-1`` for ``'int32'``.

            .. note:: Reading int values from a float file will *not*
                scale the data to [-1.0, 1.0). If the file contains
                ``np.array([42.6], dtype='float32')``, you will read
                ``np.array([43], dtype='int32')`` for
                ``dtype='int32'``.

        Returns
        -------
        audiodata : `numpy.ndarray` or type(out)
            A two-dimensional NumPy (frames x channels) array is
            returned. If the sound file has only one channel, a
            one-dimensional array is returned. Use ``always_2d=True``
            to return a two-dimensional array anyway.

            If *out* was specified, it is returned. If *out* has more
            frames than available in the file (or if *frames* is
            smaller than the length of *out*) and no *fill_value* is
            given, then only a part of *out* is overwritten and a view
            containing all valid frames is returned.

        Other Parameters
        ----------------
        always_2d : bool, optional
            By default, reading a mono sound file will return a
            one-dimensional array. With ``always_2d=True``, audio data
            is always returned as a two-dimensional array, even if the
            audio file has only one channel.
        fill_value : float, optional
            If more frames are requested than available in the file,
            the rest of the output is be filled with *fill_value*. If
            *fill_value* is not specified, a smaller array is
            returned.
        out : `numpy.ndarray` or subclass, optional
            If *out* is specified, the data is written into the given
            array instead of creating a new array. In this case, the
            arguments *dtype* and *always_2d* are silently ignored! If
            *frames* is not given, it is obtained from the length of
            *out*.

        Examples
        --------
        >>> from soundfile import SoundFile
        >>> myfile = SoundFile('stereo_file.wav')

        Reading 3 frames from a stereo file:

        >>> myfile.read(3)
        array([[ 0.71329652,  0.06294799],
               [-0.26450912, -0.38874483],
               [ 0.67398441, -0.11516333]])
        >>> myfile.close()

        See Also
        --------
        buffer_read, .write

        """
        if out is None:
            frames = self._check_frames(frames, fill_value)
            out = self._create_empty_array(frames, always_2d, dtype)
        else:
            if frames < 0 or frames > len(out):
                frames = len(out)
        frames = self._array_io('read', out, frames)
        if len(out) > frames:
            if fill_value is None:
                out = out[:frames]
            else:
                out[frames:] = fill_value
        return out

    def buffer_read(self, frames=-1, dtype=None):
        """Read from the file and return data as buffer object.

        Reads the given number of *frames* in the given data format
        starting at the current read/write position.  This advances the
        read/write position by the same number of frames.
        By default, all frames from the current read/write position to
        the end of the file are returned.
        Use `seek()` to move the current read/write position.

        Parameters
        ----------
        frames : int, optional
            The number of frames to read. If ``frames < 0``, the whole
            rest of the file is read.
        dtype : {'float64', 'float32', 'int32', 'int16'}
            Audio data will be converted to the given data type.

        Returns
        -------
        buffer
            A buffer containing the read data.

        See Also
        --------
        buffer_read_into, .read, buffer_write

        """
        frames = self._check_frames(frames, fill_value=None)
        ctype = self._check_dtype(dtype)
        cdata = _ffi.new(ctype + '[]', frames * self.channels)
        read_frames = self._cdata_io('read', cdata, ctype, frames)
        assert read_frames == frames
        return _ffi.buffer(cdata)

    def buffer_read_into(self, buffer, dtype):
        """Read from the file into a given buffer object.

        Fills the given *buffer* with frames in the given data format
        starting at the current read/write position (which can be
        changed with `seek()`) until the buffer is full or the end
        of the file is reached.  This advances the read/write position
        by the number of frames that were read.

        Parameters
        ----------
        buffer : writable buffer
            Audio frames from the file are written to this buffer.
        dtype : {'float64', 'float32', 'int32', 'int16'}
            The data type of *buffer*.

        Returns
        -------
        int
            The number of frames that were read from the file.
            This can be less than the size of *buffer*.
            The rest of the buffer is not filled with meaningful data.

        See Also
        --------
        buffer_read, .read

        """
        ctype = self._check_dtype(dtype)
        cdata, frames = self._check_buffer(buffer, ctype)
        frames = self._cdata_io('read', cdata, ctype, frames)
        return frames

    def write(self, data):
        """Write audio data from a NumPy array to the file.

        Writes a number of frames at the read/write position to the
        file. This also advances the read/write position by the same
        number of frames and enlarges the file if necessary.

        Note that writing int values to a float file will *not* scale
        the values to [-1.0, 1.0). If you write the value
        ``np.array([42], dtype='int32')``, to a ``subtype='FLOAT'``
        file, the file will then contain ``np.array([42.],
        dtype='float32')``.

        Parameters
        ----------
        data : array_like
            The data to write. Usually two-dimensional (frames x
            channels), but one-dimensional *data* can be used for mono
            files. Only the data types ``'float64'``, ``'float32'``,
            ``'int32'`` and ``'int16'`` are supported.

            .. note:: The data type of *data* does **not** select the
                  data type of the written file. Audio data will be
                  converted to the given *subtype*. Writing int values
                  to a float file will *not* scale the values to
                  [-1.0, 1.0). If you write the value ``np.array([42],
                  dtype='int32')``, to a ``subtype='FLOAT'`` file, the
                  file will then contain ``np.array([42.],
                  dtype='float32')``.

        Examples
        --------
        >>> import numpy as np
        >>> from soundfile import SoundFile
        >>> myfile = SoundFile('stereo_file.wav')

        Write 10 frames of random data to a new file:

        >>> with SoundFile('stereo_file.wav', 'w', 44100, 2, 'PCM_24') as f:
        >>>     f.write(np.random.randn(10, 2))

        See Also
        --------
        buffer_write, .read

        """
        import numpy as np

        # no copy is made if data has already the correct memory layout:
        data = np.ascontiguousarray(data)
        written = self._array_io('write', data, len(data))
        assert written == len(data)
        self._update_frames(written)

    def buffer_write(self, data, dtype):
        """Write audio data from a buffer/bytes object to the file.

        Writes the contents of *data* to the file at the current
        read/write position.
        This also advances the read/write position by the number of
        frames that were written and enlarges the file if necessary.

        Parameters
        ----------
        data : buffer or bytes
            A buffer or bytes object containing the audio data to be
            written.
        dtype : {'float64', 'float32', 'int32', 'int16'}
            The data type of the audio data stored in *data*.

        See Also
        --------
        .write, buffer_read

        """
        ctype = self._check_dtype(dtype)
        cdata, frames = self._check_buffer(data, ctype)
        written = self._cdata_io('write', cdata, ctype, frames)
        assert written == frames
        self._update_frames(written)

    def blocks(self, blocksize=None, overlap=0, frames=-1, dtype='float64',
               always_2d=False, fill_value=None, out=None):
        """Return a generator for block-wise reading.

        By default, the generator yields blocks of the given
        *blocksize* (using a given *overlap*) until the end of the file
        is reached; *frames* can be used to stop earlier.

        Parameters
        ----------
        blocksize : int
            The number of frames to read per block. Either this or *out*
            must be given.
        overlap : int, optional
            The number of frames to rewind between each block.
        frames : int, optional
            The number of frames to read.
            If ``frames < 0``, the file is read until the end.
        dtype : {'float64', 'float32', 'int32', 'int16'}, optional
            See `read()`.

        Yields
        ------
        `numpy.ndarray` or type(out)
            Blocks of audio data.
            If *out* was given, and the requested frames are not an
            integer multiple of the length of *out*, and no
            *fill_value* was given, the last block will be a smaller
            view into *out*.


        Other Parameters
        ----------------
        always_2d, fill_value, out
            See `read()`.
        fill_value : float, optional
            See `read()`.
        out : `numpy.ndarray` or subclass, optional
            If *out* is specified, the data is written into the given
            array instead of creating a new array. In this case, the
            arguments *dtype* and *always_2d* are silently ignored!

        Examples
        --------
        >>> from soundfile import SoundFile
        >>> with SoundFile('stereo_file.wav') as f:
        >>>     for block in f.blocks(blocksize=1024):
        >>>         pass  # do something with 'block'

        """
        import numpy as np

        if 'r' not in self.mode and '+' not in self.mode:
            raise SoundFileRuntimeError("blocks() is not allowed in write-only mode")

        frames = self._check_frames(frames, fill_value)
        if out is None:
            if blocksize is None:
                raise TypeError("One of {blocksize, out} must be specified")
            out_size = blocksize if fill_value is not None else min(blocksize, frames)
            out = self._create_empty_array(out_size, always_2d, dtype)
            copy_out = True
        else:
            if blocksize is not None:
                raise TypeError(
                    "Only one of {blocksize, out} may be specified")
            blocksize = len(out)
            copy_out = False

        overlap_memory = None
        while frames > 0:
            if overlap_memory is None:
                output_offset = 0
            else:
                output_offset = len(overlap_memory)
                out[:output_offset] = overlap_memory

            toread = min(blocksize - output_offset, frames)
            self.read(toread, dtype, always_2d, fill_value, out[output_offset:])

            if overlap:
                if overlap_memory is None:
                    overlap_memory = np.copy(out[-overlap:])
                else:
                    overlap_memory[:] = out[-overlap:]

            if blocksize > frames + overlap and fill_value is None:
                block = out[:frames + overlap]
            else:
                block = out
            yield np.copy(block) if copy_out else block
            frames -= toread

    def truncate(self, frames=None):
        """Truncate the file to a given number of frames.

        After this command, the read/write position will be at the new
        end of the file.

        Parameters
        ----------
        frames : int, optional
            Only the data before *frames* is kept, the rest is deleted.
            If not specified, the current read/write position is used.

        """
        if frames is None:
            frames = self.tell()
        err = _snd.sf_command(self._file, _snd.SFC_FILE_TRUNCATE,
                              _ffi.new("sf_count_t*", frames),
                              _ffi.sizeof("sf_count_t"))
        if err:
            # get the actual error code
            err = _snd.sf_error(self._file)
            raise LibsndfileError(err, "Error truncating the file")
        self._info.frames = frames

    def flush(self):
        """Write unwritten data to the file system.

        Data written with `write()` is not immediately written to
        the file system but buffered in memory to be written at a later
        time.  Calling `flush()` makes sure that all changes are
        actually written to the file system.

        This has no effect on files opened in read-only mode.

        """
        self._check_if_closed()
        _snd.sf_write_sync(self._file)

    def close(self):
        """Close the file.  Can be called multiple times."""
        if not self.closed:
            # be sure to flush data to disk before closing the file
            self.flush()
            err = _snd.sf_close(self._file)
            self._file = None
            _error_check(err)

    def _open(self, file, mode_int, closefd):
        """Call the appropriate sf_open*() function from libsndfile."""
        if isinstance(file, (_unicode, bytes)):
            if _os.path.isfile(file):
                if 'x' in self.mode:
                    raise OSError("File exists: {0!r}".format(self.name))
                elif set(self.mode).issuperset('w+'):
                    # truncate the file, because SFM_RDWR doesn't:
                    _os.close(_os.open(file, _os.O_WRONLY | _os.O_TRUNC))
            openfunction = _snd.sf_open
            if isinstance(file, _unicode):
                if _sys.platform == 'win32':
                    openfunction = _snd.sf_wchar_open
                else:
                    file = file.encode(_sys.getfilesystemencoding())
            file_ptr = openfunction(file, mode_int, self._info)
        elif isinstance(file, int):
            file_ptr = _snd.sf_open_fd(file, mode_int, self._info, closefd)
        elif _has_virtual_io_attrs(file, mode_int):
            file_ptr = _snd.sf_open_virtual(self._init_virtual_io(file),
                                            mode_int, self._info, _ffi.NULL)
        else:
            raise TypeError("Invalid file: {0!r}".format(self.name))
        if file_ptr == _ffi.NULL:
            # get the actual error code
            err = _snd.sf_error(file_ptr)
            raise LibsndfileError(err, prefix="Error opening {0!r}: ".format(self.name))
        if mode_int == _snd.SFM_WRITE:
            # Due to a bug in libsndfile version <= 1.0.25, frames != 0
            # when opening a named pipe in SFM_WRITE mode.
            # See http://github.com/erikd/libsndfile/issues/77.
            self._info.frames = 0
            # This is not necessary for "normal" files (because
            # frames == 0 in this case), but it doesn't hurt, either.
        return file_ptr

    def _init_virtual_io(self, file):
        """Initialize callback functions for sf_open_virtual()."""
        @_ffi.callback("sf_vio_get_filelen")
        def vio_get_filelen(user_data):
            curr = file.tell()
            file.seek(0, SEEK_END)
            size = file.tell()
            file.seek(curr, SEEK_SET)
            return size

        @_ffi.callback("sf_vio_seek")
        def vio_seek(offset, whence, user_data):
            file.seek(offset, whence)
            return file.tell()

        @_ffi.callback("sf_vio_read")
        def vio_read(ptr, count, user_data):
            # first try readinto(), if not available fall back to read()
            try:
                buf = _ffi.buffer(ptr, count)
                data_read = file.readinto(buf)
            except AttributeError:
                data = file.read(count)
                data_read = len(data)
                buf = _ffi.buffer(ptr, data_read)
                buf[0:data_read] = data
            return data_read

        @_ffi.callback("sf_vio_write")
        def vio_write(ptr, count, user_data):
            buf = _ffi.buffer(ptr, count)
            data = buf[:]
            written = file.write(data)
            # write() returns None for file objects in Python <= 2.7:
            if written is None:
                written = count
            return written

        @_ffi.callback("sf_vio_tell")
        def vio_tell(user_data):
            return file.tell()

        # Note: the callback functions must be kept alive!
        self._virtual_io = {'get_filelen': vio_get_filelen,
                            'seek': vio_seek,
                            'read': vio_read,
                            'write': vio_write,
                            'tell': vio_tell}

        return _ffi.new("SF_VIRTUAL_IO*", self._virtual_io)

    def _getAttributeNames(self):
        """Return all attributes used in __setattr__ and __getattr__.

        This is useful for auto-completion (e.g. IPython).

        """
        return _str_types

    def _check_if_closed(self):
        """Check if the file is closed and raise an error if it is.

        This should be used in every method that uses self._file.

        """
        if self.closed:
            raise SoundFileRuntimeError("I/O operation on closed file")

    def _check_frames(self, frames, fill_value):
        """Reduce frames to no more than are available in the file."""
        if self.seekable():
            remaining_frames = self.frames - self.tell()
            if frames < 0 or (frames > remaining_frames and
                              fill_value is None):
                frames = remaining_frames
        elif frames < 0:
            raise ValueError("frames must be specified for non-seekable files")
        return frames

    def _check_buffer(self, data, ctype):
        """Convert buffer to cdata and check for valid size."""
        assert ctype in _ffi_types.values()
        if not isinstance(data, bytes):
            data = _ffi.from_buffer(data)
        frames, remainder = divmod(len(data),
                                   self.channels * _ffi.sizeof(ctype))
        if remainder:
            raise ValueError("Data size must be a multiple of frame size")
        return data, frames

    def _create_empty_array(self, frames, always_2d, dtype):
        """Create an empty array with appropriate shape."""
        import numpy as np
        if always_2d or self.channels > 1:
            shape = frames, self.channels
        else:
            shape = frames,
        return np.empty(shape, dtype, order='C')

    def _check_dtype(self, dtype):
        """Check if dtype string is valid and return ctype string."""
        try:
            return _ffi_types[dtype]
        except KeyError:
            raise ValueError("dtype must be one of {0!r} and not {1!r}".format(
                sorted(_ffi_types.keys()), dtype))

    def _array_io(self, action, array, frames):
        """Check array and call low-level IO function."""
        if array.ndim not in (1,2):
            raise ValueError("Invalid shape: {0!r} ({1})".format(array.shape, "0 dimensions not supported" if array.ndim < 1 else "too many dimensions"))
        array_channels = 1 if array.ndim == 1 else array.shape[1]
        if array_channels != self.channels:
            raise ValueError("Invalid shape: {0!r} (Expected {1} channels, got {2})".format(array.shape, self.channels, array_channels))
        if not array.flags.c_contiguous:
            raise ValueError("Data must be C-contiguous")
        ctype = self._check_dtype(array.dtype.name)
        assert array.dtype.itemsize == _ffi.sizeof(ctype)
        cdata = _ffi.cast(ctype + '*', array.__array_interface__['data'][0])
        return self._cdata_io(action, cdata, ctype, frames)

    def _cdata_io(self, action, data, ctype, frames):
        """Call one of libsndfile's read/write functions."""
        assert ctype in _ffi_types.values()
        self._check_if_closed()
        if self.seekable():
            curr = self.tell()
        func = getattr(_snd, 'sf_' + action + 'f_' + ctype)
        frames = func(self._file, data, frames)
        _error_check(self._errorcode)
        if self.seekable():
            self.seek(curr + frames, SEEK_SET)  # Update read & write position
        return frames

    def _update_frames(self, written):
        """Update self.frames after writing."""
        if self.seekable():
            curr = self.tell()
            self._info.frames = self.seek(0, SEEK_END)
            self.seek(curr, SEEK_SET)
        else:
            self._info.frames += written

    def _prepare_read(self, start, stop, frames):
        """Seek to start frame and calculate length."""
        if start != 0 and not self.seekable():
            raise ValueError("start is only allowed for seekable files")
        if frames >= 0 and stop is not None:
            raise TypeError("Only one of {frames, stop} may be used")

        start, stop, _ = slice(start, stop).indices(self.frames)
        if stop < start:
            stop = start
        if frames < 0:
            frames = stop - start
        if self.seekable():
            self.seek(start, SEEK_SET)
        return frames

    def copy_metadata(self):
        """Get all metadata present in this SoundFile

        Returns
        -------

        metadata: dict[str, str]
            A dict with all metadata. Possible keys are: 'title', 'copyright',
            'software', 'artist', 'comment', 'date', 'album', 'license',
            'tracknumber' and 'genre'.
        """
        strs = {}
        for strtype, strid in _str_types.items():
            data = _snd.sf_get_string(self._file, strid)
            if data:
                strs[strtype] = _ffi.string(data).decode('utf-8', 'replace')
        return strs
    
    def _set_bitrate_mode(self, bitrate_mode):
        """Call libsndfile's set bitrate mode function."""
        assert bitrate_mode in _bitrate_modes

        pointer_bitrate_mode = _ffi.new("int[1]")
        pointer_bitrate_mode[0] = _bitrate_modes[bitrate_mode]
        err = _snd.sf_command(self._file, _snd.SFC_SET_BITRATE_MODE, pointer_bitrate_mode, _ffi.sizeof(pointer_bitrate_mode))
        if err != _snd.SF_TRUE:
            err = _snd.sf_error(self._file)
            raise LibsndfileError(err, f"Error set bitrate mode {bitrate_mode}")

        
    def _set_compression_level(self, compression_level):
        """Call libsndfile's set compression level function."""
        if not (0 <= compression_level <= 1):
            raise ValueError("Compression level must be in range [0..1]")

        pointer_compression_level = _ffi.new("double[1]")
        pointer_compression_level[0] = compression_level
        err = _snd.sf_command(self._file, _snd.SFC_SET_COMPRESSION_LEVEL, pointer_compression_level, _ffi.sizeof(pointer_compression_level))
        if err != _snd.SF_TRUE:
            err = _snd.sf_error(self._file)
            raise LibsndfileError(err, f"Error set compression level {compression_level}")


def _error_check(err, prefix=""):
    """Raise LibsndfileError if there is an error."""
    if err != 0:
        raise LibsndfileError(err, prefix=prefix)


def _format_int(format, subtype, endian):
    """Return numeric ID for given format|subtype|endian combo."""
    result = _check_format(format)
    if subtype is None:
        subtype = default_subtype(format)
        if subtype is None:
            raise TypeError(
                "No default subtype for major format {0!r}".format(format))
    elif not isinstance(subtype, (_unicode, str)):
        raise TypeError("Invalid subtype: {0!r}".format(subtype))
    try:
        result |= _subtypes[subtype.upper()]
    except KeyError:
        raise ValueError("Unknown subtype: {0!r}".format(subtype))
    if endian is None:
        endian = 'FILE'
    elif not isinstance(endian, (_unicode, str)):
        raise TypeError("Invalid endian-ness: {0!r}".format(endian))
    try:
        result |= _endians[endian.upper()]
    except KeyError:
        raise ValueError("Unknown endian-ness: {0!r}".format(endian))

    info = _ffi.new("SF_INFO*")
    info.format = result
    info.channels = 1
    if _snd.sf_format_check(info) == _snd.SF_FALSE:
        raise ValueError(
            "Invalid combination of format, subtype and endian")
    return result


def _check_mode(mode):
    """Check if mode is valid and return its integer representation."""
    if not isinstance(mode, (_unicode, str)):
        raise TypeError("Invalid mode: {0!r}".format(mode))
    mode_set = set(mode)
    if mode_set.difference('xrwb+') or len(mode) > len(mode_set):
        raise ValueError("Invalid mode: {0!r}".format(mode))
    if len(mode_set.intersection('xrw')) != 1:
        raise ValueError("mode must contain exactly one of 'xrw'")

    if '+' in mode_set:
        mode_int = _snd.SFM_RDWR
    elif 'r' in mode_set:
        mode_int = _snd.SFM_READ
    else:
        mode_int = _snd.SFM_WRITE
    return mode_int


def _create_info_struct(file, mode, samplerate, channels,
                        format, subtype, endian):
    """Check arguments and create SF_INFO struct."""
    original_format = format
    if format is None:
        format = _get_format_from_filename(file, mode)
        assert isinstance(format, (_unicode, str))
    else:
        _check_format(format)

    info = _ffi.new("SF_INFO*")
    if 'r' not in mode or format.upper() == 'RAW':
        if samplerate is None:
            raise TypeError("samplerate must be specified")
        info.samplerate = samplerate
        if channels is None:
            raise TypeError("channels must be specified")
        info.channels = channels
        info.format = _format_int(format, subtype, endian)
    else:
        if any(arg is not None for arg in (
                samplerate, channels, original_format, subtype, endian)):
            raise TypeError("Not allowed for existing files (except 'RAW'): "
                            "samplerate, channels, format, subtype, endian")
    return info


def _get_format_from_filename(file, mode):
    """Return a format string obtained from file (or file.name).

    If file already exists (= read mode), an empty string is returned on
    error.  If not, an exception is raised.
    The return type will always be str or unicode (even if
    file/file.name is a bytes object).

    """
    format = ''
    file = getattr(file, 'name', file)
    try:
        # This raises an exception if file is not a (Unicode/byte) string:
        format = _os.path.splitext(file)[-1][1:]
        # Convert bytes to unicode (raises AttributeError on Python 3 str):
        format = format.decode('utf-8', 'replace')
    except Exception:
        pass
    if format.upper() not in _formats and 'r' not in mode:
        raise TypeError("No format specified and unable to get format from "
                        "file extension: {0!r}".format(file))
    return format


def _format_str(format_int):
    """Return the string representation of a given numeric format."""
    for dictionary in _formats, _subtypes, _endians:
        for k, v in dictionary.items():
            if v == format_int:
                return k
    else:
        return 'n/a'


def _format_info(format_int, format_flag=_snd.SFC_GET_FORMAT_INFO):
    """Return the ID and short description of a given format."""
    format_info = _ffi.new("SF_FORMAT_INFO*")
    format_info.format = format_int
    _snd.sf_command(_ffi.NULL, format_flag, format_info,
                    _ffi.sizeof("SF_FORMAT_INFO"))
    name = format_info.name
    return (_format_str(format_info.format),
            _ffi.string(name).decode('utf-8', 'replace') if name else "")


def _available_formats_helper(count_flag, format_flag):
    """Helper for available_formats() and available_subtypes()."""
    count = _ffi.new("int*")
    _snd.sf_command(_ffi.NULL, count_flag, count, _ffi.sizeof("int"))
    for format_int in range(count[0]):
        yield _format_info(format_int, format_flag)


def _check_format(format_str):
    """Check if `format_str` is valid and return format ID."""
    if not isinstance(format_str, (_unicode, str)):
        raise TypeError("Invalid format: {0!r}".format(format_str))
    try:
        format_int = _formats[format_str.upper()]
    except KeyError:
        raise ValueError("Unknown format: {0!r}".format(format_str))
    return format_int


def _has_virtual_io_attrs(file, mode_int):
    """Check if file has all the necessary attributes for virtual IO."""
    readonly = mode_int == _snd.SFM_READ
    writeonly = mode_int == _snd.SFM_WRITE
    return all([
        hasattr(file, 'seek'),
        hasattr(file, 'tell'),
        hasattr(file, 'write') or readonly,
        hasattr(file, 'read') or hasattr(file, 'readinto') or writeonly,
    ])


class SoundFileError(Exception):
    """Base class for all soundfile-specific errors."""
    pass

class SoundFileRuntimeError(SoundFileError, RuntimeError):
    """soundfile module runtime error.

    Errors that used to be `RuntimeError`."""
    pass

class LibsndfileError(SoundFileRuntimeError):
    """libsndfile errors.


    Attributes
    ----------
    code
        libsndfile internal error number.
    """
    def __init__(self, code, prefix=""):
        SoundFileRuntimeError.__init__(self, code, prefix)
        self.code = code
        self.prefix = prefix

    @property
    def error_string(self):
        """Raw libsndfile error message."""
        if self.code:
            err_str = _snd.sf_error_number(self.code)
            return _ffi.string(err_str).decode('utf-8', 'replace')
        else:
            # Due to race conditions, if used concurrently, sf_error() may
            # return 0 (= no error) even if an error has happened.
            # See https://github.com/erikd/libsndfile/issues/610 for details.
            return "(Garbled error message from libsndfile)"

    def __str__(self):
        return self.prefix + self.error_string
