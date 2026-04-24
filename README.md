# Maple Converter

Image conversion web app with batch pricing, Stripe payments, and production-grade reliability.

Live at: [mapleconverter.com](https://mapleconverter.com)

## Features

- Drag-and-drop, file picker, or folder picker upload
- Supported input formats: HEIC, HEIF, PNG, WEBP, JPEG, JPG
- Output formats: JPEG, PNG, WEBP
- Scans uploaded folders for supported images and reports the count before pricing
- Converts images and returns a ZIP download that preserves the original folder structure
- Pricing tiers:
  - 1–10 images: free
  - 11–300 images: $1.99
  - 301+ images: $6.99 (includes 24-hour unlimited conversions)
- Stripe Checkout for paid tiers
- Stripe webhook support for production-grade payment confirmation
- Thumbnail previews and duplicate detection before upload
- Direct-to-S3 upload and presigned S3 download URLs
- Separate payment session and conversion job records in DynamoDB

### Reliability & UX

- **Preflight summary panel** — shows file count, estimated size, and a pass/warn/fail check before the user clicks Convert
- **Pre-payment file validation** — backend downloads and spot-checks each uploaded file with Sharp before opening Stripe Checkout; invalid files are listed by name with a reason
- **Per-file upload retry** — each file upload retries up to 3 times with exponential backoff (350 ms, 700 ms) before failing
- **Flow recovery after refresh/crash** — active job state is persisted to `localStorage`; on page load the app detects and resumes any in-progress or completed job
- **Per-file HEIC/HEIF skip** — unsupported HEIC variants are skipped individually rather than failing the entire batch; a skip summary is shown at the end
- **Automatic refund on job failure** — if a paid job fails after conversion starts and no output was produced, a Stripe refund is issued automatically
- **Idempotency guards** — Stripe checkout sessions are reused per job; start-conversion requests carry a stable `requestId` to prevent duplicate processing on network retry
- **Structured logging** — all lifecycle events (upload session created, checkout created/reused, job queued/started/completed/failed, refund issued) are emitted as JSON to stdout for log aggregation
- **6-stage loader timeline** — visual progress chips (Preflight → Upload → Validate → Payment → Convert → Download) advance in real time during the conversion flow

## Project Structure

- `index.html`, `mobile.html`, `style.css`, `script.js`, `success.html`, `cancel.html` — frontend
- `server/index.js` — backend API (Express)
- `server/Dockerfile` — container image for App Runner / ECS
- `apprunner.yaml` — App Runner configuration
- `server/uploads/`, `server/output/` — temporary local processing folders (not committed)

## Requirements

- Node.js 18+
- npm
- Stripe account and API keys for paid flows
- AWS account with S3 bucket and two DynamoDB tables

## Install

Run from repository root:

```bash
npm install
```

Install backend dependencies:

```bash
cd server
npm install
```

## Environment Variables

Create `server/.env` from `server/.env.example`.

Required values:

```env
PORT=5000
STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
# Optional for local development when using a named AWS CLI profile
AWS_PROFILE=default
AWS_REGION=us-east-2
S3_BUCKET=sweet-maple-converter-files-299590373878-us-east-2
S3_UPLOAD_URL_TTL_SECONDS=900
S3_DOWNLOAD_URL_TTL_SECONDS=900
PAYMENT_SESSION_TTL_SECONDS=7200
CONVERSION_JOB_TTL_SECONDS=86400
PAYMENT_SESSIONS_TABLE=sweet-maple-converter-sessions
CONVERSION_JOBS_TABLE=sweet-maple-converter-jobs
CLIENT_URL=https://mapleconverter.com
CLIENT_URLS=http://localhost:5500,http://127.0.0.1:5500,https://mapleconverter.com,https://www.mapleconverter.com
CONVERSION_CONCURRENCY=2
ZIP_COMPRESSION_LEVEL=0
JPEG_QUALITY=85
WEBP_QUALITY=80
PNG_COMPRESSION_LEVEL=6
MAX_BATCH_SIZE_MB=512
SERVER_URL=http://localhost:5000
```

For local development with shared AWS credentials, set `AWS_PROFILE` to the profile name you configured with the AWS CLI. In App Runner or other AWS-hosted environments, omit `AWS_PROFILE` and use the attached IAM role instead.

Use `CLIENT_URL` for Stripe redirect links (`success_url`/`cancel_url`). Use `CLIENT_URLS` as a comma-separated allowlist for backend CORS.

## Run Locally

From repository root:

```bash
npm run dev
```

This starts:

- Backend API on `http://localhost:5000`
- Frontend static server on `http://localhost:5500`

## Stripe Webhook Setup

### Dashboard method

1. In Stripe, create a webhook endpoint:
   - `http://localhost:5000/api/stripe-webhook`
2. Subscribe to events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
3. Copy the signing secret (`whsec_...`) into `server/.env` as `STRIPE_WEBHOOK_SECRET`.

### Stripe CLI method (optional)

```bash
stripe listen --forward-to localhost:5000/api/stripe-webhook
```

Then copy the printed signing secret to `STRIPE_WEBHOOK_SECRET`.

## Main API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/price` | Calculate price for an image count |
| `POST` | `/api/create-upload-session` | Create a session and return presigned S3 upload URLs |
| `POST` | `/api/create-checkout-session` | Validate uploaded files, then create (or reuse) a Stripe Checkout session |
| `POST` | `/api/verify-session` | Verify payment session status |
| `POST` | `/api/start-conversion-job` | Queue conversion; validates files if not already validated; idempotent via `requestId` |
| `GET` | `/api/conversion-job/:jobId` | Poll job status; returns `status`, `skipSummary`, `autoRefunded`, `invalidFiles` |
| `POST` | `/api/conversion-job/:jobId/download-url` | Get a fresh presigned download URL for a completed job |
| `POST` | `/api/stripe-webhook` | Stripe webhook receiver (`checkout.session.completed`, `checkout.session.async_payment_succeeded`) |

The `download-url` endpoint is useful when a previously issued presigned link has expired. It returns a fresh temporary download URL for completed jobs.

## Basic Test Checklist

- **Free tier**
  - Upload 1, 5, and 10 images
  - Confirm conversion and ZIP download without payment
- **$1.99 tier**
  - Upload 11 and 300 images
  - Confirm Stripe Checkout appears and conversion succeeds after payment
- **$6.99 tier**
  - Upload 301+ images
  - Confirm $6.99 charge and successful conversion
  - Confirm additional paid-size batches are allowed for 24 hours without an extra checkout
- **Pre-payment validation**
  - Upload a corrupt or unreadable file alongside valid images
  - Confirm the invalid file is listed by name with a reason before Stripe Checkout opens
- **Per-file retry**
  - Throttle the network mid-upload and confirm the upload retries automatically
- **Flow recovery**
  - Refresh the page mid-conversion
  - Confirm the app detects the pending job and resumes polling on reload
- **Auto-refund**
  - Simulate a backend conversion failure on a paid job
  - Confirm `autoRefunded: true` is returned in the job status and the refund appears in Stripe
- **HEIC/HEIF skip**
  - Upload a batch that includes an unsupported HEIC variant
  - Confirm the batch completes and a skip summary is shown
- **Edge cases**
  - Unsupported file type
  - Oversized file
  - Duplicate file selection
  - Folder upload with nested subfolders preserves structure in the ZIP
  - Payment cancel flow

## AWS Deployment

The app is deployed as:

- **Frontend**: Netlify at [mapleconverter.com](https://mapleconverter.com)
- **Backend**: AWS App Runner at `https://yq3cx7vs7h.us-east-2.awsapprunner.com`
- **Storage**: S3 bucket `sweet-maple-converter-files-299590373878-us-east-2`
- **Database**: DynamoDB tables `sweet-maple-converter-sessions` and `sweet-maple-converter-jobs`

> An ECS Fargate setup also works and the `server/Dockerfile` supports both. Swap the IAM role and env var injection steps accordingly.

### 1. Create DynamoDB tables

Existing DynamoDB tables are fine to reuse as long as the schema matches what the app expects.

Create payment session table (example): `sweet-maple-converter-sessions`

- Partition key: `sessionId` (String)
- TTL attribute: `ttl`

Create conversion jobs table (example): `sweet-maple-converter-jobs`

- Partition key: `jobId` (String)
- TTL attribute: `ttl`

Important TTL behavior:

- DynamoDB TTL is background cleanup, not exact-time expiration.
- App logic enforces expiry using `expiresAt` checks.

### 2. Deploy backend — App Runner (current setup)

Repository includes `apprunner.yaml` at the root:

- Node runtime
- Build commands for root and `server/`
- Run command: `npm --prefix server run start`
- Port: `5000`

#### Create App Runner service from GitHub

In AWS App Runner:

- Source: GitHub repository (`main` branch)
- Configuration file: repository `apprunner.yaml`

#### Set App Runner environment variables

```env
NODE_ENV=production
AWS_REGION=us-east-2
S3_BUCKET=sweet-maple-converter-files-299590373878-us-east-2
S3_UPLOAD_URL_TTL_SECONDS=900
S3_DOWNLOAD_URL_TTL_SECONDS=900
PAYMENT_SESSION_TTL_SECONDS=7200
CONVERSION_JOB_TTL_SECONDS=86400
PAYMENT_SESSIONS_TABLE=sweet-maple-converter-sessions
CONVERSION_JOBS_TABLE=sweet-maple-converter-jobs
CLIENT_URL=https://mapleconverter.com
CLIENT_URLS=https://mapleconverter.com,https://www.mapleconverter.com
SERVER_URL=https://yq3cx7vs7h.us-east-2.awsapprunner.com
CONVERSION_CONCURRENCY=2
ZIP_COMPRESSION_LEVEL=0
JPEG_QUALITY=85
WEBP_QUALITY=80
PNG_COMPRESSION_LEVEL=6
MAX_BATCH_SIZE_MB=512
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Do not set `AWS_PROFILE` in App Runner. Use an attached IAM role.

#### Attach IAM role to App Runner service

Grant the App Runner instance role:

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `s3:PutObject`
- `s3:GetObject`
- `s3:ListBucket` (optional)

Resource scope:

- `arn:aws:dynamodb:us-east-2:299590373878:table/sweet-maple-converter-sessions`
- `arn:aws:dynamodb:us-east-2:299590373878:table/sweet-maple-converter-jobs`
- `arn:aws:s3:::sweet-maple-converter-files-299590373878-us-east-2/*`

#### Stripe webhook for App Runner

In Stripe dashboard, create a webhook endpoint:

```
https://yq3cx7vs7h.us-east-2.awsapprunner.com/api/stripe-webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Copy the signing secret to `STRIPE_WEBHOOK_SECRET` in App Runner env vars.

#### Final verification

- `GET https://yq3cx7vs7h.us-east-2.awsapprunner.com/api/health` returns `{ "ok": true }`
- Free conversion flow works from mapleconverter.com
- Paid checkout redirects back to `https://mapleconverter.com/success.html`
- Stripe webhook events are delivered successfully

### 3. Deploy frontend — Netlify (current setup)

Upload these files to your Netlify site (`mapleconverter.com`):

- `index.html`
- `mobile.html`
- `style.css`
- `script.js`
- `success.html`
- `cancel.html`
- `robots.txt`
- `sitemap.xml`

The `data-api-base` attribute in `index.html` and `success.html` points to the App Runner URL above.

#### S3 CORS — allow mapleconverter.com

Add `https://mapleconverter.com` and `https://www.mapleconverter.com` to the S3 bucket CORS policy so browser presigned uploads succeed from the production domain.

### 4. Configure Stripe webhook for production

_(Already covered in step 2. Duplicate reminder for clarity.)_

Set live Stripe keys in App Runner env vars:

- `STRIPE_SECRET_KEY=sk_live_...`
- `STRIPE_WEBHOOK_SECRET=whsec_...` (from the live webhook endpoint)



## AWS CLI Quick Setup

Replace placeholders before running:

- `<REGION>` example: `us-east-1`
- `<ACCOUNT_ID>` your AWS account id
- `<BUCKET>` your S3 bucket name
- `<PAYMENT_TABLE>` example: `sweet-maple-converter-sessions`
- `<JOBS_TABLE>` example: `sweet-maple-converter-jobs`

### 1. Create S3 bucket

For `us-east-1`:

```bash
aws s3api create-bucket --bucket <BUCKET>
```

For any other region:

```bash
aws s3api create-bucket --bucket <BUCKET> --region <REGION> --create-bucket-configuration LocationConstraint=<REGION>
```

### 2. Create DynamoDB tables

Payment sessions table:

```bash
aws dynamodb create-table \
  --table-name <PAYMENT_TABLE> \
  --attribute-definitions AttributeName=sessionId,AttributeType=S \
  --key-schema AttributeName=sessionId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region <REGION>
```

Conversion jobs table:

```bash
aws dynamodb create-table \
  --table-name <JOBS_TABLE> \
  --attribute-definitions AttributeName=jobId,AttributeType=S \
  --key-schema AttributeName=jobId,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region <REGION>
```

Enable TTL on both tables (`ttl` attribute):

```bash
aws dynamodb update-time-to-live \
  --table-name <PAYMENT_TABLE> \
  --time-to-live-specification "Enabled=true, AttributeName=ttl" \
  --region <REGION>

aws dynamodb update-time-to-live \
  --table-name <JOBS_TABLE> \
  --time-to-live-specification "Enabled=true, AttributeName=ttl" \
  --region <REGION>
```

### 3. Create IAM policy for App Runner instance role

Create a policy file named `converter-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DynamoAccess",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/<PAYMENT_TABLE>",
        "arn:aws:dynamodb:<REGION>:<ACCOUNT_ID>:table/<JOBS_TABLE>"
      ]
    },
    {
      "Sid": "S3ObjectAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:HeadObject"
      ],
      "Resource": "arn:aws:s3:::<BUCKET>/*"
    }
  ]
}
```

Create the managed policy:

```bash
aws iam create-policy --policy-name MapleConverterPolicy --policy-document file://converter-policy.json
```

Attach it to your App Runner instance role:

```bash
aws iam attach-role-policy --role-name <APP_RUNNER_INSTANCE_ROLE_NAME> --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/MapleConverterPolicy
```

## Notes

- Temporary files in `server/uploads` and `server/output` are deleted after conversion/download completes and are ignored by Git.
- `mobile.html` is a redirect page for mobile users; it carries a canonical link to `index.html` and is excluded from Google indexing via the canonical tag.
- All lifecycle events are logged as structured JSON to stdout. Use CloudWatch Logs (App Runner streams logs automatically) for monitoring and alerting.

