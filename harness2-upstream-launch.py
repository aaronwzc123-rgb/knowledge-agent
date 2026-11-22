"""Forward an official CLI and cancel its process group when the browser disconnects."""

import os
import signal
import subprocess
import sys
import threading

os.environ["PATH"] = os.path.dirname(sys.executable) + os.pathsep + os.environ.get("PATH", "")
child = subprocess.Popen(sys.argv[1:], stdin=subprocess.DEVNULL, start_new_session=True)


def cancel_on_disconnect():
    os.read(0, 1)
    if child.poll() is not None:
        return
    try:
        os.killpg(child.pid, signal.SIGINT)
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    except ProcessLookupError:
        pass


threading.Thread(target=cancel_on_disconnect, daemon=True).start()
status = child.wait()
sys.exit(status if status >= 0 else 128 - status)
