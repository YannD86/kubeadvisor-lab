---
title: "Secrets in GitOps: SOPS, Sealed Secrets, External Secrets"
slug: secrets-in-gitops
realm: gitops
order: 10
summary: "Why a Secret manifest in Git is the classic mistake, the three ways teams fix it, how they compare, and a worked SOPS + age setup decrypted by kustomize-controller."
estimated_minutes: 15
level: intermediate
tags: [secrets, sops, age, sealed-secrets, external-secrets, flux]
builders: [external-secret]
scenarios: []
quiz:
  - q: "Why is a Kubernetes Secret manifest committed to Git a problem even in a private repository?"
    options: ["Secrets cannot be applied by Flux", "base64 is encoding, not encryption: anyone with repo read access, every clone and every CI runner has the plaintext forever in history", "Git rejects binary data", "The Secret would be pruned"]
    answer: 1
    explain: "Repository access is wide and history is permanent. Rotating the value later does not remove it from past commits."
  - q: "Which Flux field makes kustomize-controller decrypt SOPS-encrypted files before applying?"
    options: ["spec.postBuild.substituteFrom", "spec.decryption with provider: sops and a secretRef holding the private key", "spec.sourceRef.secretRef", "spec.healthChecks"]
    answer: 1
    explain: "Decryption happens inside kustomize-controller after the build. The age (or PGP) private key is read from the referenced Secret in the Kustomization's namespace."
  - q: "Which approach keeps no secret material in Git at all, encrypted or otherwise?"
    options: ["SOPS", "Sealed Secrets", "External Secrets Operator", "All three"]
    answer: 2
    explain: "ESO commits only a reference (store + key name); the value lives in a secret manager and is synced into the cluster at runtime."
---

# Secrets in GitOps

GitOps says everything the cluster needs is in Git. Secrets are the first
thing that cannot be, as-is, and the mistake is so common it has a
canonical form:

```yaml
apiVersion: v1
kind: Secret
metadata: { name: db, namespace: shop }
type: Opaque
data:
  password: czNjcjN0            # echo czNjcjN0 | base64 -d  →  s3cr3t
```

**Why it matters:** base64 is an encoding. Everyone with read access to
the repository (which, in most companies, is everyone), every laptop clone,
every CI runner cache and every fork now holds the plaintext, and `git
log` keeps it after you rotate it. The fix is never "make the repo
private"; it is to make sure the *value* is not in Git, or is in Git
only in a form the Git host cannot read.

Three designs do that. They differ in *where the plaintext exists* and *who
can turn the committed thing into a Secret*.

## The three approaches

| | **SOPS (+ age / PGP / KMS)** | **Sealed Secrets** | **External Secrets Operator** |
|---|---|---|---|
| What is in Git | The Secret manifest with encrypted values, keys and metadata in clear | A `SealedSecret` with one opaque ciphertext blob | An `ExternalSecret`: store name + key names, no values |
| Where plaintext lives | Nowhere at rest; decrypted in memory by kustomize-controller | Nowhere at rest; decrypted by the sealed-secrets controller | In the external store (Vault, AWS/GCP/Azure secret managers, 1Password…) |
| Who decrypts | kustomize-controller, natively (no extra controller) | A controller you install, holding the cluster's private key | A controller you install, authenticated to the store |
| Keys | Your age/PGP keys or a cloud KMS key; one private key per cluster or team | A certificate generated per cluster, rotated every 30 days; you must back it up | The store's IAM; Kubernetes never holds a long-lived decryption key |
| Rotate a value | Edit with `sops`, commit | Re-seal with `kubeseal`, commit | Change it in the store; ESO refreshes on `refreshInterval` |
| Review in a PR | Keys visible, values `ENC[...]`: reviewable diff | Blob changed: not reviewable | Fully reviewable, nothing sensitive |
| Portability | Any cluster with the key can decrypt; sharing keys across clusters is a choice | Bound to the cluster whose key sealed it (scope `strict` by default) | Any cluster with access to the store |
| Extra moving parts | `sops` CLI for authors; nothing in-cluster | One controller | One controller plus an external secret manager |
| Fits | Teams already on Flux, no secret manager, small to mid scale | Teams who want the simplest in-cluster-only option | Organisations with an existing vault or cloud secret manager |

The choice is rarely technical. If a secret manager exists, ESO: secrets
stay where security already audits them, and Git holds only pointers. If
none exists, SOPS with age is the lightest path and needs nothing beyond
Flux. Sealed Secrets is the middle ground with one hard rule: back up the
sealing key, or a cluster rebuild loses every secret.

## Worked example: SOPS + age with Flux

Run the first three steps on a workstation with `sops` and `age` installed;
the last two are cluster-side.

**1. Generate a key and tell sops which files to encrypt.**

