import signal
import subprocess
import sys


def start_photomap():
    """Start the PhotoMapAI server loop."""
    running = True
    args = ["photomap_server"] + sys.argv[1:]

    while running:
        try:
            subprocess.run(args, check=True)
        except KeyboardInterrupt:
            print("Shutting down server...")
            running = False
        except subprocess.CalledProcessError as e:
            print(f"Server exited with error: {e.returncode}")
            running = abs(e.returncode) == signal.SIGTERM.value


if __name__ == "__main__":
    start_photomap()
