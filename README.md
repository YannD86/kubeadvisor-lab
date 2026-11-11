# KubeAdvisor Lab (test build)

A Kubernetes training lab that runs on your own machine: a real three-node kind cluster,
guided manifest builders, lessons on the control plane and GitOps with live inspection
commands, and broken-cluster scenarios you repair from a web terminal.

This is a **test build shared with invited testers**. Everything in it is free to use for
evaluation; the course products of the full platform are not included.

| Realm | What it is |
|---|---|
| Manifests & CRDs | 19 builders: write a manifest from a blank editor, one field at a time, with a "why" for every field, then apply it to the cluster |
| GitOps: Flux & Helm | 10 lessons on Flux sources, kustomizations, Helm charts and releases, practised on an in-cluster Gitea |
| Components | 11 lessons on the control plane and node anatomy, including etcd, the scheduler, the kubelet and the HPA loop, with commands you run against the live cluster |
| Troubleshooting method | 7 lessons mapping symptoms to layers and commands |
| Loaded scenarios | 28 faults loaded into your cluster, with a terminal, k9s, progressive hints, automated checks and a full solution |

## Requirements

- **Docker** with at least 4 CPUs and 8 GB of memory available to containers, and about 10 GB of free disk.
  Docker Desktop (macOS, Windows with the WSL 2 backend) or dockerd on Linux.
- **Windows users:** run everything from inside a WSL 2 distribution (Ubuntu) with Docker Desktop's WSL
  integration enabled. The lab terminal needs a Unix PTY and does not run on native Windows.
- CLI tools on your PATH: `kind` (0.33+), `kubectl` (1.33+), `helm` (3.14+), `flux` (2.4+), `k9s`, `kubeconform` (optional, one chart-linting step uses it), `git`, `curl`.
  On macOS or Linux with Homebrew: `brew install kind kubectl helm fluxcd/tap/flux k9s kubeconform`.
- **Python 3.11+** with `venv`, and **Node 20+** (22 recommended) with npm.

## Quick start

```bash
git clone https://github.com/YannD86/kubeadvisor-lab.git && cd kubeadvisor-lab
./start.sh
```

The first start creates a Python virtualenv and installs the web dependencies (a few
minutes). Then:

1. Open **http://localhost:10200**.
2. Go to **Cluster** and press **Create cluster**. This creates the `sre-labs` kind cluster
   with three nodes and the Calico CNI; the first run pulls images and takes 3 to 6 minutes.
   The same thing from a shell: `bash cluster/up.sh`.
3. On the same page install the add-ons the content uses: **metrics-server** (HPA, `kubectl top`),
   **gitea** and **flux** (the GitOps realm and GitOps scenarios). ingress-nginx and cert-manager
   are only needed by the builders that mention them.
4. Start with **Components** or **Manifests & CRDs**. The **Lab terminal** button at the bottom
   opens a shell on your machine with `kubectl`, `helm`, `flux` and `k9s` already pointed at the
   cluster. Every lesson block with a **Run** button types itself into that terminal.
5. **Scenarios**: open one, press **Load**, fix the cluster, then run `lab check` in the terminal
   (also `lab hint`, `lab brief`, `lab solution`, `lab reset`).

`./stop.sh` stops the web and API processes; the cluster keeps running. `bash cluster/down.sh`
deletes the cluster. Everything the lab stores lives in `~/.kubeadvisor` (kubeconfig, progress
database, scenario work directories); delete that directory for a completely fresh start.

Ports: web on 10200, API on 10201. Change them with `LAB_WEB_PORT` and `LAB_API_PORT`
before `./start.sh`.

## When something does not work

- The terminal banner says **no lab cluster reachable**: the cluster does not exist or Docker is
  not running. Check the **Cluster** page, or run `bash cluster/status.sh`.
- A command in a lesson fails: please report it (below) with the lesson name, the command and the
  terminal output. `scripts/sweep_lessons.py` is the checker we use for exactly this.
- A scenario check does not pass after your fix: `lab solution` shows the reference fix; if the
  checks still fail with the reference solution applied, that is a bug on our side, please report it.
- The web page shows **connection error, is the API running on :10201**: look at `logs/api.log`.

## Reporting feedback

Please tell us about anything confusing, wrong or broken: a lesson statement you doubt, a
command that fails, a scenario whose hints do not help, an unclear check. Include:

- what you were doing (realm, lesson or scenario id, the command),
- what you expected and what happened (terminal output or a screenshot),
- the output of `bash cluster/status.sh`, your OS and Docker version.

Open an issue at https://github.com/YannD86/kubeadvisor-lab/issues, or use the channel you were given with the invitation.

## Known limitations of this build

- The **Courses** area is empty: the exam-preparation courses are not part of the test build.
- Run buttons send commands to the terminal as written; a few GitOps chapters (7, 9 and 10)
  reference Flux objects created by earlier chapters and expect you to follow them in order.
- A scenario may take up to a minute to load the first time while images are pulled.

## For contributors

```bash
python3 scripts/validate_content.py           # content contract, exit 1 on error
cd api && .venv/bin/python -m pytest -q tests # API tests
cd web && npx tsc --noEmit -p . && npx eslint src
python3 scripts/smoke_scenarios.py            # loads every scenario on the live cluster
api/.venv/bin/python scripts/sweep_lessons.py content/lessons/components/*.md   # runs every lesson block through the terminal
```

`docs/CONTENT_GUIDE.md` describes the content formats; `docs/PLATFORM_CONTRACT.md` the API.

## License

Shared with invited testers for evaluation only. No license for redistribution has been
granted yet.

_Built from kubeadvisor-platform 03c1ce9._
