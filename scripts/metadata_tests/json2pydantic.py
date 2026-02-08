#!/usr/bin/env python3
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Set


def json_to_pydantic_models(
    json_data: Dict[str, Any], model_name: str = "Model"
) -> str:
    """
    Convert a JSON object to Pydantic model class definitions.

    Args:
        json_data: Dictionary containing the JSON structure
        model_name: Name for the root model class

    Returns:
        String containing Pydantic model class definitions
    """
    models: Dict[str, Dict[str, str]] = {}
    imports: Set[str] = {"from pydantic import BaseModel"}

    def infer_type(value: Any) -> str:
        """Infer Python type from a JSON value."""
        if value is None:
            return "Optional[Any]"
        elif isinstance(value, bool):
            return "bool"
        elif isinstance(value, int):
            return "int"
        elif isinstance(value, float):
            return "float"
        elif isinstance(value, str):
            return "str"
        elif isinstance(value, list):
            if value:
                # Analyze first element to determine list type
                item_type = infer_type(value[0])
                return f"List[{item_type}]"
            return "List[Any]"
        elif isinstance(value, dict):
            return "Dict[str, Any]"
        return "Any"

    def process_object(obj: Dict[str, Any], class_name: str) -> None:
        """Recursively process JSON objects and create model classes."""
        fields: Dict[str, str] = {}

        for key, value in obj.items():
            if isinstance(value, dict):
                # Create nested model
                nested_class_name = "".join(
                    word.capitalize() for word in key.split("_")
                )
                process_object(value, nested_class_name)
                fields[key] = nested_class_name
            elif isinstance(value, list) and value and isinstance(value[0], dict):
                # List of objects - create model for first item
                item_class_name = "".join(
                    word.capitalize() for word in key.rstrip("s").split("_")
                )
                process_object(value[0], item_class_name)
                fields[key] = f"List[{item_class_name}]"
            else:
                fields[key] = infer_type(value)

        models[class_name] = fields

    # Process the root object
    process_object(json_data, model_name)

    # Add Optional import if needed
    if any(
        "Optional" in field_type
        for fields in models.values()
        for field_type in fields.values()
    ):
        imports.add("from typing import Optional")

    # Add List, Dict, Any imports if needed
    all_types = "".join(str(fields) for fields in models.values())
    if "List[" in all_types:
        imports.add("from typing import List")
    if "Dict[" in all_types:
        imports.add("from typing import Dict")
    if "Any" in all_types:
        imports.add("from typing import Any")

    # Generate output
    output = "\n".join(sorted(imports)) + "\n\n"

    # Output models in dependency order (nested first)
    for class_name in sorted(models.keys()):
        fields = models[class_name]
        output += f"class {class_name}(BaseModel):\n"
        for field_name, field_type in sorted(fields.items()):
            output += f"    {field_name}: {field_type}\n"
        output += "\n"

    return output


# Example usage
if __name__ == "__main__":
    # read JSON from a file passed on the command line
    if len(sys.argv) != 2:
        print("Usage: python json2pydantic.py <path_to_json_file>")
        sys.exit(1)
    json_file_path = Path(sys.argv[1])
    with json_file_path.open("r", encoding="utf-8") as f:
        example_json = json.load(f)
    pydantic_code = json_to_pydantic_models(example_json, "GenerationMetadata")
    print(pydantic_code)
