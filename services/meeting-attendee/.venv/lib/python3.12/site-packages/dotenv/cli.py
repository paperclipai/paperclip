import json
import os
import shlex
import sys
from contextlib import contextmanager
from typing import IO, Any, Dict, Iterator, List, Optional

if sys.platform == "win32":
    from subprocess import Popen

try:
    import click
except ImportError:
    sys.stderr.write(
        "It seems python-dotenv is not installed with cli option. \n"
        'Run pip install "python-dotenv[cli]" to fix this.'
    )
    sys.exit(1)

from .main import dotenv_values, set_key, unset_key
from .version import __version__


def enumerate_env() -> Optional[str]:
    """
    Return a path for the ${pwd}/.env file.

    If pwd does not exist, return None.
    """
    try:
        cwd = os.getcwd()
    except FileNotFoundError:
        return None
    path = os.path.join(cwd, ".env")
    return path


@click.group()
@click.option(
    "-f",
    "--file",
    default=enumerate_env(),
    type=click.Path(file_okay=True),
    help="Location of the .env file, defaults to .env file in current working directory.",
)
@click.option(
    "-q",
    "--quote",
    default="always",
    type=click.Choice(["always", "never", "auto"]),
    help="Whether to quote or not the variable values. Default mode is always. This does not affect parsing.",
)
@click.option(
    "-e",
    "--export",
    default=False,
    type=click.BOOL,
    help="Whether to write the dot file as an executable bash script.",
)
@click.version_option(version=__version__)
@click.pass_context
def cli(ctx: click.Context, file: Any, quote: Any, export: Any) -> None:
    """This script is used to set, get or unset values from a .env file."""
    ctx.obj = {"QUOTE": quote, "EXPORT": export, "FILE": file}


@contextmanager
def stream_file(path: os.PathLike) -> Iterator[IO[str]]:
    """
    Open a file and yield the corresponding (decoded) stream.

    Exits with error code 2 if the file cannot be opened.
    """

    try:
        with open(path) as stream:
            yield stream
    except OSError as exc:
        print(f"Error opening env file: {exc}", file=sys.stderr)
        sys.exit(2)


@cli.command(name="list")
@click.pass_context
@click.option(
    "--format",
    "output_format",
    default="simple",
    type=click.Choice(["simple", "json", "shell", "export"]),
    help="The format in which to display the list. Default format is simple, "
    "which displays name=value without quotes.",
)
def list_values(ctx: click.Context, output_format: str) -> None:
    """Display all the stored key/value."""
    file = ctx.obj["FILE"]

    with stream_file(file) as stream:
        values = dotenv_values(stream=stream)

    if output_format == "json":
        click.echo(json.dumps(values, indent=2, sort_keys=True))
    else:
        prefix = "export " if output_format == "export" else ""
        for k in sorted(values):
            v = values[k]
            if v is not None:
                if output_format in ("export", "shell"):
                    v = shlex.quote(v)
                click.echo(f"{prefix}{k}={v}")


@cli.command(name="set")
@click.pass_context
@click.argument("key", required=True)
@click.argument("value", required=True)
def set_value(ctx: click.Context, key: Any, value: Any) -> None:
    """
    Store the given key/value.

    This doesn't follow symlinks, to avoid accidentally modifying a file at a
    potentially untrusted path.
    """

    file = ctx.obj["FILE"]
    quote = ctx.obj["QUOTE"]
    export = ctx.obj["EXPORT"]
    success, key, value = set_key(file, key, value, quote, export)
    if success:
        click.echo(f"{key}={value}")
    else:
        sys.exit(1)


@cli.command()
@click.pass_context
@click.argument("key", required=True)
def get(ctx: click.Context, key: Any) -> None:
    """Retrieve the value for the given key."""
    file = ctx.obj["FILE"]

    with stream_file(file) as stream:
        values = dotenv_values(stream=stream)

    stored_value = values.get(key)
    if stored_value:
        click.echo(stored_value)
    else:
        sys.exit(1)


@cli.command()
@click.pass_context
@click.argument("key", required=True)
def unset(ctx: click.Context, key: Any) -> None:
    """
    Removes the given key.

    This doesn't follow symlinks, to avoid accidentally modifying a file at a
    potentially untrusted path.
    """
    file = ctx.obj["FILE"]
    quote = ctx.obj["QUOTE"]
    success, key = unset_key(file, key, quote)
    if success:
        click.echo(f"Successfully removed {key}")
    else:
        sys.exit(1)


@cli.command(
    context_settings={
        "allow_extra_args": True,
        "allow_interspersed_args": False,
        "ignore_unknown_options": True,
    }
)
@click.pass_context
@click.option(
    "--override/--no-override",
    default=True,
    help="Override variables from the environment file with those from the .env file.",
)
@click.argument("commandline", nargs=-1, type=click.UNPROCESSED)
def run(ctx: click.Context, override: bool, commandline: tuple[str, ...]) -> None:
    """Run command with environment variables present."""
    file = ctx.obj["FILE"]
    if not os.path.isfile(file):
        raise click.BadParameter(
            f"Invalid value for '-f' \"{file}\" does not exist.", ctx=ctx
        )
    dotenv_as_dict = {
        k: v
        for (k, v) in dotenv_values(file).items()
        if v is not None and (override or k not in os.environ)
    }

    if not commandline:
        click.echo("No command given.")
        sys.exit(1)

    run_command([*commandline, *ctx.args], dotenv_as_dict)


def run_command(command: List[str], env: Dict[str, str]) -> None:
    """Replace the current process with the specified command.

    Replaces the current process with the specified command and the variables from `env`
    added in the current environment variables.

    Parameters
    ----------
    command: List[str]
        The command and it's parameters
    env: Dict
        The additional environment variables

    Returns
    -------
    None
        This function does not return any value. It replaces the current process with the new one.

    """
    # copy the current environment variables and add the vales from
    # `env`
    cmd_env = os.environ.copy()
    cmd_env.update(env)

    if sys.platform == "win32":
        # execvpe on Windows returns control immediately
        # rather than once the command has finished.
        p = Popen(command, universal_newlines=True, bufsize=0, shell=False, env=cmd_env)
        _, _ = p.communicate()

        sys.exit(p.returncode)
    else:
        os.execvpe(command[0], args=command, env=cmd_env)
