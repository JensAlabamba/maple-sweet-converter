# Converter Magic

Image conversion web app with batch pricing and Stripe payments.

## Features

- Drag-and-drop, file picker, or folder picker upload
- Supported formats: HEIC, HEIF, PNG, WEBP, JPEG, JPG
- Scans uploaded folders for supported images and reports the supported image count before pricing
- Converts images and returns a ZIP download that preserves the original folder structure
- Pricing tiers:
  - 1-10 images: free
  - 11-300 images: $1.99
  - 301+ images: $6.99 (includes 24-hour unlimited conversions)
- Stripe Checkout for paid tiers
- Stripe webhook support for production-grade payment confirmation
- Thumbnail previews and duplicate detection before upload
- Direct-to-S3 upload and presigned S3 download URLs
- Separate payment session and conversion job records

## Project Structure

- `index.html`, `style.css`, `script.js`, `success.html`, `cancel.html`: frontend
- `server/index.js`: backend API
- `server/uploads/`, `server/output/`: temporary processing folders

## Requirements

- Node.js 18+
- npm
- Stripe account and API keys for paid flows

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
CLIENT_URL=https://maplesweetconverter.netlify.app
CLIENT_URLS=http://localhost:5500,http://127.0.0.1:5500,https://maplesweetconverter.netlify.app
SERVER_URL=http://localhost:5000
```

For local development with shared AWS credentials, set `AWS_PROFILE` to the profile name you configured with the AWS CLI. In ECS or other AWS-hosted environments, omit `AWS_PROFILE` and use the task role instead.

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

- `GET /api/health`
- `POST /api/price`
- `POST /api/create-upload-session`
- `POST /api/create-checkout-session`
- `POST /api/verify-session`
- `POST /api/start-conversion-job`
- `GET /api/conversion-job/:jobId`
- `POST /api/conversion-job/:jobId/download-url`
- `POST /api/stripe-webhook`

The `download-url` endpoint is useful when a previously issued presigned link has expired. It returns a fresh temporary download URL for completed jobs.

## Basic Test Checklist

- Free tier:
  - Upload 1, 5, and 10 images
  - Confirm conversion and ZIP download without payment
- $1.99 tier:
  - Upload 11 and 300 images
  - Confirm Stripe checkout appears and conversion is allowed after successful payment
- $6.99 tier:
  - Upload 301+ images
  - Confirm $6.99 charge and successful conversion
  - Confirm additional paid-size conversions are allowed for 24 hours without extra checkout
- Edge cases:
  - Unsupported file type
  - Oversized file
  - Duplicate file selection
  - Folder upload with nested subfolders preserves structure in the ZIP
  - Payment cancel flow

## Notes

- Temporary files are deleted after conversion/download flow completes.
- `server/uploads` and `server/output` are ignored by Git.

## AWS Deployment (Recommended)

Use this architecture for production:

- Frontend: S3 static hosting + CloudFront
- Backend: ECS Fargate service (container from `server/Dockerfile`) behind an ALB
- S3: uploaded originals + generated ZIP files
- DynamoDB table 1: payment sessions
- DynamoDB table 2: conversion jobs

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
- App logic should enforce expiry using `expiresAt` checks.

### 2. Deploy backend container (ECS Fargate)

- Build and push backend image from `server/`
- Set container port to `5000`
- Set environment variables on ECS task:

```env
PORT=5000
STRIPE_SECRET_KEY=sk_live_or_test
STRIPE_WEBHOOK_SECRET=whsec_live_or_test
AWS_REGION=us-east-2
S3_BUCKET=sweet-maple-converter-files-299590373878-us-east-2
S3_UPLOAD_URL_TTL_SECONDS=900
S3_DOWNLOAD_URL_TTL_SECONDS=900
PAYMENT_SESSION_TTL_SECONDS=7200
CONVERSION_JOB_TTL_SECONDS=86400
PAYMENT_SESSIONS_TABLE=sweet-maple-converter-sessions
CONVERSION_JOBS_TABLE=sweet-maple-converter-jobs
CLIENT_URL=https://maplesweetconverter.netlify.app
CLIENT_URLS=https://maplesweetconverter.netlify.app
SERVER_URL=https://api.your-domain
```

If you already created `sweet-maple-converter-sessions` and `sweet-maple-converter-jobs`, use those values directly. The app reads the table names from environment variables; it does not require the old example names.

Grant the ECS task role access to DynamoDB:

- `dynamodb:GetItem`
- `dynamodb:PutItem`

for both table ARNs.

Grant ECS task role access to S3 bucket objects:

- `s3:PutObject`
- `s3:GetObject`
- `s3:ListBucket` (optional, useful for some tooling and diagnostics)

### 3. Deploy frontend (S3 + CloudFront)

Upload frontend files to S3 bucket root:

- `index.html`
- `style.css`
- `script.js`
- `success.html`
- `cancel.html`

Then distribute through CloudFront.

### 4. Update frontend API URL

In `index.html` and `success.html`, set `data-api-base` to your backend URL (ALB or custom domain).

### 5. Configure Stripe webhook for production

Create Stripe endpoint:

- `https://api.your-domain/api/stripe-webhook`

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

