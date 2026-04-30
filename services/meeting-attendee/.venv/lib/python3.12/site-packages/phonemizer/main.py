#!/usr/bin/env python
# Copyright 2015-2021 Mathieu Bernard
#
# This file is part of phonemizer: you can redistribute it and/or
# modify it under the terms of the GNU General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# Phonemizer is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with phonemizer. If not, see <http://www.gnu.org/licenses/>.
"""Command-line phonemizer tool, have a 'phonemizer --help' to get in"""

import argparse
import os
import sys
import re

from phonemizer import phonemize, separator, version, logger, punctuation
from phonemizer.backend import BACKENDS


class CatchExceptions:  # pragma: nocover
    """Decorator wrapping a function in a try/except block

    When an exception occurs, display a user friendly message on
    standard output before exiting with error code 1.

    The detected exceptions are ValueError, OSError, RuntimeError,
    AssertionError and KeyboardInterrupt.

    Parameters
    ----------
    function :
        The function to wrap in a try/except block

    """
    def __init__(self, function):
        self.function = function

    def __call__(self):
        """Executes the wrapped function and catch common exceptions"""
        try:
            self.function()

        except (IOError, ValueError, OSError,
                RuntimeError, AssertionError) as err:
            self.exit('fatal error: {}'.format(err))

        except KeyboardInterrupt:
            self.exit('keyboard interruption, exiting')

    @staticmethod
    def exit(msg):
        """Write `msg` on stderr and exit with error code 1"""
        sys.stderr.write(msg.strip() + '\n')
        sys.exit(1)


