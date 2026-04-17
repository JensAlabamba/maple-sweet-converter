const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { randomUUID } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5000);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5500";
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const awsRegion = process.env.AWS_REGION || "us-east-1";
const paidSessionsTable = process.env.PAYMENT_SESSIONS_TABLE || process.env.PAID_SESSIONS_TABLE || "";
const conversionJobsTable = process.env.CONVERSION_JOBS_TABLE || "";
const s3Bucket = process.env.S3_BUCKET || "";
const uploadUrlTtlSeconds = Number(process.env.S3_UPLOAD_URL_TTL_SECONDS || 900);
const downloadUrlTtlSeconds = Number(process.env.S3_DOWNLOAD_URL_TTL_SECONDS || 900);
const paymentSessionTtlSeconds = Number(process.env.PAYMENT_SESSION_TTL_SECONDS || 7200);
const jobTtlSeconds = Number(process.env.CONVERSION_JOB_TTL_SECONDS || 86400);

app.use(cors({ origin: clientUrl }));

const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");
const maxFiles = 500;
const maxFileSizeBytes = 20 * 1024 * 1024;

const acceptedMimes = new Set([
  "image/heic",
  "image/heif",
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/jpg",
]);

const acceptedExtensions = new Set([".heic", ".heif", ".png", ".webp", ".jpeg", ".jpg"]);

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const paidCheckoutSessions = new Map();
const conversionJobs = new Map();
const activeProcessingJobs = new Set();
const ddbClient = paidSessionsTable || conversionJobsTable
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: awsRegion }))
  : null;
const s3Client = s3Bucket ? new S3Client({ region: awsRegion }) : null;

function requireS3() {
  if (!s3Client || !s3Bucket) {
    throw new Error("S3 is not configured. Set S3_BUCKET and AWS credentials/role.");
  }
}

function toUnixSeconds(epochMs) {
  return Math.floor(epochMs / 1000);
}

function normalizeFileName(fileName) {
  return String(fileName || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 140);
}

function fileToKey(jobId, index, fileName) {
  return `uploads/${jobId}/${index}-${normalizeFileName(fileName)}`;
}

async function bodyToBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (typeof body.transformToByteArray === "function") {
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    body.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    body.on("error", reject);
    body.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function rememberPaidSession(session) {
  const sessionId = String(session.id || "");
  const imageCount = Number(session.metadata?.imageCount || 0);
  if (!sessionId || imageCount < 1) return;

  const amountTotal = Number(session.amount_total || 0);
  const paidAt = Date.now();

  if (ddbClient && paidSessionsTable) {
    const ttlSeconds = Math.floor(paidAt / 1000) + 24 * 60 * 60;

    await ddbClient.send(
      new PutCommand({
        TableName: paidSessionsTable,
        Item: {
          sessionId,
          amountTotal,
          imageCount,
          paidAt,
          paymentStatus: "paid",
          expiresAt: paidAt + paymentSessionTtlSeconds * 1000,
          ttl: ttlSeconds,
        },
      })
    );

    return;
  }

  paidCheckoutSessions.set(sessionId, {
    amountTotal,
    imageCount,
    paidAt,
  });
}

async function getRememberedPaidSession(sessionId) {
  if (ddbClient && paidSessionsTable) {
    const result = await ddbClient.send(
      new GetCommand({
        TableName: paidSessionsTable,
        Key: { sessionId },
      })
    );

    return result.Item || null;
  }

  return paidCheckoutSessions.get(sessionId) || null;
}

async function getConversionJob(jobId) {
  if (ddbClient && conversionJobsTable) {
    const result = await ddbClient.send(
      new GetCommand({
        TableName: conversionJobsTable,
        Key: { jobId },
      })
    );

    return result.Item || null;
  }

  return conversionJobs.get(jobId) || null;
}

async function saveConversionJob(job) {
  if (ddbClient && conversionJobsTable) {
    await ddbClient.send(
      new PutCommand({
        TableName: conversionJobsTable,
        Item: job,
      })
    );
    return;
  }

  conversionJobs.set(job.jobId, job);
}

async function processConversionJob(jobId) {
  if (activeProcessingJobs.has(jobId)) {
    return;
  }

  activeProcessingJobs.add(jobId);

  try {
    requireS3();

    const job = await getConversionJob(jobId);
    if (!job) {
      throw new Error("Job not found.");
    }

    if (Number(job.expiresAt || 0) <= Date.now()) {
      job.status = "expired";
      job.updatedAt = Date.now();
      await saveConversionJob(job);
      return;
    }

    if (job.status === "completed" && job.resultZipKey) {
      return;
    }

    job.status = "processing";
    job.updatedAt = Date.now();
    await saveConversionJob(job);

    const zipPath = path.join(outputDir, `${jobId}.zip`);

    await new Promise(async (resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 9 } });

      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);

      archive.pipe(output);

      try {
        for (const file of job.fileManifest || []) {
          await s3Client.send(new HeadObjectCommand({ Bucket: s3Bucket, Key: file.key }));
          const object = await s3Client.send(
            new GetObjectCommand({
              Bucket: s3Bucket,
              Key: file.key,
            })
          );

          const originalBuffer = await bodyToBuffer(object.Body);
          const convertedBuffer = await sharp(originalBuffer).rotate().jpeg({ quality: 90 }).toBuffer();
          const originalBaseName = path.parse(file.originalName).name || "image";
          archive.append(convertedBuffer, {
            name: `${normalizeFileName(originalBaseName)}.jpg`,
          });
        }

        await archive.finalize();
      } catch (error) {
        reject(error);
      }
    });

    const resultZipKey = `results/${jobId}/converted-images.zip`;
    await s3Client.send(
      new PutObjectCommand({
        Bucket: s3Bucket,
        Key: resultZipKey,
        Body: fs.createReadStream(zipPath),
        ContentType: "application/zip",
      })
    );

    await removeFiles([zipPath]);

    job.status = "completed";
    job.resultZipKey = resultZipKey;
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    job.uploadedCount = Array.isArray(job.fileManifest) ? job.fileManifest.length : 0;
    await saveConversionJob(job);
  } catch (error) {
    const job = await getConversionJob(jobId);
    if (job) {
      job.status = "failed";
      job.updatedAt = Date.now();
      job.lastError = error.message;
      await saveConversionJob(job);
    }
  } finally {
    activeProcessingJobs.delete(jobId);
  }
}

