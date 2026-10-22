"""Use the explicitly owned One Room browser profile, never a personal browser."""
import sys
from pathlib import Path
from openadapt_flow.__main__ import main
from owned_browser import owned_browser

profile, url = Path(sys.argv[1]), sys.argv[2]
with owned_browser(profile, url) as endpoint:
    result = main(sys.argv[3:] + ["--browser-cdp-endpoint", endpoint])
sys.exit(result)
