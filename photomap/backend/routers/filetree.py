import logging
import os
import platform
from pathlib import Path
from typing import Dict, List

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

from .index import check_album_lock

logger = logging.getLogger(__name__)
filetree_router = APIRouter()

# On Windows, allow browsing all drives; on Unix, use a root directory
if platform.system() == "Windows":
    ROOT_DIR = None  # Special case for Windows - browse all drives
else:
    ROOT_DIR = os.environ.get("PHOTOMAP_ALBUM_ROOT", "/")


def get_windows_drives():
    """Get list of available Windows drives"""
    import string

    drives = []
    for letter in string.ascii_uppercase:
        drive_path = Path(f"{letter}:\\")
        if drive_path.exists():
            try:
                # Test if we can access the drive
                list(drive_path.iterdir())
                drives.append(
                    {
                        "name": f"{letter}: Drive",
                        "path": str(drive_path.resolve()),  # Return absolute path
                        "hasChildren": True,
                    }
                )
            except (OSError, PermissionError):
                # Skip inaccessible drives
                continue
    return drives


def is_path_safe(path_str: str) -> bool:
    """Check if path is safe to access"""
    if platform.system() == "Windows":
        # On Windows, allow any valid drive path
        try:
            path = Path(path_str)
            # Must be absolute and exist
            return path.is_absolute() and path.exists()
        except:
            return False
    else:
        # On Unix, check if it's within ROOT_DIR or if it's an absolute path we want to allow
        try:
            path = Path(path_str).resolve()

            # If ROOT_DIR is set, check if path is within it
            if ROOT_DIR:
                root_path = Path(ROOT_DIR).resolve()
                # Allow paths within ROOT_DIR or absolute paths for browsing
                return path.is_relative_to(root_path) or path.exists()
            else:
                # If no ROOT_DIR restriction, allow any existing absolute path
                return path.exists()
        except:
            return False


@filetree_router.get("/filetree/directories", tags=["FileTree"])
async def get_directories(path: str = "", show_hidden: bool = False):
    """Get directories in the specified path"""
    check_album_lock()  # May raise a 403 exception

    # --- Path parsing and validation ---
    try:
        # Handle Windows drives
        if platform.system() == "Windows" and not path:
            drives = get_windows_drives()
            return JSONResponse(
                content={"currentPath": "", "directories": drives, "isRoot": True}
            )

        # Handle regular directory browsing
        if platform.system() == "Windows":
            if path.endswith(":"):
                dir_path = Path(f"{path}\\")
            else:
                dir_path = Path(path)
        else:
            assert ROOT_DIR is not None
            if not path:
                dir_path = Path(ROOT_DIR)
            else:
                if Path(path).is_absolute():
                    dir_path = Path(path)
                else:
                    dir_path = Path(ROOT_DIR) / path

        # Security check
        if not is_path_safe(str(dir_path)):
            raise HTTPException(status_code=403, detail="Access denied")

        # If the path doesn't exist or isn't a directory, return 404
        if not dir_path.exists() or not dir_path.is_dir():
            raise HTTPException(status_code=404, detail="Directory not found")

    except Exception as e:
        logger.error(f"Invalid path or path error: {e}")
        raise HTTPException(status_code=404, detail="Invalid or non-existent directory")

    # --- Directory listing logic ---
    try:
        # Try to trigger automount for autofs directories
        logger.info("calling os.listdir to trigger automount if needed")
        try:
            os.listdir(str(dir_path))
        except Exception:
            pass

        directories = []
        logger.info("Listing directories in: %s", dir_path)
        for entry in sorted(dir_path.iterdir()):
            if entry.is_dir():
                if not show_hidden and entry.name.startswith("."):
                    continue
                try:
                    abs_path = str(entry.resolve())
                    has_children = False
                    try:
                        has_children = any(child.is_dir() for child in entry.iterdir())
                    except (OSError, PermissionError):
                        pass
                    directories.append(
                        {
                            "name": entry.name,
                            "path": abs_path,
                            "hasChildren": has_children,
                        }
                    )
                except (OSError, PermissionError):
                    continue

        current_display = str(dir_path.resolve())
        logger.info(
            f"Current directory: {current_display}, found {len(directories)} subdirectories"
        )
        return JSONResponse(
            content={
                "currentPath": current_display,
                "directories": directories,
                "isRoot": not path,
            }
        )
    except Exception as e:
        logger.error(f"FileTree error: {e}")
        return JSONResponse(content={"error": str(e)}, status_code=500)


@filetree_router.get("/filetree/home", tags=["FileTree"])
async def get_home_directory():
    """Get the user's home directory path"""
    try:
        home_path = str(Path.home().resolve())
        return JSONResponse(content={"homePath": home_path})
    except Exception as e:
        logger.error(f"Error getting home directory: {e}")
        return JSONResponse(content={"error": str(e)}, status_code=500)
