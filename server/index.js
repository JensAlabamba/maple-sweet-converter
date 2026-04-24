const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const archiver = require("archiver");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { randomUUID, createHash } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

dotenv.config();

function readEnvValue(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) {
      return value;
    }
  }

  return "";
}

const app = express();
const port = Number(process.env.PORT || 5000);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5500";
const clientUrls = String(process.env.CLIENT_URLS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const allowedOrigins = Array.from(new Set([clientUrl, ...clientUrls]));
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const awsRegion = process.env.AWS_REGION || "us-east-1";
const paidSessionsTable = readEnvValue("PAYMENT_SESSIONS_TABLE", "PAID_SESSIONS_TABLE", "SESSIONS_TABLE");
const conversionJobsTable = readEnvValue("CONVERSION_JOBS_TABLE", "JOBS_TABLE");
const s3Bucket = process.env.S3_BUCKET || "";
const uploadUrlTtlSeconds = Number(process.env.S3_UPLOAD_URL_TTL_SECONDS || 900);
const downloadUrlTtlSeconds = Number(process.env.S3_DOWNLOAD_URL_TTL_SECONDS || 900);
const paymentSessionTtlSeconds = Number(process.env.PAYMENT_SESSION_TTL_SECONDS || 7200);
const jobTtlSeconds = Number(process.env.CONVERSION_JOB_TTL_SECONDS || 86400);
const freeDailyImageLimit = Number(process.env.FREE_DAILY_IMAGE_LIMIT || 10);
const freeUsageWindowHours = Number(process.env.FREE_USAGE_WINDOW_HOURS || 24);
const freeUsageWindowMs = freeUsageWindowHours * 60 * 60 * 1000;
const unlimitedPassWindowMs = 24 * 60 * 60 * 1000;
const highestTierPriceCents = 699;
const conversionConcurrency = Math.min(8, Math.max(1, Number(process.env.CONVERSION_CONCURRENCY || 2)));
const zipCompressionLevel = Math.min(9, Math.max(0, Number(process.env.ZIP_COMPRESSION_LEVEL || 0)));
const jpegQuality = Math.min(95, Math.max(70, Number(process.env.JPEG_QUALITY || 85)));
const webpQuality = Math.min(95, Math.max(65, Number(process.env.WEBP_QUALITY || 80)));
const pngCompressionLevel = Math.min(9, Math.max(1, Number(process.env.PNG_COMPRESSION_LEVEL || 6)));

app.set("trust proxy", 1);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests and same-origin server calls with no Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
  })
);

const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");
const maxFiles = 500;
const maxFileSizeBytes = 20 * 1024 * 1024;
const maxBatchSizeMb = Math.max(50, Number(process.env.MAX_BATCH_SIZE_MB || 512));
const maxBatchSizeBytes = maxBatchSizeMb * 1024 * 1024;
const validationDeferFileCount = Math.max(50, Number(process.env.VALIDATION_DEFER_FILE_COUNT || 150));

const acceptedMimes = new Set([
  "image/heic",
  "image/heif",
  "image/png",
  "image/webp",
  "image/jpeg",
  "image/jpg",
]);

const acceptedExtensions = new Set([".heic", ".heif", ".png", ".webp", ".jpeg", ".jpg"]);
const outputFormats = {
  jpg: {
    extension: "jpg",
    displayName: "JPG",
    contentType: "image/jpeg",
    apply(image) {
      return image.jpeg({ quality: jpegQuality });
    },
  },
  jpeg: {
    extension: "jpeg",
    displayName: "JPEG",
    contentType: "image/jpeg",
    apply(image) {
      return image.jpeg({ quality: jpegQuality });
    },
  },
  png: {
    extension: "png",
    displayName: "PNG",
    contentType: "image/png",
    apply(image) {
      return image.png({ compressionLevel: pngCompressionLevel });
    },
  },
  webp: {
    extension: "webp",
    displayName: "WEBP",
    contentType: "image/webp",
    apply(image) {
      return image.webp({ quality: webpQuality });
    },
  },
};

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const paidCheckoutSessions = new Map();
const conversionJobs = new Map();
const activeProcessingJobs = new Set();
const canceledJobs = new Set();
const freeUsageCounters = new Map();
const unlimitedPasses = new Map();
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

