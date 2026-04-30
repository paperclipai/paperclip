"""
Provide a way to enable logging by setting LOG_LEVEL environment variable
"""

import logging
import os

def _create_logger():
    """
    Create a logger with standard output
    Usage: LOG_LEVEL=DEBUG python <script.py>
    """

    handler = logging.StreamHandler()
    fmt = "%(levelname)-8s [%(filename)s:%(lineno)d] %(message)s"
    handler.setFormatter(logging.Formatter(fmt=fmt))
    # Get log level from LOG_LEVEL environment variable
    log_level = os.getenv("LOG_LEVEL", "WARNING").upper()
    logger = logging.getLogger(__package__)
    logger.setLevel(level=getattr(logging, log_level, logging.WARNING))
    # Setup logging to stdout
    if not logger.handlers:
        logger.addHandler(handler)
    return logger


log = _create_logger()
