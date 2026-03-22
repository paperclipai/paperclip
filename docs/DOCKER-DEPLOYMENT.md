# Docker & Kubernetes Deployment Guide

Complete guide for deploying Paperclip with Docker and optional Kubernetes orchestration.

## Table of Contents

1. [Docker Deployment](#docker-deployment)
2. [Kubernetes Deployment](#kubernetes-deployment)
3. [Production Considerations](#production-considerations)
4. [Monitoring & Logging](#monitoring--logging)
5. [Scaling Strategies](#scaling-strategies)

## Docker Deployment

### Single Server Setup

**Best for**: Development, staging, small production (< 1000 users)

See **../PRODUCTION-README.md** for complete single-server setup.

### Multi-Container Orchestration

For production with automatic failover and scaling:

```bash
# Using docker-compose (simple)
docker-compose -f docker-compose.prod.yml up -d

# Using Docker Swarm (distributed)
docker swarm init
docker stack deploy -c docker-compose.prod.yml paperclip

# Using Kubernetes (advanced)
# See Kubernetes section below
```

## Kubernetes Deployment

### Prerequisites

- Kubernetes cluster (1.24+)
- kubectl configured
- Docker images pushed to registry
- Persistent storage provisioner

### Namespace Setup

```bash
kubectl create namespace paperclip
kubectl config set-context --current --namespace=paperclip
```

### ConfigMap & Secrets

```bash
# Environment configuration
kubectl create configmap paperclip-config \
  --from-env-file=.env.prod \
  -n paperclip

# Sensitive data (better: use external secrets)
kubectl create secret generic paperclip-secrets \
  --from-literal=BETTER_AUTH_SECRET=$(openssl rand -base64 32) \
  --from-literal=DB_PASSWORD=$(openssl rand -base64 32) \
  -n paperclip
```

### Deploy PostgreSQL

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: paperclip
spec:
  serviceName: postgres
  replicas: 1
  selector:
    matchLabels:
      app: postgres
  template:
    metadata:
      labels:
        app: postgres
    spec:
      containers:
      - name: postgres
        image: postgres:17-alpine
        ports:
        - containerPort: 5432
        env:
        - name: POSTGRES_USER
          value: paperclip_prod
        - name: POSTGRES_DB
          value: paperclip_prod
        - name: POSTGRES_PASSWORD
          valueFrom:
            secretKeyRef:
              name: paperclip-secrets
              key: DB_PASSWORD
        volumeMounts:
        - name: postgres-storage
          mountPath: /var/lib/postgresql/data
        livenessProbe:
          exec:
            command:
            - /bin/sh
            - -c
            - pg_isready -U paperclip_prod
          initialDelaySeconds: 30
          periodSeconds: 10
  volumeClaimTemplates:
  - metadata:
      name: postgres-storage
    spec:
      accessModes: [ "ReadWriteOnce" ]
      storageClassName: standard
      resources:
        requests:
          storage: 50Gi
---
apiVersion: v1
kind: Service
metadata:
  name: postgres
  namespace: paperclip
spec:
  clusterIP: None
  selector:
    app: postgres
  ports:
  - port: 5432
    targetPort: 5432
```

### Deploy Paperclip API

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: paperclip-server
  namespace: paperclip
spec:
  replicas: 3  # Scale as needed
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: paperclip-server
  template:
    metadata:
      labels:
        app: paperclip-server
    spec:
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - paperclip-server
              topologyKey: kubernetes.io/hostname
      containers:
      - name: paperclip
        image: paperclipai/paperclip:latest
        imagePullPolicy: Always
        ports:
        - containerPort: 3100
          name: http
        env:
        - name: NODE_ENV
          value: production
        - name: PORT
          value: "3100"
        - name: DATABASE_URL
          value: postgres://paperclip_prod:$(DB_PASSWORD)@postgres:5432/paperclip_prod
        - name: DB_PASSWORD
          valueFrom:
            secretKeyRef:
              name: paperclip-secrets
              key: DB_PASSWORD
        - name: BETTER_AUTH_SECRET
          valueFrom:
            secretKeyRef:
              name: paperclip-secrets
              key: BETTER_AUTH_SECRET
        - name: PAPERCLIP_PUBLIC_URL
          value: https://paperclip.yourdomain.com
        envFrom:
        - configMapRef:
            name: paperclip-config
        resources:
          requests:
            memory: "1Gi"
            cpu: "500m"
          limits:
            memory: "2Gi"
            cpu: "1000m"
        livenessProbe:
          httpGet:
            path: /health
            port: 3100
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 3100
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        volumeMounts:
        - name: data
          mountPath: /paperclip
      volumes:
      - name: data
        emptyDir: {}  # Or use PersistentVolumeClaim
---
apiVersion: v1
kind: Service
metadata:
  name: paperclip-server
  namespace: paperclip
spec:
  type: ClusterIP
  selector:
    app: paperclip-server
  ports:
  - port: 3100
    targetPort: 3100
    protocol: TCP
```

### Deploy Nginx Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: paperclip-ingress
  namespace: paperclip
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt-prod
    nginx.ingress.kubernetes.io/rate-limit: "10"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - paperclip.yourdomain.com
    secretName: paperclip-tls
  rules:
  - host: paperclip.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: paperclip-server
            port:
              number: 3100
```

### Deploy with kubectl

```bash
# Apply manifests
kubectl apply -f postgres-statefulset.yaml
kubectl apply -f paperclip-deployment.yaml
kubectl apply -f ingress.yaml

# Verify deployment
kubectl get pods -n paperclip
kubectl get svc -n paperclip
kubectl get ingress -n paperclip

# View logs
kubectl logs -f deployment/paperclip-server -n paperclip

# Port forward (local access)
kubectl port-forward svc/paperclip-server 3100:3100 -n paperclip
```

## Production Considerations

### High Availability

```yaml
# Pod Disruption Budget
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: paperclip-pdb
  namespace: paperclip
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: paperclip-server
```

### Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: paperclip-hpa
  namespace: paperclip
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: paperclip-server
  minReplicas: 3
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
  - type: Resource
    resource:
      name: memory
      target:
        type: Utilization
        averageUtilization: 80
```

### Network Policies

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: paperclip-network-policy
  namespace: paperclip
spec:
  podSelector:
    matchLabels:
      app: paperclip-server
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: ingress-nginx
    ports:
    - protocol: TCP
      port: 3100
  egress:
  - to:
    - podSelector:
        matchLabels:
          app: postgres
    ports:
    - protocol: TCP
      port: 5432
  - to:
    - namespaceSelector: {}
      podSelector:
        matchLabels:
          k8s-app: kube-dns
    ports:
    - protocol: UDP
      port: 53
```

## Monitoring & Logging

### Prometheus Metrics

```yaml
apiVersion: v1
kind: Service
metadata:
  name: paperclip-metrics
  namespace: paperclip
spec:
  selector:
    app: paperclip-server
  ports:
  - name: metrics
    port: 9090
    targetPort: 9090
```

### Loki Logging

```bash
# Send logs to Loki
kubectl apply -f - <<EOF
apiVersion: v1
kind: ConfigMap
metadata:
  name: promtail-config
  namespace: paperclip
data:
  promtail.yaml: |
    clients:
    - url: http://loki:3100/loki/api/v1/push
    scrape_configs:
    - job_name: kubernetes-pods
      kubernetes_sd_configs:
      - role: pod
      relabel_configs:
      - source_labels: [__meta_kubernetes_namespace]
        action: replace
        target_label: namespace
EOF
```

## Scaling Strategies

### Vertical Scaling
- Increase CPU/memory limits
- Move to larger node instances
- Database: increase resources

### Horizontal Scaling
- Increase Deployment replicas
- Enable HPA (Horizontal Pod Autoscaler)
- Use RollingUpdate for zero-downtime

### Database Scaling
- Read replicas for PostgreSQL
- Connection pooling (PgBouncer)
- Managed database service (RDS, Cloud SQL)

---

For complete deployment information, see:
- **PRODUCTION-README.md** - Docker deployment overview
- **DEPLOYMENT.md** - Step-by-step guide
- **DEPLOYMENT-QUICKSTART.md** - Quick reference
