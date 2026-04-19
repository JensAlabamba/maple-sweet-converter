const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const multer = require("multer");
const sharp = require("sharp");
const archiver = require("archiver");
const path = require("path");
const fs = require("fs");
const fsPromises = require("fs/promises");
const { randomUUID, createHash } = require("crypto");
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } = require("@aws-sdk/lib-dynamodb");
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");
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
      return image.jpeg({ quality: 90 });
    },
  },
  jpeg: {
    extension: "jpeg",
    displayName: "JPEG",
    contentType: "image/jpeg",
    apply(image) {
      return image.jpeg({ quality: 90 });
    },
  },
  png: {
    extension: "png",
    displayName: "PNG",
    contentType: "image/png",
    apply(image) {
      return image.png({ compressionLevel: 9 });
    },
  },
  webp: {
    extension: "webp",
    displayName: "WEBP",
    contentType: "image/webp",
    apply(image) {
      return image.webp({ quality: 90 });
    },
  },
};

const stripeClient = process.env.STRIPE_SECRET_KEY
  ? require("stripe")(process.env.STRIPE_SECRET_KEY)
  : null;

const paidCheckoutSessions = new Map();
const conversionJobs = new Map();
const activeProcessingJobs = new Set();
const freeUsageCounters = new Map();
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

function normalizeOutputFormat(value) {
  const format = String(value || "jpg").trim().toLowerCase();
  return outputFormats[format] ? format : "jpg";
}

function getOutputFormatInfo(value) {
  return outputFormats[normalizeOutputFormat(value)];
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

async function convertBufferToFormat(buffer, outputFormat) {
  try {
    const formatInfo = getOutputFormatInfo(outputFormat);
    const image = sharp(buffer).rotate();
    return await formatInfo.apply(image).toBuffer();
  } catch (error) {
    if (isUnsupportedHeifCompressionError(error)) {
      throw buildHeifCompressionError("One of your uploaded files");
    }

    throw error;
  }
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

    const formatInfo = getOutputFormatInfo(job.outputFormat);
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
          const convertedBuffer = await convertBufferToFormat(originalBuffer, job.outputFormat);
          const originalBaseName = path.parse(file.originalName).name || "image";
          archive.append(convertedBuffer, {
            name: `${normalizeFileName(originalBaseName)}.${formatInfo.extension}`,
          });
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
    const outputFormat = normalizeOutputFormat(req.body?.outputFormat);
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

    if (amount === 0) {
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
      outputFormat,
      paymentRequired: amount > 0,
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

    return res.json({
      jobId,
      imageCount: files.length,
      outputFormat,
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

app.get("/api/free-usage-status", async (req, res) => {
  try {
    const state = await getFreeUsageState(req);
    const usedToday = Number(state.used || 0);
    const remainingToday = Math.max(0, freeDailyImageLimit - usedToday);
    const resetAt = Number(state.windowEndsAt || 0) > 0 ? new Date(state.windowEndsAt).toISOString() : null;

    return res.json({
      limit: freeDailyImageLimit,
      usedToday,
      remainingToday,
      resetAt,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to read free usage status." });
  }
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
    let outputFormat = normalizeOutputFormat(req.body?.outputFormat);
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
      outputFormat = normalizeOutputFormat(job.outputFormat);
    }

    const outputFormatInfo = getOutputFormatInfo(outputFormat);

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
              name: `Image conversion (${imageCount} files to ${outputFormatInfo.displayName})`,
              description: `Convert uploaded images to ${outputFormatInfo.displayName} and download as ZIP`,
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
        outputFormat: normalizeOutputFormat(job.outputFormat),
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
    } else if (!job.freeQuotaReserved) {
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
    await saveConversionJob(job);
    processConversionJob(jobId);

    return res.json({
      jobId,
      status: "queued",
      outputFormat: normalizeOutputFormat(job.outputFormat),
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
        outputFormat: normalizeOutputFormat(job.outputFormat),
      });
    }

    return res.json({
      jobId,
      status: job.status || "queued",
      outputFormat: normalizeOutputFormat(job.outputFormat),
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
  const outputFormat = normalizeOutputFormat(req.body?.outputFormat);
  const outputFormatInfo = getOutputFormatInfo(outputFormat);

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
