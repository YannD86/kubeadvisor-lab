---
title: "kubeadm layout and PKI: /etc/kubernetes, certificates, kubeconfigs and tokens"
slug: kubeadm-layout-and-pki
realm: components
order: 10
summary: "What every file under /etc/kubernetes is for, the three certificate authorities and their expiry, the anatomy of a kubeconfig, how ServiceAccount tokens are issued and bound, and what kubeadm upgrade actually does."
estimated_minutes: 18
level: intermediate
tags: [kubeadm, pki, certificates, kubeconfig, serviceaccount, tokens, upgrade]
builders: []
scenarios: []
quiz:
  - q: "`kubeadm certs check-expiration` shows apiserver.crt expiring tomorrow but ca.crt valid for 9 more years. What is the least disruptive fix?"
    options: ["Re-run kubeadm init", "kubeadm certs renew all, then restart the static pods by moving their manifests out of /etc/kubernetes/manifests and back (and distribute the new admin.conf)", "Replace ca.crt", "Nothing; the kubelet rotates it"]
    answer: 1
    explain: "Leaf certificates are signed by the CA; renewing them with the same CA keeps every existing trust relationship valid. The kubelet rotates only its own client certificate, not the control-plane ones."
  - q: "A Pod reads /var/run/secrets/kubernetes.io/serviceaccount/token. Where did that token come from?"
    options: ["A Secret the ServiceAccount controller created", "The kubelet requested it from the TokenRequest API; it is bound to this Pod, has an expiry, and the kubelet refreshes it", "kubeadm generated it at init", "CoreDNS"]
    answer: 1
    explain: "Since 1.24 tokens are projected volumes: short-lived JWTs signed with sa.key, carrying an audience, an expiry and the Pod's uid. Deleting the Pod invalidates the token even before it expires."
  - q: "Which file do the kube-scheduler and kube-controller-manager use to authenticate to the API server?"
    options: ["admin.conf", "kubelet.conf", "scheduler.conf and controller-manager.conf respectively, each with its own client certificate and identity", "pki/ca.key"]
    answer: 2
    explain: "Each control-plane component has a dedicated kubeconfig and certificate (CN=system:kube-scheduler, system:kube-controller-manager) so RBAC and audit can treat them separately."
---

# kubeadm layout and PKI

kubeadm's output is a directory. Everything that makes the control-plane node
*this* cluster's control plane is under `/etc/kubernetes`, and most of it is
certificates. Knowing the tree means you can diagnose an authentication
failure in one `ls` and recover a cluster with a text editor.

## The tree

```
/etc/kubernetes/
├── admin.conf                   kubeconfig: CN=kubernetes-admin, group kubeadm:cluster-admins
├── super-admin.conf             kubeconfig in system:masters (1.29+); break-glass only
├── kubelet.conf                 kubeconfig the kubelet uses; points at its rotated cert
├── controller-manager.conf      kubeconfig: CN=system:kube-controller-manager
├── scheduler.conf               kubeconfig: CN=system:kube-scheduler
├── manifests/                   static pods: etcd, kube-apiserver, kube-controller-manager, kube-scheduler
└── pki/
    ├── ca.crt, ca.key                        cluster CA
    ├── apiserver.crt, .key                   API server serving cert (SANs below)
    ├── apiserver-kubelet-client.crt, .key    API server -> kubelet (logs, exec)
    ├── apiserver-etcd-client.crt, .key       API server -> etcd
    ├── front-proxy-ca.crt, .key              aggregation layer CA
    ├── front-proxy-client.crt, .key          API server -> aggregated API servers
    ├── sa.key, sa.pub                        ServiceAccount token signing and verification
    └── etcd/
        ├── ca.crt, ca.key                    etcd CA
        ├── server.crt, peer.crt, healthcheck-client.crt
```

Worker nodes have only `kubelet.conf`, `pki/ca.crt` and the kubelet's own
certificates under `/var/lib/kubelet/pki/`.

## Three certificate authorities, one chain each

| CA | Signs | Trusted by |
|---|---|---|
| cluster CA (`pki/ca.crt`) | API server serving cert, every client cert in the `.conf` files, kubelet client certs (via CSR approval) | kubectl (`certificate-authority-data`), kubelets, every Pod (`kube-root-ca.crt` ConfigMap) |
| etcd CA | etcd server and peer certs, the API server's etcd client cert | etcd and the API server only |
| front-proxy CA | `front-proxy-client.crt` | aggregated API servers (metrics-server) via `--requestheader-client-ca-file` |

The API server's serving certificate carries the SANs clients will dial:
`kubernetes`, `kubernetes.default.svc.cluster.local`, the first ClusterIP
(`10.96.0.1`), the node's IP and name, and in kind also `localhost` and the
Docker-network address. A `certificate is valid for ..., not <name>` error
means you dialled a name outside that list; `--apiserver-cert-extra-sans`
at init, or a renewal with the new name, fixes it.

**Expiry.** CAs are issued for 10 years, every leaf for 1 year.
`kubeadm upgrade` renews all leaves as a side effect, which is why clusters
upgraded yearly never notice; clusters that are not upgraded go dark on
their first birthday with `x509: certificate has expired` everywhere at
once. `kubeadm certs check-expiration` is the check to alert on;
`kubeadm certs renew all` is the fix, followed by restarting the static
pods (move the manifests out and back) and re-copying `admin.conf` to
whoever uses it.

