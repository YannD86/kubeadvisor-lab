## Diagnosis

Start with what the control plane knows about the node:

```bash
kubectl get nodes
# NAME                     STATUS     ROLES           AGE   VERSION
# sre-labs-worker          NotReady   <none>          ...
kubectl describe node sre-labs-worker | sed -n '/^Conditions/,/^Addresses/p'
#   Ready   Unknown   ...   NodeStatusUnknown   Kubelet stopped posting node status.
kubectl get pods -n lab-kubelet -o wide
# api-...   1/1   Running       sre-labs-worker    <- stale; turns Terminating after ~5 min
# api-...   1/1   Running       sre-labs-worker2
```

"Kubelet stopped posting node status" is the API server's view: it has not
received a heartbeat (Lease renewal / NodeStatus) for 50 s (`--node-monitor-grace-period`, 50 s by default since 1.32). The host may be
perfectly fine. Go and look at the agent itself. In this lab the node is a
Docker container; on a real cluster you would `ssh` in:

```bash
docker exec -it sre-labs-worker bash
root@sre-labs-worker:/# systemctl is-active kubelet
inactive
root@sre-labs-worker:/# systemctl status kubelet --no-pager | head -5
# kubelet.service - kubelet: The Kubernetes Node Agent
#    Loaded: loaded (/etc/systemd/system/kubelet.service; enabled)
#    Active: inactive (dead) since ...
root@sre-labs-worker:/# journalctl -u kubelet -n 5 --no-pager
# ... systemd[1]: Stopping kubelet: The Kubernetes Node Agent...
# ... systemd[1]: kubelet.service: Deactivated successfully.
root@sre-labs-worker:/# crictl ps | grep nginx      # containers are still alive
```

`inactive (dead)` with a clean "Stopping" line: nothing crashed, somebody or
something stopped the unit. With a crash you would instead see
`activating (auto-restart)` and an error in the journal.

## Root cause

The kubelet service on `sre-labs-worker` was stopped. Without it the node
cannot report status, so the node-lifecycle controller marks it `NotReady`
(Unknown), taints it `node.kubernetes.io/unreachable:NoExecute`, and after
the 5-minute default toleration starts evicting its Pods. The workloads keep
running under containerd the whole time, which is why "the app still
answers" and "the node is down" are both true.

## Fix

```bash
docker exec sre-labs-worker systemctl start kubelet      # real life: ssh node && sudo systemctl start kubelet
docker exec sre-labs-worker systemctl is-active kubelet  # active
kubectl get nodes -w                                     # sre-labs-worker Ready within ~10 s
kubectl rollout status deploy/api -n lab-kubelet         # 2/2
```

If the Pod on the node had already been marked `Terminating`, the returning
kubelet completes the termination and the ReplicaSet schedules a replacement
on the same node. Also make sure the unit is enabled so it comes back after a
reboot: `systemctl enable kubelet`.

## Prevention

- Alert on `kube_node_status_condition{condition="Ready",status!="true"}`
  with a short `for:` (2-3 min) so you act before the 5-minute eviction
  cascade.
- Protect the unit: `Restart=always` is already the kubeadm default for
  crashes; for accidental stops, restrict who can run `systemctl stop kubelet`
  on nodes (sudo policy) and log it (auditd).
- Node-level monitoring (node_exporter + `systemd_unit_state`) catches an
  inactive kubelet even when the control plane is the one that is blind.
- Runbook step zero for NotReady: `ssh node; systemctl status kubelet;
  journalctl -u kubelet -n 100`. Most NotReady incidents end there.
