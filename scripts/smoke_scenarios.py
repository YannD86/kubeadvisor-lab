#!/usr/bin/env python3
"""Smoke-test scenarios against the running API + lab cluster.

For each scenario id (default: all without addon requirements):
  load (setup.sh) -> expect success
  check           -> expect NOT passed for troubleshoot scenarios (the fault is real)
  cleanup         -> expect success
Usage: scripts/smoke_scenarios.py [--api URL] [--keep] [ids...]
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request


def call(api: str, method: str, path: str):
    req = urllib.request.Request(api + path, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:  # noqa: PERF203
        return e.code, json.loads(e.read() or b"{}")


def wait_job(api: str, jid: str, timeout: int = 900) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        _, j = call(api, "GET", f"/api/jobs/{jid}")
        if j.get("status") != "running":
            return j
        time.sleep(3)
    return {"status": "timeout", "output": []}


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)  # progress is visible when piped to a file
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:10101")
    ap.add_argument("--keep", action="store_true", help="do not clean up after the check")
    ap.add_argument("--with-addons", action="store_true", help="include scenarios that require addons")
    ap.add_argument("ids", nargs="*")
    a = ap.parse_args()
    _, cat = call(a.api, "GET", "/api/scenarios")
    scenarios = {s["id"]: s for s in cat["scenarios"]}
    ids = a.ids or [s for s, v in scenarios.items() if a.with_addons or not v.get("requires_addons")]
    failures = 0
    for sid in ids:
        s = scenarios.get(sid)
        if not s:
            print(f"?? {sid}: unknown")
            failures += 1
            continue
        t0 = time.time()
        code, j = call(a.api, "POST", f"/api/scenarios/{sid}/load")
        if code != 200:
            print(f"XX {sid}: load refused: {j.get('detail')}")
            failures += 1
            continue
        j = wait_job(a.api, j["id"])
        if j["status"] != "succeeded":
            print(f"XX {sid}: setup {j['status']}\n   " + "\n   ".join(j["output"][-12:]))
            failures += 1
            call(a.api, "POST", f"/api/scenarios/{sid}/cleanup")
            continue
        _, chk = call(a.api, "POST", f"/api/scenarios/{sid}/check")
        fails = [r["name"] for r in chk["results"] if not r["passed"]]
        expect_fail = s["type"] == "troubleshoot"
        ok = (not chk["passed"]) if expect_fail else True
        if not ok:
            print(f"XX {sid}: checks PASSED on the broken state (fault not injected?)")
            failures += 1
        else:
            print(f"ok {sid}: setup {j['duration']}s, {len(fails)}/{len(chk['results'])} checks failing as expected  [{time.time()-t0:.0f}s]")
        if not a.keep:
            _, c = call(a.api, "POST", f"/api/scenarios/{sid}/cleanup")
            cj = wait_job(a.api, c["id"], 600)
            if cj["status"] != "succeeded":
                print(f"XX {sid}: cleanup {cj['status']}\n   " + "\n   ".join(cj["output"][-8:]))
                failures += 1
    print(f"\n{len(ids) - failures}/{len(ids)} scenarios behaved; {failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
