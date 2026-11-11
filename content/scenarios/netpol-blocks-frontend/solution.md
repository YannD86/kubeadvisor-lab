## Diagnosis

Classify the failure first. The frontend sees timeouts, not `connection
refused`; endpoints exist and the backend answers on port-forward. Packets
are therefore being dropped between the two Pods, which in a cluster means a
NetworkPolicy (or a host firewall, far rarer).

```bash
kubectl logs -n lab-netpol deploy/frontend --tail=3
# curl: (28) Connection timed out after 3001 milliseconds
# 09:12:05 GET http://backend -> 000

kubectl get networkpolicy -n lab-netpol
# NAME                   POD-SELECTOR   AGE
# default-deny-ingress   <none>         6h

kubectl describe networkpolicy default-deny-ingress -n lab-netpol
# Spec:
#   PodSelector:     <none> (Allowing the specific traffic to all pods in this namespace)
#   Allowing ingress traffic:
#     <none> (Selected pods are isolated for ingress)
#   Policy Types: Ingress
```

`PodSelector: <none>` is `{}`: every Pod in `lab-netpol` is selected, and with
no ingress rules every selected Pod is isolated for ingress. The backend Pods
accept nothing, including from the frontend.

## Root cause

A namespace-wide default-deny for ingress was applied without a matching
allow policy for the legitimate flow `frontend -> backend:80`. The deny is
intentional (security baseline); the missing allow is the bug.

## Fix

Do not delete or edit `default-deny-ingress`. Add a second policy that
selects the backend and whitelists the frontend on the port it needs:

```bash
kubectl apply -n lab-netpol -f - <<'EOF2'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: allow-frontend-to-backend
spec:
  podSelector:
    matchLabels:
      app: backend
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: frontend
      ports:
        - protocol: TCP
          port: 80
EOF2

kubectl exec -n lab-netpol deploy/frontend -- curl -s -o /dev/null -w '%{http_code}\n' --max-time 5 http://backend
# 200
```

Calico applies the change immediately for new connections. A throwaway Pod
without the `app=frontend` label still times out, which is exactly what the
baseline demands.

If you ever add a default-deny for **Egress** as well, remember that the
frontend then also needs an egress rule to `kube-system` on UDP/TCP 53,
otherwise name resolution fails before any HTTP request is made.

## Prevention

- Ship default-deny and the allow policies for known flows in the same
  change; a deny without its allows is an outage, not hardening.
- Keep the flow list next to the app (same chart/kustomization) so a new
  dependency comes with its policy.
- Test connectivity in CI with a short-lived Pod per flow, or run a
  continuous checker that alerts when a known flow starts timing out.
- Prefer `kubectl describe networkpolicy` over `get -o yaml`: it spells out
  "isolated for ingress" explicitly.
