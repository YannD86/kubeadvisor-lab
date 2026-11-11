## Diagnosis

`kubectl` is refused, so the API server is not listening. There is nothing
to query through the API; go to the control-plane node and use the
container runtime directly:

```bash
kubectl get nodes
# The connection to the server 127.0.0.1:43725 was refused - did you specify the right host or port?

docker exec -it sre-labs-control-plane bash          # real cluster: ssh control-plane
root@sre-labs-control-plane:/# crictl ps -a | grep -E 'kube-apiserver|etcd'
# 3f1c...  Exited   ...  kube-apiserver   <- several, restarted every few seconds: crash loop
# a90b...  Running  ...  etcd             <- etcd itself is fine
root@sre-labs-control-plane:/# crictl logs --tail 20 3f1c...
# W ... grpc: addrConn.createTransport failed to connect to {Addr: "127.0.0.1:2389", ...}.
#   Err: connection error: desc = "transport: Error while dialing: dial tcp 127.0.0.1:2389: connect: connection refused"
# E ... "command failed" err="context deadline exceeded"   (or: error waiting for etcd connection)
```

The API server is dialling etcd on **2389**. Check what it was told and what
etcd actually offers:

```bash
root@sre-labs-control-plane:/# grep -- --etcd-servers /etc/kubernetes/manifests/kube-apiserver.yaml
#     - --etcd-servers=https://127.0.0.1:2389
root@sre-labs-control-plane:/# grep -- --listen-client-urls /etc/kubernetes/manifests/etcd.yaml
#     - --listen-client-urls=https://127.0.0.1:2379,https://172.18.0.4:2379
root@sre-labs-control-plane:/# journalctl -u kubelet --no-pager | grep -i apiserver | tail -3
#   ... "Back-off restarting failed container" ... kube-apiserver
```

## Root cause

The `--etcd-servers` flag in the kube-apiserver static Pod manifest points
at `https://127.0.0.1:2389`; etcd listens on `2379`. The kubelet applied the
edited manifest immediately (static Pods restart on any change), the new
API server cannot reach its datastore, refuses to start, and crash-loops.
Running workloads are untouched because kubelets and kube-proxy keep their
last known state, but every control-plane function is gone.

## Fix

Edit the manifest on the node; the kubelet does the rest.

```bash
docker exec sre-labs-control-plane \
  sed -i 's#--etcd-servers=https://127.0.0.1:2389#--etcd-servers=https://127.0.0.1:2379#' \
  /etc/kubernetes/manifests/kube-apiserver.yaml

# watch the kubelet restart it (up to ~20 s to notice, ~10-20 s to boot)
docker exec sre-labs-control-plane sh -c 'sleep 25; crictl ps | grep kube-apiserver'
kubectl get --raw /readyz
# ok
kubectl -n kube-system get pods -l component=kube-apiserver
# kube-apiserver-sre-labs-control-plane   1/1   Running
```

If kubectl from your terminal still fails after the fix, test from the
node with the admin kubeconfig to separate "API down" from "my kubeconfig":
`kubectl --kubeconfig /etc/kubernetes/admin.conf get --raw /readyz`.

## Prevention

- Keep the control-plane manifests under configuration management and
  review every change; a one-character port edit in `kube-apiserver.yaml`
  deserves the same scrutiny as a database migration.
- External monitoring of `/readyz` (and etcd's `/health`) from outside the
  cluster: when the API is down, in-cluster alerting is down with it.
- Practice the "below the API" toolbox regularly: `crictl ps -a`,
  `crictl logs`, `journalctl -u kubelet`, `/etc/kubernetes/manifests`,
  `/etc/kubernetes/admin.conf`. The runbook for this incident is four lines
  long only if you have typed them before.
- Run a highly available control plane (3 nodes, stacked or external etcd)
  so one bad manifest degrades instead of taking everything down.