function normalizeStoredPathSegment(segment) {
  const normalized = String(segment || "")
    .replace(/[<>:"|?*\x00-\x1F]/g, "_")
    .trim();
  return normalized || "item";
}

function normalizeRelativePath(relativePath, fallbackName = "file") {
  const rawValue = String(relativePath || "").trim().replace(/\\+/g, "/");
  const parts = rawValue
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..");

  if (parts.length === 0) {
    return normalizeStoredPathSegment(fallbackName);
  }

  return parts.map(normalizeStoredPathSegment).join("/");
}

function getArchiveEntryName(file, outputFormat) {
  const formatInfo = getOutputFormatInfo(outputFormat);
  const originalPath = normalizeRelativePath(file.relativePath || file.originalName, file.originalName);
  const parsedPath = path.posix.parse(originalPath);
  const directoryPath = parsedPath.dir;
  const baseName = normalizeStoredPathSegment(parsedPath.name || path.parse(file.originalName || "image").name || "image");
  const fileName = `${baseName}.${formatInfo.extension}`;

  return directoryPath ? `${directoryPath}/${fileName}` : fileName;
}

function fileToKey(jobId, index, fileName) {
  return `uploads/${jobId}/${index}-${normalizeFileName(fileName)}`;
}

function normalizeOutputFormat(value) {
  const format = String(value || "jpg").trim().toLowerCase();
  return outputFormats[format] ? format : "jpg";
}

function getOutputFormatInfo(value) {
  return outputFormats[normalizeOutputFormat(value)];
}

function logEvent(level, event, meta = {}) {
  const entry = {
    level,
    event,
    time: new Date().toISOString(),
    ...meta,
  };

  if (level === "error") {
    console.error(JSON.stringify(entry));
    return;
  }

  console.log(JSON.stringify(entry));
}

function getStartRequestId(rawValue, jobId) {
  const provided = String(rawValue || "").trim();
  if (provided) {
    return provided.slice(0, 120);
  }

  return `start-${jobId}-${Date.now()}`;
}

function isUnsupportedHeifCompressionError(error) {
  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("heif") &&
    (message.includes("support for this compression format has not been built in") ||
      message.includes("error while loading plugin") ||
      message.includes("bad seek"))
  );
}

function buildHeifCompressionError(fileLabel) {
  const safeName = String(fileLabel || "One of your files");
  return new Error(
    `${safeName} uses a HEIC/HEIF compression variant not supported by this server image. Please re-export that file as JPG/PNG (or standard HEIC) and try again.`
  );
}

function getFileLabel(file) {
  return String(file?.relativePath || file?.originalName || "One of your uploaded files");
}

async function convertBufferToFormat(buffer, outputFormat) {
  const formatInfo = getOutputFormatInfo(outputFormat);

  // First attempt: Sharp (fast path, handles most HEIC/HEIF and all other formats).
  try {
    const image = sharp(buffer).rotate();
    return await formatInfo.apply(image).toBuffer();
  } catch (sharpError) {
    if (!isUnsupportedHeifCompressionError(sharpError)) {
      throw sharpError;
    }
    // Fall through to heic-convert for unsupported compression variants.
  }

  // Fallback: heic-convert (WASM-based, supports more HEIC/HEIF variants).
  try {
    // Decode HEIC → raw JPEG bytes first, then re-process through Sharp for
    // the requested output format (PNG, WEBP, JPEG, etc.).
    const jpegBuffer = await heicConvert({ buffer, format: "JPEG", quality: 1 });
    const image = sharp(jpegBuffer).rotate();
    return await formatInfo.apply(image).toBuffer();
  } catch (heicError) {
    // If heic-convert also fails, throw as an unsupported variant so the caller
    // can surface a clean message to the user.
    throw buildHeifCompressionError("One of your uploaded files");
  }
}

function getValidationErrorReason(error) {
  if (isUnsupportedHeifCompressionError(error)) {
    return "Unsupported HEIC/HEIF compression variant";
  }

  const message = String(error?.message || "");
  if (!message) {
    return "Corrupted or unreadable image data";
  }

  if (/input buffer|unsupported image|corrupt|invalid|decode|decode error/i.test(message)) {
    return "Corrupted or unreadable image data";
  }

  return `Unable to process image (${message})`;
}

async function validateUploadedFilesForJob(job) {
  requireS3();

  const manifest = Array.isArray(job?.fileManifest) ? job.fileManifest : [];
  if (manifest.length < 1) {
    return {
      ok: false,
      invalidFiles: [
        {
          name: "uploaded batch",
          reason: "No uploaded files were found for this job",
        },
      ],
    };
  }

  const invalidFiles = [];
  const invalidFileKeys = [];
  let cursor = 0;
  const workerCount = Math.min(4, Math.max(1, manifest.length));

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= manifest.length) {
        return;
      }

      const file = manifest[index];
      try {
        const object = await s3Client.send(
          new GetObjectCommand({
            Bucket: s3Bucket,
            Key: file.key,
          })
        );

        const originalBuffer = await bodyToBuffer(object.Body);
        await convertBufferToFormat(originalBuffer, job.outputFormat);
      } catch (error) {
        invalidFiles.push({
          name: getFileLabel(file),
          reason: getValidationErrorReason(error),
        });
        invalidFileKeys.push(file.key);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return {
    ok: invalidFiles.length === 0,
    invalidFiles,
    invalidFileKeys,
  };
}

function buildInvalidFileMessage(invalidFiles) {
  const files = Array.isArray(invalidFiles) ? invalidFiles : [];
  const first = files[0];
  const firstName = String(first?.name || "One of your files");
  const firstReason = String(first?.reason || "Corrupted or unreadable image data");

  if (files.length === 1) {
    return `${firstName} cannot be processed: ${firstReason}. Remove that file and try again.`;
  }

  return `${files.length} uploaded files cannot be processed. First issue: ${firstName} (${firstReason}). Remove the corrupted/unsupported files and try again.`;
}

function shouldDeferDeepValidation(job) {
  const manifest = Array.isArray(job?.fileManifest) ? job.fileManifest : [];
  return manifest.length >= validationDeferFileCount;
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

async function savePaidSessionRecord(sessionId, patch = {}) {
  const now = Date.now();
  const current = (await getRememberedPaidSession(sessionId)) || { sessionId };
  const merged = {
    ...current,
    ...patch,
    sessionId,
    updatedAt: now,
  };

  const expiresAt = Number(merged.expiresAt || now + paymentSessionTtlSeconds * 1000);
  merged.expiresAt = expiresAt;
  merged.ttl = Number(merged.ttl || toUnixSeconds(expiresAt));

  if (ddbClient && paidSessionsTable) {
    await ddbClient.send(
      new PutCommand({
        TableName: paidSessionsTable,
        Item: merged,
      })
    );
    return merged;
  }

  paidCheckoutSessions.set(sessionId, merged);
  return merged;
}

async function createRefundForSession({ sessionId, jobId = "", reason = "requested_by_customer" }) {
  const tracked = await getRememberedPaidSession(sessionId);
  if (!tracked) {
    throw new Error("Payment session not found.");
  }

  if (tracked.refundStatus === "refunded") {
    return {
      refunded: true,
      refundId: tracked.refundId || null,
      alreadyRefunded: true,
    };
  }

  if (Number(tracked.amountTotal || 0) <= 0) {
    throw new Error("This session has no refundable payment.");
  }

  if (!stripeClient) {
    throw new Error("Stripe is not configured on the server.");
  }

  const checkoutSession = await stripeClient.checkout.sessions.retrieve(sessionId, {
    expand: ["payment_intent"],
  });

  const paymentIntent =
    typeof checkoutSession.payment_intent === "string"
      ? checkoutSession.payment_intent
      : checkoutSession.payment_intent?.id;

  if (!paymentIntent) {
    throw new Error("No payment intent found for refund.");
  }

  const refund = await stripeClient.refunds.create({
    payment_intent: paymentIntent,
    reason,
    metadata: {
      sessionId,
      jobId,
    },
  });

  await savePaidSessionRecord(sessionId, {
    refundStatus: "refunded",
    refundId: refund.id,
    refundedAt: Date.now(),
    paymentStatus: "refunded",
  });

  return {
    refunded: true,
    refundId: refund.id,
    alreadyRefunded: false,
  };
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

function buildJobProgress(job) {
  const total = Number(job?.imageCount || 0);
  const processed = Number(job?.processedCount || 0);
  const startedAt = Number(job?.processingStartedAt || 0);

  if (total < 1) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
  const elapsedMs = startedAt > 0 ? Math.max(0, Date.now() - startedAt) : 0;

  let estimatedRemainingSeconds = null;
  if (processed > 0 && processed < total && elapsedMs > 0) {
    const avgMsPerFile = elapsedMs / processed;
    const remainingFiles = total - processed;
    estimatedRemainingSeconds = Math.max(1, Math.round((avgMsPerFile * remainingFiles) / 1000));
  } else if (processed >= total) {
    estimatedRemainingSeconds = 0;
  }

  return {
    processed,
    total,
    percent,
    elapsedSeconds: Math.round(elapsedMs / 1000),
    estimatedRemainingSeconds,
  };
}

async function processConversionJob(jobId) {
  if (activeProcessingJobs.has(jobId)) {
    return;
  }

  activeProcessingJobs.add(jobId);
  logEvent("info", "conversion.job.started", { jobId });

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

    if (job.status === "canceled" || canceledJobs.has(jobId) || job.cancelRequested) {
      job.status = "canceled";
      job.updatedAt = Date.now();
      job.canceledAt = Number(job.canceledAt || Date.now());
      await saveConversionJob(job);
      return;
    }

    job.status = "processing";
    job.processingStartedAt = Date.now();
    job.processedCount = 0;
    job.updatedAt = Date.now();
    await saveConversionJob(job);

    const formatInfo = getOutputFormatInfo(job.outputFormat);
    const zipPath = path.join(outputDir, `${jobId}.zip`);

    await new Promise(async (resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: zipCompressionLevel } });

      output.on("close", resolve);
      output.on("error", reject);
      archive.on("error", reject);

      archive.pipe(output);

      try {
        const manifest = Array.isArray(job.fileManifest) ? job.fileManifest : [];
        const excludedFileKeys = new Set(Array.isArray(job.excludedFileKeys) ? job.excludedFileKeys : []);
        let convertedCount = 0;
        const skippedFiles = [];
        let cursor = 0;
        let lastProgressSaveAt = Date.now();

        async function worker() {
          while (true) {
            if (canceledJobs.has(jobId) || job.cancelRequested) {
              return;
            }

            const index = cursor;
            cursor += 1;

            if (index >= manifest.length) {
              return;
            }

            const file = manifest[index];

            if (excludedFileKeys.has(file.key)) {
              skippedFiles.push(getFileLabel(file));
              continue;
            }

            try {
              const object = await s3Client.send(
                new GetObjectCommand({
                  Bucket: s3Bucket,
                  Key: file.key,
                })
              );

              const originalBuffer = await bodyToBuffer(object.Body);
              const convertedBuffer = await convertBufferToFormat(originalBuffer, job.outputFormat);

              archive.append(convertedBuffer, {
                name: getArchiveEntryName(file, job.outputFormat),
              });

              convertedCount += 1;
              job.processedCount = convertedCount;

              const now = Date.now();
              const shouldSaveProgress =
                convertedCount >= manifest.length ||
                convertedCount % 5 === 0 ||
                now - lastProgressSaveAt >= 1500;

              if (shouldSaveProgress) {
                job.updatedAt = now;
                await saveConversionJob(job);
                lastProgressSaveAt = now;
              }
            } catch (error) {
              if (isUnsupportedHeifCompressionError(error)) {
                skippedFiles.push(getFileLabel(file));
                continue;
              }

              throw error;
            }
          }
        }

        const workerCount = Math.min(conversionConcurrency, Math.max(1, manifest.length));
        const workers = [];
        for (let i = 0; i < workerCount; i += 1) {
          workers.push(worker());
        }

        await Promise.all(workers);

        if (canceledJobs.has(jobId) || job.cancelRequested) {
          throw new Error("JOB_CANCELED");
        }

        if (convertedCount === 0) {
          if (skippedFiles.length > 0) {
            throw buildHeifCompressionError(skippedFiles[0]);
          }

          throw new Error("No convertible files were found for this job.");
        }

        if (skippedFiles.length > 0) {
          job.skippedFiles = skippedFiles;
          job.skipSummary = `${skippedFiles.length} file(s) were skipped because their HEIC/HEIF compression variant is unsupported.`;
        } else {
          delete job.skippedFiles;
          delete job.skipSummary;
        }

        await archive.finalize();
      } catch (error) {
        reject(error);
      }
    });

    const resultZipKey = `results/${jobId}/converted-images-${formatInfo.extension}.zip`;
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
    job.outputFormat = normalizeOutputFormat(job.outputFormat);
    job.resultZipKey = resultZipKey;
    job.updatedAt = Date.now();
    job.completedAt = Date.now();
    job.uploadedCount = Array.isArray(job.fileManifest) ? job.fileManifest.length : 0;
    await saveConversionJob(job);
    logEvent("info", "conversion.job.completed", {
      jobId,
      outputFormat: job.outputFormat,
      uploadedCount: job.uploadedCount,
      skippedCount: Array.isArray(job.skippedFiles) ? job.skippedFiles.length : 0,
    });
  } catch (error) {
    const job = await getConversionJob(jobId);
    if (job) {
      if (String(error?.message || "") === "JOB_CANCELED") {
        job.status = "canceled";
        job.canceledAt = Number(job.canceledAt || Date.now());
        logEvent("info", "conversion.job.canceled", { jobId });
      } else {
        job.status = "failed";
        job.lastError = error.message;
        logEvent("error", "conversion.job.failed", {
          jobId,
          error: String(error?.message || "Unknown conversion error"),
        });

        const shouldAutoRefund =
          job.paymentRequired &&
          !job.resultZipKey &&
          String(job.paymentSessionId || "").trim().length > 0;

        if (shouldAutoRefund) {
          try {
            const refundResult = await createRefundForSession({
              sessionId: String(job.paymentSessionId),
              jobId,
              reason: "requested_by_customer",
            });

            job.autoRefunded = refundResult.refunded;
            job.autoRefundId = refundResult.refundId || null;
            job.autoRefundedAt = Date.now();
            job.lastError = `${job.lastError} Payment was automatically refunded.`;
            logEvent("info", "conversion.job.auto_refunded", {
              jobId,
              refundId: refundResult.refundId || null,
            });
          } catch (refundError) {
            job.autoRefunded = false;
            job.autoRefundError = String(refundError?.message || "Refund attempt failed");
            logEvent("error", "conversion.job.auto_refund_failed", {
              jobId,
              error: job.autoRefundError,
            });
          }
        }
      }
      job.updatedAt = Date.now();
      await saveConversionJob(job);
    }
  } finally {
    canceledJobs.delete(jobId);
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
  if (imageCount <= 300) return 199;
  return 699;
}

