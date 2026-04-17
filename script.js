const apiBase = document.body.dataset.apiBase || "http://localhost:5000";

const jumpToUploaderBtn = document.getElementById("jumpToUploader");
const chooseFilesBtn = document.getElementById("chooseFilesBtn");
const fileInput = document.getElementById("fileInput");
const uploader = document.getElementById("uploader");
const convertBtn = document.getElementById("convertBtn");
const countLabel = document.getElementById("countLabel");
const priceLabel = document.getElementById("priceLabel");
const duplicateInfo = document.getElementById("duplicateInfo");
const previewGrid = document.getElementById("previewGrid");
const statusMessage = document.getElementById("statusMessage");
const paidBadge = document.getElementById("paidBadge");

let selectedFiles = [];
let paidSession = null;
let skippedDuplicateCount = 0;
let previewObjectUrls = [];

function getPriceCents(imageCount) {
  if (imageCount <= 10) return 0;
  if (imageCount <= 300) return 100;
  return 300;
}

function formatPriceLabel(cents) {
  if (cents === 0) return "Free for this batch";
  return `$${(cents / 100).toFixed(0)} for this batch`;
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b0210f" : "#8d4d2f";
}

function readPaidSession() {
  try {
    const raw = localStorage.getItem("paidSession");
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    if (!parsed.sessionId || !parsed.count || !parsed.createdAt) {
      return null;
    }

    const maxAgeMs = 12 * 60 * 60 * 1000;
    if (Date.now() - parsed.createdAt > maxAgeMs) {
      localStorage.removeItem("paidSession");
      return null;
    }

    return parsed;
  } catch (_error) {
    localStorage.removeItem("paidSession");
    return null;
  }
}

function updatePaidBadge() {
  if (!paidSession) {
    paidBadge.classList.add("hidden");
    paidBadge.textContent = "";
    return;
  }

  if (paidSession.jobId) {
    paidBadge.textContent = `Payment verified. Job ${paidSession.jobId.slice(0, 8)} is ready to finalize.`;
  } else {
    paidBadge.textContent = `Payment verified for ${paidSession.count} images.`;
  }
  paidBadge.classList.remove("hidden");
}

function updateSelectionUI() {
  const count = selectedFiles.length;
  const cents = getPriceCents(count);

  countLabel.textContent = String(count);
  priceLabel.textContent = formatPriceLabel(cents);

  if (skippedDuplicateCount > 0) {
    duplicateInfo.textContent = `${skippedDuplicateCount} duplicate file(s) skipped.`;
    duplicateInfo.classList.remove("hidden");
  } else {
    duplicateInfo.textContent = "";
    duplicateInfo.classList.add("hidden");
  }

  if (count === 0) {
    if (paidSession?.jobId) {
      convertBtn.textContent = "Finalize Paid Job";
      setStatus("Paid job is ready. Click to generate your ZIP.");
      return;
    }

    convertBtn.textContent = "Convert & Download ZIP";
    setStatus("Select images to begin.");
    return;
  }

  convertBtn.textContent = cents === 0 ? "Convert & Download ZIP" : "Continue to Payment";
  setStatus("Ready to process your batch.");
}

