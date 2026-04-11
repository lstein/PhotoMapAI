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
            if "canvas_v2_metadata" in json_data:
                json_data = {"metadata_version": 5, **json_data}
            elif "app_version" in json_data:
                if any(
                    json_data["app_version"].startswith(x) for x in ["v1.", "2.", "v2."]
                ):
                    json_data = {"metadata_version": 2, **json_data}
                elif json_data["app_version"].startswith("3."):
                    if "model" in json_data and isinstance(json_data["model"], str):
                        json_data = {"metadata_version": 2, **json_data}
                    else:
                        json_data = {"metadata_version": 3, **json_data}
                else:
                    json_data = {"metadata_version": 5, **json_data}
            elif "model_weights" in json_data:
                # v2 metadata has model_weights field
                json_data = {"metadata_version": 2, **json_data}
            else:
                json_data = {"metadata_version": 3, **json_data}

        self.metadata = self.adapter.validate_python(json_data)
        return self.metadata