function parseBoolean(value) {
  return value === true || String(value || "").toLowerCase() === "true";
}

function getRequestedAmountCents({ imageCount, unlimitedRequested = false, unlimitedPassActive = false }) {
  if (unlimitedPassActive) {
    return 0;
  }

  if (unlimitedRequested) {
    return highestTierPriceCents;
  }

  return getPriceCents(imageCount);
}

function getClientFingerprint(req) {
  const forwardedFor = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)[0];
  const rawIp = forwardedFor || req.ip || req.socket?.remoteAddress || "unknown";
  const normalizedIp = String(rawIp).replace(/^::ffff:/, "");
  const userAgent = String(req.headers["user-agent"] || "unknown");

  return createHash("sha256")
    .update(`${normalizedIp}::${userAgent}`)
    .digest("hex")
    .slice(0, 24);
}

function getFreeUsageKey(fingerprint) {
  return `free-usage#${fingerprint}`;
}

function getUnlimitedPassKey(fingerprint) {
  return `unlimited-pass#${fingerprint}`;
}

async function getUnlimitedPass(req) {
  const fingerprint = getClientFingerprint(req);
  const passKey = getUnlimitedPassKey(fingerprint);
  const now = Date.now();

  if (ddbClient && paidSessionsTable) {
    const result = await ddbClient.send(
      new GetCommand({
        TableName: paidSessionsTable,
        Key: { sessionId: passKey },
      })
    );

    const item = result.Item || null;
    if (!item) {
      return null;
    }

    if (Number(item.expiresAt || 0) <= now || item.paymentStatus !== "active") {
      return null;
    }

    return item;
  }

  const pass = unlimitedPasses.get(passKey) || null;
  if (!pass) {
    return null;
  }

  if (Number(pass.expiresAt || 0) <= now || pass.paymentStatus !== "active") {
    unlimitedPasses.delete(passKey);
    return null;
  }

  return pass;
}