**Gotcha:** the kubelet is the exception. With `rotateCertificates: true`
it requests a new client certificate through a CSR before the current one
expires; the `csrapproving` controller approves it and the `csrsigning`
controller signs it with `pki/ca.key`. Its *serving*
certificate, used when the API server dials it for logs, is self-signed
unless you enable `serverTLSBootstrap` and approve those CSRs too, which is
why metrics-server in this lab runs with `--kubelet-insecure-tls`.

## Kubeconfig anatomy

A kubeconfig is three lists and a pointer:

```yaml
clusters:            # where: server URL plus the CA to verify it
- name: kind-sre-labs
  cluster: { server: https://127.0.0.1:XXXXX, certificate-authority-data: <ca.crt> }
users:               # who: a client cert, a token, or an exec plugin
- name: kind-sre-labs
  user: { client-certificate-data: <crt>, client-key-data: <key> }
contexts:            # a (cluster, user, default namespace) triple
- name: kind-sre-labs
  context: { cluster: kind-sre-labs, user: kind-sre-labs }
current-context: kind-sre-labs
```

`kubectl` resolves the current context, picks the cluster and user, and
that is the entire client-side configuration. Identity lives in the
certificate's subject: `CN` becomes the username, each `O` a group. RBAC
binds to those strings; nothing in the cluster stores "users".

## ServiceAccount tokens

Pods authenticate with JWTs signed by `sa.key`. Since 1.24 they are not
Secrets. The `ServiceAccount` admission plugin adds a projected volume with
three sources: a `serviceAccountToken` the kubelet obtains from the
TokenRequest API, the `kube-root-ca.crt` ConfigMap, and the namespace from
the downward API. The token is **bound**: its claims include the audience
(`https://kubernetes.default.svc.cluster.local`, the `--service-account-issuer`),
an expiry (requested for one hour; the kubelet rotates it before that), and
the Pod's name and uid, so it dies with the Pod. Decode a mounted token and
you will see a one-year `exp`: kube-apiserver's
`--service-account-extend-token-expiration` (default true) stretches
admission-injected tokens as a transition safety net, and the Pod binding is
what really ends their life. `kubectl create token <sa>` mints one on demand
for testing. Legacy long-lived Secret tokens still work if you create them
by hand and are never cleaned up automatically; only auto-generated ones
unused for a year are invalidated and then deleted by the legacy token
cleaner.

## How kubeadm upgrade works

1. `kubeadm upgrade plan` reads the `kubeadm-config` ConfigMap, checks the
   version skew (kubelets may lag the API server by up to three minors,
   kubectl by one) and lists targets.
2. `kubeadm upgrade apply vX.Y.Z` on the first control-plane node pulls the
   images, renews every certificate, writes new static pod manifests into
   `/etc/kubernetes/tmp/kubeadm-upgraded-manifests-*`, backs the old ones
   up to `/etc/kubernetes/tmp/kubeadm-backup-manifests-*` (and etcd's data
   dir to `kubeadm-backup-etcd-*`), then moves them into `manifests/` one
   component at a time, waiting for each new static pod to pass its health
   check before the next. It finishes by updating the `kubelet-config` and
   `kube-proxy` ConfigMaps and CoreDNS.
3. On every other node: drain, `kubeadm upgrade node` (rewrites the local
   kubelet config and, on control-plane nodes, the manifests), upgrade the
   `kubelet` and `kubectl` packages, `systemctl restart kubelet`, uncordon.

kind clusters are not upgraded in place; you recreate them with a newer
node image. The mechanism is still worth knowing: it is a rolling restart
of static pods driven by file moves, the same lever every control-plane
scenario in this realm uses.

**Try it:** walk the tree, check expiry, and read who you are.

```bash
docker exec sre-labs-control-plane find /etc/kubernetes -maxdepth 2 | sort
docker exec sre-labs-control-plane kubeadm certs check-expiration
docker exec sre-labs-control-plane openssl x509 -in /etc/kubernetes/pki/apiserver.crt -noout -subject -issuer -enddate -ext subjectAltName
docker exec sre-labs-control-plane openssl x509 -in /etc/kubernetes/pki/front-proxy-client.crt -noout -subject -issuer
docker exec sre-labs-control-plane bash -c 'kubectl --kubeconfig /etc/kubernetes/admin.conf config view --raw -o jsonpath="{.users[0].user.client-certificate-data}" | base64 -d | openssl x509 -noout -subject'
docker exec sre-labs-control-plane bash -c 'kubectl --kubeconfig /etc/kubernetes/scheduler.conf config view --raw -o jsonpath="{.users[0].user.client-certificate-data}" | base64 -d | openssl x509 -noout -subject'
docker exec sre-labs-worker ls -l /var/lib/kubelet/pki/
docker exec sre-labs-worker ls /etc/kubernetes/
kubectl config get-contexts
kubectl config view --minify | grep -E 'server|name:|namespace'
kubectl get sa default -o jsonpath='secrets: {.secrets}{"\n"}'          # empty: no legacy token Secrets
kubectl create token default --duration=10m | cut -d. -f2 | base64 -d 2>/dev/null; echo   # the JWT claims: iss, aud, exp, sub
kubectl -n kube-system get cm kubeadm-config -o jsonpath='{.data.ClusterConfiguration}' | head -30
```

The two subjects you decode are `O=kubeadm:cluster-admins, CN=kubernetes-admin`
and `CN=system:kube-scheduler`. Look them up with
`kubectl get clusterrolebinding -o wide | grep -E 'cluster-admins|kube-scheduler'`
and you have closed the loop from a file on disk to an RBAC decision.
