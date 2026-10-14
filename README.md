# Node React PostgreSQL Platform — Cloudly DevOps Assessment

A local DevOps assessment project that packages a React/Vite frontend and Node.js/Express backend with PostgreSQL, then extends the platform with Kubernetes, Ingress, Redis/BullMQ, OpenSearch, CI/CD, monitoring, autoscaling, and log collection.

> **Implementation and verification note:** This README distinguishes configured resources from verified behavior. Docker Compose frontend and API health checks returned HTTP `200` / `{"status":"ok"}`. Kubernetes application pods were reported `Running`, but the host request to `http://node-react.local` failed with connection refused during testing. The GitHub Actions image build/push succeeded in a previous run, while its deployment stage failed because the hosted runner did not have a usable `KUBECONFIG_B64` for the local Kind cluster. HPA CPU utilization was reported as `unknown`, and Fluent Bit → Loki log delivery was not verified because the Fluent Bit output reported HTTP 500/ring errors.

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Run locally with Docker Compose](#run-locally-with-docker-compose)
- [Deploy to local Kubernetes](#deploy-to-local-kubernetes)
- [Request path, Ingress, and Kubernetes DNS](#request-path-ingress-and-kubernetes-dns)
- [Debugging guide](#debugging-guide)
- [Platform services: Redis, BullMQ, and OpenSearch](#platform-services-redis-bullmq-and-opensearch)
- [Database read/write routing and consistency](#database-readwrite-routing-and-consistency)
- [CI/CD workflow, secrets, and rollback](#cicd-workflow-secrets-and-rollback)
- [Observability, alerting, HPA, and rate limiting](#observability-alerting-hpa-and-rate-limiting)
- [Evidence and screenshots](#evidence-and-screenshots)
- [Known limitations and next steps](#known-limitations-and-next-steps)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)

## Architecture

```text
Browser
  |
  | Docker Compose: http://localhost:8081
  | Kubernetes:     http://node-react.local (Ingress; connectivity pending)
  v
React/Vite frontend
  |
  | /api requests
  v
Node.js / Express backend
  |             |                 |
  v             v                 v
PostgreSQL     Redis/BullMQ      OpenSearch
(primary DB)   background jobs   search
                  |
                  v
             BullMQ worker

Kubernetes observability (configured locally):
Prometheus -> Grafana
Fluent Bit -> Loki (delivery not yet verified)
Backend HPA (manifest applied; CPU metric was unknown)
```

The repository contains Docker Compose configuration for local application startup and Kubernetes manifests under `k8s/`. The local Kubernetes cluster used during testing was Kind, named `cloudly-assessment`, with a `dev` namespace. Monitoring components were installed locally with Helm.

## Prerequisites

Install and start the following on your workstation:

- Docker Desktop with Docker Compose v2
- Git
- `kubectl`
- Kind
- A web browser
- Helm, if you want to install or inspect the monitoring stack

Check the tools:

```powershell
docker version
docker compose version
kubectl version --client
kind version
helm version
```

Commands below use PowerShell on Windows. Adapt paths and shell syntax for other operating systems.

## Run locally with Docker Compose

From the repository root:

```powershell
docker compose up --build -d
docker compose ps
```

Open the frontend:

- `http://localhost:8081`

Check the backend health endpoint through the published application port:

```powershell
curl.exe -i http://localhost:8081/api/health
```

**Observed result during assessment:** the frontend returned HTTP `200`, and the API health endpoint returned:

```json
{"status":"ok"}
```

To view service logs:

```powershell
docker compose logs --tail=100
docker compose logs --tail=100 backend
docker compose logs --tail=100 frontend
```

Stop the stack:

```powershell
docker compose down
```

The PostgreSQL service is configured with persistent storage so database files can survive container recreation. Do not remove the named volume when stopping the stack unless you intentionally want to delete local database data. To inspect the actual Compose service names and port mappings, run:

```powershell
docker compose config
docker compose ps
```

### Environment variables

Provide database connection details and frontend API configuration through environment variables or a local `.env` file, according to the Compose configuration. Typical settings include database host, port, username, password, database name, and the frontend API base URL.

- Do not commit `.env` files containing real credentials.
- Keep only safe placeholders in example configuration.
- In Compose, the database host should be the Compose service name rather than `localhost` from inside the backend container.
- From a browser, the frontend API URL must resolve from the browser's point of view; from a container, service-to-service calls should use the Docker network and service DNS.

## Deploy to local Kubernetes

The local Kind cluster used for this assessment was named `cloudly-assessment`, and application resources were placed in namespace `dev`.

Check the current context and cluster:

```powershell
kubectl config current-context
kubectl get nodes -o wide
kubectl get namespace dev
```

If the cluster does not exist, create one:

```powershell
kind create cluster --name cloudly-assessment
kubectl config use-context kind-cloudly-assessment
```

Apply the namespace and manifests. Review the files first and apply in an order that respects dependencies; if the namespace manifest is present:

```powershell
kubectl apply -f k8s/namespace-dev.yaml
kubectl apply -R -f k8s/
```

If your local manifest filenames differ, use the actual filenames in the repository. Applying the directory recursively may re-apply the namespace; this is normally idempotent. Confirm resource status:

```powershell
kubectl get all -n dev
kubectl get pvc -n dev
kubectl get ingress -n dev
kubectl get hpa -n dev
kubectl get events -n dev --sort-by=.lastTimestamp
```

Inspect a specific deployment or pod when troubleshooting:

```powershell
kubectl describe deployment backend -n dev
kubectl logs deployment/backend -n dev --tail=100
```

**Observed during assessment:** frontend, backend, PostgreSQL, Redis, OpenSearch, and BullMQ worker pods were reported `Running` and ready at the time of the check. The Ingress controller pod was also `Running`. These pod statuses do not, by themselves, prove that browser traffic through the Ingress works.

### Ingress access status

The Ingress resource was configured for host `node-react.local`, with `/` routed to the frontend service and `/api` routed to the backend service. A hosts-file entry was added for `node-react.local`, but requests to `http://node-react.local/` and `/api/health` failed with connection refused during the recorded verification. The Ingress controller service showed NodePort `31309` and `EXTERNAL-IP` pending.

Therefore, **Kubernetes Ingress access is currently unverified/failed in the recorded test**. Do not treat `http://node-react.local` as a working endpoint until the Kind host-port mapping or NodePort access is corrected and retested.

## Request path, Ingress, and Kubernetes DNS

Expected request path:

```text
Browser
  -> node-react.local
  -> Ingress controller
  -> Ingress rule (host + path)
  -> Kubernetes Service
  -> ready Pod
  -> backend database/service dependency
```

- `/` is intended to route to the frontend Service.
- `/api` is intended to route to the backend Service.
- A Service selects matching pods using labels and provides a stable virtual IP/DNS name.
- Within namespace `dev`, a service can usually be reached by its service name, such as `backend-service`.
- A fully qualified service DNS name follows the pattern `<service>.<namespace>.svc.cluster.local`, for example `backend-service.dev.svc.cluster.local`.
- Service DNS is for communication from inside the cluster. It does not automatically make a service reachable from the host browser.
- Ingress exposes HTTP(S) routing through an Ingress controller. With Kind, the cluster's port mappings and the controller's NodePort/LoadBalancer configuration must also allow traffic from the host.

### Debugging scenario A: Ingress is reachable but the backend is not

Check in this order:

```powershell
kubectl get ingress -n dev
kubectl describe ingress node-react-ingress -n dev
kubectl get svc -n dev
kubectl get endpoints -n dev
kubectl get pods -n dev -o wide
kubectl logs deployment/backend -n dev --tail=100
```

Verify the Ingress backend service name and target port, the Service selector, the Service endpoints, the backend container port, and backend readiness. If the Ingress controller can be reached but the API returns `502`/`503`, investigate service endpoints and backend health. If the host cannot connect at all, investigate Kind port mapping and controller exposure before debugging application code.

### Debugging scenario B: frontend cannot reach backend

- Open browser developer tools and inspect the failed request URL, status, and CORS/network errors.
- Check the frontend API base URL. A URL such as `http://backend-service:4000` is normally resolvable only inside the cluster, not by the user's browser.
- For browser-originated calls, route API traffic through the same host using `/api`, if that matches the frontend and Ingress configuration.
- From inside the cluster, test backend service DNS and port connectivity from a temporary diagnostic pod.
- Check backend logs, Service endpoints, readiness probes, and any CORS settings.

## Platform services: Redis, BullMQ, and OpenSearch

Kubernetes manifests and backend code were added for Redis, a BullMQ worker, and OpenSearch. These components provide the intended building blocks for asynchronous work and search:

- **Redis:** queue backing store/cache service for internal application use.
- **BullMQ worker:** processes queued background jobs separately from the HTTP request path.
- **OpenSearch:** search index used by the backend search implementation.

Keep Redis, the queue worker, OpenSearch, and PostgreSQL internal to the cluster unless a deliberate access requirement says otherwise. Avoid exposing internal platform services directly to the public Ingress.

Useful checks:

```powershell
kubectl get pods,svc -n dev
kubectl logs deployment/bullmq-worker -n dev --tail=100
kubectl logs deployment/backend -n dev --tail=100
```

**Verification status:** the relevant resources and code were present and pods were reported running, but end-to-end job processing and indexing/search behavior were not fully verified during the recorded assessment. Confirm a job is enqueued and processed, then submit a search query and verify expected indexed results before claiming those flows are fully operational.

## Database read/write routing and consistency

The assessment asks for `DB_WRITE_URL` and `DB_READ_URL` to illustrate read/write routing. In a production topology, writes should go to the primary database, while reads may go to a replica:

```text
Application write -> DB_WRITE_URL -> primary PostgreSQL
Application read  -> DB_READ_URL  -> read replica
```

This repository's local environment includes a PostgreSQL service with persistent storage. A separate read replica and replication topology were not verified as running during the assessment. Therefore, `DB_READ_URL` should only point to a real read replica when one is deployed and configured; do not point it at a nonexistent replica or claim replication is operational without testing it.

Replication introduces lag: a read immediately after a write may return stale data if it is served by a replica. For read-after-write operations, use the primary or a consistency strategy that waits for replica catch-up. Credentials for both URLs must be stored as secrets, not committed to source control.

## CI/CD workflow, secrets, and rollback

The repository contains `.github/workflows/ci-cd.yml` for the assessment CI/CD workflow.

The intended environment mapping is:

| Git ref pattern | Intended environment |
|---|---|
| `master` | `dev` |
| `pre-release/v*` | `preprod` |
| `release/v*` | `release` |

The workflow is intended to build/test container images, tag and push them to a registry, and deploy to the target environment. Review the actual workflow before changing branch names or secrets.

### Secrets handling

Configure secrets in **GitHub repository → Settings → Secrets and variables → Actions**. Use the names referenced by the workflow. Do not place tokens, passwords, registry credentials, or kubeconfig data directly in YAML or README. Use least-privilege credentials and rotate exposed credentials.

The workflow previously built/pushed images successfully, but the deployment stage failed because `KUBECONFIG_B64` was empty or unavailable for the hosted runner. A GitHub-hosted runner cannot directly use a Kind cluster that exists only on a developer's laptop. To deploy from CI, use an intentionally reachable target cluster with a narrowly scoped credential, or run deployment from a controlled self-hosted runner with appropriate access. Do not publish a local Kind kubeconfig as a public artifact.

### Rollback strategy

A practical rollback procedure is:

1. Keep immutable image tags (commit SHA or release version), rather than deploying only `latest`.
2. Identify the last known-good image tag or release.
3. Update the deployment to that image tag and apply it to the target environment.
4. Check rollout status and application health.
5. If a Kubernetes rollout is configured with revision history, inspect and use `kubectl rollout undo deployment/<deployment> -n <namespace>` when appropriate.
6. Verify logs, health endpoints, and metrics after rollback.

A rollback strategy is documented here, but a successful automated rollback was not verified in the recorded run.

## Observability, alerting, HPA, and rate limiting

Prometheus and Grafana were installed locally, and Grafana screenshots were captured for backend CPU, memory, and replica metrics. The dashboard and query coverage for request rate/error rate still need validation.

### Suggested alerts

| Signal | Example condition | Why it matters |
|---|---|---|
| HTTP error rate | 5xx ratio remains above a threshold for several minutes | Detects user-visible failures |
| Request latency | p95 latency exceeds the service SLO | Identifies slow requests |
| CPU utilization | Sustained high CPU relative to requests/limits | Indicates saturation or need to scale |
| Memory usage | Sustained high memory or repeated OOM kills | Detects memory pressure |
| Desired vs available replicas | Available replicas stay below desired replicas | Detects failed scheduling/readiness |
| Pod restarts | Restart rate rises above normal | Detects crashes or dependency failures |
| Queue backlog | Pending jobs continue growing | Detects worker throughput problems |
| Database health | Connection exhaustion or persistent query failures | Protects core application availability |

Tune thresholds to observed baseline and service requirements; these are alerting recommendations, not claims that all alert rules are configured.

### HPA

The backend HPA manifest is present at `k8s/hpa-backend.yaml` and was applied. During the check, CPU utilization showed `unknown`, so effective autoscaling is **not yet verified**. Confirm that the metrics API is available, the backend Deployment defines CPU requests, and the HPA reports a numeric current utilization:

```powershell
kubectl top pods -n dev
kubectl describe hpa backend-hpa -n dev
```

### Rate limiting

The Ingress manifest contains rate-limit annotations configured for approximately `10` requests per second with a burst multiplier of `5`. This is intended to reduce bursts and protect backend capacity. Validate that the deployed Ingress controller honors these annotations and test the actual behavior before treating the limit as enforced.

### Logging

Fluent Bit configuration was added in `fluent-bit-values.yaml` to tail Kubernetes container logs and send them to Loki at `loki.monitoring.svc.cluster.local:3100`. Loki was installed and its pod reported ready, but Fluent Bit output showed HTTP 500/ring-related errors during testing. Therefore, searchable log delivery is **not yet verified**. The required evidence of a successful Loki query should be added only after logs are visible and filterable in Grafana Explore.

## Evidence and screenshots

Assessment screenshots are stored in `docs/screenshots/`. The evidence should reflect actual results:

- `kubectl get all -n dev` output
- Docker Compose frontend/API health checks
- Application in the browser at `http://node-react.local` **only after it works**
- Grafana dashboards
- Loki log queries **only after successful ingestion**
- GitHub Actions run, including the real status of each stage

If a screenshot documents a failed test, label it as a failed/pending verification rather than successful evidence. Do not describe the current Ingress, HPA CPU metric, CI deployment, or Loki log pipeline as passing until they have been retested successfully.

## Known limitations and next steps

1. **Ingress host connectivity:** `http://node-react.local` and `/api/health` returned connection refused. The Ingress controller Service exposed NodePort `31309`; Kind host-port mapping/access needs correction and retesting.
2. **CI deployment:** image build/push succeeded in a previous run, but deployment failed because the hosted runner did not have a usable kubeconfig for the local Kind cluster.
3. **HPA:** CPU utilization was `unknown`; verify metrics-server/resource requests and numeric HPA readings.
4. **Fluent Bit/Loki:** output reported HTTP 500/ring errors; confirm log delivery and query results.
5. **Search and background jobs:** resources/code exist, but end-to-end search indexing and queue processing need a successful functional test.
6. **Read replica:** separate read-replica operation and replication lag were not verified; document the intended routing without claiming a replica is running.
7. **Request/error dashboards and alerts:** confirm metrics are emitted and panels/rules work.

## Design decisions and trade-offs

- **Docker Compose** gives a simple one-command local environment for quick application validation.
- **Kind** allows Kubernetes testing on a local workstation without a managed cluster. Host port mapping is a known networking trade-off compared with a cloud cluster.
- **Kubernetes Services** provide stable discovery and decouple clients from pod IPs.
- **Ingress** centralizes HTTP path routing and rate limiting, but depends on controller installation and host-to-cluster port mapping.
- **Redis/BullMQ** separates asynchronous work from the request path, but needs retries, idempotent job handlers, and queue monitoring for production.
- **OpenSearch** separates search queries from transactional database access, but needs index lifecycle and reindexing strategies.
- **Prometheus/Grafana** provide metrics visibility; logs require the Fluent Bit → Loki path to be healthy as well.
- **HPA** can respond to resource pressure only when metrics are available and resource requests are set.
- **CI/CD** should use immutable tags, scoped secrets, environment protections, and a deployment target reachable from the runner.

### What I would do with more time

- Fix and verify Kind host-port mapping and end-to-end Ingress access.
- Complete CI deployment using a secure, reachable target rather than assuming a hosted runner can access local Kind.
- Fix Fluent Bit/Loki delivery and capture a successful log query.
- Ensure HPA has working metrics and demonstrate scale-out under load.
- Verify queue processing, OpenSearch indexing/search, and any database read/write routing end to end.
- Add request/error/latency instrumentation, actionable alert rules, and a repeatable smoke-test stage.
- Automate screenshot/evidence collection and document exact tested versions and commands.

---

## Assessment submission

Repository: https://github.com/tahsinulhoque/node-react-postgres-platform