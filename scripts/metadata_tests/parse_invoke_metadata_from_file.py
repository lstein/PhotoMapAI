#!/usr/bin/env python3
import argparse
import json
import os
import sys
from itertools import groupby
from pathlib import Path
from typing import Annotated, Any, Generator, Union

from PIL import Image
from pydantic import Field, TypeAdapter

from photomap.backend.metadata_modules.invokemetadata import GenerationMetadataAdapter


def read_records(file_path: Path) -> Generator[tuple[str, dict[str, Any]], None, None]:
    """
    Read records from a file where each record starts with ## filename.

    Args:
        file_path: Path to the file containing records

    Yields:
        Tuple of (filename, json_data) for each record
    """
    with open(file_path) as f:
        filename = ""
        for is_header, group in groupby(f, key=lambda line: line.startswith("##")):
            if is_header:
                filename = next(group).strip()[2:].strip()
            else:
                try:
                    json_data = json.loads("".join(group))
                    yield filename, json_data
                except json.JSONDecodeError as e:
                    print(f"Error parsing JSON for {filename}: {e}", file=sys.stderr)


def parse_file(file_path: Path, print_parse: bool = False) -> None:
    """
    Retrieve the metadata from the PNG file and parse its
    generation metadata from embedded JSON.

    Args:
        file_path: Path to the file to parse
        print_parse: If True, pretty-print serialized metadata on successful parse
    """
    metadata_dict = {}
    metadata_adapter = GenerationMetadataAdapter()
    for filename, metadata_dict in read_records(file_path):
        try:
            generation_metadata = metadata_adapter.parse(metadata_dict)
            print(f"## {filename}: successfully parsed")
            if print_parse:
                print(generation_metadata.model_dump_json(indent=4))
        except BrokenPipeError:
            raise
        except Exception as e:
            print(f"## {filename}: parse failed: {e}", file=sys.stderr)
            if metadata_dict is not None:
                print(
                    f"Raw data = {json.dumps(metadata_dict, indent=4)}", file=sys.stderr
                )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Parse Invoke generation metadata from a file"
    )
    parser.add_argument("file", help="Path to the file to parse")
    parser.add_argument(
        "--print_parse",
        action="store_true",
        help="Pretty-print serialized metadata on successful parse",
    )

    args = parser.parse_args()
    path = args.file

    if os.path.isfile(path):
        parse_file(Path(path), print_parse=args.print_parse)
    else:
        print(f"Error: '{path}' is not a valid file", file=sys.stderr)
        sys.exit(1)
