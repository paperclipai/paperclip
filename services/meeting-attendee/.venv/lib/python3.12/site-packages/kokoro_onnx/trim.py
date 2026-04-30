"""
Copyright (c) 2013--2023, librosa development team.

Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.


***This file extracted from librosa package since we use only the trim() function and librosa requires many dependencies***

Reference:
    - https://gist.github.com/evq/82e95a363eeeb75d15dd62abc1eb1bde
    - https://github.com/librosa/librosa/blob/894942673d55aa2206df1296b6c4c50827c7f1d6/librosa/effects.py#L612
"""

import warnings
from collections.abc import Callable
from typing import Any

import numpy as np
from numpy.lib.stride_tricks import as_strided


class LibrosaError(Exception):
    """The root librosa exception class"""

    pass


class ParameterError(LibrosaError):
    """Exception class for mal-formed inputs"""

    pass


# @numba.vectorize(
#    ["float32(complex64)", "float64(complex128)"], nopython=True, cache=True, identity=0
# )  # type: ignore
def _cabs2(x):  # pragma: no cover
    """Efficiently compute abs2 on complex inputs"""
    return x.real**2 + x.imag**2


def abs2(x, dtype):
    """Compute the squared magnitude of a real or complex array.

    This function is equivalent to calling `np.abs(x)**2` but it
    is slightly more efficient.

    Parameters
    ----------
    x : np.ndarray or scalar, real or complex typed
        The input data, either real (float32, float64) or complex (complex64, complex128) typed
    dtype : np.dtype, optional
        The data type of the output array.
        If not provided, it will be inferred from `x`

    Returns
    -------
    p : np.ndarray or scale, real
        squared magnitude of `x`

    Examples
    --------
    >>> librosa.util.abs2(3 + 4j)
    25.0

    >>> librosa.util.abs2((0.5j)**np.arange(8))
    array([1.000e+00, 2.500e-01, 6.250e-02, 1.562e-02, 3.906e-03, 9.766e-04,
       2.441e-04, 6.104e-05])
    """
    if np.iscomplexobj(x):
        # suppress type check, mypy doesn't like vectorization
        y = _cabs2(x)
        if dtype is None:
            return y  # type: ignore
        else:
            return y.astype(dtype)  # type: ignore
    else:
        # suppress type check, mypy doesn't know this is real
        return np.square(x, dtype=dtype)  # type: ignore


def amplitude_to_db(
    S,
    *,
    ref: float | Callable = 1.0,
    amin: float = 1e-5,
    top_db: float | None = 80.0,
) -> np.floating[Any] | np.ndarray:
    """Convert an amplitude spectrogram to dB-scaled spectrogram.

    This is equivalent to ``power_to_db(S**2, ref=ref**2, amin=amin**2, top_db=top_db)``,
    but is provided for convenience.

    Parameters
    ----------
    S : np.ndarray
        input amplitude

    ref : scalar or callable
        If scalar, the amplitude ``abs(S)`` is scaled relative to ``ref``:
        ``20 * log10(S / ref)``.
        Zeros in the output correspond to positions where ``S == ref``.

        If callable, the reference value is computed as ``ref(S)``.

    amin : float > 0 [scalar]
        minimum threshold for ``S`` and ``ref``

    top_db : float >= 0 [scalar]
        threshold the output at ``top_db`` below the peak:
        ``max(20 * log10(S/ref)) - top_db``

    Returns
    -------
    S_db : np.ndarray
        ``S`` measured in dB

    See Also
    --------
    power_to_db, db_to_amplitude

    Notes
    -----
    This function caches at level 30.
    """
    S = np.asarray(S)

    if np.issubdtype(S.dtype, np.complexfloating):
        warnings.warn(
            "amplitude_to_db was called on complex input so phase "
            "information will be discarded. To suppress this warning, "
            "call amplitude_to_db(np.abs(S)) instead.",
            stacklevel=2,
        )

    magnitude = np.abs(S)

    if callable(ref):
        # User supplied a function to calculate reference power
        ref_value = ref(magnitude)
    else:
        ref_value = np.abs(ref)

    out_array = magnitude if isinstance(magnitude, np.ndarray) else None
    power = np.square(magnitude, out=out_array)

    db: np.ndarray = power_to_db(power, ref=ref_value**2, amin=amin**2, top_db=top_db)
    return db