async function activateUnlimitedPass(req, sourceSessionId = "") {
  const fingerprint = getClientFingerprint(req);
  const passKey = getUnlimitedPassKey(fingerprint);
  const now = Date.now();
  const expiresAt = now + unlimitedPassWindowMs;
  const sessionId = String(sourceSessionId || "");

  if (ddbClient && paidSessionsTable) {
    await ddbClient.send(
      new PutCommand({
        TableName: paidSessionsTable,
        Item: {
          sessionId: passKey,
          paymentStatus: "active",
          recordType: "unlimited_pass",
          sourceSessionId: sessionId || null,
          createdAt: now,
          updatedAt: now,
          expiresAt,
          ttl: toUnixSeconds(expiresAt),
        },
      })
    );

    return {
      sessionId: passKey,
      paymentStatus: "active",
      expiresAt,
      sourceSessionId: sessionId || null,
    };
  }

  const pass = {
    sessionId: passKey,
    paymentStatus: "active",
    recordType: "unlimited_pass",
    sourceSessionId: sessionId || null,
    createdAt: now,
    updatedAt: now,
    expiresAt,
  };

  unlimitedPasses.set(passKey, pass);
  return pass;
}

async function getUnlimitedPassStatus(req) {
  const pass = await getUnlimitedPass(req);
  if (!pass) {
    return {
      active: false,
      expiresAt: null,
    };
  }

  return {
    active: true,
    expiresAt: Number(pass.expiresAt || 0),
  };
}

async function getFreeUsageState(req) {
  const fingerprint = getClientFingerprint(req);
  const usageKey = getFreeUsageKey(fingerprint);
  const now = Date.now();

  if (ddbClient && paidSessionsTable) {
    const result = await ddbClient.send(
      new GetCommand({
        TableName: paidSessionsTable,
        Key: { sessionId: usageKey },
      })
    );

    const item = result.Item || {};
    const windowEndsAt = Number(item.windowEndsAt || 0);

    if (!windowEndsAt || windowEndsAt <= now) {
      return {
        used: 0,
        windowEndsAt: null,
      };
    }

    return {
      used: Number(item.freeImagesUsed || 0),
      windowEndsAt,
    };
  }

  const record = freeUsageCounters.get(usageKey);
  if (!record) {
    return {
      used: 0,
      windowEndsAt: null,
    };
  }

  if (Number(record.windowEndsAt || 0) <= now) {
    freeUsageCounters.delete(usageKey);
    return {
      used: 0,
      windowEndsAt: null,
    };
  }

  return {
    used: Number(record.freeImagesUsed || 0),
    windowEndsAt: Number(record.windowEndsAt || 0),
  };
}

async function getFreeUsageForToday(req) {
  const state = await getFreeUsageState(req);
  return Number(state.used || 0);
}

async function reserveFreeUsageForToday(req, imageCount) {
  const count = Number(imageCount || 0);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Invalid image count for free usage reservation.");
  }

  const fingerprint = getClientFingerprint(req);
  const usageKey = getFreeUsageKey(fingerprint);
  const now = Date.now();
  const windowEndMs = now + freeUsageWindowMs;

  if (ddbClient && paidSessionsTable) {
    const ttl = toUnixSeconds(windowEndMs + 24 * 60 * 60 * 1000);
    const maxBeforeIncrement = freeDailyImageLimit - count;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const state = await getFreeUsageState(req);
      const activeWindow = Number(state.windowEndsAt || 0) > now;

      if (activeWindow && Number(state.used || 0) + count > freeDailyImageLimit) {
        return {
          allowed: false,
          used: Number(state.used || 0),
        };
      }

      try {
        if (activeWindow) {
          const result = await ddbClient.send(
            new UpdateCommand({
              TableName: paidSessionsTable,
              Key: { sessionId: usageKey },
              UpdateExpression:
                "SET #recordType = :recordType, #fingerprint = :fingerprint, #updatedAt = :updatedAt, #ttl = :ttl ADD #freeImagesUsed :increment",
              ConditionExpression:
                "attribute_exists(#freeImagesUsed) AND #windowEndsAt > :now AND #freeImagesUsed <= :maxBeforeIncrement",
              ExpressionAttributeNames: {
                "#recordType": "recordType",
                "#fingerprint": "fingerprint",
                "#updatedAt": "updatedAt",
                "#ttl": "ttl",
                "#freeImagesUsed": "freeImagesUsed",
                "#windowEndsAt": "windowEndsAt",
              },
              ExpressionAttributeValues: {
                ":recordType": "free_usage",
                ":fingerprint": fingerprint,
                ":updatedAt": now,
                ":ttl": ttl,
                ":increment": count,
                ":now": now,
                ":maxBeforeIncrement": maxBeforeIncrement,
              },
              ReturnValues: "UPDATED_NEW",
            })
          );

          return {
            allowed: true,
            used: Number(result.Attributes?.freeImagesUsed || count),
          };
        }

        await ddbClient.send(
          new UpdateCommand({
            TableName: paidSessionsTable,
            Key: { sessionId: usageKey },
            UpdateExpression:
              "SET #recordType = :recordType, #fingerprint = :fingerprint, #windowStartedAt = :windowStartedAt, #windowEndsAt = :windowEndsAt, #updatedAt = :updatedAt, #expiresAt = :expiresAt, #ttl = :ttl, #freeImagesUsed = :freeImagesUsed",
            ConditionExpression: "attribute_not_exists(#windowEndsAt) OR #windowEndsAt <= :now",
            ExpressionAttributeNames: {
              "#recordType": "recordType",
              "#fingerprint": "fingerprint",
              "#windowStartedAt": "windowStartedAt",
              "#windowEndsAt": "windowEndsAt",
              "#updatedAt": "updatedAt",
              "#expiresAt": "expiresAt",
              "#ttl": "ttl",
              "#freeImagesUsed": "freeImagesUsed",
            },
            ExpressionAttributeValues: {
              ":recordType": "free_usage",
              ":fingerprint": fingerprint,
              ":windowStartedAt": now,
              ":windowEndsAt": windowEndMs,
              ":updatedAt": now,
              ":expiresAt": windowEndMs,
              ":ttl": ttl,
              ":freeImagesUsed": count,
              ":now": now,
            },
          })
        );

        return {
          allowed: true,
          used: count,
        };
      } catch (error) {
        if (error?.name !== "ConditionalCheckFailedException") {
          throw error;
        }
      }
    }

    const state = await getFreeUsageState(req);
    return {
      allowed: false,
      used: Number(state.used || 0),
    };
  }

  const current = freeUsageCounters.get(usageKey);
  const currentWindowEndsAt = Number(current?.windowEndsAt || 0);
  const activeWindow = currentWindowEndsAt > now;
  const used = activeWindow ? Number(current?.freeImagesUsed || 0) : 0;

  if (used + count > freeDailyImageLimit) {
    return {
      allowed: false,
      used,
    };
  }

  const nextWindowEndsAt = activeWindow ? currentWindowEndsAt : windowEndMs;
  const nextWindowStartedAt = activeWindow ? Number(current?.windowStartedAt || now) : now;

  freeUsageCounters.set(usageKey, {
    freeImagesUsed: used + count,
    windowStartedAt: nextWindowStartedAt,
    windowEndsAt: nextWindowEndsAt,
    expiresAt: windowEndMs + 24 * 60 * 60 * 1000,
  });

  return {
    allowed: true,
    used: used + count,
  };
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

