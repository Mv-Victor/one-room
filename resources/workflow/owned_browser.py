"""Launch one locally owned browser without nesting Playwright sync event loops."""
import subprocess
import os
import signal
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright


@contextmanager
def owned_browser(profile: Path, url: str):
    parent = os.getppid()
    stopped = threading.Event()
    def guard_parent():
        while not stopped.wait(0.5):
            if os.getppid() != parent:
                if os.getpgrp() == os.getpid():
                    os.killpg(os.getpgrp(), signal.SIGTERM)
                else:
                    os.kill(os.getpid(), signal.SIGTERM)
                return
    threading.Thread(target=guard_parent, daemon=True).start()
    profile.mkdir(parents=True, exist_ok=True)
    port_file = profile / "DevToolsActivePort"
    port_file.unlink(missing_ok=True)
    with sync_playwright() as playwright:
        executable = playwright.chromium.executable_path
    child = subprocess.Popen([
        executable, f"--user-data-dir={profile}", "--remote-debugging-port=0",
        "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
        "--lang=zh-CN", url,
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError("本地浏览器启动失败")
            try:
                port = port_file.read_text().splitlines()[0]
                endpoint = f"http://127.0.0.1:{port}"
                with urlopen(endpoint + "/json/list", timeout=1) as response:
                    if response.status == 200:
                        break
            except (OSError, IndexError):
                pass
            time.sleep(0.1)
        else:
            raise RuntimeError("等待本地浏览器超时")
        yield endpoint
    finally:
        stopped.set()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
