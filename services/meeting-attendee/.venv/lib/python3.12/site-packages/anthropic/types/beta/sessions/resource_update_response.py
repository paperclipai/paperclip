# File generated from our OpenAPI spec by Stainless. See CONTRIBUTING.md for details.

from typing import Union
from typing_extensions import Annotated, TypeAlias

from ...._utils import PropertyInfo
from .beta_managed_agents_file_resource import BetaManagedAgentsFileResource
from .beta_managed_agents_memory_store_resource import BetaManagedAgentsMemoryStoreResource
from .beta_managed_agents_github_repository_resource import BetaManagedAgentsGitHubRepositoryResource

__all__ = ["ResourceUpdateResponse"]

ResourceUpdateResponse: TypeAlias = Annotated[
    Union[
        BetaManagedAgentsGitHubRepositoryResource, BetaManagedAgentsFileResource, BetaManagedAgentsMemoryStoreResource
    ],
    PropertyInfo(discriminator="type"),
]