def parse_args():
    """Argument parser for the phonemization script"""
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description='''Multilingual text to phonemes converter

The 'phonemize' program allows simple phonemization of words and texts
in many language using four backends: espeak, espeak-mbrola, festival
and segments.

- espeak is a text-to-speech software supporting multiple languages
  and IPA (International Phonetic Alphabet) output. See
  http://espeak.sourceforge.net or
  https://github.com/espeak-ng/espeak-ng

- espeak-mbrola uses the SAMPA phonetic alphabet, it requires mbrola to be
  installed as well as additional mbrola voices. It does not support word or
  syllable tokenization. See
  https://github.com/espeak-ng/espeak-ng/blob/master/docs/mbrola.md

- festival is also a text-to-speech software. Currently only American
  English is supported and festival uses a custom phoneset
  (http://www.festvox.org/bsv/c4711.html), but festival is the only
  backend supporting tokenization at the syllable
  level. See http://www.cstr.ed.ac.uk/projects/festival

- segments is a Unicode tokenizer that build a phonemization from a
  grapheme to phoneme mapping provided as a file by the user. See
  https://github.com/cldf/segments.

See the '--list-languages' option below for details on the languages
supported by each backend.

''',
        epilog='''
Examples:

* Phonemize a US English text with espeak

   $ echo 'hello world' | phonemize -l en-us -b espeak
   həloʊ wɜːld

* Phonemize a US English text with festival

   $ echo 'hello world' | phonemize -l en-us -b festival
   hhaxlow werld

* Phonemize a Japanese text with segments

  $ echo 'konnichiwa tsekai' | phonemize -l japanese -b segments
  konnitʃiwa t͡sekai

* Add a separator between phones

  $ echo 'hello world' | phonemize -l en-us -b festival -p '-' --strip
  hh-ax-l-ow w-er-l-d

* Phonemize some French text file using espeak

  $ phonemize -l fr-fr -b espeak text.txt -o phones.txt
        ''')

    # general arguments
    parser.add_argument(
        '-V', '--version',
        action='store_true',
        help='show version information and exit.')

    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        '-v', '--verbose',
        action='store_true',
        help='write all log messages to stderr '
        '(displays only warnings by default).')
    group.add_argument(
        '-q', '--quiet',
        action='store_true',
        help='do not display any log message, even warnings.')

    parser.add_argument(
        '-j', '--njobs',
        type=int, metavar='<int>', default=1,
        help='number of parallel jobs, default is %(default)s.')

    # input/output arguments
    group = parser.add_argument_group('input/output')
    group.add_argument(
        'input',
        default=sys.stdin, nargs='?', metavar='<file>',
        help='input text file to phonemize, if not specified read from stdin.')

    group.add_argument(
        '-o', '--output',
        default=sys.stdout, metavar='<file>',
        help='output text file to write, if not specified write to stdout.')

    group.add_argument(
        '--prepend-text',
        default=False, const=True, nargs='?', metavar='<str>',
        help='''prepend each line of the phonemized output text with its
        matching input text. If a string is specified as option value, use it
        as field separator, else use one of "|", "||", "|||", "||||" by
        selecting the first one that is not configured as a token separator
        (see -p/-s/-w options).''')

    group.add_argument(
        '--preserve-empty-lines',
        action='store_true',
        help='''preserve the empty lines in the phonemized output, default is
        to remove them.''')

    group = parser.add_argument_group('backends')
    group.add_argument(
        '-b', '--backend',
        metavar='<str>', default=None,
        choices=['espeak', 'espeak-mbrola', 'festival', 'segments'],
        help="""the phonemization backend, must be 'espeak', 'espeak-mbrola',
        'festival' or 'segments'. Default is 'espeak'.""")

    group.add_argument(
        '-L', '--list-languages',
        action='store_true',
        help="""list available languages (and exit) for the specified backend,
        or for all backends if none selected.""")

    group = parser.add_argument_group('language')
    group.add_argument(
        '-l', '--language',
        metavar='<str|file>', default='en-us',
        help='''the language code of the input text, use '--list-languages'
        for a list of supported languages. Default is %(default)s.''')

    group = parser.add_argument_group('token separators')
    group.add_argument(
        '-p', '--phone-separator',
        metavar='<str>', default=separator.default_separator.phone,
        help='phone separator, default is "%(default)s".')

    group.add_argument(
        '-w', '--word-separator',
        metavar='<str>', default=separator.default_separator.word,
        help='''word separator, not valid for espeak-mbrola backend,
        default is "%(default)s".''')

    group.add_argument(
        '-s', '--syllable-separator',
        metavar='<str>', default=separator.default_separator.syllable,
        help='''syllable separator, only valid for festival backend,
        this option has no effect if another backend is used.
        Default is "%(default)s".''')

    group.add_argument(
        '--strip',
        action='store_true',
        help='removes the end separators in phonemized tokens.')

    group = parser.add_argument_group('specific to espeak backend')
    try:
        espeak_library = BACKENDS['espeak'].library()
    except RuntimeError:  # pragma: nocover
        espeak_library = None

    group.add_argument(
        '--espeak-library',
        default=None, type=str, metavar='<library>',
        help=f'''the path to the espeak shared library to use (*.so on Linux,
        *.dylib on Mac and *.dll on Windows, useful to overload the default
        espeak version installed on the system). Default to
        {espeak_library}. This path can also be specified
        using the PHONEMIZER_ESPEAK_LIBRARY environment variable.''')
    group.add_argument(
        '--tie',
        nargs='?', default=False, const=True, metavar='<chr>',
        help='''when the option is set, use a tie character within multi-letter
        phoneme names, default to U+361 (as in d͡ʒ), 'z' means ZWJ character,
        only compatible with espeak>1.48 and incompatible with the
        -p/--phone-separator option''')
    group.add_argument(
        '--with-stress',
        action='store_true',
        help='''when the option is set, the stresses on phonemes are present
        (stresses characters are ˈ'ˌ). By default stresses are removed.''')
    group.add_argument(
        '--language-switch',
        default='keep-flags',
        choices=['keep-flags', 'remove-flags', 'remove-utterance'],
        help="""espeak can pronounce some words in another language (typically
        English) when phonemizing a text. This option setups the policy to use
        when such a language switch occurs. Three values are available:
        'keep-flags' (the default), 'remove-flags' or 'remove-utterance'. The
        'keep-flags' policy keeps the language switching flags, for example
        (en) or (jp), in the output. The 'remove-flags' policy removes them and
        the 'remove-utterance' policy removes the whole line of text including
        a language switch.""")
    group.add_argument(
        '--words-mismatch',
        default='ignore', choices=['ignore', 'warn', 'remove'],
        help="""espeak can join two consecutive words or drop some words,
        yielding a word count mismatch between orthographic and phonemized
        text. This option setups the policy to use when such a words count
        mismatch occurs. Three values are available: 'ignore' (the default)
        which do nothing, 'warn' which issue a warning for each mismatched
        line, and 'remove' which remove the mismatched lines from the
        output.""")

    group = parser.add_argument_group('specific to festival backend')
    try:
        festival_executable = BACKENDS['festival'].executable()
    except RuntimeError:  # pragma: nocover
        festival_executable = None

    group.add_argument(
        '--festival-executable',
        default=None, type=str, metavar='<executable>',
        help=f'''the path to the festival executable to use (useful to
        overload the default festival installed on the system). Default to
        {festival_executable}. This path can also be specified using the
        PHONEMIZER_FESTIVAL_EXECUTABLE environment variable.''')

    group = parser.add_argument_group(
        'punctuation processing',
        description='not available for espeak-mbrola backend')
    group.add_argument(
        '--preserve-punctuation',
        action='store_true',
        help='''preserve the punctuation marks in the phonemized output,
        default is to remove them.''')
    group.add_argument(
        '--punctuation-marks',
        type=str, metavar='<str>',
        default=punctuation.Punctuation.default_marks(),
        help='''the marks to consider during punctuation processing (either
        for removal or preservation). Default is %(default)s.''')
    group.add_argument(
        '--punctuation-marks-is-regex',
        action='store_true',
        help="""interpret the '--punctuation-marks' parameter as a regex.
        Default is to interpret as a string.""")

    return parser.parse_args()


