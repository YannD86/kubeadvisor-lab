---
title: "etcd: Raft, quorum, the key layout, and backup/restore"
slug: etcd
realm: components
order: 4
summary: "Why etcd needs an odd number of members, what lives under /registry, how compaction and defragmentation keep it healthy, how to take and restore a snapshot the kubeadm way, and what a slow disk does to a cluster."
estimated_minutes: 20
level: intermediate
tags: [etcd, raft, quorum, backup, snapshot, pki]
builders: []
scenarios: []
quiz:
  - q: "A 4-member etcd cluster loses two members. What happens?"
    options: ["It keeps serving reads and writes", "It serves reads only", "It loses quorum: 2 is not a majority of 4, so no writes and no linearizable reads", "It elects a new leader among the two survivors"]
    answer: 2
    explain: "Quorum is floor(n/2)+1. For 4 members that is 3, the same as for 5. A fourth member adds load without adding fault tolerance, which is why clusters run 3 or 5."
  - q: "After `etcdutl snapshot restore` on a kubeadm control plane, Pods created after the snapshot are still running on the nodes. What happens to them?"
    options: ["They keep running forever, invisible to the API", "The kubelet notices they no longer exist in the API server and stops them; controllers recreate what the restored state declares", "The scheduler re-adopts them", "etcd rejects the restore"]
    answer: 1
    explain: "The restored etcd is the new truth. Kubelets reconcile against it and kill orphaned containers; controllers recreate children of the objects that exist in the snapshot. Restore is a time machine for the whole cluster, not just the database."
  - q: "Which signal most directly shows etcd is suffering from slow disk?"
    options: ["High apiserver CPU", "etcd_disk_wal_fsync_duration_seconds p99 above ~10 ms and 'took too long' warnings in etcd logs", "CoreDNS restarts", "Many Pending Pods"]
    answer: 1
    explain: "Every write must be fsynced to the WAL before it is committed. Slow fsync delays commits, delays heartbeats, and eventually triggers leader elections. The downstream symptoms (API timeouts, Pending Pods) come later."
---

# etcd

etcd is the only stateful part of the control plane. Everything else can be
restarted, rebuilt or run three times over; if etcd's data is gone, the
cluster is gone. This lesson is about the properties that make it reliable
and the handful of operations an SRE actually performs on it.

## Raft in four sentences

Members elect a leader; only the leader accepts writes. The leader appends
each write to its log and replicates it to followers. When a majority has
written the entry to disk, it is *committed* and the client gets an answer.
If followers stop hearing heartbeats (`--heartbeat-interval`, 100 ms) for an
election timeout (`--election-timeout`, 1000 ms), they start a new election,
and the new leader is guaranteed to have every committed entry.

The majority rule is where cluster sizing comes from.

| Members | Quorum | Failures tolerated |
|---|---|---|
| 1 | 1 | 0 |
| 2 | 2 | 0 |
| 3 | 2 | 1 |
| 4 | 3 | 1 |
| 5 | 3 | 2 |

**Why it matters:** even numbers buy nothing. Three members survive one
failure, five survive two, and more than five slows every write because the
leader waits for a larger majority. The lab runs one member; that is fine for
a laptop and would be an outage waiting to happen in production.

**Gotcha:** a cluster that has lost quorum still answers *serializable* reads
from whatever each member has, but refuses writes and linearizable reads.
The API server uses linearizable reads by default, so to Kubernetes a
quorum-less etcd is simply down.

## Ports and certificates

| Port | Who connects | Certificate |
|---|---|---|
| 2379 | kube-apiserver (client traffic) | server: `pki/etcd/server.crt`; client: `pki/apiserver-etcd-client.crt` |
| 2380 | other etcd members (Raft) | `pki/etcd/peer.crt` |
| 2381 | the kubelet's probes (`/livez`, `/readyz`) and `/metrics` scrapers, over plain HTTP on localhost | none |

kubeadm gives etcd its own CA (`pki/etcd/ca.crt`), separate from the cluster
CA. The API server's `--etcd-cafile` points at it. The etcd static pod's
probes need no certificate: they hit `http://127.0.0.1:2381/livez` and
`/readyz` on the metrics port, and `pki/etcd/healthcheck-client.crt` is a
spare client cert you can use with `etcdctl`. When you call
`etcdctl`, you must present a client certificate signed by that CA; the
server cert works because kubeadm issues it with both server and client
usages.

## The key layout

Kubernetes stores every object under `/registry/<resource>/<namespace>/<name>`
(`/registry/<resource>/<name>` for cluster-scoped ones). Values are protobuf
by default, so `etcdctl get` shows mostly binary; the key names alone tell
you a lot. Secrets are stored in plaintext unless you configure
`--encryption-provider-config` on the API server; this is the main reason
etcd backups are treated as sensitive as the cluster itself.

