"""Entry point for the packaged app (PyInstaller). From a checkout, use: python -m hacoap_manager"""

import sys

from hacoap_manager.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