async function createPendingPaymentSession({ sessionId, imageCount, amountTotal, jobId }) {
  const now = Date.now();
  const expiresAt = now + paymentSessionTtlSeconds * 1000;

  if (ddbClient && paidSessionsTable) {
    await ddbClient.send(
      new PutCommand({
        TableName: paidSessionsTable,
        Item: {
          sessionId,
          imageCount,
          amountTotal,
          jobId: jobId || null,
          paymentStatus: "pending",
          createdAt: now,
          updatedAt: now,
          expiresAt,
          ttl: toUnixSeconds(expiresAt),
        },
      })
    );
    return;
  }

  paidCheckoutSessions.set(sessionId, {
    sessionId,
    imageCount,
    amountTotal,
    jobId: jobId || null,
    paymentStatus: "pending",
    createdAt: now,
    updatedAt: now,
    expiresAt,
  });
}

async function markPaymentSessionPaid({ session, eventId }) {
  const sessionId = String(session.id || "");
  if (!sessionId) return;

  const now = Date.now();
  const imageCount = Number(session.metadata?.imageCount || 0);
  const jobId = String(session.metadata?.jobId || "");
  const amountTotal = Number(session.amount_total || 0);
  const expiresAt = now + paymentSessionTtlSeconds * 1000;

  if (ddbClient && paidSessionsTable) {
    const current = await getRememberedPaidSession(sessionId);

    if (current?.lastWebhookEventId === eventId) {
      return;
    }

    await ddbClient.send(
      new PutCommand({
        TableName: paidSessionsTable,
        Item: {
          sessionId,
          imageCount,
          amountTotal,
          jobId: jobId || current?.jobId || null,
          paymentStatus: "paid",
          paidAt: now,
          createdAt: current?.createdAt || now,
          updatedAt: now,
          expiresAt: current?.expiresAt || expiresAt,
          lastWebhookEventId: eventId,
          ttl: toUnixSeconds(current?.expiresAt || expiresAt),
        },
      })
    );
    return;
  }

  const existing = paidCheckoutSessions.get(sessionId) || {};
  if (existing.lastWebhookEventId === eventId) return;

  paidCheckoutSessions.set(sessionId, {
    ...existing,
    sessionId,
    imageCount,
    amountTotal,
    jobId: jobId || existing.jobId || null,
    paymentStatus: "paid",
    paidAt: now,
    createdAt: existing.createdAt || now,
    updatedAt: now,
    expiresAt: existing.expiresAt || expiresAt,
    lastWebhookEventId: eventId,
  });
}

function cleanupPaidSessions() {
  const maxAgeMs = 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const [sessionId, record] of paidCheckoutSessions.entries()) {
    if (now - record.paidAt > maxAgeMs) {
      paidCheckoutSessions.delete(sessionId);
    }
  }
}

