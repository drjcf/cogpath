#!/usr/bin/env bash
# cogpath on GCP: Firestore (named database) + Cloud Storage + Cloud Run service (API) + Cloud Run Job (worker)
# + Firebase Hosting (console). Idempotent: every step skips what already exists.
#
#   PROJECT=edai-prep REGION=us-central1 ./deploy/deploy.sh            # everything
#   ./deploy/deploy.sh image|service|job|hosting                        # one step
#
# Before the first run:
#   1. gcloud auth login && firebase login --no-localhost
#   2. The model key as a secret (typed, never in a shell history line):
#        read -rs MODEL_API_KEY && printf '%s' "$MODEL_API_KEY" | gcloud secrets create MODEL_API_KEY --project "$PROJECT" --data-file=-
#   3. Firebase Authentication: enable the Google provider in the Firebase console (Build > Authentication > Sign-in method)
#      and put the web app config in deploy/firebase-web-config.json (Project settings > Your apps > SDK setup and configuration,
#      or: firebase apps:sdkconfig web --project "$PROJECT").
#   4. ALLOWLIST: comma-separated emails that may upload, review, approve and build. Others can read everything.
set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-edai-prep}"
REGION="${REGION:-us-central1}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-nam5}"
DB="${DB:-cogpath}"
BUCKET="${BUCKET:-${PROJECT}-cogpath}"
SA_NAME="${SA_NAME:-cogpath}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
REPO="${REPO:-cogpath}"
TAG="${TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${REPO}/app:${TAG}"
ALLOWLIST="${ALLOWLIST:-john@edaisystems.com}"
WEB_CONFIG_FILE="${WEB_CONFIG_FILE:-deploy/firebase-web-config.json}"
VERSION="$(node -p "require('./package.json').version")"
STEP="${1:-all}"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

setup() {
  say "project ${PROJECT}, region ${REGION}"
  gcloud config set project "$PROJECT" >/dev/null
  gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com firestore.googleapis.com storage.googleapis.com secretmanager.googleapis.com iam.googleapis.com identitytoolkit.googleapis.com >/dev/null

  say "Firestore database ${DB} (${FIRESTORE_LOCATION})"
  gcloud firestore databases describe --database="$DB" >/dev/null 2>&1 || gcloud firestore databases create --database="$DB" --location="$FIRESTORE_LOCATION" --type=firestore-native

  say "bucket gs://${BUCKET}"
  gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1 || gcloud storage buckets create "gs://${BUCKET}" --location=US --uniform-bucket-level-access

  say "secret MODEL_API_KEY"
  gcloud secrets describe MODEL_API_KEY >/dev/null 2>&1 || { echo "create it first: read -rs MODEL_API_KEY && printf '%s' \"\$MODEL_API_KEY\" | gcloud secrets create MODEL_API_KEY --data-file=-"; exit 1; }

  say "service account ${SA}"
  gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || gcloud iam service-accounts create "$SA_NAME" --display-name="cogpath API and worker"
  for role in roles/datastore.user roles/secretmanager.secretAccessor roles/run.developer roles/logging.logWriter; do
    gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA}" --role="$role" --condition=None >/dev/null
  done
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" --member="serviceAccount:${SA}" --role=roles/storage.objectAdmin >/dev/null
  # Launching a job execution that runs as this account requires actAs on it.
  gcloud iam service-accounts add-iam-policy-binding "$SA" --member="serviceAccount:${SA}" --role=roles/iam.serviceAccountUser >/dev/null

  say "artifact registry ${REPO}"
  gcloud artifacts repositories describe "$REPO" --location="$REGION" >/dev/null 2>&1 || gcloud artifacts repositories create "$REPO" --location="$REGION" --repository-format=docker
}

image() {
  say "image ${IMAGE}"
  gcloud builds submit --tag "$IMAGE" --quiet
  echo "$IMAGE" > deploy/.last-image
}

last_image() { if [ -f deploy/.last-image ]; then cat deploy/.last-image; else echo "$IMAGE"; fi; }

# gcloud's list delimiter is switched to | (the ^|^ prefix) because the allowlist holds commas and the JSON web config holds commas and colons.
env_vars() {
  local web_config=""
  if [ -f "$WEB_CONFIG_FILE" ]; then web_config="$(node -e "process.stdout.write(JSON.stringify(JSON.parse(require('fs').readFileSync('$WEB_CONFIG_FILE','utf8'))))")"; fi
  printf '^|^COGPATH_STORE=gcp|COGPATH_FIRESTORE_DB=%s|COGPATH_BUCKET=%s|COGPATH_WORKER_JOB=projects/%s/locations/%s/jobs/cogpath-worker|COGPATH_ALLOWLIST=%s|COGPATH_VERSION=%s|GOOGLE_CLOUD_PROJECT=%s' "$DB" "$BUCKET" "$PROJECT" "$REGION" "$ALLOWLIST" "$VERSION" "$PROJECT"
  if [ -n "$web_config" ]; then printf '|COGPATH_FIREBASE_WEB_CONFIG=%s' "$web_config"; fi
}

service() {
  local img; img="$(last_image)"
  say "Cloud Run service cogpath-api ← ${img}"
  local vars; vars="$(env_vars)"
  gcloud run deploy cogpath-api --image "$img" --region "$REGION" --service-account "$SA" --allow-unauthenticated \
    --memory 1Gi --cpu 1 --timeout 300 --concurrency 40 --min-instances 0 --max-instances 3 \
    --set-env-vars "$vars" --set-secrets MODEL_API_KEY=MODEL_API_KEY:latest --quiet
  gcloud run services describe cogpath-api --region "$REGION" --format='value(status.url)'
}

job() {
  local img; img="$(last_image)"
  say "Cloud Run job cogpath-worker ← ${img}"
  local vars; vars="$(env_vars)"
  gcloud run jobs deploy cogpath-worker --image "$img" --region "$REGION" --service-account "$SA" \
    --command node --args worker/index.js --memory 2Gi --cpu 1 --task-timeout 3h --max-retries 0 --tasks 1 \
    --set-env-vars "$vars" --set-secrets MODEL_API_KEY=MODEL_API_KEY:latest --quiet
}

hosting() {
  say "Firebase Hosting (console)"
  npm run build:web
  firebase deploy --only hosting --project "$PROJECT" --non-interactive
  echo "Authorize the hosting domain for sign-in if not done: Firebase console > Authentication > Settings > Authorized domains"
}

case "$STEP" in
  all) setup; image; service; job; hosting ;;
  setup) setup ;;
  image) image ;;
  service) service ;;
  job) job ;;
  hosting) hosting ;;
  *) echo "usage: $0 [all|setup|image|service|job|hosting]"; exit 1 ;;
esac