```bash
age-keygen -o age.agekey
# Public key: age1u8n6k…                 ← goes in .sops.yaml; the file holds the private key
cat > .sops.yaml <<'YAML'
creation_rules:
  - path_regex: .*\.enc\.yaml$
    encrypted_regex: ^(data|stringData)$     # encrypt values only; kind/metadata stay readable
    age: age1u8n6k…                          # one or more recipients, comma-separated
YAML
```

**2. Write the Secret and encrypt it in place.**

```bash
kubectl create secret generic db -n shop --from-literal=password=s3cr3t \
  --dry-run=client -o yaml > apps/shop/db-secret.enc.yaml
sops --encrypt --in-place apps/shop/db-secret.enc.yaml
```

The committed file keeps its shape; only the values and a trailer change:

```yaml
apiVersion: v1
kind: Secret
metadata: { name: db, namespace: shop }
type: Opaque
data:
  password: ENC[AES256_GCM,data:7K1xP0dq…,iv:…,tag:…,type:str]
sops:
  age:
    - recipient: age1u8n6k…
      enc: |
        -----BEGIN AGE ENCRYPTED FILE-----
        …
  lastmodified: "2026-10-22T09:30:11Z"
  mac: ENC[AES256_GCM,data:…,type:str]
  encrypted_regex: ^(data|stringData)$
  version: 3.9.4
```

**3. Commit it** alongside the rest of `apps/shop/`, referenced from the
directory's `kustomization.yaml` like any manifest.

**4. Give kustomize-controller the private key**, once per cluster, out of
band (this is the one secret that is not in Git):

```bash
kubectl -n flux-system create secret generic sops-age \
  --from-file=age.agekey=age.agekey        # the key must be in a file ending in .agekey
```

**5. Point the Kustomization at it.**

```yaml
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: apps
  namespace: flux-system
spec:
  interval: 10m
  sourceRef: { kind: GitRepository, name: demo }
  path: ./apps
  prune: true
  decryption:
    provider: sops
    secretRef:
      name: sops-age                       # must live in the Kustomization's namespace
```

After the build and before the apply, kustomize-controller finds every
object carrying a `sops` field, decrypts the `data`/`stringData` values with
the keys in `sops-age`, and applies plain Secrets. The decrypted material
exists only in the controller's memory and in the API server, as with any
Secret. A missing or wrong key fails the whole Kustomization at the build
step: `Ready=False` with reason `BuildFailed` and a message starting
`error decrypting sources:` or `decryption failed for 'v1/Secret/db':`, so
nothing half-encrypted is ever applied.

**Gotcha:** SOPS protects Git, not the cluster. Inside the cluster the
Secret is ordinary; etcd encryption at rest and RBAC on `secrets` are
separate controls. And the `sops-age` Secret is the master key: restrict
who can read Secrets in `flux-system`, and rotate it by adding a new
recipient (`sops updatekeys`) before removing the old.

## Sealed Secrets and ESO in one screen each

```bash
# Sealed Secrets: encrypt with the cluster's public certificate, commit the result
kubeseal --fetch-cert > pub-cert.pem
kubectl create secret generic db -n shop --from-literal=password=s3cr3t --dry-run=client -o yaml \
  | kubeseal --cert pub-cert.pem -o yaml > apps/shop/db-sealedsecret.yaml   # kind: SealedSecret, bitnami.com/v1alpha1
```

```yaml
# External Secrets Operator: commit a pointer; the operator writes the Secret
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: { name: db, namespace: shop }
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: ClusterSecretStore, name: vault }
  target: { name: db }                       # the Secret that will be created
  data:
    - secretKey: password                    # key in the Kubernetes Secret
      remoteRef: { key: shop/db, property: password }   # location in the store
```

The *External Secret* builder walks through that manifest field by field.
Flux applies `SealedSecret` and `ExternalSecret` objects like any other
custom resource; the respective controller turns them into Secrets, and
`wait: true` on the Kustomization holds dependants until the Secret exists
(both report a `Ready` condition).

**Try it:** prove the classic mistake to yourself, then see what Flux
would need for SOPS. Nothing here requires the SOPS tooling in the lab
terminal.

```bash
kubectl create secret generic db --from-literal=password=s3cr3t --dry-run=client -o yaml
echo czNjcjN0 | base64 -d; echo                                 # "encryption" by base64
kubectl get crds | grep -E 'sealedsecrets|external-secrets' || echo "no secret tooling installed: the manifests above are what you would commit"
flux create kustomization secure-apps --source=GitRepository/demo --path=./apps \
  --prune=true --interval=10m \
  --decryption-provider=sops --decryption-secret=sops-age --export   # the Kustomization, generated
kubectl -n flux-system auth can-i get secrets --as=system:serviceaccount:flux-system:kustomize-controller   # who can read sops-age
```

## Where to go next

This closes the realm. Go back to the scenarios attached to lessons 3, 4,
5, 7 and 9: each one breaks a single mechanism you have now read about, and
the fastest way to make this knowledge stick is to find the break with
`flux get`, `describe` and `flux logs` before opening the solution.
