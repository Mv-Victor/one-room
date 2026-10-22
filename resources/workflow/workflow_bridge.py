"""Local bridge to the pinned OpenAdapt Flow API. No model or hosted service."""
import json
import sys
from pathlib import Path

from openadapt_flow.compiler import compile_recording
from openadapt_flow.interactive_recorder import InteractiveRecorder
import time
from owned_browser import owned_browser


def emit(event, **values):
    print(json.dumps({"event": event, **values}, ensure_ascii=False), flush=True)


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    root = Path(config["root"])
    profile = root.parent / "browser-profile"
    with owned_browser(profile, config["url"]) as endpoint:
        emit("browser_ready")
        while not (root / "arm").exists():
            if (root / "stop").exists():
                raise ValueError("已取消，未记录操作")
            time.sleep(0.1)
        recorder = InteractiveRecorder(
            config["url"], root / "recording",
            param_fields=tuple(config["parameterFields"]),
            secret_fields=tuple(config["secretFields"]), cdp_endpoint=endpoint,
            stop_when=lambda: (root / "stop").exists(),
        )
        recorder.start()
        emit("recording")
        recorder.run()
    emit("compiling")
    workflow = compile_recording(root / "recording", root / "bundle", name=config["title"])
    if not workflow.steps:
        raise ValueError("录制没有有效步骤，请重新录制")
    if workflow.secret_params:
        raise ValueError("流程包含登录或敏感字段，请登录后重新录制业务步骤")
    emit("ready", parameters=workflow.params, steps=len(workflow.steps))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit("failed", error=str(error))
        sys.exit(1)
