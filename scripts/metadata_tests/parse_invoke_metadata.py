#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path
from typing import Annotated, Any, Union

from PIL import Image
from pydantic import Field, TypeAdapter

from photomap.backend.metadata_modules.invokemetadata import (
    GenerationMetadata,
    GenerationMetadataAdapter,
)


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
q    """
    metadata_dict = {}
    try:
        metadata_tags = ["invokeai_metadata", "Sd-metadata", "sd-metadata"]
        metadata_adapter = GenerationMetadataAdapter()
        with Image.open(file_path) as img:
            for tag in metadata_tags:
                if tag in img.info:
                    metadata_json = img.info[tag]
                    metadata_dict = json.loads(metadata_json)
                    generation_metadata = metadata_adapter.parse(metadata_dict)
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