async function convertFilesToFormat(files, jobId, outputFormat) {
  const convertedPaths = [];
  const formatInfo = getOutputFormatInfo(outputFormat);

  for (const file of files) {
    const outputName = `${jobId}-${path.parse(file.originalname).name}.${formatInfo.extension}`;
    const outputPath = path.join(outputDir, outputName);

    try {
      const image = sharp(file.path).rotate();
      await formatInfo.apply(image).toFile(outputPath);
    } catch (error) {
      if (isUnsupportedHeifCompressionError(error)) {
        throw buildHeifCompressionError(file.originalname || file.filename || "One of your files");
      }

      throw error;
    }

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

async function verifyPaidSession({ sessionId, imageCount, paymentAmount }) {
  const amount = Number.isFinite(Number(paymentAmount))
    ? Number(paymentAmount)
    : getPriceCents(imageCount);
  if (amount <= 0) return false;

  if (!stripeClient) {
    throw new Error("Stripe is not configured on the server.");
  }

  const tracked = await getRememberedPaidSession(sessionId);

  if (tracked) {
    const notExpired = Number(tracked.expiresAt || 0) > Date.now();
    if (!notExpired || tracked.paymentStatus !== "paid") {
      return false;
    }

    if (Number(tracked.amountTotal || 0) >= highestTierPriceCents) {
      return true;
    }

    return tracked.amountTotal === amount && tracked.imageCount === imageCount;
  }

  return false;
}

async function recoverPaidSessionFromStripe({ sessionId, imageCount, paymentAmount }) {
  const amount = Number.isFinite(Number(paymentAmount))
    ? Number(paymentAmount)
    : getPriceCents(imageCount);

  if (!stripeClient) {
    throw new Error("Stripe is not configured on the server.");
  }

  const session = await stripeClient.checkout.sessions.retrieve(sessionId);
  const sessionAmount = Number(session.amount_total || 0);
  const paid =
    session.payment_status === "paid" &&
    (
      (amount > 0 && (sessionAmount === amount || sessionAmount >= highestTierPriceCents)) ||
      (amount <= 0 && sessionAmount > 0)
    );

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
      logEvent("info", "stripe.webhook.payment_recorded", {
        eventId: event.id,
        eventType: event.type,
        sessionId: String(event?.data?.object?.id || ""),
      });
      cleanupPaidSessions();
    }

    return res.json({ received: true });
  } catch (error) {
    logEvent("error", "stripe.webhook.error", {
      error: String(error?.message || "Webhook processing error"),
    });
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
});

app.use(express.json());