function setSelectedFiles(fileList) {
  const files = Array.from(fileList || []);
  const unique = [];
  const seen = new Set();
  let duplicates = 0;

  for (const file of files) {
    const key = `${file.name.toLowerCase()}::${file.size}::${file.lastModified}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
    unique.push(file);
  }

  selectedFiles = unique;
  skippedDuplicateCount = duplicates;
  renderPreviews();
  updateSelectionUI();
}

function clearPreviewObjectUrls() {
  for (const objectUrl of previewObjectUrls) {
    URL.revokeObjectURL(objectUrl);
  }
  previewObjectUrls = [];
}

function renderPreviews() {
  clearPreviewObjectUrls();
  previewGrid.innerHTML = "";

  if (selectedFiles.length === 0) {
    previewGrid.classList.add("hidden");
    return;
  }

  const maxPreviewCount = 12;
  const filesToShow = selectedFiles.slice(0, maxPreviewCount);

  for (const file of filesToShow) {
    const previewItem = document.createElement("div");
    previewItem.className = "preview-item";

    const image = document.createElement("img");
    image.alt = file.name;

    if (file.type.startsWith("image/")) {
      const objectUrl = URL.createObjectURL(file);
      previewObjectUrls.push(objectUrl);
      image.src = objectUrl;
    }

    const caption = document.createElement("p");
    caption.title = file.name;
    caption.textContent = file.name;

    previewItem.appendChild(image);
    previewItem.appendChild(caption);
    previewGrid.appendChild(previewItem);
  }

  if (selectedFiles.length > maxPreviewCount) {
    const moreItem = document.createElement("div");
    moreItem.className = "preview-item";
    moreItem.innerHTML = `<p style="padding: 0.8rem; white-space: normal;">+${selectedFiles.length - maxPreviewCount} more</p>`;
    previewGrid.appendChild(moreItem);
  }

  previewGrid.classList.remove("hidden");
}

async function startCheckout(imageCount) {
  const jobId = localStorage.getItem("pendingJobId") || "";

  const response = await fetch(`${apiBase}/api/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageCount, jobId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to create checkout session.");
  }

  if (!data.checkoutUrl) {
    throw new Error("Checkout URL missing from server response.");
  }

  window.location.href = data.checkoutUrl;
}

async function createUploadSession(files) {
  const metadata = files.map((file) => ({
    name: file.name,
    type: file.type,
    size: file.size,
  }));

  const response = await fetch(`${apiBase}/api/create-upload-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: metadata }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to create upload session.");
  }

  return data;
}

async function uploadFilesToS3(uploadTargets, files) {
  if (!Array.isArray(uploadTargets) || uploadTargets.length !== files.length) {
    throw new Error("Upload target mismatch.");
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const target = uploadTargets[i];

    const response = await fetch(target.url, {
      method: "PUT",
      headers: {
        "Content-Type": target.contentType || file.type || "application/octet-stream",
      },
      body: file,
    });

    if (!response.ok) {
      throw new Error(`Failed uploading ${file.name}.`);
    }
  }
}

async function startConversionJob(jobId, paymentSessionId = "") {
  const response = await fetch(`${apiBase}/api/start-conversion-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, paymentSessionId }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to start conversion job.");
  }

  return data;
}

async function getConversionJobStatus(jobId) {
  const response = await fetch(`${apiBase}/api/conversion-job/${encodeURIComponent(jobId)}`);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Unable to fetch conversion status.");
  }

  return data;
}

async function waitForJobAndDownload(jobId) {
  const pollDelayMs = 1800;
  const maxAttempts = 200;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const status = await getConversionJobStatus(jobId);

    if (status.status === "completed" && status.downloadUrl) {
      return status.downloadUrl;
    }

    if (status.status === "failed") {
      throw new Error(status.error || "Conversion failed.");
    }

    if (status.status === "expired") {
      throw new Error("Job expired. Please upload again.");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollDelayMs);
    });
  }

  throw new Error("Conversion is taking too long. Please try again.");
}

async function finalizePaidJob() {
  if (!paidSession?.jobId || !paidSession?.sessionId) {
    return;
  }

  setStatus("Finalizing your paid job...");
  convertBtn.disabled = true;

  const startResult = await startConversionJob(paidSession.jobId, paidSession.sessionId);

  if (startResult.status === "completed" && startResult.downloadUrl) {
    window.location.href = startResult.downloadUrl;
  } else {
    setStatus("Processing your images...");
    const downloadUrl = await waitForJobAndDownload(paidSession.jobId);
    window.location.href = downloadUrl;
  }

  localStorage.removeItem("paidSession");
  localStorage.removeItem("pendingJobId");
  paidSession = null;
  updatePaidBadge();
  updateSelectionUI();
  setStatus("Download ready.");
}