### 6. Final checks

- Confirm ALB health check on `GET /api/health`
- Test free and paid flows end-to-end
- Confirm DynamoDB records are written for payment sessions and conversion jobs
- Confirm uploaded files and ZIP outputs are stored under expected S3 keys

## AWS App Runner Deployment

This project is ready for App Runner source deployment from GitHub.

Repository includes `apprunner.yaml` at the root with:

- Node runtime
- Build commands for root and `server/`
- Run command: `npm --prefix server run start`
- Port mapping to `PORT` on `5000`

### 1. Create App Runner service from GitHub

In AWS App Runner:

- Source: GitHub repository
- Repository: `JensAlabamba/maple-sweet-converter`
- Branch: `main`
- Configuration file: use repository `apprunner.yaml`

### 2. Set App Runner environment variables

Set these runtime environment variables on the App Runner service:

```env
NODE_ENV=production
AWS_REGION=us-east-2
S3_BUCKET=sweet-maple-converter-files-299590373878-us-east-2
PAYMENT_SESSION_TTL_SECONDS=7200
CONVERSION_JOB_TTL_SECONDS=86400
PAYMENT_SESSIONS_TABLE=sweet-maple-converter-sessions
CONVERSION_JOBS_TABLE=sweet-maple-converter-jobs
CLIENT_URL=https://maplesweetconverter.netlify.app
CLIENT_URLS=https://maplesweetconverter.netlify.app
SERVER_URL=https://<your-app-runner-domain>
```

When enabling Stripe, also set:

```env
STRIPE_SECRET_KEY=sk_test_or_live
STRIPE_WEBHOOK_SECRET=whsec_xxx
```

Do not set `AWS_PROFILE` in App Runner. Use an IAM role.

### 3. Attach IAM role to App Runner service

Grant these permissions to the App Runner instance role:

- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `s3:PutObject`
- `s3:GetObject`
- `s3:ListBucket` (optional)

Resource scope:

- `arn:aws:dynamodb:us-east-2:299590373878:table/sweet-maple-converter-sessions`
- `arn:aws:dynamodb:us-east-2:299590373878:table/sweet-maple-converter-jobs`
- `arn:aws:s3:::sweet-maple-converter-files-299590373878-us-east-2/*`

### 4. Point frontend to App Runner API

After App Runner is deployed, replace localhost API base in frontend files with your App Runner URL:

- `index.html` `data-api-base`
- `success.html` `data-api-base`
- `script.js` fallback `apiBase`
- inline `apiBase` in `success.html`

Use this format:

```txt
https://<your-app-runner-domain>
```

### 5. Stripe webhook for App Runner

In Stripe dashboard, create webhook endpoint:

```txt
https://<your-app-runner-domain>/api/stripe-webhook
```

Subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`

Copy webhook signing secret to `STRIPE_WEBHOOK_SECRET` in App Runner env vars.

### 6. Final verification

- `GET https://<your-app-runner-domain>/api/health` returns `{ "ok": true }`
- Free conversion flow works from Netlify frontend
- Paid checkout redirects back to Netlify `success.html`
- Stripe webhook events are delivered successfully

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

### 3. Create IAM policy for ECS task role

Create a policy file named `ecs-converter-policy.json`:

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
aws iam create-policy --policy-name ConverterMagicEcsPolicy --policy-document file://ecs-converter-policy.json
```

Attach it to your ECS task role:

```bash
aws iam attach-role-policy --role-name <ECS_TASK_ROLE_NAME> --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/ConverterMagicEcsPolicy
```

