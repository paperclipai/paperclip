{{/*
Expand the name of the chart.
*/}}
{{- define "paperclip.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "paperclip.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Headless Service name. fullname is already truncated to 63 chars; reserve room
for the "-headless" suffix (9 chars) so the resulting DNS label stays within the
63-char Kubernetes limit for long release names.
*/}}
{{- define "paperclip.headlessServiceName" -}}
{{- printf "%s-headless" (include "paperclip.fullname" . | trunc 54 | trimSuffix "-") }}
{{- end }}

{{/*
Allowed hostnames the server accepts on its Host header: the loopback address
(always prepended — the server uses allowedHostnames[0] to build
PAPERCLIP_API_URL) plus any operator-configured extras. Single source of truth
for the PAPERCLIP_ALLOWED_HOSTNAMES env var and the health-probe Host header.
*/}}
{{- define "paperclip.allowedHostnames" -}}
{{- prepend (.Values.env.extraAllowedHostnames | default list) "127.0.0.1" | join "," -}}
{{- end }}

{{/*
Host header for health probes: allowedHostnames[0] — the prepended loopback,
always accepted by the private-hostname guard.
*/}}
{{- define "paperclip.probeHost" -}}
{{- include "paperclip.allowedHostnames" . | splitList "," | first -}}
{{- end }}

{{/*
Shared httpGet block for all health probes: hits /healthz on the http port with
the Host header derived from the allowed-hostnames list.
*/}}
{{- define "paperclip.probeHttpGet" -}}
httpGet:
  path: /healthz
  port: http
  httpHeaders:
    - name: Host
      value: {{ include "paperclip.probeHost" . | quote }}
{{- end }}

{{/*
Chart name and version label.
*/}}
{{- define "paperclip.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "paperclip.labels" -}}
helm.sh/chart: {{ include "paperclip.chart" . }}
{{ include "paperclip.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "paperclip.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paperclip.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "paperclip.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "paperclip.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name (existing or generated).
*/}}
{{- define "paperclip.secretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- printf "%s-credentials" (include "paperclip.fullname" .) }}
{{- end }}
{{- end }}

{{/*
Resolved image ref.
*/}}
{{- define "paperclip.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}
