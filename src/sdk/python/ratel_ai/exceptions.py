"""Typed embedding and artifact errors, surfaced from the native binding.

``EmbedderError`` subclasses ``RuntimeError`` so existing ``except RuntimeError``
handlers keep working; ``DimensionMismatchError`` subclasses it specifically for
vector-width mismatches. A model-identity mismatch remains an ``EmbedderError``.
Invalid embedding *config* (a bad source combination) is raised as a plain
``ValueError`` at construction.

``ArtifactError`` / ``IncompatibleMergeError`` cover artifact construction
failures; SDK merge composition is internal and there is no public Python merge
API. ``ArtifactWarmError`` covers warm failures and carries ``code`` /
``missing`` attributes set by the native binding.

``RetrieverError`` is raised by, or for, a caller-supplied ranking function
(``retrieve_fn`` / ``reranker_fn``, ADR-0027); the Jev and OpenAI Decisions plugins
raise it for every failure.

``RegistryBusyError`` is the refusal a synchronous registry mutation still
raises while an operation owns the registry.
"""

from __future__ import annotations

from ._native import (
    ArtifactError,
    ArtifactWarmError,
    DimensionMismatchError,
    EmbedderError,
    IncompatibleMergeError,
)

_REGISTRY_BUSY = "registry busy; await the active operation"


class RegistryBusyError(RuntimeError):
    """A synchronous registry mutation was refused: an operation owns the registry.

    The operation is a dense one (a semantic or hybrid search, an embedding
    pass, an artifact build or warm) or a queued ``register``. ``register``
    itself does not raise it while it can wait: on a running event loop it
    returns an awaitable that applies the write once the operation settles. It
    comes from the calls that cannot wait, such as ``SkillCatalog.replace_all``,
    ``set_trace_sink``, ``experimental_enable_adaptive_ranking``, and a
    ``register`` called with no running event loop. Retryable: await the
    operation in flight, then call again.

    A ``RuntimeError`` with the message the plain ``RuntimeError`` carried, so
    existing ``except RuntimeError`` handlers and message checks keep working.
    Mirrors the TypeScript SDK's ``RegistryBusyError``.
    """

    def __init__(self, message: str = _REGISTRY_BUSY) -> None:
        """Create the error; the message defaults to the one the refusal always had."""
        super().__init__(message)


class RetrieverError(RuntimeError):
    """A retrieve or rerank function failed (ADR-0027).

    Raise it from your own ``retrieve_fn`` / ``reranker_fn`` to control what a
    search does with the failure; the Jev plugin (`ratel_jev_plugin`) and the
    OpenAI Decisions plugin (`ratel_openai_decision_plugin`) raise it for every
    failure. As a **reranker**, one with ``transient=True`` does
    not fail the search: it returns the first stage's order and records
    ``rerank_fallback:<code>`` on the trace. Anything else a function raises,
    including a non-transient ``RetrieverError``, fails the search.

    The plugins' codes: ``"Config"``, ``"Unauthorized"``, ``"InvalidRequest"``
    (not transient); ``"RateLimited"``, ``"Overloaded"``, ``"Timeout"``,
    ``"Unreachable"``, ``"Http"``, ``"Malformed"``, and ``"Refused"`` (the
    Decisions model declined to answer) (transient).

    Attributes:
        code: stable machine-readable discriminant.
        transient: whether a retry may succeed.
        status: the HTTP status, when the model's service sent one.
        retry_after_secs: seconds the service asked to wait, when it sent
            ``Retry-After``.
    """

    def __init__(
        self,
        message: str,
        code: str,
        *,
        transient: bool = False,
        status: int | None = None,
        retry_after_secs: int | None = None,
    ) -> None:
        """Create the error; ``transient`` defaults to ``False``."""
        super().__init__(message)
        self.code = code
        self.transient = transient
        self.status = status
        self.retry_after_secs = retry_after_secs


__all__ = [
    "ArtifactError",
    "ArtifactWarmError",
    "DimensionMismatchError",
    "EmbedderError",
    "IncompatibleMergeError",
    "RegistryBusyError",
    "RetrieverError",
]
