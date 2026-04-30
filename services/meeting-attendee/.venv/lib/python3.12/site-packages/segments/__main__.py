"""
CLI for the segments package.
"""
import sys
import logging
import pathlib
import argparse

from segments import Tokenizer, Profile


class ParserError(Exception):  # pylint: disable=C0115
    pass


def tokenize(args):
    """
    Tokenize a string (passed as argument or read from stdin)

    segments [--profile=PATH/TO/PROFILE] tokenize [STRING]
    """
    if args.profile and not pathlib.Path(args.profile).exists():  # pragma: no cover
        raise ParserError('--profile must be a path for an existing file')
    print(Tokenizer(profile=args.profile)(_read(args), column=args.mapping))


def profile(args):
    """
    Create an orthography profile for a string (passed as argument or read from stdin)

    segments profile [STRING]
    """
    print(Profile.from_text(_read(args)))


def _read(args):
    string = args.args[0] if args.args else sys.stdin.read()
    if not isinstance(string, str):
        string = string.decode(args.encoding)
    return string.strip()


def main(parsed_args=None):  # pylint: disable=C0116
    commands = {'tokenize': tokenize, 'profile': profile}
    logging.basicConfig()
    parser = argparse.ArgumentParser(
        description="Main command line interface of the segments package.",
        epilog="Use '%(prog)s help <cmd>' to get help about individual commands.")
    parser.add_argument("--verbosity", help="increase output verbosity")
    parser.add_argument('command', help=' | '.join(commands))
    parser.add_argument('args', nargs=argparse.REMAINDER)
    parser.add_argument("--encoding", help='input encoding', default="utf8")
    parser.add_argument("--profile", help='path to an orthography profile', default=None)
    parser.add_argument(
        "--mapping",
        help='column name in ortho profile to map graphemes',
        default=Profile.GRAPHEME_COL)

    args = parsed_args or parser.parse_args()
    if args.command == 'help' and len(args.args):
        # As help text for individual commands we simply re-use the docstrings of the
        # callables registered for the command:
        print(commands[args.args[0]].__doc__.strip()
              if args.args[0] in commands else f"Invalid command: '{args.args[0]}'")
    else:
        if args.command not in commands:
            print('invalid command')
            parser.print_help()
            sys.exit(64)
        try:
            commands[args.command](args)
        except ParserError as e:
            print(e)
            print(commands[args.command].__doc__.strip())
            sys.exit(64)
        except Exception as e:  # pragma: no cover  # pylint: disable=W0718
            print(e)
            sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':  # pragma: no cover
    main()
