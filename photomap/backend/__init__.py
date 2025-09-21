import logging

from colorama import Fore, Style
from colorama import init as colorama_init

colorama_init()

LEVEL_COLORS = {
    "DEBUG": Fore.CYAN,
    "INFO": Fore.GREEN,
    "WARNING": Fore.YELLOW,
    "ERROR": Fore.RED,
    "CRITICAL": Fore.MAGENTA,
}


class UvicornStyleFormatter(logging.Formatter):
    def format(self, record):
        levelname = record.levelname
        color = LEVEL_COLORS.get(levelname, "")
        reset = Style.RESET_ALL
        record.levelname = f"{color}{levelname}{reset}"
        record.uvicorn_pad = " " * (9 - len(levelname))  # 9 = 4 (max level) + 5 spaces
        return super().format(record)


formatter = UvicornStyleFormatter("%(levelname)s:%(uvicorn_pad)s%(message)s")

handler = logging.StreamHandler()
handler.setFormatter(formatter)

root = logging.getLogger()
root.handlers.clear()
root.addHandler(handler)
root.setLevel(logging.INFO)
