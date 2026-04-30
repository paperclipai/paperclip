
"""
Module to expose more detailed version info for the installed `numpy`
"""
version = "2.4.4"
__version__ = version
full_version = version

git_revision = "be93fe2960dbf49b4647f5783c66d967fb2c65b5"
release = 'dev' not in version and '+' not in version
short_version = version.split("+")[0]