**Try it:** define a helper that runs `etcdctl` inside the etcd container with
the right certificates, then explore. The image is distroless: it ships
`etcdctl` and `etcdutl` but no shell, so `kubectl exec` must call the binary
directly (no `sh -c`, no environment variables; `ETCDCTL_API=3` has been the
default since 3.4 anyway).

```bash
e() { kubectl -n kube-system exec etcd-sre-labs-control-plane -- etcdctl --endpoints https://127.0.0.1:2379 --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key "$@"; }
e endpoint status -w table          # leader, raft term, raft index, DB size
e endpoint health
e member list -w table              # one member; note peer URL :2380 and client URL :2379
e get /registry/ --prefix --keys-only | head -20
e get /registry/ --prefix --keys-only | wc -l
e get /registry/pods/kube-system/ --prefix --keys-only
e get /registry/namespaces/default --keys-only
docker exec sre-labs-control-plane curl -s http://127.0.0.1:2381/metrics | grep -E '^etcd_server_has_leader|^etcd_disk_wal_fsync_duration_seconds_count'
docker exec sre-labs-control-plane grep -E 'listen-client-urls|listen-peer-urls|data-dir' /etc/kubernetes/manifests/etcd.yaml
```

## Compaction and defragmentation

etcd is multi-version: every write creates a new revision and keeps the old
one, which is what makes `watch` from a past `resourceVersion` possible. The
API server *compacts* old revisions every five minutes
(`--etcd-compaction-interval`). Compaction frees space inside the database
file but does not shrink the file; `etcdctl defrag` does, and briefly blocks
the member, so run it one member at a time. If the file reaches
`--quota-backend-bytes` (2 GiB by default) etcd raises a `NOSPACE` alarm and
turns read-only until you defrag and `alarm disarm`. `endpoint status` shows
`DB SIZE`; watch it grow when something creates Events or ConfigMaps in a
loop.

## Backup and restore, the kubeadm way

A snapshot is a consistent copy of the whole keyspace at one revision. Take
it from inside the container so the paths and certificates are right; the
etcd `--data-dir` (`/var/lib/etcd`) is a hostPath, so the file lands on the
node.

```bash
e snapshot save /var/lib/etcd/lab-snapshot.db
docker exec sre-labs-control-plane ls -lh /var/lib/etcd/
kubectl -n kube-system exec etcd-sre-labs-control-plane -- etcdutl snapshot status /var/lib/etcd/lab-snapshot.db -w table
docker exec sre-labs-control-plane rm -f /var/lib/etcd/lab-snapshot.db     # keep the data dir clean once you have read the table
```

Restoring is a control-plane outage by design. The flow on a kubeadm node:

1. Copy the snapshot to the control-plane node.
2. Stop the API server and etcd by moving `kube-apiserver.yaml` and
   `etcd.yaml` out of `/etc/kubernetes/manifests/`; the kubelet removes the
   Pods within seconds. Nothing else will write to etcd while you work.
3. `etcdutl snapshot restore lab-snapshot.db --data-dir /var/lib/etcd-restored`
   (for a multi-member cluster also `--name`, `--initial-cluster`,
   `--initial-advertise-peer-urls`, on every member, from the same file).
   The restore rewrites member identity, so the result is a brand-new
   cluster with the old data.
4. Point etcd at the new directory: either swap the directories, or edit the
   `hostPath` and `--data-dir` in `etcd.yaml`.
5. Move both manifests back. Watch `crictl ps` on the node until etcd and
   the API server are up, then `kubectl get nodes`.

**Gotcha:** controllers and kubelets treat the restored state as truth. Pods
created after the snapshot are killed as orphans; objects deleted after the
snapshot come back and their controllers recreate children. Restore the
snapshot you mean, and tell the people whose changes you are about to undo.

Do not run the restore on the lab cluster during a scenario: it rewinds
every namespace, including the checker's.

## What a slow etcd looks like

Every commit waits for an fsync of the write-ahead log. On a slow or shared
disk the fsync p99 climbs past 10 ms, etcd logs `apply request took too long`
and `waiting for ReadIndex response took too long`, heartbeats arrive late,
and followers start elections. From the outside the symptoms are indirect:
API requests time out or return `504`, `etcdserver: request timed out` in API
server logs, leader elections for the scheduler and controller-manager flap
because their lease renewals fail, and nodes flicker `NotReady` because
status updates do not land in time. Pods already running keep running; the
cluster stops *changing*. The fix is almost always the disk: dedicated SSD,
no shared volume, and `etcdctl check perf` to confirm before and after.
