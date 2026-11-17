{{/* The release's resources' base name. */}}
{{- define "nether.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "nether.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/* What selects the server's pods. */}}
{{- define "nether.selector" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: server
{{- end -}}

{{- define "nether.image" -}}
{{- printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) -}}
{{- end -}}

{{/* The nodes when the autoscaler is off: 2 with `ha`, else 1, unless set. */}}
{{- define "nether.replicas" -}}
{{- if kindIs "invalid" .Values.replicaCount -}}
{{- if .Values.ha.enabled }}2{{ else }}1{{ end -}}
{{- else -}}
{{- .Values.replicaCount -}}
{{- end -}}
{{- end -}}

{{/* The Secret the server's secrets come from. */}}
{{- define "nether.secretName" -}}
{{- .Values.secrets.existingSecret | default (include "nether.fullname" .) -}}
{{- end -}}

{{/* The attachments' volume claim, when they are on disk. */}}
{{- define "nether.claimName" -}}
{{- .Values.storage.disk.existingClaim | default (printf "%s-files" (include "nether.fullname" .)) -}}
{{- end -}}

{{/* A secret key from the Secret, optional unless `required`. */}}
{{- define "nether.secretEnv" -}}
- name: {{ .name }}
  valueFrom:
    secretKeyRef:
      name: {{ .secret }}
      key: {{ .key }}
      optional: {{ not .required }}
{{- end -}}

{{/*
  The server's environment, the same for its pods and its migration Job.
  Settings come from values; secrets from the Secret.
*/}}
{{- define "nether.env" -}}
{{- $secret := include "nether.secretName" . -}}
{{- $keys := .Values.secrets.keys -}}
- name: NETHER_HOST
  value: "0.0.0.0"
- name: NETHER_PORT
  value: "3000"
- name: NETHER_LOG_LEVEL
  value: {{ .Values.server.logLevel | quote }}
- name: NETHER_DRAIN_SECONDS
  value: {{ .Values.server.drainSeconds | quote }}
{{- with .Values.server.publicUrl }}
- name: NETHER_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.server.trustProxy }}
- name: NETHER_TRUST_PROXY
  value: {{ . | quote }}
{{- end }}
- name: NETHER_ENTERPRISE_HA
  value: {{ ternary "on" "off" .Values.ha.enabled | quote }}
{{- range $feature, $value := .Values.server.enterprise }}
- name: {{ printf "NETHER_ENTERPRISE_%s" (upper $feature) }}
  value: {{ $value | quote }}
{{- end }}
- name: NETHER_NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
{{- if eq .Values.storage.kind "s3" }}
- name: NETHER_STORAGE
  value: s3
- name: NETHER_S3_ENDPOINT
  value: {{ .Values.storage.s3.endpoint | quote }}
- name: NETHER_S3_BUCKET
  value: {{ .Values.storage.s3.bucket | quote }}
- name: NETHER_S3_REGION
  value: {{ .Values.storage.s3.region | quote }}
{{ include "nether.secretEnv" (dict "name" "NETHER_S3_ACCESS_KEY" "secret" $secret "key" $keys.s3AccessKey "required" true) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_S3_SECRET_KEY" "secret" $secret "key" $keys.s3SecretKey "required" true) }}
{{- else }}
- name: NETHER_STORAGE
  value: disk
- name: NETHER_STORAGE_PATH
  value: /data/attachments
- name: NETHER_BACKUP_PATH
  value: /data/backups
{{- if .Values.ha.enabled }}
# One volume every node mounts, ReadWriteMany.
- name: NETHER_STORAGE_SHARED
  value: "on"
{{- end }}
{{- end }}
{{ include "nether.secretEnv" (dict "name" "NETHER_DATABASE_URL" "secret" $secret "key" $keys.databaseUrl "required" true) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_REDIS_URL" "secret" $secret "key" $keys.redisUrl "required" .Values.ha.enabled) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_SECRET_KEY" "secret" $secret "key" $keys.secretKey "required" false) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_SETUP_CODE" "secret" $secret "key" $keys.setupCode "required" false) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_SMTP_URL" "secret" $secret "key" $keys.smtpUrl "required" false) }}
{{ include "nether.secretEnv" (dict "name" "NETHER_OIDC_CLIENT_SECRET" "secret" $secret "key" $keys.oidcClientSecret "required" false) }}
{{- with .Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* The server's container's security, and its pod's. */}}
{{- define "nether.containerSecurity" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
runAsNonRoot: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "nether.podSecurity" -}}
runAsNonRoot: true
# The image's `node` user.
runAsUser: 1000
runAsGroup: 1000
fsGroup: 1000
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{/* Checks that a release has what it needs, saying what is missing. */}}
{{- define "nether.validate" -}}
{{- if and .Values.ha.enabled (eq .Values.storage.kind "disk") (not (has "ReadWriteMany" .Values.storage.disk.accessModes)) (not .Values.storage.disk.existingClaim) -}}
{{- fail "ha.enabled with storage.kind disk needs a ReadWriteMany volume: set storage.disk.accessModes to [ReadWriteMany], give storage.disk.existingClaim, or use storage.kind s3." -}}
{{- end -}}
{{- if and (not .Values.secrets.existingSecret) (not .Values.bundled.enabled) (not .Values.secrets.databaseUrl) -}}
{{- fail "Set secrets.databaseUrl, or secrets.existingSecret with its NETHER_DATABASE_URL key, or bundled.enabled to try it." -}}
{{- end -}}
{{- if and .Values.ha.enabled (not .Values.secrets.existingSecret) (not .Values.bundled.enabled) (not .Values.secrets.redisUrl) -}}
{{- fail "ha.enabled needs Valkey: set secrets.redisUrl, or secrets.existingSecret with its NETHER_REDIS_URL key." -}}
{{- end -}}
{{- if and (eq .Values.storage.kind "s3") (not .Values.secrets.existingSecret) (or (not .Values.secrets.s3AccessKey) (not .Values.secrets.s3SecretKey)) -}}
{{- fail "storage.kind s3 needs secrets.s3AccessKey and secrets.s3SecretKey, or secrets.existingSecret with their keys." -}}
{{- end -}}
{{- end -}}
