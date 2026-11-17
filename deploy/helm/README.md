# Helm chart

`nether/` is the official chart for running the Nether server on
Kubernetes, one node or several with high availability, the sync service
scaling with the server
([ADR 0082](../../docs/adr/0082-several-nodes-share-sync-through-valkey-take-their-order-from-postgresql-and-roll-out-one-at-a-time.md)).
Each release pushes it to `oci://ghcr.io/fzn0x/charts/nether`; the
[Kubernetes guide](https://fzn0x.github.io/nether/kubernetes/) shows how
to install it, and `nether/examples/` has whole sets of values.

```sh
helm install nether oci://ghcr.io/fzn0x/charts/nether --set bundled.enabled=true
```

It installs the server's Deployment, its Service, its migration Job, a
Secret unless you bring one, a volume claim for attachments on disk, and,
when asked, an Ingress, a Gateway API HTTPRoute, a PodDisruptionBudget and
an autoscaler. `bundled.enabled` adds one PostgreSQL and one Valkey with
no failover, to try it.

## Checks

- `.github/workflows/helm.yml`, on every change here: `helm lint --strict`
  with the defaults and each example; `helm template` of each example,
  validated with kubeconform against Kubernetes 1.30 and 1.37; and values
  that cannot run refused, saying why.
- `.github/workflows/kind.yml`, on changes to the chart or the server, and
  nightly: the image built from the commit and loaded into a kind cluster
  (`kind-cluster.yaml`), installed with `nether/examples/kind.yaml`, then
  `check.mjs`: setup with the chart's code, sync through the Service, a pod
  deleted, and an upgrade that replaces every pod while a client keeps
  asking, with no request failed and no push lost.

To run the kind check here, with Docker, kind, kubectl and Helm:

```sh
docker build -f deploy/docker/Dockerfile -t ghcr.io/fzn0x/nether-server:kind .
kind create cluster --name nether-check --config deploy/helm/kind-cluster.yaml
kind load docker-image ghcr.io/fzn0x/nether-server:kind --name nether-check
kubectl apply -f deploy/helm/kind-claim.yaml
helm install nether deploy/helm/nether -f deploy/helm/nether/examples/kind.yaml --wait
node deploy/helm/check.mjs
```

The tools the checks use, all Apache-2.0: Helm v4.3.1, kind v0.33.0 with
Kubernetes 1.37.0, and kubeconform v0.8.0, with HTTPRoute's schema from
the CRDs catalog (MIT) at a pinned commit.