function getPriceCents(imageCount) {
  if (imageCount <= 10) return 0;
  if (imageCount <= 300) return 100;
  return 300;
}

function ensureDirs() {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: maxFileSizeBytes,
    files: maxFiles,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const valid = acceptedMimes.has(file.mimetype) || acceptedExtensions.has(ext);

    if (!valid) {
      cb(new Error("Unsupported file type. Allowed: HEIC, PNG, WEBP, JPEG, JPG."));
      return;
    }

    cb(null, true);
  },
});

async function convertFilesToJpg(files, jobId) {
  const convertedPaths = [];

  for (const file of files) {
    const outputName = `${jobId}-${path.parse(file.originalname).name}.jpg`;
    const outputPath = path.join(outputDir, outputName);

    await sharp(file.path)
      .rotate()
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    convertedPaths.push(outputPath);
  }

  return convertedPaths;
}

function createZipFromFiles(files, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);

    archive.pipe(output);

    files.forEach((file) => {
      archive.file(file, { name: path.basename(file) });
    });

    archive.finalize();
  });
}

async function removeFiles(filePaths) {
  await Promise.all(
    filePaths.map(async (filePath) => {
      try {
        await fsPromises.unlink(filePath);
      } catch (_error) {
        // Ignore cleanup errors for already removed files.
      }
    })
  );
}

async function verifyPaidSession({ sessionId, imageCount }) {
  const amount = getPriceCents(imageCount);
  if (amount === 0) return true;

  if (!stripeClient) {
    throw new Error("Stripe is not configured on the server.");
  }

  const tracked = await getRememberedPaidSession(sessionId);

  if (tracked) {
    const notExpired = Number(tracked.expiresAt || 0) > Date.now();
    return (
      tracked.paymentStatus === "paid" &&
      notExpired &&
      tracked.amountTotal === amount &&
      tracked.imageCount === imageCount
    );
  }

  return false;
}

async function recoverPaidSessionFromStripe({ sessionId, imageCount }) {
  const amount = getPriceCents(imageCount);
  if (amount === 0) return true;

  if (!stripeClient) {
    throw new Error("Stripe is not configured on the server.");
  }

  const session = await stripeClient.checkout.sessions.retrieve(sessionId);
  const paid =
    session.payment_status === "paid" &&
    session.amount_total === amount &&
    Number(session.metadata?.imageCount || 0) === imageCount;

  if (paid) {
    await markPaymentSessionPaid({ session, eventId: `recovery-${Date.now()}` });
  }

  return paid;
}

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!stripeClient) {
      return res.status(503).send("Stripe is not configured.");
    }

    if (!webhookSecret) {
      return res.status(503).send("Webhook secret is not configured.");
    }

    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).send("Missing Stripe signature.");
    }

    const event = stripeClient.webhooks.constructEvent(req.body, signature, webhookSecret);

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await markPaymentSessionPaid({ session: event.data.object, eventId: event.id });
      cleanupPaidSessions();
    }

    return res.json({ received: true });
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.json());