app.post("/api/create-upload-session", async (req, res) => {
  try {
    requireS3();

    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    const outputFormat = normalizeOutputFormat(req.body?.outputFormat);
    const unlimitedRequested = parseBoolean(req.body?.unlimitedRequested);
    if (files.length < 1) {
      return res.status(400).json({ error: "At least one file is required." });
    }

    if (files.length > maxFiles) {
      return res.status(400).json({ error: `Too many files. Max is ${maxFiles}.` });
    }

    const jobId = randomUUID();
    const now = Date.now();
    const expiresAt = now + jobTtlSeconds * 1000;
    const unlimitedPass = await getUnlimitedPassStatus(req);
    const amount = getRequestedAmountCents({
      imageCount: files.length,
      unlimitedRequested,
      unlimitedPassActive: unlimitedPass.active,
    });

    if (amount === 0 && !unlimitedPass.active) {
      const usedToday = await getFreeUsageForToday(req);
      const remainingToday = Math.max(0, freeDailyImageLimit - usedToday);

      if (files.length > remainingToday) {
        return res.status(429).json({
          error: `Free limit reached. You can convert up to ${freeDailyImageLimit} free images per 24-hour window. Remaining in your current window: ${remainingToday}.`,
          freeDailyImageLimit,
          freeRemainingToday: remainingToday,
        });
      }
    }

    const fileManifest = [];
    const uploadTargets = [];
    let totalBatchBytes = 0;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] || {};
      const fileName = String(file.name || "");
      const relativePath = normalizeRelativePath(file.relativePath || fileName, fileName);
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

      totalBatchBytes += size;
      if (totalBatchBytes > maxBatchSizeBytes) {
        return res.status(400).json({
          error: `Total batch size exceeds ${maxBatchSizeMb}MB. Please upload a smaller batch.`,
          maxBatchSizeMb,
        });
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
        relativePath,
        contentType,
        size,
      });

      uploadTargets.push({
        key,
        url,
        contentType,
        originalName: fileName,
        relativePath,
      });
    }

    await saveConversionJob({
      jobId,
      imageCount: files.length,
      outputFormat,
      paymentRequired: amount > 0,
      unlimitedPassApplied: unlimitedPass.active,
      unlimitedRequested,
      requiredAmountCents: amount,
      freeQuotaReserved: false,
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

    logEvent("info", "upload.session.created", {
      jobId,
      imageCount: files.length,
      outputFormat,
      amount,
      unlimitedRequested,
      unlimitedPassApplied: unlimitedPass.active,
    });

    return res.json({
      jobId,
      imageCount: files.length,
      supportedImageCount: files.length,
      outputFormat,
      amount,
      unlimitedRequested,
      unlimitedPassActive: unlimitedPass.active,
      unlimitedPassExpiresAt: unlimitedPass.expiresAt,
      totalBatchBytes,
      maxBatchSizeMb,
      uploadTargets,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create upload session." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/free-usage-status", async (req, res) => {
  try {
    const state = await getFreeUsageState(req);
    const unlimitedPass = await getUnlimitedPassStatus(req);
    const usedToday = Number(state.used || 0);
    const remainingToday = Math.max(0, freeDailyImageLimit - usedToday);
    const resetAt = Number(state.windowEndsAt || 0) > 0 ? new Date(state.windowEndsAt).toISOString() : null;

    return res.json({
      limit: freeDailyImageLimit,
      usedToday,
      remainingToday,
      resetAt,
      unlimitedPassActive: unlimitedPass.active,
      unlimitedPassExpiresAt: unlimitedPass.expiresAt ? new Date(unlimitedPass.expiresAt).toISOString() : null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to read free usage status." });
  }
});

app.post("/api/price", (req, res) => {
  const imageCount = Number(req.body?.imageCount || 0);
  const unlimitedRequested = parseBoolean(req.body?.unlimitedRequested);
  if (!Number.isInteger(imageCount) || imageCount < 0) {
    return res.status(400).json({ error: "Invalid image count." });
  }

  const cents = getRequestedAmountCents({ imageCount, unlimitedRequested, unlimitedPassActive: false });
  return res.json({
    imageCount,
    unlimitedRequested,
    cents,
    dollars: (cents / 100).toFixed(2),
  });
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const imageCount = Number(req.body?.imageCount || 0);
    const jobId = String(req.body?.jobId || "");
    const requestedUnlimited = parseBoolean(req.body?.unlimitedRequested);
    const skipInvalidFiles = parseBoolean(req.body?.skipInvalidFiles);
    let outputFormat = normalizeOutputFormat(req.body?.outputFormat);
    let unlimitedRequested = requestedUnlimited;
    if (!Number.isInteger(imageCount) || imageCount < 1) {
      return res.status(400).json({ error: "Invalid image count." });
    }

    if (jobId) {
      const job = await getConversionJob(jobId);
      if (!job) {
        return res.status(404).json({ error: "Conversion job not found." });
      }

      // When skipping invalid files, recompute the valid file count from the stored exclusions.
      if (skipInvalidFiles) {
        const excludedKeys = new Set(Array.isArray(job.invalidFileKeys) ? job.invalidFileKeys : []);
        const manifest = Array.isArray(job.fileManifest) ? job.fileManifest : [];
        const validFileCount = manifest.filter((f) => !excludedKeys.has(f.key)).length;

        if (validFileCount < 1) {
          return res.status(400).json({ error: "No valid files remain after excluding unsupported ones." });
        }

        job.excludedFileKeys = [...excludedKeys];
        job.imageCount = validFileCount;
        job.validationStatus = "passed";
        job.validationDeferred = false;
        job.invalidFiles = [];
        job.lastError = null;
        job.updatedAt = Date.now();
        await saveConversionJob(job);

        outputFormat = normalizeOutputFormat(job.outputFormat);
        unlimitedRequested = parseBoolean(job.unlimitedRequested);
        // Fall through to checkout creation with updated imageCount = validFileCount.
        // The outer scope imageCount variable is now stale; use job.imageCount below.
        // We reassign here so the remaining code uses the correct count.
        const effectiveImageCount = validFileCount;

        const outputFormatInfo = getOutputFormatInfo(outputFormat);
        const unlimitedPass = await getUnlimitedPassStatus(req);
        const amount = getRequestedAmountCents({
          imageCount: effectiveImageCount,
          unlimitedRequested,
          unlimitedPassActive: unlimitedPass.active,
        });

        if (amount === 0) {
          return res.json({
            required: false,
            amount,
            validFileCount: effectiveImageCount,
            unlimitedRequested,
            unlimitedPassActive: unlimitedPass.active,
            unlimitedPassExpiresAt: unlimitedPass.expiresAt,
          });
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
                  name: unlimitedRequested
                    ? "24-hour Unlimited Conversion Pass"
                    : `Image conversion (${effectiveImageCount} files to ${outputFormatInfo.displayName})`,
                  description: unlimitedRequested
                    ? "Unlimited image conversions for 24 hours"
                    : `Convert uploaded images to ${outputFormatInfo.displayName} and download as ZIP`,
                },
              },
              quantity: 1,
            },
          ],
          metadata: {
            jobId,
            imageCount: effectiveImageCount,
            outputFormat,
            unlimitedRequested: String(unlimitedRequested),
          },
          success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&jobId=${encodeURIComponent(jobId)}`,
          cancel_url: `${clientUrl}/cancel.html`,
          idempotency_key: `checkout:${jobId}:${effectiveImageCount}:${amount}:${outputFormat}:skip`,
        });

        job.checkoutSessionId = session.id;
        job.updatedAt = Date.now();
        await saveConversionJob(job);

        logEvent("info", "checkout.session.created.with.skip", { jobId, sessionId: session.id, excludedCount: excludedKeys.size, validFileCount: effectiveImageCount });

        return res.json({
          required: true,
          amount,
          checkoutUrl: session.url,
          sessionId: session.id,
          jobId,
          validFileCount: effectiveImageCount,
        });
      }

      if (Number(job.imageCount) !== imageCount) {
        return res.status(400).json({ error: "imageCount does not match the conversion job." });
      }

      if (shouldDeferDeepValidation(job)) {
        job.validationStatus = "passed";
        job.validationDeferred = true;
        job.invalidFiles = [];
        job.invalidFileKeys = [];
        job.lastError = null;
        job.updatedAt = Date.now();
        await saveConversionJob(job);
        logEvent("info", "validation.deferred.large_batch", {
          jobId,
          fileCount: Array.isArray(job.fileManifest) ? job.fileManifest.length : 0,
          threshold: validationDeferFileCount,
        });
      } else {
        const validation = await validateUploadedFilesForJob(job);
        if (!validation.ok) {
          const manifest = Array.isArray(job.fileManifest) ? job.fileManifest : [];
          const validFileCount = manifest.length - validation.invalidFiles.length;

          job.validationStatus = "failed";
          job.validationDeferred = false;
          job.invalidFiles = validation.invalidFiles;
          job.invalidFileKeys = validation.invalidFileKeys;
          job.lastError = buildInvalidFileMessage(validation.invalidFiles);
          job.updatedAt = Date.now();
          await saveConversionJob(job);

          return res.status(400).json({
            error: job.lastError,
            invalidFiles: validation.invalidFiles,
            validFileCount,
          });
        }

        job.validationStatus = "passed";
        job.validationDeferred = false;
        job.invalidFiles = [];
        job.invalidFileKeys = [];
        job.lastError = null;
        job.updatedAt = Date.now();
        await saveConversionJob(job);
      }

      outputFormat = normalizeOutputFormat(job.outputFormat);
      unlimitedRequested = parseBoolean(job.unlimitedRequested);

      if (job.checkoutSessionId && stripeClient) {
        try {
          const existingSession = await stripeClient.checkout.sessions.retrieve(String(job.checkoutSessionId));
          if (existingSession.payment_status === "paid") {
            await markPaymentSessionPaid({ session: existingSession, eventId: `checkout-reuse-${Date.now()}` });
            return res.json({
              required: false,
              amount: Number(existingSession.amount_total || 0),
              sessionId: existingSession.id,
              jobId,
              recovered: true,
            });
          }

          if (existingSession.status === "open" && existingSession.url) {
            logEvent("info", "checkout.session.reused", { jobId, sessionId: existingSession.id });
            return res.json({
              required: true,
              amount: Number(existingSession.amount_total || 0),
              checkoutUrl: existingSession.url,
              sessionId: existingSession.id,
              jobId,
              reused: true,
            });
          }
        } catch (_error) {
          // Continue by creating a new checkout session when retrieval fails.
        }
      }
    }

    const outputFormatInfo = getOutputFormatInfo(outputFormat);

    const unlimitedPass = await getUnlimitedPassStatus(req);
    const amount = getRequestedAmountCents({
      imageCount,
      unlimitedRequested,
      unlimitedPassActive: unlimitedPass.active,
    });
    if (amount === 0) {
      return res.json({
        required: false,
        amount,
        unlimitedRequested,
        unlimitedPassActive: unlimitedPass.active,
        unlimitedPassExpiresAt: unlimitedPass.expiresAt,
      });
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
              name: unlimitedRequested
                ? "24-hour Unlimited Conversion Pass"
                : `Image conversion (${imageCount} files to ${outputFormatInfo.displayName})`,
              description: unlimitedRequested
                ? "Unlimited image conversions for 24 hours"
                : `Convert uploaded images to ${outputFormatInfo.displayName} and download as ZIP`,
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
        outputFormat,
        unlimitedRequested: String(unlimitedRequested),
      },
    }, {
      idempotencyKey: `checkout:${jobId || "no-job"}:${imageCount}:${amount}:${outputFormat}`,
    });

    await createPendingPaymentSession({
      sessionId: session.id,
      imageCount,
      amountTotal: amount,
      jobId,
    });

    if (jobId) {
      const job = await getConversionJob(jobId);
      if (job) {
        job.checkoutSessionId = session.id;
        job.updatedAt = Date.now();
        await saveConversionJob(job);
      }
    }

    logEvent("info", "checkout.session.created", {
      jobId: jobId || null,
      sessionId: session.id,
      amount,
      imageCount,
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

    const currentRecord = await getRememberedPaidSession(sessionId);
    const expectedAmount = Number(currentRecord?.amountTotal || 0);
    let paid = await verifyPaidSession({ sessionId, imageCount, paymentAmount: expectedAmount });

    if (!paid && recover) {
      paid = await recoverPaidSessionFromStripe({ sessionId, imageCount, paymentAmount: expectedAmount });
    }

    const tracked = paid ? await getRememberedPaidSession(sessionId) : null;
    let unlimitedPass = await getUnlimitedPassStatus(req);

    if (
      paid &&
      !unlimitedPass.active &&
      Number(tracked?.amountTotal || 0) >= highestTierPriceCents
    ) {
      await activateUnlimitedPass(req, sessionId);
      unlimitedPass = await getUnlimitedPassStatus(req);
    }

    return res.json({
      paid,
      amountTotal: Number(tracked?.amountTotal || 0),
      unlimitedPassActive: unlimitedPass.active,
      unlimitedPassExpiresAt: unlimitedPass.expiresAt ? new Date(unlimitedPass.expiresAt).toISOString() : null,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to verify payment." });
  }
});

app.post("/api/start-conversion-job", async (req, res) => {
  try {
    requireS3();

    const jobId = String(req.body?.jobId || "");
    const paymentSessionId = String(req.body?.paymentSessionId || "");
    const skipInvalidFiles = parseBoolean(req.body?.skipInvalidFiles);
    const requestId = getStartRequestId(req.body?.requestId, jobId);

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required." });
    }

    const job = await getConversionJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    if (job.lastStartRequestId && job.lastStartRequestId === requestId) {
      return res.status(202).json({
        jobId,
        status: job.status || "queued",
      });
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
        outputFormat: normalizeOutputFormat(job.outputFormat),
        skipSummary: job.skipSummary || null,
        skippedFiles: Array.isArray(job.skippedFiles) ? job.skippedFiles : [],
      });
    }

    if (job.status === "processing") {
      return res.status(202).json({
        jobId,
        status: "processing",
      });
    }

    if (job.status === "failed") {
      job.status = "queued";
      job.processedCount = 0;
      job.lastError = null;
      delete job.autoRefunded;
      delete job.autoRefundId;
      delete job.autoRefundError;
      delete job.autoRefundedAt;
      job.updatedAt = Date.now();
      await saveConversionJob(job);
    }

    if (job.status === "canceled" || job.cancelRequested) {
      return res.status(409).json({
        jobId,
        status: "canceled",
        error: "Job was canceled.",
      });
    }

    if (job.validationStatus !== "passed") {
      if (shouldDeferDeepValidation(job)) {
        job.validationStatus = "passed";
        job.validationDeferred = true;
        job.invalidFiles = [];
        job.invalidFileKeys = [];
        job.lastError = null;
        job.updatedAt = Date.now();
        logEvent("info", "validation.deferred.large_batch", {
          jobId,
          fileCount: Array.isArray(job.fileManifest) ? job.fileManifest.length : 0,
          threshold: validationDeferFileCount,
        });
      } else {
        const validation = await validateUploadedFilesForJob(job);
        if (!validation.ok) {
          const manifest = Array.isArray(job.fileManifest) ? job.fileManifest : [];
          const validFileCount = manifest.length - validation.invalidFiles.length;

          if (skipInvalidFiles) {
            if (validFileCount < 1) {
              return res.status(400).json({
                jobId,
                status: "validation_failed",
                error: "No valid files remain after excluding unsupported ones.",
                invalidFiles: validation.invalidFiles,
                validFileCount,
              });
            }

            job.excludedFileKeys = Array.isArray(validation.invalidFileKeys)
              ? validation.invalidFileKeys.slice()
              : [];
            job.imageCount = validFileCount;
            job.validationStatus = "passed";
            job.validationDeferred = false;
            job.invalidFiles = [];
            job.invalidFileKeys = [];
            job.lastError = null;
            job.updatedAt = Date.now();
            await saveConversionJob(job);
          } else {
            job.validationStatus = "failed";
            job.validationDeferred = false;
            job.invalidFiles = validation.invalidFiles;
            job.invalidFileKeys = validation.invalidFileKeys;
            job.lastError = buildInvalidFileMessage(validation.invalidFiles);
            job.updatedAt = Date.now();
            await saveConversionJob(job);

            return res.status(400).json({
              jobId,
              status: "validation_failed",
              error: job.lastError,
              invalidFiles: validation.invalidFiles,
              validFileCount,
            });
          }
        }

        job.validationStatus = "passed";
        job.validationDeferred = false;
        job.invalidFiles = [];
        job.invalidFileKeys = [];
        job.lastError = null;
        job.updatedAt = Date.now();
      }
    }

    if (job.paymentRequired) {
      if (!paymentSessionId) {
        return res.status(402).json({ error: "Payment session required for this job." });
      }

      const paid = await verifyPaidSession({
        sessionId: paymentSessionId,
        imageCount: Number(job.imageCount || 0),
        paymentAmount: Number(job.requiredAmountCents || 0),
      });

      if (!paid) {
        return res.status(402).json({ error: "Payment not verified yet." });
      }

      const tracked = await getRememberedPaidSession(paymentSessionId);
      if (Number(tracked?.amountTotal || 0) >= highestTierPriceCents) {
        await activateUnlimitedPass(req, paymentSessionId);
      }

      job.paymentSessionId = paymentSessionId;
      job.paymentStatus = "paid";
    } else if (!job.freeQuotaReserved && !job.unlimitedPassApplied) {
      const reservation = await reserveFreeUsageForToday(req, Number(job.imageCount || 0));
      if (!reservation.allowed) {
        const remainingToday = Math.max(0, freeDailyImageLimit - Number(reservation.used || 0));
        return res.status(429).json({
          error: `Free limit reached. You can convert up to ${freeDailyImageLimit} free images per 24-hour window. Remaining in your current window: ${remainingToday}.`,
          freeDailyImageLimit,
          freeRemainingToday: remainingToday,
        });
      }

      job.freeQuotaReserved = true;
    }
    job.lastStartRequestId = requestId;
    await saveConversionJob(job);
    logEvent("info", "conversion.job.queued", {
      jobId,
      paymentRequired: Boolean(job.paymentRequired),
      requestId,
    });
    processConversionJob(jobId);

    return res.json({
      jobId,
      status: "queued",
      outputFormat: normalizeOutputFormat(job.outputFormat),
    });
  } catch (error) {
    logEvent("error", "conversion.job.start_failed", {
      error: String(error?.message || "Unable to start conversion job"),
    });
    return res.status(500).json({
      error: error.message || "Conversion job failed.",
    });
  }
});

app.post("/api/cancel-conversion-job", async (req, res) => {
  try {
    const jobId = String(req.body?.jobId || "");
    const paymentSessionId = String(req.body?.paymentSessionId || "");
    const requestRefund = parseBoolean(req.body?.requestRefund);
    const reason = String(req.body?.reason || "User requested cancellation").slice(0, 300);

    if (!jobId) {
      return res.status(400).json({ error: "jobId is required." });
    }

    const job = await getConversionJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const zipProduced = job.status === "completed" && Boolean(job.resultZipKey);
    if (zipProduced) {
      return res.status(409).json({
        jobId,
        status: "completed",
        refunded: false,
        error: "ZIP already produced. Refunds are not available after successful delivery.",
      });
    }

    job.cancelRequested = true;
    job.canceledAt = Date.now();
    job.cancellationReason = reason;

    if (job.status === "awaiting_upload" || job.status === "queued") {
      job.status = "canceled";
    }

    canceledJobs.add(jobId);
    job.updatedAt = Date.now();
    await saveConversionJob(job);

    let refundResult = { refunded: false, refundId: null, alreadyRefunded: false };

    if (requestRefund && job.paymentRequired) {
      const sessionId = paymentSessionId || String(job.paymentSessionId || "");
      if (!sessionId) {
        return res.status(400).json({
          jobId,
          status: job.status,
          refunded: false,
          error: "paymentSessionId is required to request a refund for this paid job.",
        });
      }

      refundResult = await createRefundForSession({
        sessionId,
        jobId,
      });
    }

    return res.json({
      jobId,
      status: job.status,
      canceled: true,
      refunded: refundResult.refunded,
      refundId: refundResult.refundId,
      alreadyRefunded: refundResult.alreadyRefunded,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to cancel conversion job." });
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
        outputFormat: normalizeOutputFormat(job.outputFormat),
        skipSummary: job.skipSummary || null,
        skippedFiles: Array.isArray(job.skippedFiles) ? job.skippedFiles : [],
      });
    }

    return res.json({
      jobId,
      status: job.status || "queued",
      outputFormat: normalizeOutputFormat(job.outputFormat),
      paymentStatus: job.paymentStatus || "pending",
      progress: buildJobProgress(job),
      error: job.lastError || null,
      invalidFiles: Array.isArray(job.invalidFiles) ? job.invalidFiles : [],
      skipSummary: job.skipSummary || null,
      skippedFiles: Array.isArray(job.skippedFiles) ? job.skippedFiles : [],
      autoRefunded: Boolean(job.autoRefunded),
      autoRefundId: job.autoRefundId || null,
      autoRefundError: job.autoRefundError || null,
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
        paymentAmount: Number(job.requiredAmountCents || 0),
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
      outputFormat: normalizeOutputFormat(job.outputFormat),
      expiresInSeconds: downloadUrlTtlSeconds,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to issue download URL." });
  }
});

app.post("/api/convert", upload.array("images", maxFiles), async (req, res) => {
  const uploadedFiles = req.files || [];
  const imageCount = uploadedFiles.length;
  const totalBatchBytes = uploadedFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
  const outputFormat = normalizeOutputFormat(req.body?.outputFormat);
  const outputFormatInfo = getOutputFormatInfo(outputFormat);

  if (imageCount < 1) {
    return res.status(400).json({ error: "Please upload at least one image." });
  }

  if (totalBatchBytes > maxBatchSizeBytes) {
    await removeFiles(uploadedFiles.map((f) => f.path));
    return res.status(400).json({
      error: `Total batch size exceeds ${maxBatchSizeMb}MB. Please upload a smaller batch.`,
      maxBatchSizeMb,
    });
  }

  const amount = getPriceCents(imageCount);
  const sessionId = String(req.body?.sessionId || "");

  try {
    const unlimitedPass = await getUnlimitedPassStatus(req);

    if (amount > 0) {
      if (unlimitedPass.active) {
        // Highest-tier pass covers paid conversions during the active window.
      } else {
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
    } else {
      const reservation = await reserveFreeUsageForToday(req, imageCount);
      if (!reservation.allowed) {
        await removeFiles(uploadedFiles.map((f) => f.path));
        const remainingToday = Math.max(0, freeDailyImageLimit - Number(reservation.used || 0));
        return res.status(429).json({
          error: `Free limit reached. You can convert up to ${freeDailyImageLimit} free images per 24-hour window. Remaining in your current window: ${remainingToday}.`,
          freeDailyImageLimit,
          freeRemainingToday: remainingToday,
        });
      }
    }

    const jobId = randomUUID();
    const convertedFiles = await convertFilesToFormat(uploadedFiles, jobId, outputFormat);
    const zipPath = path.join(outputDir, `${jobId}.zip`);

    await createZipFromFiles(convertedFiles, zipPath);

    res.download(zipPath, `converted-images-${outputFormatInfo.extension}-${jobId}.zip`, async (err) => {
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
