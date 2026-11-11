"""Run every ```bash block of realm lessons through the lab terminal and report commands that fail.

Usage (local runner started, kind cluster up):
    api/.venv/bin/python scripts/sweep_lessons.py content/lessons/components/*.md > /tmp/sweep.txt

Each block is sent line by line to ws://127.0.0.1:10201/ws/terminal exactly as the lesson's "Run" button
would send it. A line is marked FAIL when it exits non-zero or prints an error-looking word, so expect
false positives (log excerpts containing "error", an intentional "no" from kubectl auth can-i): read the
captured output under each FAIL. Interactive or blocking lines (shells, watches, infinite loops) are
skipped and listed as SKIP. Lessons that assume a loaded scenario must be run with that scenario loaded.
The commands really run against the lab cluster and leave the objects a learner would leave.
"""
import asyncio
import re
import sys
from pathlib import Path

import websockets

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PROMPT = re.compile(r"sre-labs \S+ \$ $")
SKIP = re.compile(
    r"(\s-it\s.*--\s*(sh|bash|/bin/sh|/bin/bash)\s*$)|(^k9s)|(\bwatch\b)|(\s-w\s*(#.*)?$)|(\s-f\s*(#.*)?$)|(logs .* -f\b)"
    r"|(port-forward)|(exec -it)|(read -p)|(while true)|(--follow)|(\bless\b)|(\bvi\b|\bvim\b|\bnano\b)|(^\$ )"
)
ERR = re.compile(
    r"(error|Error|ERROR|not found|No such file|refused|Forbidden|forbidden|Unable|unknown flag|unknown command|"
    r"exit code|invalid|Invalid|cannot|failed|FAILED|No resources found|unauthorized|timed out)"
)


def blocks(path: Path) -> list[str]:
    out, cur, inb = [], [], False
    for line in path.read_text().splitlines():
        if not inb and line.startswith("```bash"):
            inb, cur = True, []
        elif inb and line.startswith("```"):
            inb = False
            out.append("\n".join(cur))
        elif inb:
            cur.append(line)
    return out


async def run_lesson(path: Path) -> None:
    print(f"\n##### {path}")
    url = "ws://127.0.0.1:10201/ws/terminal?mode=shell&cols=200&rows=50"
    async with websockets.connect(url, max_size=None) as ws:
        buf = ""

        async def drain(t: float) -> None:
            nonlocal buf
            try:
                while True:
                    m = await asyncio.wait_for(ws.recv(), timeout=t)
                    buf += ANSI.sub("", m.decode(errors="replace") if isinstance(m, bytes) else m)
            except (asyncio.TimeoutError, websockets.ConnectionClosed):
                pass

        async def until_prompt(max_s: float) -> str:
            nonlocal buf
            start = len(buf)
            deadline = asyncio.get_event_loop().time() + max_s
            while asyncio.get_event_loop().time() < deadline:
                await drain(0.4)
                if PROMPT.search(buf[start:].rstrip("\r\n") + "\n"[:0]) or PROMPT.search(buf[start:]):
                    break
            return buf[start:]

        await drain(3.0)
        # make every line's exit status visible
        await ws.send("export PROMPT_COMMAND='rc=$?; [ $rc -ne 0 ] && echo \"__RC=$rc\"'\n")
        await until_prompt(5)
        for bi, block in enumerate(blocks(path)):
            lines = block.splitlines()
            i = 0
            while i < len(lines):
                line = lines[i]
                # heredoc: send through the terminator
                chunk = [line]
                m = re.search(r"<<-?\s*'?(\w+)'?", line)
                if m:
                    term = m.group(1)
                    while i + 1 < len(lines) and lines[i].strip() != term:
                        i += 1
                        chunk.append(lines[i])
                i += 1
                text = "\n".join(chunk)
                if not text.strip() or text.strip().startswith("#"):
                    continue
                if SKIP.search(re.sub(r"\s+#.*$", "", text, flags=re.M)):
                    print(f"  SKIP  {text.splitlines()[0][:110]}")
                    continue
                await ws.send(text + "\n")
                out = await until_prompt(40)
                body = "\n".join(out.splitlines()[1:-1])  # drop echo + next prompt
                rc = re.search(r"__RC=(\d+)", body)
                flagged = rc or ERR.search(body)
                tag = "FAIL" if flagged else " ok "
                print(f"  {tag}  {text.splitlines()[0][:110]}")
                if flagged:
                    for l in body.splitlines()[:8]:
                        print(f"        | {l[:160]}")
        await ws.send("exit\n")
        await drain(2.0)


async def main() -> None:
    for p in sys.argv[1:]:
        try:
            await run_lesson(Path(p))
        except Exception as e:  # noqa: BLE001
            print(f"  !!!! session error: {e}")


asyncio.run(main())
