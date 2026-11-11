export interface DNode { id: string; label: string; sub?: string; x: number; y: number; w?: number; h?: number; group?: string; desc: string; cmd?: string }
export interface DEdge { from: string; to: string; label?: string; dashed?: boolean }
export interface DGroup { id: string; label: string; x: number; y: number; w: number; h: number; color: string }
export interface DSpec { title: string; width: number; height: number; groups: DGroup[]; nodes: DNode[]; edges: DEdge[]; legend?: string }

export const SPECS: Record<string, DSpec> = {
  "cluster-anatomy": {
    title: "Cluster anatomy: who talks to whom",
    width: 900, height: 420,
    groups: [
      { id: "cp", label: "Control plane (sre-labs-control-plane)", x: 20, y: 20, w: 420, h: 380, color: "#38bdf8" },
      { id: "node", label: "Worker node (sre-labs-worker)", x: 480, y: 20, w: 400, h: 380, color: "#34d399" },
    ],
    nodes: [
      { id: "api", label: "kube-apiserver", sub: "static pod · :6443", x: 150, y: 60, w: 170, desc: "The only component that talks to etcd. Every kubectl, controller, kubelet and scheduler request goes through it: authentication, authorization (RBAC), admission, validation, then persistence. Exposes watch streams so other components react to changes.", cmd: "kubectl -n kube-system get pod -l component=kube-apiserver -o wide" },
      { id: "etcd", label: "etcd", sub: "static pod · :2379/2380", x: 40, y: 170, w: 140, desc: "Strongly consistent key-value store (Raft). Holds the entire cluster state under /registry. Only the API server has its client certificate. Back it up; everything else is reproducible.", cmd: "kubectl -n kube-system exec etcd-sre-labs-control-plane -- sh -c 'ETCDCTL_API=3 etcdctl --cacert /etc/kubernetes/pki/etcd/ca.crt --cert /etc/kubernetes/pki/etcd/server.crt --key /etc/kubernetes/pki/etcd/server.key endpoint health'" },
      { id: "sched", label: "kube-scheduler", sub: "static pod", x: 230, y: 170, w: 170, desc: "Watches for Pods with no nodeName, filters nodes (resources, taints, affinity, ports), scores them, and writes a Binding. If it is down, new Pods stay Pending with no events.", cmd: "kubectl -n kube-system get pod -l component=kube-scheduler" },
      { id: "cm", label: "kube-controller-manager", sub: "static pod", x: 40, y: 290, w: 220, desc: "Dozens of control loops in one binary: Deployment → ReplicaSet → Pod, EndpointSlices, Node lifecycle, ServiceAccount tokens, garbage collection. If it is down, Deployments never create ReplicaSets.", cmd: "kubectl -n kube-system get pod -l component=kube-controller-manager" },
      { id: "dns", label: "CoreDNS", sub: "Deployment", x: 290, y: 290, w: 120, desc: "Cluster DNS. Answers <svc>.<ns>.svc.cluster.local from a watch on Services and EndpointSlices; forwards the rest. Runs as a normal Deployment, not a static pod.", cmd: "kubectl -n kube-system get cm coredns -o yaml" },
      { id: "kubelet", label: "kubelet", sub: "systemd service", x: 560, y: 60, w: 140, desc: "The node agent. Watches the API server for Pods bound to its node, asks the container runtime to run them, runs probes, reports node and Pod status, and manages static pods from /etc/kubernetes/manifests.", cmd: "docker exec sre-labs-worker systemctl status kubelet --no-pager | head -5" },
      { id: "cri", label: "containerd", sub: "CRI runtime", x: 730, y: 60, w: 130, desc: "Pulls images and runs containers on request from the kubelet over the CRI gRPC socket. Inspect it with crictl on the node.", cmd: "docker exec sre-labs-worker crictl ps" },
      { id: "proxy", label: "kube-proxy", sub: "DaemonSet", x: 560, y: 170, w: 140, desc: "Programs iptables/IPVS rules so a Service ClusterIP DNATs to a ready endpoint. A Service with no endpoints gets a REJECT rule (connection refused).", cmd: "kubectl -n kube-system get ds kube-proxy" },
      { id: "cni", label: "Calico (CNI)", sub: "DaemonSet", x: 730, y: 170, w: 130, desc: "Gives each Pod an IP, wires it into the node network, and enforces NetworkPolicy. kind's default kindnet does not enforce policies; this lab installs Calico so it does.", cmd: "kubectl -n kube-system get ds calico-node" },
      { id: "pods", label: "Pods", sub: "your workloads", x: 600, y: 290, w: 200, desc: "Containers sharing a network namespace (one IP) and volumes. Created by the kubelet from the PodSpec the scheduler bound to this node.", cmd: "kubectl get pods -A -o wide --field-selector spec.nodeName=sre-labs-worker" },
    ],
    edges: [
      { from: "api", to: "etcd", label: "read/write" }, { from: "sched", to: "api", label: "watch · bind" }, { from: "cm", to: "api", label: "watch · create" }, { from: "dns", to: "api", label: "watch svc" },
      { from: "kubelet", to: "api", label: "watch pods · status" }, { from: "kubelet", to: "cri" }, { from: "proxy", to: "api", label: "watch svc/eps" }, { from: "cni", to: "pods", dashed: true }, { from: "cri", to: "pods" }, { from: "kubelet", to: "pods", label: "probes", dashed: true },
    ],
    legend: "Click a component. Solid arrows are API calls or control; dashed arrows are data-plane effects. Everything converges on the API server; only the API server touches etcd.",
  },
  "request-lifecycle": {
    title: "From kubectl apply to a running container",
    width: 900, height: 300,
    groups: [{ id: "api", label: "kube-apiserver request pipeline", x: 150, y: 20, w: 560, h: 120, color: "#38bdf8" }],
    nodes: [
      { id: "kubectl", label: "kubectl apply", x: 20, y: 60, w: 110, desc: "Client-side: reads YAML, computes a server-side or three-way patch, sends an HTTPS request with your kubeconfig credentials.", cmd: "kubectl apply --dry-run=server -f manifest.yaml -v=6" },
      { id: "authn", label: "AuthN", sub: "who are you", x: 170, y: 60, w: 90, desc: "Client certificate, bearer token (ServiceAccount, OIDC) or webhook. Failure is 401.", cmd: "kubectl auth whoami" },
      { id: "authz", label: "AuthZ (RBAC)", sub: "may you", x: 275, y: 60, w: 110, desc: "RBAC evaluates Roles/ClusterRoles bound to the subject for this verb on this resource. Failure is 403 Forbidden.", cmd: "kubectl auth can-i create deployments -n default" },
      { id: "adm", label: "Admission", sub: "mutate · validate", x: 400, y: 60, w: 130, desc: "Mutating plugins/webhooks may change the object (defaults, sidecars), then validating ones can reject it (quotas, policies, Pod Security).", cmd: "kubectl get validatingwebhookconfigurations,mutatingwebhookconfigurations" },
      { id: "schema", label: "Schema", sub: "OpenAPI/CRD", x: 545, y: 60, w: 90, desc: "Structural validation against the built-in or CRD schema; unknown fields are pruned or rejected (strict).", cmd: "kubectl explain deployment.spec.strategy" },
      { id: "etcd", label: "etcd", x: 650, y: 60, w: 50, desc: "The object is persisted; a watch event is emitted to every client watching that resource." },
      { id: "ctrl", label: "controller-manager", sub: "Deployment → RS → Pod", x: 150, y: 200, w: 170, desc: "The Deployment controller sees the new object and creates a ReplicaSet; the ReplicaSet controller creates Pods (nodeName empty).", cmd: "kubectl get rs -o wide" },
      { id: "sched", label: "scheduler", sub: "binding", x: 370, y: 200, w: 120, desc: "Sees a Pod with no nodeName, filters and scores nodes, writes a Binding (sets spec.nodeName).", cmd: "kubectl get events --field-selector reason=Scheduled" },
      { id: "kubelet", label: "kubelet", sub: "on the node", x: 540, y: 200, w: 110, desc: "Sees a Pod bound to its node, pulls images through containerd, creates the sandbox and containers, runs probes.", cmd: "kubectl describe pod <pod> | sed -n '/Events/,$p'" },
      { id: "status", label: "status write-back", x: 700, y: 200, w: 160, desc: "kubelet writes Pod status; the ReplicaSet and Deployment controllers update their status (readyReplicas, conditions). Desired vs observed converges." },
    ],
    edges: [{ from: "kubectl", to: "authn" }, { from: "authn", to: "authz" }, { from: "authz", to: "adm" }, { from: "adm", to: "schema" }, { from: "schema", to: "etcd" }, { from: "etcd", to: "ctrl", label: "watch", dashed: true }, { from: "ctrl", to: "sched", label: "Pod created", dashed: true }, { from: "sched", to: "kubelet", label: "bound", dashed: true }, { from: "kubelet", to: "status" }, { from: "status", to: "etcd", label: "via API", dashed: true }],
    legend: "Every write passes the pipeline in order. Dashed arrows are watch events: controllers never call each other, they react to state.",
  },
  "flux-flow": {
    title: "Flux: from a Git commit to a reconciled cluster",
    width: 900, height: 330,
    groups: [{ id: "flux", label: "flux-system controllers", x: 230, y: 20, w: 450, h: 290, color: "#38bdf8" }],
    nodes: [
      { id: "git", label: "Git repo", sub: "Gitea / GitHub", x: 20, y: 60, w: 140, desc: "Source of truth. In this lab: http://localhost:30080 (Gitea). A GitRepository object points at a URL + branch/tag/semver.", cmd: "flux get sources git -A" },
      { id: "helmrepo", label: "Helm repo / OCI", x: 20, y: 200, w: 140, desc: "A HelmRepository (index.yaml or oci://) or an OCIRepository. Also produced into artifacts by source-controller.", cmd: "flux get sources helm -A" },
      { id: "src", label: "source-controller", sub: "fetch → artifact", x: 260, y: 60, w: 170, desc: "Polls sources every spec.interval, verifies, and packages the content as a tarball artifact served over HTTP inside the cluster. Status.artifact.revision is what consumers read.", cmd: "kubectl -n flux-system logs deploy/source-controller --tail=20" },
      { id: "kc", label: "kustomize-controller", sub: "Kustomization", x: 480, y: 60, w: 180, desc: "Downloads the artifact, runs kustomize build on spec.path, applies with server-side apply, prunes removed objects, waits for health checks, honours dependsOn.", cmd: "flux get kustomizations -A" },
      { id: "hc", label: "helm-controller", sub: "HelmRelease", x: 480, y: 200, w: 180, desc: "Renders the chart with values, runs helm install/upgrade with remediation and drift detection, records the release Secret like the CLI would.", cmd: "flux get helmreleases -A" },
      { id: "nc", label: "notification-controller", sub: "Alerts · Receivers", x: 260, y: 200, w: 170, desc: "Turns reconciliation events into Slack/Teams/webhooks (Provider + Alert) and receives webhooks to trigger immediate reconciliation (Receiver).", cmd: "flux events -A --for Kustomization/apps" },
      { id: "cluster", label: "Cluster objects", sub: "Deployments, CRs…", x: 720, y: 120, w: 160, desc: "The materialised state. Any drift (kubectl edit, scale) is reverted on the next reconcile unless the object is suspended.", cmd: "kubectl get all -n lab-podinfo" },
    ],
    edges: [{ from: "git", to: "src", label: "poll" }, { from: "helmrepo", to: "src", label: "poll" }, { from: "src", to: "kc", label: "artifact", dashed: true }, { from: "src", to: "hc", label: "chart", dashed: true }, { from: "kc", to: "cluster", label: "SSA apply" }, { from: "hc", to: "cluster", label: "helm upgrade" }, { from: "kc", to: "nc", dashed: true }, { from: "hc", to: "nc", dashed: true }],
    legend: "Sources produce artifacts; consumers apply them. Each object has its own interval; `flux reconcile` forces a run.",
  },
  "helm-flow": {
    title: "Helm: chart + values → release revision",
    width: 900, height: 260,
    groups: [],
    nodes: [
      { id: "chart", label: "Chart", sub: "Chart.yaml · templates/", x: 20, y: 40, w: 150, desc: "A versioned package: Chart.yaml metadata, templates/ rendered with Go templating, default values.yaml, optional values.schema.json and dependencies.", cmd: "helm show chart podinfo/podinfo" },
      { id: "values", label: "values", sub: "-f / --set / valuesFrom", x: 20, y: 160, w: 150, desc: "Layered: chart defaults < -f files in order < --set. Flux's HelmRelease merges valuesFrom then values.", cmd: "helm get values web -n lab-helmcli" },
      { id: "render", label: "render", sub: "helm template", x: 230, y: 100, w: 130, desc: "Templates + values → plain manifests. Run it in CI: helm template + kubeconform catches most mistakes before a cluster sees them.", cmd: "helm template web ./webchart | head -40" },
      { id: "apply", label: "install / upgrade", sub: "3-way merge", x: 420, y: 100, w: 150, desc: "Helm diffs last release manifest, live state and new manifest, then applies. --wait/--atomic make failures roll back automatically.", cmd: "helm upgrade --install web ./webchart -n lab-helmcli --wait" },
      { id: "secret", label: "release Secret", sub: "sh.helm.release.v1.*", x: 630, y: 40, w: 180, desc: "Every revision is stored as a Secret in the release namespace: the rendered manifest, values and status. helm history reads these.", cmd: "kubectl get secrets -n lab-helmcli -l owner=helm" },
      { id: "objects", label: "cluster objects", x: 630, y: 160, w: 180, desc: "The Deployments, Services, ConfigMaps the chart produced, labelled app.kubernetes.io/managed-by=Helm.", cmd: "kubectl get all -n lab-helmcli -l app.kubernetes.io/managed-by=Helm" },
    ],
    edges: [{ from: "chart", to: "render" }, { from: "values", to: "render" }, { from: "render", to: "apply" }, { from: "apply", to: "secret", label: "revision N" }, { from: "apply", to: "objects" }, { from: "secret", to: "apply", label: "rollback", dashed: true }],
    legend: "A release is the chart rendered with values, applied, and recorded. Rollback re-applies the manifest of an older revision.",
  },
  "service-traffic-path": {
    title: "Service traffic path and where it breaks",
    width: 900, height: 250,
    groups: [],
    nodes: [
      { id: "client", label: "client Pod", x: 20, y: 90, w: 110, desc: "curl http://web.lab-shop:80 from any Pod. Uses /etc/resolv.conf (nameserver = kube-dns ClusterIP, search domains, ndots:5)." },
      { id: "dns", label: "CoreDNS", sub: "name → ClusterIP", x: 170, y: 90, w: 120, desc: "Resolves web.lab-shop.svc.cluster.local to the Service ClusterIP. Break: Corefile wrong, dnsPolicy None, NetworkPolicy blocking UDP/TCP 53.", cmd: "kubectl run -it --rm dnsprobe --image=busybox:1.36 --restart=Never -- nslookup web.lab-shop" },
      { id: "svc", label: "Service ClusterIP", sub: "virtual IP", x: 330, y: 90, w: 140, desc: "Not a process: an IP that exists only in kube-proxy rules. port is what clients use, targetPort is the container port.", cmd: "kubectl get svc -n lab-shop web -o wide" },
      { id: "proxy", label: "kube-proxy rules", sub: "DNAT to endpoint", x: 510, y: 90, w: 150, desc: "iptables/IPVS picks one ready endpoint. No endpoints → REJECT → connection refused. Break: selector mismatch, Pods not Ready.", cmd: "kubectl get endpointslices -n lab-shop -l kubernetes.io/service-name=web" },
      { id: "netpol", label: "NetworkPolicy", sub: "Calico", x: 700, y: 20, w: 150, desc: "Evaluated on the destination Pod's ingress and source Pod's egress. Drops silently → timeouts, not refused.", cmd: "kubectl get netpol -A" },
      { id: "pod", label: "backend Pod :targetPort", x: 700, y: 160, w: 180, desc: "The container must actually listen on targetPort. Wrong targetPort → connection refused from the Pod's kernel; app crash → 5xx or reset.", cmd: "kubectl exec -n lab-shop deploy/web -- netstat -tlnp 2>/dev/null || kubectl exec -n lab-shop deploy/web -- ss -tlnp" },
    ],
    edges: [{ from: "client", to: "dns", label: "1 resolve" }, { from: "dns", to: "svc", label: "2 ClusterIP", dashed: true }, { from: "client", to: "svc", label: "3 connect", dashed: true }, { from: "svc", to: "proxy", label: "4 DNAT" }, { from: "proxy", to: "netpol", label: "5 policy" }, { from: "netpol", to: "pod", label: "6 deliver" }],
    legend: "Refused = nothing listening (empty Service or wrong targetPort). Timeout = dropped (policy, routing, dead node). 5xx = the app.",
  },
};