async function convertNow(files, sessionId = "") {
  const payload = new FormData();
  files.forEach((file) => payload.append("images", file));

  if (sessionId) {
    payload.append("sessionId", sessionId);
  }

  const response = await fetch(`${apiBase}/api/convert`, {
    method: "POST",
    body: payload,
  });

  if (!response.ok) {
    let message = "Conversion failed.";
    try {
      const errorData = await response.json();
      message = errorData.error || message;
    } catch (_error) {
      // Keep default message if server did not send JSON.
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `converted-images-${Date.now()}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function handleConvertClick() {
  try {
    const count = selectedFiles.length;

    if (count === 0 && !paidSession?.jobId) {
      setStatus("Please choose at least one image.", true);
      return;
    }

    if (count === 0 && paidSession?.jobId) {
      await finalizePaidJob();
      return;
    }

    const cents = getPriceCents(count);

    setStatus("Requesting secure upload links...");
    convertBtn.disabled = true;
    const uploadSession = await createUploadSession(selectedFiles);
    localStorage.setItem("pendingJobId", uploadSession.jobId);

    setStatus("Uploading files to secure storage...");
    await uploadFilesToS3(uploadSession.uploadTargets, selectedFiles);

    if (uploadSession.amount > 0 && !paidSession) {
      setStatus("Upload complete. Redirecting to secure Stripe checkout...");
      await startCheckout(count);
      return;
    }

    if (uploadSession.amount > 0 && paidSession) {
      if (count !== Number(paidSession.count)) {
        setStatus(`This payment covers ${paidSession.count} images. Please match that count.`, true);
        return;
      }

      setStatus("Converting uploaded files...");
      const startResult = await startConversionJob(uploadSession.jobId, paidSession.sessionId);

      if (startResult.status === "completed" && startResult.downloadUrl) {
        window.location.href = startResult.downloadUrl;
      } else {
        setStatus("Processing your images...");
        const downloadUrl = await waitForJobAndDownload(uploadSession.jobId);
        window.location.href = downloadUrl;
      }

      localStorage.removeItem("paidSession");
      localStorage.removeItem("pendingJobId");
      paidSession = null;
      updatePaidBadge();
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }

    if (uploadSession.amount === 0 || cents === 0) {
      setStatus("Converting uploaded files...");
      const startResult = await startConversionJob(uploadSession.jobId);

      if (startResult.status === "completed" && startResult.downloadUrl) {
        window.location.href = startResult.downloadUrl;
      } else {
        setStatus("Processing your images...");
        const downloadUrl = await waitForJobAndDownload(uploadSession.jobId);
        window.location.href = downloadUrl;
      }

      localStorage.removeItem("pendingJobId");
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }
  } catch (error) {
    setStatus(error.message || "Something went wrong.", true);
  } finally {
    convertBtn.disabled = false;
  }
}

jumpToUploaderBtn.addEventListener("click", () => {
  uploader.scrollIntoView({ behavior: "smooth", block: "center" });
});

chooseFilesBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", (event) => {
  setSelectedFiles(event.target.files);
});

uploader.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploader.style.borderColor = "#ef5b1f";
});

uploader.addEventListener("dragleave", () => {
  uploader.style.borderColor = "#e4b690";
});

uploader.addEventListener("drop", (event) => {
  event.preventDefault();
  uploader.style.borderColor = "#e4b690";
  if (event.dataTransfer?.files?.length) {
    setSelectedFiles(event.dataTransfer.files);
  }
});

convertBtn.addEventListener("click", handleConvertClick);

paidSession = readPaidSession();
updatePaidBadge();
updateSelectionUI();

if (paidSession?.jobId) {
  finalizePaidJob().catch((error) => {
    setStatus(error.message || "Unable to finalize paid job.", true);
    convertBtn.disabled = false;
  });
}

window.addEventListener("beforeunload", () => {
  clearPreviewObjectUrls();
});
