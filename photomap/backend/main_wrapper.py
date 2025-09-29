import os
import signal
import subprocess
import sys
import logging

from photomap.backend.args import get_args

logger = logging.getLogger(__name__)

def start_photomap_loop():
    """Start the PhotoMapAI server loop."""
    args = get_args()

    running = True
    exe_dir = os.path.dirname(sys.executable)
    photomap_server_exe = os.path.join(exe_dir, "photomap_server")
    args = [photomap_server_exe] + sys.argv[1:]

    while running:
        try:
            logger.info("Loading...")
            subprocess.run(args, check=True)
        except KeyboardInterrupt:
            logger.warning("Shutting down server...")
            running = False
        except subprocess.CalledProcessError as e:
            running = abs(e.returncode) == signal.SIGTERM.value
            if running:
                logger.info("Restarting server.")
            else:
                logger.error(f"Server exited with error code {e.returncode}")

if __name__ == "__main__":
    start_photomap_loop()