def _signal_to_frame_nonsilent(
    y: np.ndarray,
    frame_length: int = 2048,
    hop_length: int = 512,
    top_db: float = 60,
    ref: Callable | float = np.max,
    aggregate: Callable = np.max,
) -> np.ndarray:
    """Frame-wise non-silent indicator for audio input.

    This is a helper function for `trim` and `split`.

    Parameters
    ----------
    y : np.ndarray
        Audio signal, mono or stereo

    frame_length : int > 0
        The number of samples per frame

    hop_length : int > 0
        The number of samples between frames

    top_db : number
        The threshold (in decibels) below reference to consider as
        silence.
        You can also use a negative value for `top_db` to treat any value
        below `ref + |top_db|` as silent.  This will only make sense if
        `ref` is not `np.max`.

    ref : callable or float
        The reference amplitude

    aggregate : callable [default: np.max]
        Function to aggregate dB measurements across channels (if y.ndim > 1)

        Note: for multiple leading axes, this is performed using ``np.apply_over_axes``.

    Returns
    -------
    non_silent : np.ndarray, shape=(m,), dtype=bool
        Indicator of non-silent frames
    """
    # Compute the MSE for the signal
    mse = rms(y=y, frame_length=frame_length, hop_length=hop_length)

    # Convert to decibels and slice out the mse channel
    db: np.ndarray = amplitude_to_db(mse[..., 0, :], ref=ref, top_db=None)

    # Aggregate everything but the time dimension
    if db.ndim > 1:
        db = np.apply_over_axes(aggregate, db, range(db.ndim - 1))
        # Squeeze out leading singleton dimensions here
        # We always want to keep the trailing dimension though
        db = np.squeeze(db, axis=tuple(range(db.ndim - 1)))

    return db > -top_db


def trim(
    y: np.ndarray,
    *,
    top_db: float = 60,
    ref: float | Callable = np.max,
    frame_length: int = 2048,
    hop_length: int = 512,
    aggregate: Callable = np.max,
) -> tuple[np.ndarray, np.ndarray]:
    """Trim leading and trailing silence from an audio signal.

    Silence is defined as segments of the audio signal that are `top_db`
    decibels (or more) quieter than a reference level, `ref`.
    By default, `ref` is set to the signal's maximum RMS value.
    It's important to note that if the entire signal maintains a uniform
    RMS value, there will be no segments considered quieter than the maximum,
    leading to no trimming.
    This implies that a completely silent signal will remain untrimmed with the default `ref` setting.
    In these situations, an explicit value for `ref` (in decibels) should be used instead.

    Parameters
    ----------
    y : np.ndarray, shape=(..., n)
        Audio signal. Multi-channel is supported.
    top_db : number
        The threshold (in decibels) below reference to consider as
        silence.
        You can also use a negative value for `top_db` to treat any value
        below `ref + |top_db|` as silent.  This will only make sense if
        `ref` is not `np.max`.
    ref : number or callable
        The reference amplitude.  By default, it uses `np.max` and compares
        to the peak amplitude in the signal.
    frame_length : int > 0
        The number of samples per analysis frame
    hop_length : int > 0
        The number of samples between analysis frames
    aggregate : callable [default: np.max]
        Function to aggregate across channels (if y.ndim > 1)

    Returns
    -------
    y_trimmed : np.ndarray, shape=(..., m)
        The trimmed signal
    index : np.ndarray, shape=(2,)
        the interval of ``y`` corresponding to the non-silent region:
        ``y_trimmed = y[index[0]:index[1]]`` (for mono) or
        ``y_trimmed = y[:, index[0]:index[1]]`` (for stereo).

    Examples
    --------
    >>> # Load some audio
    >>> y, sr = librosa.load(librosa.ex('choice'))
    >>> # Trim the beginning and ending silence
    >>> yt, index = librosa.effects.trim(y)
    >>> # Print the durations
    >>> print(librosa.get_duration(y, sr=sr), librosa.get_duration(yt, sr=sr))
    25.025986394557822 25.007891156462584
    """
    non_silent = _signal_to_frame_nonsilent(
        y,
        frame_length=frame_length,
        hop_length=hop_length,
        ref=ref,
        top_db=top_db,
        aggregate=aggregate,
    )

    nonzero = np.flatnonzero(non_silent)

    if nonzero.size > 0:
        # Compute the start and end positions
        # End position goes one frame past the last non-zero
        start = int(frames_to_samples(nonzero[0], hop_length=hop_length))
        end = min(
            y.shape[-1],
            int(frames_to_samples(nonzero[-1] + 1, hop_length=hop_length)),
        )
    else:
        # The entire signal is trimmed here: nothing is above the threshold
        start, end = 0, 0

    # Slice the buffer and return the corresponding interval
    return y[..., start:end], np.asarray([start, end])


