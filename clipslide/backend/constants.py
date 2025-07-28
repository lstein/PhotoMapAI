'''
clipslide.backend.constants
Constants used elsewhere in the application.
Also defines the function get_package_resource_path to retrieve paths to static files or templates.
'''

from pathlib import Path
try:
    # Python 3.9+
    from importlib.resources import files
except ImportError:
    # Python 3.8 fallback
    from importlib_resources import files


# Constants
DEFAULT_ALBUM = "family"
DEFAULT_DELAY = 5
DEFAULT_MODE = "random"
DEFAULT_TOP_K = 20

def get_package_resource_path(resource_name: str) -> str:
    """Get the path to a package resource (static files or templates)."""
    try:
        package_files = files("clipslide.frontend")
        resource_path = package_files / resource_name

        if hasattr(resource_path, "as_posix"):
            return str(resource_path)
        else:
            with resource_path as path:
                return str(path)
    except Exception:
        return str(Path(__file__).parent / resource_name)
