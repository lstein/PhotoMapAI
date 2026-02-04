import json
import os
import sys
from pathlib import Path
from typing import Annotated, Any, Union

from canvas2metadata import GenerationMetadataCanvas
from invoke2metadata import GenerationMetadata2
from invoke3metadata import GenerationMetadata3
from invoke5metadata import GenerationMetadata5
from PIL import Image
from pydantic import Field, TypeAdapter

GenerationMetadata = Annotated[
    Union[
        GenerationMetadata2,
        GenerationMetadata3,
        GenerationMetadata5,
        GenerationMetadataCanvas,
    ],
    Field(discriminator="metadata_version"),
]


def add_image_type_discriminator(image: dict[str, Any]) -> None:
    """Add image_type discriminator to an image object based on its fields."""
    if "dataURL" in image:
        image["image_type"] = "dataURL"
    elif "image_name" in image:
        image["image_type"] = "file"


def preprocess_canvas_metadata(json_data: dict[str, Any]) -> dict[str, Any]:
    """Preprocess canvas metadata to add type discriminators to image objects."""
    if "canvas_v2_metadata" not in json_data:
        return json_data

    canvas_metadata = json_data["canvas_v2_metadata"]

    def process_image_in_dict(obj: dict[str, Any], key: str = "image") -> None:
        """Add type discriminator to an image object if it exists."""
        if key in obj and obj[key]:
            add_image_type_discriminator(obj[key])

    def process_objects(objects: list[dict[str, Any]]) -> None:
        """Process a list of objects that may contain images."""
        for obj in objects:
            process_image_in_dict(obj)

    def process_reference_images(ref_images: list[dict[str, Any]]) -> None:
        """Process reference images with ipAdapter."""
        for ref_image in ref_images:
            if "ipAdapter" in ref_image and ref_image["ipAdapter"]:
                process_image_in_dict(ref_image["ipAdapter"])

    # Process layers with objects (rasterLayers, inpaintMasks, controlLayers)
    for layer_key in ["rasterLayers", "inpaintMasks", "controlLayers"]:
        if layer_key in canvas_metadata and canvas_metadata[layer_key]:
            for layer in canvas_metadata[layer_key]:
                if "objects" in layer and layer["objects"]:
                    process_objects(layer["objects"])

    # Process top-level referenceImages
    if "referenceImages" in canvas_metadata and canvas_metadata["referenceImages"]:
        process_reference_images(canvas_metadata["referenceImages"])

    # Process regionalGuidance with objects and referenceImages
    if "regionalGuidance" in canvas_metadata and canvas_metadata["regionalGuidance"]:
        for region in canvas_metadata["regionalGuidance"]:
            if "objects" in region and region["objects"]:
                process_objects(region["objects"])
            if "referenceImages" in region and region["referenceImages"]:
                process_reference_images(region["referenceImages"])

    return json_data


def parse_generation_metadata(json_data: dict[str, Any]) -> GenerationMetadata:
    if "metadata_version" not in json_data:
        if "canvas_v2_metadata" in json_data:
            json_data = {"metadata_version": "canvas", **json_data}
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

    # Preprocess canvas metadata to add image type discriminators
    json_data = preprocess_canvas_metadata(json_data)

    return TypeAdapter(GenerationMetadata).validate_python(json_data)


def traverse_directory(directory: str) -> None:
    """
    Traverse the specified directory to find PNG files and parse their
    generation metadata from embedded JSON.

    Args:
        directory: Path to the directory to traverse
    """
    dir_path = Path(directory)

    for file_path in dir_path.rglob("*.png"):
        parse_file(file_path)


def parse_file(file_path: Path) -> None:
    """
    Retrieve the metadata from the PNG file and parse its
    generation metadata from embedded JSON.

    Args:
        file_path: Path to the file to parse
    """
    try:
        metadata_tags = ["invokeai_metadata", "Sd-metadata", "sd-metadata"]
        metadata_dict = None
        with Image.open(file_path) as img:
            for tag in metadata_tags:
                if tag in img.info:
                    metadata_json = img.info[tag]
                    metadata_dict = json.loads(metadata_json)
                    generation_metadata = parse_generation_metadata(metadata_dict)
                    print(f"## File: {file_path}")
                    print(generation_metadata.model_dump_json(indent=4))
    except Exception as e:
        print(f"Error processing file {file_path}: {e}", file=sys.stderr)
        if metadata_dict is not None:
            print(f"Raw data = {json.dumps(metadata_dict, indent=4)}", file=sys.stderr)


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "."

    if os.path.isfile(path):
        parse_file(Path(path))
    elif os.path.isdir(path):
        traverse_directory(path)
    else:
        print(f"Error: '{path}' is not a valid directory", file=sys.stderr)
        sys.exit(1)
