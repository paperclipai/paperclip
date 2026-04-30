"""GraphDB exceptions."""

import rdflib.contrib.rdf4j.exceptions as rdf4j_exceptions


class GraphDBError(Exception):
    """Base class for GraphDB exceptions."""


class ResponseFormatError(GraphDBError):
    """Raised when the response format is invalid."""


class RepositoryNotHealthyError(
    GraphDBError, rdf4j_exceptions.RepositoryNotHealthyError
):
    """Raised when the repository is not healthy."""


class RepositoryNotFoundError(GraphDBError, rdf4j_exceptions.RepositoryNotFoundError):
    """Raised when the repository is not found."""


class BadRequestError(GraphDBError):
    """Raised when the request is invalid."""


class UnauthorisedError(GraphDBError):
    """Raised when the user is unauthorised."""


class ForbiddenError(GraphDBError):
    """Raised when the user is forbidden."""


class NotFoundError(GraphDBError):
    """Raised when the resource is not found."""


class ConflictError(GraphDBError):
    """Raised when the request conflicts with the current state of the server."""


class PreconditionFailedError(GraphDBError):
    """Raised when the precondition is failed."""


class InternalServerError(GraphDBError):
    """Raised when the server returns an internal server error."""


class ServiceUnavailableError(GraphDBError):
    """Raised when the server is unavailable."""
