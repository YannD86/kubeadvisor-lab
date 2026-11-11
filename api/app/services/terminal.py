"""PTY sessions bridged to WebSockets (shell or k9s) for the lab terminal."""
from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import shutil
import signal
import struct
import termios
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect

from app.config import LAB_HOME, ROOT, WORK_DIR, script_env

RCFILE = LAB_HOME / "bashrc"


def write_rcfile() -> Path:
    RCFILE.write_text(
        r"""
[ -f /etc/bash.bashrc ] && source /etc/bash.bashrc
[ -f "$HOME/.bashrc" ] && source "$HOME/.bashrc" 2>/dev/null
export PS1='\[\e[1;36m\]sre-labs\[\e[0m\]${LAB_SCENARIO:+\[\e[2m\]:$LAB_SCENARIO\[\e[0m\]} \[\e[1;33m\]\W\[\e[0m\] \$ '
alias k=kubectl
alias kn='kubectl -n "${LAB_NAMESPACE:-default}"'
command -v kubectl >/dev/null && source <(kubectl completion bash) 2>/dev/null && complete -o default -F __start_kubectl k
command -v helm >/dev/null && source <(helm completion bash) 2>/dev/null
command -v flux >/dev/null && source <(flux completion bash) 2>/dev/null
[ -f "$KUBECONFIG" ] || [ -z "${LAB_ROOT:-}" ] || bash "$LAB_ROOT/cluster/ensure-kubeconfig.sh" >/dev/null 2>&1
echo -e "\e[1;36m  SRE Kube Labs terminal\e[0m  kubectl / helm / flux / k9s ready  (alias: k, kn)"
if ! kubectl get --raw /readyz --request-timeout=3s >/dev/null 2>&1; then
  echo -e "  \e[1;33mno lab cluster reachable\e[0m  (KUBECONFIG=$KUBECONFIG)"
  echo -e "  kubectl will fail until the cluster exists: create or repair it from the Cluster page, or run: bash \"$LAB_ROOT/cluster/up.sh\""
fi
if [ -n "${LAB_SCENARIO:-}" ]; then
  echo -e "  scenario: \e[1m$LAB_SCENARIO\e[0m   namespace: \e[1m${LAB_NAMESPACE:-default}\e[0m"
  echo -e "  lab commands: \e[1mlab check\e[0m | \e[1mlab hint\e[0m | \e[1mlab brief\e[0m | \e[1mlab solution\e[0m | \e[1mlab reset\e[0m | \e[1mk9s\e[0m"
fi
echo
printf '\033]777;lab-ready\007'   # invisible marker: the web terminal holds queued "Run" input until the shell is ready
"""
    )
    return RCFILE


class PtySession:
    def __init__(self, argv: list[str], env: dict, cwd: str, cols: int = 120, rows: int = 32):
        self.argv, self.env, self.cwd = argv, env, cwd
        self.cols, self.rows = cols, rows
        self.pid = -1
        self.fd = -1

    def spawn(self) -> None:
        pid, fd = pty.fork()
        if pid == 0:  # child: never return into the server's event loop
            try:
                try:
                    os.chdir(self.cwd)
                except OSError:
                    pass
                os.execvpe(self.argv[0], self.argv, self.env)
            except BaseException as e:  # noqa: BLE001
                os.write(2, f"failed to start {self.argv[0]}: {e}\r\n".encode())
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd
        self.resize(self.cols, self.rows)

    def resize(self, cols: int, rows: int) -> None:
        self.cols, self.rows = max(20, cols), max(5, rows)
        if self.fd >= 0:
            fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, self.cols, 0, 0))

    def close(self) -> None:
        if self.pid > 0:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                pass
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except OSError:
                pass
        self.pid, self.fd = -1, -1


def build_session(mode: str, scenario: str | None, namespace: str | None, cols: int, rows: int) -> PtySession:
    extra = {"LAB_SCENARIO": scenario or "", "LAB_NAMESPACE": namespace or "", "HOME": os.environ.get("HOME", "/tmp")}
    if scenario:
        wd = WORK_DIR / scenario
        wd.mkdir(parents=True, exist_ok=True)
        extra["LAB_WORKDIR"] = str(wd)
        cwd = str(wd)
    else:
        cwd = str(WORK_DIR)
    env = script_env(extra)
    env["COLUMNS"], env["LINES"] = str(cols), str(rows)
    if mode == "k9s":
        if not shutil.which("k9s"):
            argv = ["bash", "-c", "echo 'k9s is not installed (brew install k9s)'; exec bash --rcfile " + str(write_rcfile())]
        else:
            argv = ["k9s", "--headless=false"]
            if namespace:
                argv += ["-n", namespace]
            else:
                argv += ["-A"]
    else:
        argv = ["bash", "--rcfile", str(write_rcfile())]
    return PtySession(argv, env, cwd, cols, rows)


async def bridge(ws: WebSocket, session: PtySession) -> None:
    """Pump bytes between the WebSocket and the PTY until either side closes."""
    loop = asyncio.get_running_loop()
    session.spawn()
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def on_readable():
        try:
            data = os.read(session.fd, 65536)
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(session.fd)
            queue.put_nowait(None)
        else:
            queue.put_nowait(data)

    loop.add_reader(session.fd, on_readable)

    async def to_ws():
        while True:
            data = await queue.get()
            if data is None:
                break
            await ws.send_bytes(data)

    async def from_ws():
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                os.write(session.fd, msg["bytes"])
            elif msg.get("text") is not None:
                text = msg["text"]
                if text.startswith("\x01{"):  # control frame: \x01{"resize":[cols,rows]}
                    try:
                        import json
                        ctl = json.loads(text[1:])
                        if "resize" in ctl:
                            session.resize(int(ctl["resize"][0]), int(ctl["resize"][1]))
                    except Exception:  # noqa: BLE001
                        pass
                else:
                    os.write(session.fd, text.encode())

    t1 = asyncio.create_task(to_ws())
    t2 = asyncio.create_task(from_ws())
    try:
        done, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    except WebSocketDisconnect:
        pass
    finally:
        try:
            loop.remove_reader(session.fd)
        except Exception:  # noqa: BLE001
            pass
        session.close()
        try:
            await ws.close()
        except Exception:  # noqa: BLE001
            pass
