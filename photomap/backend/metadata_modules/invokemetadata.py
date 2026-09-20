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

# The discriminator values the union above accepts. ``metadata_version`` is
# PhotoMapAI's own schema tag, injected by :meth:`GenerationMetadataAdapter.parse`
# — InvokeAI has never written an integer under that name. See
# :meth:`GenerationMetadataAdapter._with_discriminator` for why that matters.
SCHEMA_VERSIONS = (2, 3, 5)

# The key InvokeAI 7 stamps its *record* version under — ``metadata_version``,
# a semver string. Because that collides with the discriminator above, the
# value is moved to this name before validation and declared on
# ``GenerationMetadata5`` so it survives the round trip.
RECORD_VERSION_FIELD = "invoke_record_version"


def looks_like_invoke_metadata(metadata: dict | None) -> bool:
    """Cheap structural check for an InvokeAI generation record.

    The single definition of "this looks like something InvokeAI produced",
    shared by the drawer formatter, the video formatter and the recall
    router so those paths cannot drift apart. ``generation_mode`` is what
    catches a video record, whose other two markers are not guaranteed.
    """
    if not metadata:
        return False
    return (
        "app_version" in metadata
        or "generation_mode" in metadata
        or "canvas_v2_metadata" in metadata
    )


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
        self.metadata = self.adapter.validate_python(
            self._with_discriminator(json_data)
        )
        return self.metadata

    @classmethod
    def _with_discriminator(cls, json_data: dict[str, Any]) -> dict[str, Any]:
        """Ensure ``metadata_version`` holds a value the union discriminates on.

        ``metadata_version`` means two different things depending on who
        wrote it, and the two collided in InvokeAI 7:

        * To *us* it is the schema tag selecting ``GenerationMetadata2`` /
          ``3`` / ``5``. It is synthesised here, from ``app_version`` and
          structural fingerprints, because InvokeAI never wrote it.
        * To InvokeAI 7 it is the version of the *record* — a semver string,
          currently ``"1.0.0"``, stamped by the ``core_metadata`` node and
          documented in its media-metadata reference.

        Left alone, an InvokeAI 7 record reaches the discriminated union
        tagged ``"1.0.0"``, matches no member, and every image and video that
        release produced degrades to the formatter's flat scalar table. So
        anything that is not one of our own tags is treated as InvokeAI's
        record version: it is preserved under ``invoke_record_version`` (a
        declared field, so it neither trips the unknown-field warning nor is
        silently lost) and our own tag is inferred in its place.
        """
        version = json_data.get("metadata_version")
        if isinstance(version, int) and version in SCHEMA_VERSIONS:
            # The ``isinstance`` guard is not redundant: ``5.0 in (2, 3, 5)``
            # is True, and the discriminated union does not accept a float.
            return json_data

        payload = dict(json_data)
        record_version = payload.pop("metadata_version", None)
        schema_version = cls._infer_metadata_version(payload)
        if record_version is not None and schema_version == 5:
            # Only v5 declares the field. v2 and v3 forbid extras, and no
            # release old enough to be read as one ever stamped a record
            # version, so there is nothing to preserve on those paths and
            # injecting the key would turn a parse into a failure.
            #
            # Stringified because the whole point of moving the value aside
            # is that a parse must not fail over it: the field is
            # informational, never rendered, and a record carrying a number
            # or anything else under this name would otherwise trade one
            # validation error for another.
            payload.setdefault(RECORD_VERSION_FIELD, str(record_version))
        return {"metadata_version": schema_version, **payload}

    @staticmethod
    def _infer_metadata_version(json_data: dict[str, Any]) -> int:
        """Guess the metadata schema version for pre-discriminator payloads.

        InvokeAI has never stamped our schema tag, so every payload needs
        this. ``app_version`` is the most authoritative signal when present —
        check it first so a v3 image that happens to carry a
        ``canvas_v2_metadata`` field isn't misclassified as v5. Structural
        fingerprints (``model_weights``, ``canvas_v2_metadata``) are the
        fallbacks for payloads without ``app_version``.
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

        # No ``app_version`` — fall back to structural fingerprints. The
        # video-only keys are among them because a video record is
        # v5-shaped; they are a backstop only, since ``core_metadata`` always
        # stamps ``app_version`` alongside them.
        if "canvas_v2_metadata" in json_data:
            return 5
        if "model_weights" in json_data:
            return 2
        if "num_frames" in json_data or "source_video" in json_data:
            return 5
        return 3