def rms(
    *,
    y: np.ndarray | None = None,
    S: np.ndarray | None = None,
    frame_length: int = 2048,
    hop_length: int = 512,
    center: bool = True,
    pad_mode="constant",
    dtype=np.float32,
) -> np.ndarray:
    """Compute root-mean-square (RMS) value for each frame, either from the
    audio samples ``y`` or from a spectrogram ``S``.

    Computing the RMS value from audio samples is faster as it doesn't require
    a STFT calculation. However, using a spectrogram will give a more accurate
    representation of energy over time because its frames can be windowed,
    thus prefer using ``S`` if it's already available.

    Parameters
    ----------
    y : np.ndarray [shape=(..., n)] or None
        (optional) audio time series. Required if ``S`` is not input.
        Multi-channel is supported.
    S : np.ndarray [shape=(..., d, t)] or None
        (optional) spectrogram magnitude. Required if ``y`` is not input.
    frame_length : int > 0 [scalar]
        length of analysis frame (in samples) for energy calculation
    hop_length : int > 0 [scalar]
        hop length for STFT. See `librosa.stft` for details.
    center : bool
        If `True` and operating on time-domain input (``y``), pad the signal
        by ``frame_length//2`` on either side.
        If operating on spectrogram input, this has no effect.
    pad_mode : str
        Padding mode for centered analysis.  See `numpy.pad` for valid
        values.
    dtype : np.dtype, optional
        Data type of the output array.  Defaults to float32.

    Returns
    -------
    rms : np.ndarray [shape=(..., 1, t)]
        RMS value for each frame

    Examples
    --------
    >>> y, sr = librosa.load(librosa.ex('trumpet'))
    >>> librosa.feature.rms(y=y)
    array([[1.248e-01, 1.259e-01, ..., 1.845e-05, 1.796e-05]],
          dtype=float32)

    Or from spectrogram input

    >>> S, phase = librosa.magphase(librosa.stft(y))
    >>> rms = librosa.feature.rms(S=S)

    >>> import matplotlib.pyplot as plt
    >>> fig, ax = plt.subplots(nrows=2, sharex=True)
    >>> times = librosa.times_like(rms)
    >>> ax[0].semilogy(times, rms[0], label='RMS Energy')
    >>> ax[0].set(xticks=[])
    >>> ax[0].legend()
    >>> ax[0].label_outer()
    >>> librosa.display.specshow(librosa.amplitude_to_db(S, ref=np.max),
    ...                          y_axis='log', x_axis='time', ax=ax[1])
    >>> ax[1].set(title='log Power spectrogram')

    Use a STFT window of constant ones and no frame centering to get consistent
    results with the RMS computed from the audio samples ``y``

    >>> S = librosa.magphase(librosa.stft(y, window=np.ones, center=False))[0]
    >>> librosa.feature.rms(S=S)
    >>> plt.show()

    """
    if y is not None:
        if center:
            padding = [(0, 0) for _ in range(y.ndim)]
            padding[-1] = (int(frame_length // 2), int(frame_length // 2))
            y = np.pad(y, padding, mode=pad_mode)

        x = frame(y, frame_length=frame_length, hop_length=hop_length)

        # Calculate power
        power = np.mean(abs2(x, dtype=dtype), axis=-2, keepdims=True)
    elif S is not None:
        # Check the frame length
        if S.shape[-2] != frame_length // 2 + 1:
            raise ParameterError(
                f"Since S.shape[-2] is {S.shape[-2]}, "
                f"frame_length is expected to be {S.shape[-2] * 2 - 2} or {S.shape[-2] * 2 - 1}; "
                f"found {frame_length}"
            )

        # power spectrogram
        x = abs2(S, dtype=dtype)

        # Adjust the DC and sr/2 component
        x[..., 0, :] *= 0.5
        if frame_length % 2 == 0:
            x[..., -1, :] *= 0.5

        # Calculate power
        power = 2 * np.sum(x, axis=-2, keepdims=True) / frame_length**2
    else:
        raise ParameterError("Either `y` or `S` must be input.")

    rms_result: np.ndarray = np.sqrt(power)
    return rms_result


def frame(
    x: np.ndarray,
    *,
    frame_length: int,
    hop_length: int,
    axis: int = -1,
    writeable: bool = False,
    subok: bool = False,
) -> np.ndarray:
    """Slice a data array into (overlapping) frames.

    This implementation uses low-level stride manipulation to avoid
    making a copy of the data.  The resulting frame representation
    is a new view of the same input data.

    For example, a one-dimensional input ``x = [0, 1, 2, 3, 4, 5, 6]``
    can be framed with frame length 3 and hop length 2 in two ways.
    The first (``axis=-1``), results in the array ``x_frames``::

        [[0, 2, 4],
         [1, 3, 5],
         [2, 4, 6]]

    where each column ``x_frames[:, i]`` contains a contiguous slice of
    the input ``x[i * hop_length : i * hop_length + frame_length]``.

    The second way (``axis=0``) results in the array ``x_frames``::

        [[0, 1, 2],
         [2, 3, 4],
         [4, 5, 6]]

    where each row ``x_frames[i]`` contains a contiguous slice of the input.

    This generalizes to higher dimensional inputs, as shown in the examples below.
    In general, the framing operation increments by 1 the number of dimensions,
    adding a new "frame axis" either before the framing axis (if ``axis < 0``)
    or after the framing axis (if ``axis >= 0``).

    Parameters
    ----------
    x : np.ndarray
        Array to frame
    frame_length : int > 0 [scalar]
        Length of the frame
    hop_length : int > 0 [scalar]
        Number of steps to advance between frames
    axis : int
        The axis along which to frame.
    writeable : bool
        If ``False``, then the framed view of ``x`` is read-only.
        If ``True``, then the framed view is read-write.  Note that writing to the framed view
        will also write to the input array ``x`` in this case.
    subok : bool
        If True, sub-classes will be passed-through, otherwise the returned array will be
        forced to be a base-class array (default).

    Returns
    -------
    x_frames : np.ndarray [shape=(..., frame_length, N_FRAMES, ...)]
        A framed view of ``x``, for example with ``axis=-1`` (framing on the last dimension)::

            x_frames[..., j] == x[..., j * hop_length : j * hop_length + frame_length]

        If ``axis=0`` (framing on the first dimension), then::

            x_frames[j] = x[j * hop_length : j * hop_length + frame_length]

    Raises
    ------
    ParameterError
        If ``x.shape[axis] < frame_length``, there is not enough data to fill one frame.

        If ``hop_length < 1``, frames cannot advance.

    See Also
    --------
    numpy.lib.stride_tricks.as_strided

    Examples
    --------
    Extract 2048-sample frames from monophonic signal with a hop of 64 samples per frame

    >>> y, sr = librosa.load(librosa.ex('trumpet'))
    >>> frames = librosa.util.frame(y, frame_length=2048, hop_length=64)
    >>> frames
    array([[-1.407e-03, -2.604e-02, ..., -1.795e-05, -8.108e-06],
           [-4.461e-04, -3.721e-02, ..., -1.573e-05, -1.652e-05],
           ...,
           [ 7.960e-02, -2.335e-01, ..., -6.815e-06,  1.266e-05],
           [ 9.568e-02, -1.252e-01, ...,  7.397e-06, -1.921e-05]],
          dtype=float32)
    >>> y.shape
    (117601,)

    >>> frames.shape
    (2048, 1806)

    Or frame along the first axis instead of the last:

    >>> frames = librosa.util.frame(y, frame_length=2048, hop_length=64, axis=0)
    >>> frames.shape
    (1806, 2048)

    Frame a stereo signal:

    >>> y, sr = librosa.load(librosa.ex('trumpet', hq=True), mono=False)
    >>> y.shape
    (2, 117601)
    >>> frames = librosa.util.frame(y, frame_length=2048, hop_length=64)
    (2, 2048, 1806)

    Carve an STFT into fixed-length patches of 32 frames with 50% overlap

    >>> y, sr = librosa.load(librosa.ex('trumpet'))
    >>> S = np.abs(librosa.stft(y))
    >>> S.shape
    (1025, 230)
    >>> S_patch = librosa.util.frame(S, frame_length=32, hop_length=16)
    >>> S_patch.shape
    (1025, 32, 13)
    >>> # The first patch contains the first 32 frames of S
    >>> np.allclose(S_patch[:, :, 0], S[:, :32])
    True
    >>> # The second patch contains frames 16 to 16+32=48, and so on
    >>> np.allclose(S_patch[:, :, 1], S[:, 16:48])
    True
    """
    # This implementation is derived from numpy.lib.stride_tricks.sliding_window_view (1.20.0)
    # https://numpy.org/doc/stable/reference/generated/numpy.lib.stride_tricks.sliding_window_view.html

    x = np.array(x, copy=False, subok=subok)

    if x.shape[axis] < frame_length:
        raise ParameterError(
            f"Input is too short (n={x.shape[axis]:d}) for frame_length={frame_length:d}"
        )

    if hop_length < 1:
        raise ParameterError(f"Invalid hop_length: {hop_length:d}")

    # put our new within-frame axis at the end for now
    out_strides = x.strides + tuple([x.strides[axis]])

    # Reduce the shape on the framing axis
    x_shape_trimmed = list(x.shape)
    x_shape_trimmed[axis] -= frame_length - 1

    out_shape = tuple(x_shape_trimmed) + tuple([frame_length])
    xw = as_strided(
        x, strides=out_strides, shape=out_shape, subok=subok, writeable=writeable
    )

    if axis < 0:
        target_axis = axis - 1
    else:
        target_axis = axis + 1

    xw = np.moveaxis(xw, -1, target_axis)

    # Downsample along the target axis
    slices = [slice(None)] * xw.ndim
    slices[axis] = slice(0, None, hop_length)
    return xw[tuple(slices)]


def power_to_db(
    S,
    *,
    ref: float | Callable = 1.0,
    amin: float = 1e-10,
    top_db: float | None = 80.0,
) -> np.floating[Any] | np.ndarray:
    """Convert a power spectrogram (amplitude squared) to decibel (dB) units

    This computes the scaling ``10 * log10(S / ref)`` in a numerically
    stable way.

    Parameters
    ----------
    S : np.ndarray
        input power

    ref : scalar or callable
        If scalar, the amplitude ``abs(S)`` is scaled relative to ``ref``::

            10 * log10(S / ref)

        Zeros in the output correspond to positions where ``S == ref``.

        If callable, the reference value is computed as ``ref(S)``.

    amin : float > 0 [scalar]
        minimum threshold for ``abs(S)`` and ``ref``

    top_db : float >= 0 [scalar]
        threshold the output at ``top_db`` below the peak:
        ``max(10 * log10(S/ref)) - top_db``

    Returns
    -------
    S_db : np.ndarray
        ``S_db ~= 10 * log10(S) - 10 * log10(ref)``

    See Also
    --------
    perceptual_weighting
    db_to_power
    amplitude_to_db
    db_to_amplitude

    Notes
    -----
    This function caches at level 30.

    Examples
    --------
    Get a power spectrogram from a waveform ``y``

    >>> y, sr = librosa.load(librosa.ex('trumpet'))
    >>> S = np.abs(librosa.stft(y))
    >>> librosa.power_to_db(S**2)
    array([[-41.809, -41.809, ..., -41.809, -41.809],
           [-41.809, -41.809, ..., -41.809, -41.809],
           ...,
           [-41.809, -41.809, ..., -41.809, -41.809],
           [-41.809, -41.809, ..., -41.809, -41.809]], dtype=float32)

    Compute dB relative to peak power

    >>> librosa.power_to_db(S**2, ref=np.max)
    array([[-80., -80., ..., -80., -80.],
           [-80., -80., ..., -80., -80.],
           ...,
           [-80., -80., ..., -80., -80.],
           [-80., -80., ..., -80., -80.]], dtype=float32)

    Or compare to median power

    >>> librosa.power_to_db(S**2, ref=np.median)
    array([[16.578, 16.578, ..., 16.578, 16.578],
           [16.578, 16.578, ..., 16.578, 16.578],
           ...,
           [16.578, 16.578, ..., 16.578, 16.578],
           [16.578, 16.578, ..., 16.578, 16.578]], dtype=float32)

    And plot the results

    >>> import matplotlib.pyplot as plt
    >>> fig, ax = plt.subplots(nrows=2, sharex=True, sharey=True)
    >>> imgpow = librosa.display.specshow(S**2, sr=sr, y_axis='log', x_axis='time',
    ...                                   ax=ax[0])
    >>> ax[0].set(title='Power spectrogram')
    >>> ax[0].label_outer()
    >>> imgdb = librosa.display.specshow(librosa.power_to_db(S**2, ref=np.max),
    ...                                  sr=sr, y_axis='log', x_axis='time', ax=ax[1])
    >>> ax[1].set(title='Log-Power spectrogram')
    >>> fig.colorbar(imgpow, ax=ax[0])
    >>> fig.colorbar(imgdb, ax=ax[1], format="%+2.0f dB")
    """
    S = np.asarray(S)

    if amin <= 0:
        raise ParameterError("amin must be strictly positive")

    if np.issubdtype(S.dtype, np.complexfloating):
        warnings.warn(
            "power_to_db was called on complex input so phase "
            "information will be discarded. To suppress this warning, "
            "call power_to_db(np.abs(D)**2) instead.",
            stacklevel=2,
        )
        magnitude = np.abs(S)
    else:
        magnitude = S

    if callable(ref):
        # User supplied a function to calculate reference power
        ref_value = ref(magnitude)
    else:
        ref_value = np.abs(ref)

    log_spec: np.ndarray = 10.0 * np.log10(np.maximum(amin, magnitude))
    log_spec -= 10.0 * np.log10(np.maximum(amin, ref_value))

    if top_db is not None:
        if top_db < 0:
            raise ParameterError("top_db must be non-negative")
        log_spec = np.maximum(log_spec, log_spec.max() - top_db)

    return log_spec


def frames_to_samples(
    frames,
    *,
    hop_length: int = 512,
    n_fft: int | None = None,
) -> np.integer[Any] | np.ndarray:
    """Convert frame indices to audio sample indices.

    Parameters
    ----------
    frames : number or np.ndarray [shape=(n,)]
        frame index or vector of frame indices
    hop_length : int > 0 [scalar]
        number of samples between successive frames
    n_fft : None or int > 0 [scalar]
        Optional: length of the FFT window.
        If given, time conversion will include an offset of ``n_fft // 2``
        to counteract windowing effects when using a non-centered STFT.

    Returns
    -------
    times : number or np.ndarray
        time (in samples) of each given frame number::

            times[i] = frames[i] * hop_length

    See Also
    --------
    frames_to_time : convert frame indices to time values
    samples_to_frames : convert sample indices to frame indices

    Examples
    --------
    >>> y, sr = librosa.load(librosa.ex('choice'))
    >>> tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    >>> beat_samples = librosa.frames_to_samples(beats, sr=sr)
    """
    offset = 0
    if n_fft is not None:
        offset = int(n_fft // 2)

    return (np.asanyarray(frames) * hop_length + offset).astype(int)
