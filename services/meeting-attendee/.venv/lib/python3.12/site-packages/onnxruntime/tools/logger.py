# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import logging


def get_logger(name, level=logging.DEBUG):
    logging.basicConfig(format="%(asctime)s %(name)s [%(levelname)s] - %(message)s")
    logger = logging.getLogger(name)
    logger.setLevel(level)
    return logger
