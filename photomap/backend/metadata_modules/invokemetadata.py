"""
Wrapper for GenerationMetadata
"""

from typing import Annotated, Any

from pydantic import Field, TypeAdapter

from .invoke.invoke2metadata import GenerationMetadata2
from .invoke.invoke3metadata import GenerationMetadata3
from .invoke.invoke5metadata import GenerationMetadata5

GenerationMetadata = Annotated[
    GenerationMetadata2 | GenerationMetadata3 | GenerationMetadata5,
    Field(discriminator="metadata_version"),
]


class GenerationMetadataAdapter:
    def __init__(self):
        self.adapter = TypeAdapter(GenerationMetadata)
        self.metadata = None

    def parse(self, json_data: dict[str, Any]) -> GenerationMetadata:
        """
        Parse JSON data into a GenerationMetadata object.

        :param json_data: Dictionary containing metadata
        :type json_data: dict[str, Any]
        :return: Parsed generation metadata
        :rtype: GenerationMetadata
        """
        if "metadata_version" not in json_data:
            inferred = self._infer_metadata_version(json_data)
            json_data = {"metadata_version": inferred, **json_data}

        self.metadata = self.adapter.validate_python(json_data)
        return self.metadata

    @staticmethod
    def _infer_metadata_version(json_data: dict[str, Any]) -> int:
        """Guess the metadata schema version for pre-discriminator payloads.

        InvokeAI started stamping ``metadata_version`` only at v5, so older
        images need a heuristic. ``app_version`` is the most authoritative
        signal when present — check it first so a v3 image that happens to
        carry a ``canvas_v2_metadata`` field isn't misclassified as v5.
        Structural fingerprints (``model_weights``, ``canvas_v2_metadata``)
        are the fallbacks for payloads without ``app_version``.
        """
        app_version = json_data.get("app_version")
        if isinstance(app_version, str):
            # InvokeAI has shipped both bare and ``v``-prefixed strings,
            # e.g. ``"2.3.5"`` and ``"v2.3.5"``. Accept either form for
            # every major version we know about.
            if any(app_version.startswith(prefix) for prefix in ("v1.", "1.", "2.", "v2.")):
                return 2
            if any(app_version.startswith(prefix) for prefix in ("3.", "v3.")):
                # Some v3-era images stored ``model`` as a string instead of
                # the canonical Model object; treat those as v2 since v3's
                # schema requires a richer shape.
                if isinstance(json_data.get("model"), str):
                    return 2
                return 3
            # Any other ``app_version`` (4.x, 5.x, future) → v5.
            return 5

        # No ``app_version`` — fall back to structural fingerprints.
        if "canvas_v2_metadata" in json_data:
            return 5
        if "model_weights" in json_data:
            return 2
        return 3