app.post("/api/create-upload-session", async (req, res) => {
  try {
    requireS3();

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length < 1) {
      return res.status(400).json({ error: "At least one file is required." });
    }

    if (files.length > maxFiles) {
      return res.status(400).json({ error: `Too many files. Max is ${maxFiles}.` });
    }

    const jobId = randomUUID();
    const now = Date.now();
    const expiresAt = now + jobTtlSeconds * 1000;
    const amount = getPriceCents(files.length);

    const fileManifest = [];
    const uploadTargets = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] || {};
      const fileName = String(file.name || "");
      const contentType = String(file.type || "application/octet-stream");
      const size = Number(file.size || 0);

      const ext = path.extname(fileName).toLowerCase();
      const validType = acceptedMimes.has(contentType) || acceptedExtensions.has(ext);

      if (!validType) {
        return res.status(400).json({ error: `Unsupported file type for ${fileName}.` });
      }

      if (!Number.isFinite(size) || size < 1 || size > maxFileSizeBytes) {
        return res.status(400).json({ error: `${fileName} exceeds max file size of 20MB.` });
      }

      const key = fileToKey(jobId, index, fileName);
      const uploadCommand = new PutObjectCommand({
        Bucket: s3Bucket,
        Key: key,
        ContentType: contentType,
      });

      const url = await getSignedUrl(s3Client, uploadCommand, {
        expiresIn: uploadUrlTtlSeconds,
      });

      fileManifest.push({
        key,
        originalName: fileName,
        contentType,
        size,
      });

      uploadTargets.push({
        key,
        url,
        contentType,
        originalName: fileName,
      });
    }

    await saveConversionJob({
      jobId,
      imageCount: files.length,
      paymentRequired: amount > 0,
      paymentSessionId: null,
      paymentStatus: amount > 0 ? "pending" : "not_required",
      status: "awaiting_upload",
      uploadedCount: 0,
      fileManifest,
      resultZipKey: null,
      createdAt: now,
      updatedAt: now,
      expiresAt,
      ttl: toUnixSeconds(expiresAt),
    });

    return res.json({
      jobId,
      imageCount: files.length,
      amount,
      uploadTargets,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create upload session." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/price", (req, res) => {
  const imageCount = Number(req.body?.imageCount || 0);
  if (!Number.isInteger(imageCount) || imageCount < 0) {
    return res.status(400).json({ error: "Invalid image count." });
  }

  const cents = getPriceCents(imageCount);
  return res.json({
    imageCount,
    cents,
    dollars: (cents / 100).toFixed(2),
  });
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const imageCount = Number(req.body?.imageCount || 0);
    const jobId = String(req.body?.jobId || "");
    if (!Number.isInteger(imageCount) || imageCount < 1) {
      return res.status(400).json({ error: "Invalid image count." });
    }

    if (jobId) {
      const job = await getConversionJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Conversion job not found." });
      }
      if (Number(job.imageCount) !== imageCount) {
        return res.status(400).json({ error: "imageCount does not match the conversion job." });
      }
    }

    const amount = getPriceCents(imageCount);
    if (amount === 0) {
      return res.json({ required: false, amount });
    }

    if (!stripeClient) {
      return res.status(500).json({ error: "Stripe is not configured. Add STRIPE_SECRET_KEY in server/.env." });
    }

    const session = await stripeClient.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: {
              name: `Image conversion (${imageCount} files)`,
              description: "Convert uploaded images to JPG and download as ZIP",
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&count=${imageCount}&job_id=${jobId}`,
      cancel_url: `${clientUrl}/cancel.html?count=${imageCount}`,
      metadata: {
        imageCount: String(imageCount),
        jobId,
      },
    });

    await createPendingPaymentSession({
      sessionId: session.id,
      imageCount,
      amountTotal: amount,
      jobId,
    });

    return res.json({
      required: true,
      amount,
      checkoutUrl: session.url,
      sessionId: session.id,
      jobId,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create checkout session." });
  }
});

app.post("/api/verify-session", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    const imageCount = Number(req.body?.imageCount || 0);
    const recover = Boolean(req.body?.recover);

    if (!sessionId || !Number.isInteger(imageCount) || imageCount < 1) {
      return res.status(400).json({ error: "sessionId and imageCount are required." });
    }

    let paid = await verifyPaidSession({ sessionId, imageCount });

    if (!paid && recover) {
      paid = await recoverPaidSessionFromStripe({ sessionId, imageCount });
    }

    return res.json({ paid });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to verify payment." });
  }
});

app.post("/api/start-conversion-job", async (req, res) => {
  try {
    requireS3();

    const jobId = String(req.body?.jobId || "");
    const paymentSessionId = String(req.body?.paymentSessionId || "");

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required." });
    }

    const job = await getConversionJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (Number(job.expiresAt || 0) <= Date.now()) {
      return res.status(410).json({ error: "Job expired. Please upload again." });
    }

    if (job.status === "completed" && job.resultZipKey) {
      const existingDownloadUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: s3Bucket, Key: job.resultZipKey }),
        { expiresIn: downloadUrlTtlSeconds }
      );

      return res.json({
        jobId,
        status: "completed",
        downloadUrl: existingDownloadUrl,
      });
    }

    if (job.status === "processing") {
      return res.status(202).json({
        jobId,
        status: "processing",
      });
    }

    if (job.status === "failed") {
      return res.status(409).json({
        jobId,
        status: "failed",
        error: job.lastError || "Job failed.",
      });
    }

    if (job.paymentRequired) {
      if (!paymentSessionId) {
        return res.status(402).json({ error: "Payment session required for this job." });
      }

      const paid = await verifyPaidSession({
        sessionId: paymentSessionId,
        imageCount: Number(job.imageCount || 0),
      });

      if (!paid) {
        return res.status(402).json({ error: "Payment not verified yet." });
      }

      job.paymentSessionId = paymentSessionId;
      job.paymentStatus = "paid";
    }
    await saveConversionJob(job);
    processConversionJob(jobId);

    return res.json({
      jobId,
      status: "queued",
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Conversion job failed.",
    });
  }
});

app.get("/api/conversion-job/:jobId", async (req, res) => {
  try {
    requireS3();

    const jobId = String(req.params?.jobId || "");
    if (!jobId) {
      return res.status(400).json({ error: "jobId is required." });
    }

    const job = await getConversionJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (Number(job.expiresAt || 0) <= Date.now()) {
      return res.status(410).json({
        jobId,
        status: "expired",
      });
    }

    if (job.status === "completed" && job.resultZipKey) {
      const downloadUrl = await getSignedUrl(
        s3Client,
        new GetObjectCommand({ Bucket: s3Bucket, Key: job.resultZipKey }),
        { expiresIn: downloadUrlTtlSeconds }
      );

      return res.json({
        jobId,
        status: "completed",
        downloadUrl,
      });
    }

    return res.json({
      jobId,
      status: job.status || "queued",
      paymentStatus: job.paymentStatus || "pending",
      error: job.lastError || null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to read conversion job." });
  }
});

app.post("/api/conversion-job/:jobId/download-url", async (req, res) => {
  try {
    requireS3();

    const jobId = String(req.params?.jobId || "");
    const paymentSessionId = String(req.body?.paymentSessionId || "");

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required." });
    }

    const job = await getConversionJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (Number(job.expiresAt || 0) <= Date.now()) {
      return res.status(410).json({
        jobId,
        status: "expired",
        error: "Job expired. Please upload again.",
      });
    }

    if (job.status !== "completed" || !job.resultZipKey) {
      return res.status(409).json({
        jobId,
        status: job.status || "pending",
        error: "Download URL is only available for completed jobs.",
      });
    }

    if (job.paymentRequired) {
      if (!paymentSessionId) {
        return res.status(402).json({ error: "paymentSessionId is required for paid jobs." });
      }

      const paid = await verifyPaidSession({
        sessionId: paymentSessionId,
        imageCount: Number(job.imageCount || 0),
      });

      if (!paid) {
        return res.status(402).json({ error: "Payment not verified for this job." });
      }
    }

    const downloadUrl = await getSignedUrl(
      s3Client,
      new GetObjectCommand({
        Bucket: s3Bucket,
        Key: job.resultZipKey,
      }),
      { expiresIn: downloadUrlTtlSeconds }
    );

    return res.json({
      jobId,
      status: "completed",
      downloadUrl,
      expiresInSeconds: downloadUrlTtlSeconds,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to issue download URL." });
  }
});

app.post("/api/convert", upload.array("images", maxFiles), async (req, res) => {
  const uploadedFiles = req.files || [];
  const imageCount = uploadedFiles.length;

  if (imageCount < 1) {
    return res.status(400).json({ error: "Please upload at least one image." });
  }

  const amount = getPriceCents(imageCount);
  const sessionId = String(req.body?.sessionId || "");

  try {
    if (amount > 0) {
      if (!sessionId) {
        await removeFiles(uploadedFiles.map((f) => f.path));
        return res.status(402).json({ error: "Payment required for this batch size." });
      }

      const paid = await verifyPaidSession({ sessionId, imageCount });
      if (!paid) {
        await removeFiles(uploadedFiles.map((f) => f.path));
        return res.status(402).json({ error: "Payment not verified. Please complete checkout first." });
      }
    }

    const jobId = randomUUID();
    const convertedFiles = await convertFilesToJpg(uploadedFiles, jobId);
    const zipPath = path.join(outputDir, `${jobId}.zip`);

    await createZipFromFiles(convertedFiles, zipPath);

    res.download(zipPath, `converted-images-${jobId}.zip`, async (err) => {
      await removeFiles(uploadedFiles.map((f) => f.path));
      await removeFiles(convertedFiles);
      await removeFiles([zipPath]);

      if (err && !res.headersSent) {
        res.status(500).json({ error: "Download failed." });
      }
    });
  } catch (error) {
    await removeFiles(uploadedFiles.map((f) => f.path));
    return res.status(500).json({
      error: `Conversion failed. ${error.message}`,
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File too large. Max per file is 20MB." });
    }
    if (error.code === "LIMIT_FILE_COUNT") {
      return res.status(400).json({ error: `Too many files. Max is ${maxFiles}.` });
    }
    return res.status(400).json({ error: error.message });
  }

  return res.status(400).json({ error: error.message || "Request failed." });
});

ensureDirs();
app.listen(port, () => {
  // Keep startup output concise and readable in local dev terminals.
  console.log(`Image converter API running on http://localhost:${port}`);
});
