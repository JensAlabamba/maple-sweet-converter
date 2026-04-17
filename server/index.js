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

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 5000);
const clientUrl = process.env.CLIENT_URL || "http://localhost:5500";

app.use(cors({ origin: clientUrl }));
app.use(express.json());

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

  const session = await stripeClient.checkout.sessions.retrieve(sessionId);
  return (
    session.payment_status === "paid" &&
    session.amount_total === amount &&
    Number(session.metadata?.imageCount || 0) === imageCount
  );
}

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
    if (!Number.isInteger(imageCount) || imageCount < 1) {
      return res.status(400).json({ error: "Invalid image count." });
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
      success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&count=${imageCount}`,
      cancel_url: `${clientUrl}/cancel.html?count=${imageCount}`,
      metadata: {
        imageCount: String(imageCount),
      },
    });

    return res.json({
      required: true,
      amount,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Failed to create checkout session." });
  }
});

app.post("/api/verify-session", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "");
    const imageCount = Number(req.body?.imageCount || 0);

    if (!sessionId || !Number.isInteger(imageCount) || imageCount < 1) {
      return res.status(400).json({ error: "sessionId and imageCount are required." });
    }

    const paid = await verifyPaidSession({ sessionId, imageCount });
    return res.json({ paid });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unable to verify payment." });
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