def list_languages(args_backend):
    """Returns the available languages for the given `backend` as a str"""
    for backend in BACKENDS.keys() if not args_backend else [args_backend]:
        print(
            f'supported languages for {backend} are:\n' +
            '\n'.join(f'\t{k}\t->\t{v}' for k, v in sorted(
                BACKENDS[backend].supported_languages().items())))


def get_logger(verbose, quiet):
    """Returns a configured logger"""
    verbosity = 'normal'
    if verbose:
        verbosity = 'verbose'
    elif quiet:
        verbosity = 'quiet'
    return logger.get_logger(verbosity=verbosity)


def setup_stream(stream, mode):
    """If `stream` is a filename, open it as a file"""
    if isinstance(stream, str):
        # pylint: disable=consider-using-with
        return open(stream, mode, encoding='utf8')
    return stream  # pragma: nocover


@CatchExceptions
def main():
    """Phonemize a text from command-line arguments"""
    args = parse_args()

    # setup a custom path to espeak and festival if required (this must be done
    # before generating the version message)
    if args.espeak_library:
        BACKENDS['espeak'].set_library(args.espeak_library)
    if args.festival_executable:
        BACKENDS['festival'].set_executable(args.festival_executable)

    # display version information and exit
    if args.version:
        print(version.version())
        return

    # list supported languages and exit
    if args.list_languages:
        print(list_languages(args.backend))
        return

    # set default backend as espeak if not specified
    args.backend = args.backend or 'espeak'

    # configure logging according to --verbose/--quiet options
    log = get_logger(args.verbose, args.quiet)

    # configure input:output as a readable/writable streams
    streamin = setup_stream(args.input, 'r')
    log.debug('reading from %s', streamin.name)
    streamout = setup_stream(args.output, 'w')
    log.debug('writing to %s', streamout.name)

    # configure the separator for phonemes, syllables and words.
    if args.backend == 'espeak-mbrola':
        log.debug('using espeak-mbrola backend: ignoring word separator')
        sep = separator.Separator(
            phone=args.phone_separator,
            syllable=None,
            word=None)
    else:
        sep = separator.Separator(
            phone=args.phone_separator,
            syllable=args.syllable_separator,
            word=args.word_separator)
    log.debug('separator is %s', sep)

    if args.prepend_text:
        input_output_separator = sep.input_output_separator(args.prepend_text)
        log.debug(
            'prepend input text to output, separator is "%s"',
            input_output_separator)
    else:
        input_output_separator = False

    if args.punctuation_marks_is_regex:
        try:
            log.debug('punctuation marks is regex %s', args.punctuation_marks)
            args.punctuation_marks = re.compile(args.punctuation_marks)
        except re.error:
            # manually close the open streams for windows
            streamin.close()
            streamout.close()
            raise ValueError(f"can't compile regex pattern from {args.punctuation_marks}")

    # phonemize the input text
    out = phonemize(
        streamin.readlines(),
        language=args.language,
        backend=args.backend,
        separator=sep,
        strip=args.strip,
        prepend_text=args.prepend_text,
        preserve_empty_lines=args.preserve_empty_lines,
        preserve_punctuation=args.preserve_punctuation,
        punctuation_marks=args.punctuation_marks,
        with_stress=args.with_stress,
        tie=args.tie,
        language_switch=args.language_switch,
        words_mismatch=args.words_mismatch,
        njobs=args.njobs,
        logger=log)

    if out and input_output_separator:
        streamout.write(
            os.linesep.join(
                f'{line[0]} {input_output_separator} {line[1]}'
                for line in out)
            + os.linesep)
    elif out:
        streamout.write(os.linesep.join(out) + os.linesep)


if __name__ == '__main__':  # pragma: nocover
    main()
