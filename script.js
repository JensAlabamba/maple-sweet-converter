const apiBase = document.body.dataset.apiBase || "https://yq3cx7vs7h.us-east-2.awsapprunner.com";

const jumpToUploaderBtn = document.getElementById("jumpToUploader");
const chooseFilesBtn = document.getElementById("chooseFilesBtn");
const fileInput = document.getElementById("fileInput");
const folderInput = document.getElementById("folderInput");
const uploader = document.getElementById("uploader");
const convertBtn = document.getElementById("convertBtn");
const countLabel = document.getElementById("countLabel");
const priceLabel = document.getElementById("priceLabel");
const adjustedBatchNote = document.getElementById("adjustedBatchNote");
const selectionSummary = document.getElementById("selectionSummary");
const preflightSummary = document.getElementById("preflightSummary");
const duplicateInfo = document.getElementById("duplicateInfo");
const largeFileInfo = document.getElementById("largeFileInfo");
const invalidFilesPanel = document.getElementById("invalidFilesPanel");
const invalidFilesTitle = document.getElementById("invalidFilesTitle");
const invalidFilesList = document.getElementById("invalidFilesList");
const dedupeToggle = document.getElementById("dedupeToggle");
const unlimitedToggle = document.getElementById("unlimitedToggle");
const freeQuotaInfo = document.getElementById("freeQuotaInfo");
const previewGrid = document.getElementById("previewGrid");
const statusMessage = document.getElementById("statusMessage");
const paidBadge = document.getElementById("paidBadge");
const loader = document.getElementById("loader");
const zipLoaderTitle = document.getElementById("zipLoaderTitle");
const zipLoaderSub = document.getElementById("zipLoaderSub");
const loaderTimeline = document.getElementById("loaderTimeline");
const cancelJobBtn = document.getElementById("cancelJobBtn");
const refundModal = document.getElementById("refundModal");
const refundCloseBtn = document.getElementById("refundCloseBtn");
const refundAmountElement = document.getElementById("refundAmount");
const refundIdElement = document.getElementById("refundId");
const refundStatusElement = document.getElementById("refundStatus");
const outputFormatInputs = Array.from(document.querySelectorAll('input[name="outputFormat"]'));

let selectedFiles = [];
let selectedInputFiles = [];
let paidSession = null;
let skippedDuplicateCount = 0;
let detectedDuplicateCount = 0;
let supportedImageCount = 0;
let ignoredUnsupportedCount = 0;
let largeFileCount = 0;
let largestFileBytes = 0;
let selectedTotalBytes = 0;
let previewObjectUrls = [];
let loaderStepTimer = null;
let loaderSubtextPinned = false;
let activeJobContext = null;
const duplicatePreferenceKey = "removeDuplicatesEnabled";
const unlimitedPreferenceKey = "useUnlimitedPassEnabled";
const flowStateKey = "activeFlowState";
const droppedFilePathMap = new WeakMap();
const largeFileWarningBytes = 8 * 1024 * 1024;
const maxBatchSizeMb = 512;
const maxBatchSizeBytes = maxBatchSizeMb * 1024 * 1024;
const outputFormatLabels = {
  jpg: "JPG",
  jpeg: "JPEG",
  png: "PNG",
  webp: "WEBP",
};

function isAcceptedImageFile(file) {
  const fileName = String(file?.name || "").toLowerCase();
  return /\.(heic|heif|png|webp|jpe?g)$/i.test(fileName);
}

function getFileRelativePath(file) {
  const droppedPath = droppedFilePathMap.get(file);
  return String(droppedPath || file?.webkitRelativePath || file?.name || "");
}

function readFileEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryChunk(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function collectFilesFromEntry(entry, pathPrefix = "") {
  if (!entry) {
    return [];
  }

  if (entry.isFile) {
    const file = await readFileEntry(entry);
    const relativePath = `${pathPrefix}${entry.name}`;
    droppedFilePathMap.set(file, relativePath);
    return [file];
  }

  if (entry.isDirectory) {
    const nextPrefix = `${pathPrefix}${entry.name}/`;
    const reader = entry.createReader();
    const files = [];

    while (true) {
      const entries = await readDirectoryChunk(reader);
      if (!entries.length) {
        break;
      }

      for (const nestedEntry of entries) {
        const nestedFiles = await collectFilesFromEntry(nestedEntry, nextPrefix);
        files.push(...nestedFiles);
      }
    }

    return files;
  }

  return [];
}

async function collectDroppedFiles(dataTransfer) {
  const directFiles = Array.from(dataTransfer?.files || []);
  const items = Array.from(dataTransfer?.items || []);
  if (!items.length) {
    return directFiles;
  }

  const files = [];
  let usedEntries = false;

  for (const item of items) {
    if (item.kind !== "file") {
      continue;
    }

    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null;
    if (entry) {
      usedEntries = true;
      const entryFiles = await collectFilesFromEntry(entry);
      files.push(...entryFiles);
      continue;
    }

    const directFile = item.getAsFile();
    if (directFile) {
      files.push(directFile);
    }
  }

  // Merge entry-based files with direct file list so multi-file drops are
  // preserved even when one browser path reports partial results.
  const merged = [...files, ...directFiles];
  if (merged.length === 0) {
    return [];
  }

  const unique = [];
  const seen = new Set();
  for (const file of merged) {
    const key = `${String(file?.name || "")}::${Number(file?.size || 0)}::${Number(file?.lastModified || 0)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(file);
  }

  return unique;
}

function openFilePicker(input) {
  if (!input) return;

  try {
    if (typeof input.showPicker === "function") {
      input.showPicker();
      return;
    }
  } catch (_error) {
    // Fall through to click() fallback.
  }

  input.click();
}

const loaderSteps = [
  "Uploading files...",
  "Converting images...",
  "Packing your ZIP...",
  "Almost ready...",
];

function getPriceCents(imageCount) {
  if (imageCount <= 10) return 0;
  if (imageCount <= 300) return 199;
  return 699;
}

function formatPriceLabel(cents) {
  if (cents === 0) return "Free for this batch";
  return `$${(cents / 100).toFixed(2)} for this batch`;
}

function formatSizeMb(bytes) {
  const mb = Number(bytes || 0) / (1024 * 1024);
  return `${mb.toFixed(1)}MB`;
}

function formatDurationSeconds(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0));
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function formatResetTime(isoDate) {
  if (!isoDate) {
    return "after your first free conversion";
  }

  const parsed = new Date(isoDate);
  if (Number.isNaN(parsed.getTime())) {
    return "soon";
  }

  return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function updateFreeQuotaInfo(status) {
  if (!freeQuotaInfo) return;

  if (!status || typeof status.remainingToday !== "number" || typeof status.limit !== "number") {
    freeQuotaInfo.textContent = "Free remaining in your 24-hour window: unavailable right now.";
    freeQuotaInfo.style.color = "#8d4d2f";
    return;
  }

  const resetLabel = formatResetTime(status.resetAt);
  freeQuotaInfo.textContent = `Free remaining in your 24-hour window: ${status.remainingToday}/${status.limit} (resets ${resetLabel})`;
  freeQuotaInfo.style.color = status.remainingToday > 0 ? "#8d4d2f" : "#b0210f";
}

async function refreshFreeQuotaInfo() {
  if (!freeQuotaInfo) return;

  try {
    const response = await fetch(`${apiBase}/api/free-usage-status`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to load free usage status.");
    }

    updateFreeQuotaInfo(data);
  } catch (_error) {
    updateFreeQuotaInfo(null);
  }
}

function setStatus(message, isError = false) {
  statusMessage.textContent = message;
  statusMessage.style.color = isError ? "#b0210f" : "#8d4d2f";
}

function getPreflightState(fileCount = selectedFiles.length) {
  const checks = {
    hasFiles: fileCount > 0,
    withinFileLimit: fileCount <= 500,
    withinBatchLimit: selectedTotalBytes <= maxBatchSizeBytes,
  };

  const ok = checks.hasFiles && checks.withinFileLimit && checks.withinBatchLimit;
  const estimatedSeconds = Math.max(8, Math.round((selectedTotalBytes / (1024 * 1024)) * 2.4 + fileCount * 0.55));

  return {
    ok,
    checks,
    estimatedSeconds,
  };
}

function clearValidationIssues() {
  if (!invalidFilesPanel || !invalidFilesList || !invalidFilesTitle) return;

  invalidFilesTitle.textContent = "";
  invalidFilesList.innerHTML = "";
  invalidFilesPanel.classList.add("hidden");
}

function setAdjustedBatchNote(validCount) {
  if (!adjustedBatchNote) return;

  const count = Number(validCount || 0);
  if (!Number.isFinite(count) || count <= 0) {
    adjustedBatchNote.textContent = "";
    adjustedBatchNote.classList.add("hidden");
    return;
  }

  const recalculatedPrice = formatPriceLabel(getPriceCents(count));
  adjustedBatchNote.textContent = `Continuing with ${count} valid file(s). Updated price: ${recalculatedPrice}.`;
  adjustedBatchNote.classList.remove("hidden");
}

function clearAdjustedBatchNote() {
  if (!adjustedBatchNote) return;
  adjustedBatchNote.textContent = "";
  adjustedBatchNote.classList.add("hidden");
}

function showValidationIssues(invalidFiles = []) {
  if (!invalidFilesPanel || !invalidFilesList || !invalidFilesTitle) return;

  const list = Array.isArray(invalidFiles) ? invalidFiles : [];
  if (!list.length) {
    clearValidationIssues();
    return;
  }

  invalidFilesTitle.textContent = `${list.length} file(s) need attention before you continue:`;
  invalidFilesList.innerHTML = "";

  list.slice(0, 8).forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = `${entry.name || "Unknown file"}: ${entry.reason || "Unable to process image"}`;
    invalidFilesList.appendChild(item);
  });

  if (list.length > 8) {
    const extra = document.createElement("li");
    extra.textContent = `+${list.length - 8} more file(s)`;
    invalidFilesList.appendChild(extra);
  }

  invalidFilesPanel.classList.remove("hidden");
}

// Ask the user whether to omit invalid files and continue, or cancel.
// Returns a promise that resolves with { proceed: true/false }.
function askUserAboutInvalidFiles(invalidFiles, validCount) {
  return new Promise((resolve) => {
    showValidationIssues(invalidFiles);

    const newPriceCents = getPriceCents(validCount);
    const priceNote =
      validCount === 0
        ? "No valid files would remain."
        : `After omitting, ${validCount} file(s) remain — ${formatPriceLabel(newPriceCents)}.`;

    // Inject a decision row into the panel
    const panelActions = document.getElementById("invalidFilesPanelActions");
    if (!panelActions) return resolve({ proceed: false });

    document.getElementById("invalidFilesActionNote").textContent = priceNote;
    panelActions.classList.remove("hidden");

    const continueBtn = document.getElementById("invalidFilesOmitBtn");
    const cancelBtn = document.getElementById("invalidFilesCancelBtn");

    continueBtn.disabled = validCount === 0;

    function cleanup() {
      panelActions.classList.add("hidden");
      continueBtn.removeEventListener("click", onContinue);
      cancelBtn.removeEventListener("click", onCancel);
    }

    function onContinue() {
      cleanup();
      resolve({ proceed: true });
    }

    function onCancel() {
      cleanup();
      clearValidationIssues();
      resolve({ proceed: false });
    }

    continueBtn.addEventListener("click", onContinue);
    cancelBtn.addEventListener("click", onCancel);

    invalidFilesPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
}

function setLoaderStage(stage) {
  if (!loaderTimeline) return;

  const stages = Array.from(loaderTimeline.querySelectorAll(".timeline-stage"));
  const activeIndex = stages.findIndex((node) => node.dataset.stage === stage);

  stages.forEach((node, index) => {
    node.classList.remove("is-active", "is-done");
    if (activeIndex >= 0 && index < activeIndex) {
      node.classList.add("is-done");
    }
    if (index === activeIndex) {
      node.classList.add("is-active");
    }
  });
}

function saveFlowState(patch = {}) {
  try {
    const current = JSON.parse(localStorage.getItem(flowStateKey) || "{}");
    const next = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    };
    localStorage.setItem(flowStateKey, JSON.stringify(next));
  } catch (_error) {
    // Ignore local storage failures.
  }
}

function readFlowState() {
  try {
    return JSON.parse(localStorage.getItem(flowStateKey) || "null");
  } catch (_error) {
    return null;
  }
}

function clearFlowState() {
  localStorage.removeItem(flowStateKey);
}

function setLoaderSubtext(text, options = {}) {
  if (!zipLoaderSub) return;
  if (typeof options.pin === "boolean") {
    loaderSubtextPinned = options.pin;
  }
  zipLoaderSub.textContent = text;
}

function updateCancelButtonUI() {
  if (!cancelJobBtn) return;

  if (!activeJobContext?.jobId) {
    cancelJobBtn.classList.add("hidden");
    cancelJobBtn.disabled = true;
    cancelJobBtn.textContent = "Cancel Conversion";
    return;
  }

  cancelJobBtn.disabled = false;
  cancelJobBtn.classList.remove("hidden");
  cancelJobBtn.textContent = activeJobContext.paymentSessionId
    ? "Cancel Conversion & Request Refund"
    : "Cancel Conversion";
}

function setActiveJobContext(jobId, paymentSessionId = "") {
  activeJobContext = {
    jobId: String(jobId || ""),
    paymentSessionId: String(paymentSessionId || ""),
  };
  updateCancelButtonUI();
}

function clearActiveJobContext() {
  activeJobContext = null;
  updateCancelButtonUI();
}

function showLoader(title = "Preparing your ZIP") {
  if (!loader) return;

  if (zipLoaderTitle) {
    zipLoaderTitle.textContent = title;
  }

  loaderSubtextPinned = false;
  setLoaderSubtext(loaderSteps[0]);
  setLoaderStage("preflight");
  loader.classList.add("is-visible");
  loader.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  updateCancelButtonUI();

  let stepIndex = 1;
  if (loaderStepTimer) {
    clearInterval(loaderStepTimer);
  }

  loaderStepTimer = setInterval(() => {
    if (loaderSubtextPinned) {
      return;
    }

    setLoaderSubtext(loaderSteps[stepIndex % loaderSteps.length]);
    stepIndex += 1;
  }, 1700);
}

function hideLoader() {
  if (!loader) return;

  if (loaderStepTimer) {
    clearInterval(loaderStepTimer);
    loaderStepTimer = null;
  }

  loader.classList.remove("is-visible");
  loader.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  setLoaderStage("");
  clearActiveJobContext();
}

function displayRefundConfirmation(refundData) {
  if (!refundModal || !refundAmountElement || !refundIdElement) {
    console.warn("Refund modal elements not found");
    return;
  }

  // Get the refund amount from paidSession (stored in cents)
  const amountCents = paidSession?.amountTotal || 0;
  const amountDollars = (amountCents / 100).toFixed(2);
  const refundId = refundData?.refundId || "";
  const displayRefundId = refundId.length > 8 ? refundId.slice(-8) : refundId;

  // Populate refund details
  refundAmountElement.textContent = `$${amountDollars}`;
  refundIdElement.textContent = displayRefundId;
  refundIdElement.title = `Full Refund ID: ${refundId}`;
  
  if (refundStatusElement) {
    refundStatusElement.textContent = "Completed";
  }

  // Show the refund modal
  refundModal.classList.remove("hidden");
  refundModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

function hideRefundModal() {
  if (!refundModal) return;
  
  refundModal.classList.add("hidden");
  refundModal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function getSelectedOutputFormat() {
  const selectedInput = outputFormatInputs.find((input) => input.checked);
  return selectedInput?.value || "jpg";
}

function getSelectedOutputFormatLabel() {
  return outputFormatLabels[getSelectedOutputFormat()] || "JPG";
}

function isUnlimitedRequested() {
  return Boolean(unlimitedToggle?.checked);
}

function readPaidSession() {
  try {
    const raw = localStorage.getItem("paidSession");
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    if (!parsed.sessionId || !parsed.count || !parsed.createdAt) {
      return null;
    }

    const expiresAt = Number(parsed.expiresAt || 0);
    const maxAgeMs = 12 * 60 * 60 * 1000;
    const expired = expiresAt > 0 ? Date.now() >= expiresAt : Date.now() - parsed.createdAt > maxAgeMs;
    if (expired) {
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

  if (paidSession.unlimitedPassActive) {
    const expiresAt = paidSession.unlimitedPassExpiresAt ? new Date(paidSession.unlimitedPassExpiresAt) : null;
    const expiresLabel = expiresAt && !Number.isNaN(expiresAt.getTime())
      ? expiresAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "in 24 hours";
    paidBadge.textContent = `Unlimited pass active until ${expiresLabel}.`;
  } else if (paidSession.jobId) {
    paidBadge.textContent = `Payment verified. Job ${paidSession.jobId.slice(0, 8)} is ready to finalize.`;
  } else {
    paidBadge.textContent = `Payment verified for ${paidSession.count} images.`;
  }
  paidBadge.classList.remove("hidden");
}

function updateSelectionUI() {
  const count = selectedFiles.length;
  const cents = getPriceCents(count);
  const outputLabel = getSelectedOutputFormatLabel();
  const folderUpload = selectedInputFiles.some((file) => Boolean(file?.webkitRelativePath));
  const unlimitedPassActive = Boolean(paidSession?.unlimitedPassActive);
  const unlimitedRequested = isUnlimitedRequested();
  const preflight = getPreflightState(count);

  countLabel.textContent = String(count);
  if (unlimitedPassActive && cents > 0) {
    priceLabel.textContent = "Covered by your unlimited pass";
  } else if (unlimitedRequested) {
    priceLabel.textContent = "$6.99 for 24-hour unlimited";
  } else {
    priceLabel.textContent = formatPriceLabel(cents);
  }

  if (selectionSummary) {
    if (selectedInputFiles.length > 0) {
      const pieces = [`Found ${supportedImageCount} supported image(s)`];

      if (ignoredUnsupportedCount > 0) {
        pieces.push(`${ignoredUnsupportedCount} unsupported file(s) ignored`);
      }

      if (folderUpload) {
        pieces.push("folder structure will be preserved in the ZIP");
      }

      if (selectedTotalBytes > 0) {
        pieces.push(`total selected size ${formatSizeMb(selectedTotalBytes)}`);
      }

      selectionSummary.textContent = `${pieces.join(". ")}.`;
      selectionSummary.classList.remove("hidden");
    } else {
      selectionSummary.textContent = "";
      selectionSummary.classList.add("hidden");
    }
  }

  if (detectedDuplicateCount > 0) {
    if (skippedDuplicateCount > 0) {
      duplicateInfo.textContent = `${skippedDuplicateCount} duplicate file(s) skipped.`;
    } else {
      duplicateInfo.textContent = `${detectedDuplicateCount} duplicate file(s) kept (auto-remove off).`;
    }
    duplicateInfo.classList.remove("hidden");
  } else {
    duplicateInfo.textContent = "";
    duplicateInfo.classList.add("hidden");
  }

  if (largeFileInfo) {
    if (largeFileCount > 0) {
      largeFileInfo.textContent = `${largeFileCount} large file(s) detected (largest ${formatSizeMb(largestFileBytes)}). Upload and conversion may take longer.`;
      largeFileInfo.classList.remove("hidden");
    } else {
      largeFileInfo.textContent = "";
      largeFileInfo.classList.add("hidden");
    }
  }

  if (preflightSummary) {
    const checks = [];
    checks.push(preflight.checks.hasFiles ? "files selected" : "select at least one file");
    checks.push(preflight.checks.withinBatchLimit ? `batch ${formatSizeMb(selectedTotalBytes)} within ${maxBatchSizeMb}MB` : `batch exceeds ${maxBatchSizeMb}MB`);
    checks.push(preflight.checks.withinFileLimit ? "file count within limit" : "too many files selected");

    preflightSummary.textContent = `Preflight: ${checks.join(" | ")}. Estimated processing time: about ${formatDurationSeconds(preflight.estimatedSeconds)}.`;
    preflightSummary.classList.remove("hidden", "preflight-ok", "preflight-warn", "preflight-fail");

    if (preflight.ok) {
      preflightSummary.classList.add("preflight-ok");
    } else if (count > 0) {
      preflightSummary.classList.add("preflight-fail");
    } else {
      preflightSummary.classList.add("preflight-warn");
    }
  }

  if (count === 0) {
    convertBtn.disabled = !paidSession?.jobId;
    if (paidSession?.jobId) {
      convertBtn.textContent = "Finalize Paid Job";
      setStatus("Paid job is ready. Click to generate your ZIP.");
      return;
    }

    convertBtn.textContent = `Convert to ${outputLabel} ZIP`;
    if (selectedInputFiles.length > 0) {
      setStatus("No supported images found in this selection.", true);
    } else {
      setStatus("Select images to begin.");
    }
    return;
  }

  convertBtn.disabled = !preflight.ok;

  convertBtn.textContent = cents === 0 || unlimitedPassActive
    ? "Convert & Download ZIP"
    : (unlimitedRequested ? "Continue to Unlimited Checkout" : "Continue to Payment");
  if (unlimitedPassActive && cents > 0) {
    setStatus(`Unlimited pass active. Ready to process your batch as ${outputLabel}.`);
    return;
  }

  if (unlimitedRequested && !unlimitedPassActive) {
    setStatus(`Unlimited pass selected. Continue to checkout, then process your ${outputLabel} batch.`);
    return;
  }

  setStatus(`Ready to process your batch as ${outputLabel}.`);
}

function setSelectedFiles(fileList) {
  clearValidationIssues();
  clearAdjustedBatchNote();
  selectedInputFiles = Array.from(fileList || []);
  const files = selectedInputFiles.filter(isAcceptedImageFile);
  supportedImageCount = files.length;
  ignoredUnsupportedCount = Math.max(0, selectedInputFiles.length - files.length);
  const unique = [];
  const seen = new Set();
  let duplicates = 0;

  for (const file of files) {
    const key = `${getFileRelativePath(file).toLowerCase()}::${file.size}::${file.lastModified}`;
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }

    seen.add(key);
    unique.push(file);
  }

  const removeDuplicates = dedupeToggle ? dedupeToggle.checked : true;
  detectedDuplicateCount = duplicates;
  selectedFiles = removeDuplicates ? unique : files;
  skippedDuplicateCount = removeDuplicates ? duplicates : 0;
  selectedTotalBytes = selectedFiles.reduce((sum, file) => sum + Number(file?.size || 0), 0);
  largeFileCount = selectedFiles.filter((file) => Number(file?.size || 0) >= largeFileWarningBytes).length;
  largestFileBytes = selectedFiles.reduce((max, file) => Math.max(max, Number(file?.size || 0)), 0);
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

async function startCheckout(imageCount, outputFormat, unlimitedRequested = false, options = {}) {
  const jobId = localStorage.getItem("pendingJobId") || "";
  const skipInvalidFiles = options.skipInvalidFiles === true;

  setLoaderStage("validate");
  setStatus("Validating uploaded files before payment...");
  setLoaderSubtext("Validating uploaded files before payment...", { pin: true });
  saveFlowState({ stage: "validating_before_checkout", jobId, imageCount, outputFormat });

  const response = await fetch(`${apiBase}/api/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageCount, jobId, outputFormat, unlimitedRequested, skipInvalidFiles }),
  });

  const data = await response.json();
  if (!response.ok) {
    if (Array.isArray(data.invalidFiles) && data.invalidFiles.length > 0 && !skipInvalidFiles) {
      // Surface invalid files to caller so it can ask the user what to do.
      return {
        requiresUserChoice: true,
        invalidFiles: data.invalidFiles,
        validCount: Number(data.validFileCount || 0),
      };
    }
    showValidationIssues(data.invalidFiles || []);
    throw new Error(data.error || "Unable to create checkout session.");
  }

  clearValidationIssues();

  if (data.required === false) {
    return {
      alreadyPaid: true,
      sessionId: String(data.sessionId || ""),
      jobId: String(data.jobId || jobId),
      amount: Number(data.amount || 0),
    };
  }

  if (!data.checkoutUrl) {
    throw new Error("Checkout URL missing from server response.");
  }

  setLoaderStage("payment");
  setStatus("Validation passed. Redirecting to secure Stripe checkout...");
  setLoaderSubtext("Validation passed. Redirecting to secure Stripe checkout...", { pin: true });
  saveFlowState({ stage: "redirecting_to_checkout", jobId, imageCount, outputFormat });

  window.location.href = data.checkoutUrl;
  return {
    alreadyPaid: false,
    sessionId: String(data.sessionId || ""),
    jobId,
    amount: Number(data.amount || 0),
  };
}

async function createUploadSession(files, outputFormat, unlimitedRequested = false) {
  const metadata = files.map((file) => ({
    name: file.name,
    relativePath: getFileRelativePath(file),
    type: file.type,
    size: file.size,
  }));

  const response = await fetch(`${apiBase}/api/create-upload-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files: metadata, outputFormat, unlimitedRequested }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to create upload session.");
  }

  return data;
}

async function uploadFilesToS3(uploadTargets, files, onProgress = null) {
  if (!Array.isArray(uploadTargets) || uploadTargets.length !== files.length) {
    throw new Error("Upload target mismatch.");
  }

  const uploadConcurrency = Math.min(8, Math.max(3, Number(navigator.hardwareConcurrency || 4)));
  let cursor = 0;
  let uploadedCount = 0;

  async function uploadSingleFileWithRetry(file, target) {
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await fetch(target.url, {
          method: "PUT",
          headers: {
            "Content-Type": target.contentType || file.type || "application/octet-stream",
          },
          body: file,
        });

        if (!response.ok) {
          throw new Error(`Upload returned ${response.status}`);
        }

        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw new Error(`Failed uploading ${file.name} after ${maxAttempts} attempts.`);
        }

        const backoffMs = 350 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  async function uploadWorker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= files.length) {
        return;
      }

      const file = files[index];
      const target = uploadTargets[index];

      await uploadSingleFileWithRetry(file, target);

      uploadedCount += 1;
      if (typeof onProgress === "function") {
        onProgress({
          uploaded: uploadedCount,
          total: files.length,
          fileName: file.name,
        });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < uploadConcurrency; i += 1) {
    workers.push(uploadWorker());
  }

  await Promise.all(workers);
}

async function startConversionJob(jobId, paymentSessionId = "", options = {}) {
  const flowState = readFlowState();
  const requestId =
    flowState?.jobId === jobId && flowState?.startRequestId
      ? String(flowState.startRequestId)
      : `start-${jobId}-${Date.now()}`;
  const skipInvalidFiles = options.skipInvalidFiles === true;

  saveFlowState({
    stage: "starting_conversion",
    jobId,
    paymentSessionId: String(paymentSessionId || ""),
    startRequestId: requestId,
  });
  const response = await fetch(`${apiBase}/api/start-conversion-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jobId, paymentSessionId, requestId, skipInvalidFiles }),
  });

  const data = await response.json();
  if (!response.ok) {
    showValidationIssues(data.invalidFiles || []);
    const error = new Error(data.error || "Unable to start conversion job.");
    error.invalidFiles = Array.isArray(data.invalidFiles) ? data.invalidFiles : [];
    error.validFileCount = Number(data.validFileCount || 0);
    error.validationFailed = data.status === "validation_failed";
    throw error;
  }

  clearValidationIssues();

  return data;
}

async function cancelConversionJob({ jobId, paymentSessionId = "", requestRefund = false }) {
  const response = await fetch(`${apiBase}/api/cancel-conversion-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jobId,
      paymentSessionId,
      requestRefund,
      reason: "Canceled by user from loader",
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Unable to cancel conversion.");
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
  const pollDelayMs = 2000;
  const maxOverallWaitMs = 90 * 60 * 1000;
  const maxNoProgressWaitMs = 30 * 60 * 1000;
  const startedAt = Date.now();
  let lastProgressAt = startedAt;
  let lastProcessedCount = -1;

  while (true) {
    const status = await getConversionJobStatus(jobId);

    if (status.status === "processing" && status.progress) {
      setLoaderStage("convert");
      saveFlowState({ stage: "processing", jobId, progress: status.progress });
      const processed = Number(status.progress.processed || 0);
      const total = Number(status.progress.total || 0);
      const etaSeconds = Number(status.progress.estimatedRemainingSeconds);

       if (processed > lastProcessedCount) {
        lastProcessedCount = processed;
        lastProgressAt = Date.now();
      }

      if (total > 0) {
        if (Number.isFinite(etaSeconds) && etaSeconds > 0) {
          const etaLabel = formatDurationSeconds(etaSeconds);
          setStatus(`Processing images (${processed}/${total}). Estimated time left: about ${etaLabel}.`);
          setLoaderSubtext(`Converting images (${processed}/${total}) - about ${etaLabel} left`, { pin: true });
        } else {
          setStatus(`Processing images (${processed}/${total}).`);
          setLoaderSubtext(`Converting images (${processed}/${total})...`, { pin: true });
        }
      }
    }

    if (status.status === "completed" && status.downloadUrl) {
      setLoaderStage("download");
      saveFlowState({ stage: "download_ready", jobId });
      return status.downloadUrl;
    }

    if (status.status === "failed") {
      showValidationIssues(status.invalidFiles || []);
      if (status.autoRefunded) {
        const refundSuffix = status.autoRefundId ? ` Refund ID: ${status.autoRefundId}.` : "";
        throw new Error(`Conversion failed, but your payment was automatically refunded.${refundSuffix}`);
      }
      throw new Error(status.error || "Conversion failed.");
    }

    if (status.status === "expired") {
      throw new Error("Job expired. Please upload again.");
    }

    if (status.status === "canceled") {
      throw new Error("Conversion was canceled.");
    }

    const now = Date.now();
    if (now - startedAt > maxOverallWaitMs) {
      throw new Error("This large conversion is still processing. Click Finalize Paid Job again to keep checking.");
    }

    if (now - lastProgressAt > maxNoProgressWaitMs) {
      throw new Error("Conversion is still running but no recent progress was detected. Click Finalize Paid Job again to continue polling.");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, pollDelayMs);
    });
  }
}

async function finalizePaidJob() {
  if (!paidSession?.jobId || !paidSession?.sessionId) {
    return;
  }

  showLoader("Finalizing your ZIP");
  setLoaderStage("preflight");

  try {
    setStatus("Finalizing your paid job...");
    setLoaderStage("validate");
    setLoaderSubtext("Verifying your paid session...");
    convertBtn.disabled = true;
    setActiveJobContext(paidSession.jobId, paidSession.sessionId);
    saveFlowState({
      stage: "finalizing_paid_job",
      jobId: paidSession.jobId,
      paymentSessionId: paidSession.sessionId,
      paid: true,
    });

    const startResult = await startConversionJob(paidSession.jobId, paidSession.sessionId);

    if (startResult.status === "completed" && startResult.downloadUrl) {
      setLoaderStage("download");
      setLoaderSubtext("Download is ready...");
      window.location.href = startResult.downloadUrl;
    } else {
      setStatus("Processing your images...");
      setLoaderStage("convert");
      setLoaderSubtext("Packing your ZIP...");
      const downloadUrl = await waitForJobAndDownload(paidSession.jobId);
      setLoaderStage("download");
      setLoaderSubtext("Download is ready...");
      window.location.href = downloadUrl;
    }

    if (!paidSession.unlimitedPassActive) {
      localStorage.removeItem("paidSession");
      paidSession = null;
    }
    localStorage.removeItem("pendingJobId");
    clearFlowState();
    updatePaidBadge();
    updateSelectionUI();
    setStatus("Download ready.");
  } finally {
    hideLoader();
    convertBtn.disabled = false;
  }
}

async function convertNow(files, sessionId = "") {
  const outputFormat = getSelectedOutputFormat();
  const payload = new FormData();
  files.forEach((file) => payload.append("images", file));
  payload.append("outputFormat", outputFormat);

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
  anchor.download = `converted-images-${outputFormat}-${Date.now()}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function handleConvertClick() {
  try {
    const count = selectedFiles.length;
    const outputFormat = getSelectedOutputFormat();
    const outputLabel = getSelectedOutputFormatLabel();
    const unlimitedRequested = isUnlimitedRequested();
    const preflight = getPreflightState(count);

    if (count === 0 && !paidSession?.jobId) {
      setStatus("Please choose at least one image.", true);
      return;
    }

    if (count === 0 && paidSession?.jobId) {
      await finalizePaidJob();
      return;
    }

    if (!preflight.ok) {
      setStatus("Preflight checks failed. Review the summary and fix the flagged items before continuing.", true);
      return;
    }

    if (selectedTotalBytes > maxBatchSizeBytes) {
      setStatus(`Total batch size is ${formatSizeMb(selectedTotalBytes)}. Max allowed is ${maxBatchSizeMb}MB.`, true);
      return;
    }

    const cents = getPriceCents(count);

    showLoader("Preparing your ZIP");
    setLoaderStage("preflight");
    const longRunHint = largeFileCount > 0 ? " Large files detected, this may take longer." : "";
    setStatus(`Requesting secure upload links for ${outputLabel} output...${longRunHint}`);
    setLoaderSubtext("Preparing secure upload links...");
    convertBtn.disabled = true;
    saveFlowState({
      stage: "creating_upload_session",
      outputFormat,
      imageCount: count,
      unlimitedRequested,
    });
    const uploadSession = await createUploadSession(selectedFiles, outputFormat, unlimitedRequested);
    localStorage.setItem("pendingJobId", uploadSession.jobId);
    localStorage.setItem("pendingOutputFormat", outputFormat);
    saveFlowState({
      stage: "uploading",
      jobId: uploadSession.jobId,
      imageCount: count,
      outputFormat,
      paidFlow: uploadSession.amount > 0,
    });

    setStatus(`Uploading files to secure storage...${longRunHint}`);
    setLoaderStage("upload");
    const uploadStartedAt = Date.now();
    setLoaderSubtext(`Uploading files (0/${selectedFiles.length})...`, { pin: true });
    await uploadFilesToS3(uploadSession.uploadTargets, selectedFiles, ({ uploaded, total }) => {
      const elapsedSeconds = Math.max(1, Math.floor((Date.now() - uploadStartedAt) / 1000));
      const averageSecondsPerFile = elapsedSeconds / Math.max(1, uploaded);
      const remainingFiles = Math.max(0, total - uploaded);
      const estimatedRemainingSeconds = Math.max(1, Math.round(averageSecondsPerFile * remainingFiles));

      if (uploaded < total) {
        setLoaderSubtext(
          `Uploading files (${uploaded}/${total}) - about ${formatDurationSeconds(estimatedRemainingSeconds)} left...`,
          { pin: true }
        );
      } else {
        setLoaderSubtext(`Uploading files (${uploaded}/${total})...`, { pin: true });
      }

      if (uploaded === total) {
        setStatus("Upload complete. Validating files before payment...");
        saveFlowState({
          stage: "uploaded_waiting_validation",
          jobId: uploadSession.jobId,
          imageCount: total,
          outputFormat,
          paidFlow: uploadSession.amount > 0,
        });
      }
    });

    if (uploadSession.amount > 0 && !paidSession) {
      setLoaderStage("validate");
      setStatus("Upload complete. Validating files before payment...");
      setLoaderSubtext("Validating uploaded files before payment...", { pin: true });
      let effectiveCount = count;
      let checkoutResult = await startCheckout(count, outputFormat, unlimitedRequested);

      if (checkoutResult?.requiresUserChoice) {
        // Hide the loader so the user can see the invalid files panel.
        hideLoader();
        convertBtn.disabled = false;

        const userChoice = await askUserAboutInvalidFiles(checkoutResult.invalidFiles, checkoutResult.validCount);

        if (!userChoice.proceed) {
          clearAdjustedBatchNote();
          setStatus("Conversion cancelled. Remove the flagged files and try again.");
          return;
        }

        // User agreed to omit invalid files — resume with the valid count.
        effectiveCount = checkoutResult.validCount;
        setAdjustedBatchNote(effectiveCount);
        showLoader("Preparing your ZIP");
        setLoaderStage("validate");
        convertBtn.disabled = true;
        setLoaderSubtext("Applying file exclusions and recalculating price...", { pin: true });
        checkoutResult = await startCheckout(effectiveCount, outputFormat, unlimitedRequested, { skipInvalidFiles: true });
      }

      if (checkoutResult?.alreadyPaid) {
        const recoveredPaidSession = {
          sessionId: checkoutResult.sessionId,
          count: effectiveCount,
          createdAt: Date.now(),
          jobId: checkoutResult.jobId || uploadSession.jobId,
          amountTotal: checkoutResult.amount,
        };

        paidSession = recoveredPaidSession;
        localStorage.setItem("paidSession", JSON.stringify(recoveredPaidSession));
        updatePaidBadge();
        setLoaderStage("convert");
        setStatus("Payment already verified. Finalizing your paid job...");
        await finalizePaidJob();
      }
      return;
    }

    if (uploadSession.amount > 0 && paidSession) {
      if (!paidSession.unlimitedPassActive && count !== Number(paidSession.count)) {
        setStatus(`This payment covers ${paidSession.count} images. Please match that count.`, true);
        return;
      }

      setStatus(`Converting uploaded files to ${outputLabel}...${longRunHint}`);
      setLoaderStage("convert");
      setLoaderSubtext("Converting images...");
      setActiveJobContext(uploadSession.jobId, paidSession.sessionId);
      const startResult = await startConversionJob(uploadSession.jobId, paidSession.sessionId);

      if (startResult.status === "completed" && startResult.downloadUrl) {
        setLoaderStage("download");
        setLoaderSubtext("Download is ready...");
        window.location.href = startResult.downloadUrl;
      } else {
        setStatus("Processing your images...");
        setLoaderStage("convert");
        setLoaderSubtext("Packing your ZIP...");
        const downloadUrl = await waitForJobAndDownload(uploadSession.jobId);
        setLoaderStage("download");
        setLoaderSubtext("Download is ready...");
        window.location.href = downloadUrl;
      }

      if (!paidSession.unlimitedPassActive) {
        localStorage.removeItem("paidSession");
        paidSession = null;
      }
      localStorage.removeItem("pendingJobId");
      localStorage.removeItem("pendingOutputFormat");
      clearFlowState();
      updatePaidBadge();
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }

    if (uploadSession.amount === 0 || cents === 0) {
      setStatus(`Converting uploaded files to ${outputLabel}...${longRunHint}`);
      setLoaderStage("convert");
      setLoaderSubtext("Converting images...");
      const activeSessionId = paidSession?.unlimitedPassActive ? String(paidSession.sessionId || "") : "";
      setActiveJobContext(uploadSession.jobId, activeSessionId);
      let startResult;
      try {
        startResult = await startConversionJob(uploadSession.jobId);
      } catch (error) {
        if (error?.validationFailed && Array.isArray(error.invalidFiles) && error.invalidFiles.length > 0) {
          hideLoader();
          convertBtn.disabled = false;

          const userChoice = await askUserAboutInvalidFiles(error.invalidFiles, error.validFileCount);
          if (!userChoice.proceed) {
            clearAdjustedBatchNote();
            setStatus("Conversion cancelled. Remove the flagged files and try again.");
            return;
          }

          setAdjustedBatchNote(error.validFileCount);
          showLoader("Preparing your ZIP");
          setLoaderStage("validate");
          convertBtn.disabled = true;
          setLoaderSubtext("Applying file exclusions and resuming conversion...", { pin: true });
          setStatus("Continuing with valid files only...");

          startResult = await startConversionJob(uploadSession.jobId, "", { skipInvalidFiles: true });
        } else {
          throw error;
        }
      }

      if (startResult.status === "completed" && startResult.downloadUrl) {
        setLoaderStage("download");
        setLoaderSubtext("Download is ready...");
        window.location.href = startResult.downloadUrl;
      } else {
        setStatus("Processing your images...");
        setLoaderStage("convert");
        setLoaderSubtext("Packing your ZIP...");
        const downloadUrl = await waitForJobAndDownload(uploadSession.jobId);
        setLoaderStage("download");
        setLoaderSubtext("Download is ready...");
        window.location.href = downloadUrl;
      }

      localStorage.removeItem("pendingJobId");
      localStorage.removeItem("pendingOutputFormat");
      clearFlowState();
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }
  } catch (error) {
    const rawMessage = String(error?.message || "");
    if (/failed to fetch|networkerror|network request failed/i.test(rawMessage)) {
      setStatus(
        "Connection timed out while preparing your batch. Please retry; large folders may take longer and will continue with deferred validation.",
        true
      );
    } else {
      setStatus(rawMessage || "Something went wrong.", true);
    }
  } finally {
    hideLoader();
    convertBtn.disabled = false;
    refreshFreeQuotaInfo();
  }
}

jumpToUploaderBtn.addEventListener("click", () => {
  uploader.scrollIntoView({ behavior: "smooth", block: "center" });
});

if (folderInput) {
  // Some browsers block programmatic picker open for [hidden] inputs.
  folderInput.hidden = false;
  folderInput.style.display = "none";
}

chooseFilesBtn.addEventListener("click", () => {
  openFilePicker(fileInput);
});

fileInput.addEventListener("change", (event) => {
  setSelectedFiles(event.target.files);
  event.target.value = "";
});

if (folderInput) {
  folderInput.addEventListener("change", (event) => {
    setSelectedFiles(event.target.files);
    event.target.value = "";
  });
}

if (dedupeToggle) {
  const savedPreference = localStorage.getItem(duplicatePreferenceKey);
  if (savedPreference === "false") {
    dedupeToggle.checked = false;
  }

  dedupeToggle.addEventListener("change", () => {
    localStorage.setItem(duplicatePreferenceKey, dedupeToggle.checked ? "true" : "false");
    setSelectedFiles(selectedInputFiles);
  });
}

if (unlimitedToggle) {
  const savedUnlimitedPreference = localStorage.getItem(unlimitedPreferenceKey);
  if (savedUnlimitedPreference === "true") {
    unlimitedToggle.checked = true;
  }

  unlimitedToggle.addEventListener("change", () => {
    localStorage.setItem(unlimitedPreferenceKey, unlimitedToggle.checked ? "true" : "false");
    updateSelectionUI();
  });
}

if (cancelJobBtn) {
  cancelJobBtn.addEventListener("click", async () => {
    if (!activeJobContext?.jobId) {
      return;
    }

    const shouldCancel = window.confirm(
      activeJobContext.paymentSessionId
        ? "Cancel conversion and request a refund (only if ZIP is not produced)?"
        : "Cancel this conversion?"
    );
    if (!shouldCancel) {
      return;
    }

    try {
      cancelJobBtn.disabled = true;
      const result = await cancelConversionJob({
        jobId: activeJobContext.jobId,
        paymentSessionId: activeJobContext.paymentSessionId,
        requestRefund: Boolean(activeJobContext.paymentSessionId),
      });

      if (result.refunded) {
        // Show refund confirmation modal before clearing paidSession
        displayRefundConfirmation(result);
        localStorage.removeItem("paidSession");
        paidSession = null;
        updatePaidBadge();
      } else {
        setStatus("Conversion canceled.");
      }
    } catch (error) {
      setStatus(error.message || "Unable to cancel conversion.", true);
    } finally {
      hideLoader();
      convertBtn.disabled = false;
      cancelJobBtn.disabled = false;
      refreshFreeQuotaInfo();
    }
  });
}

if (refundCloseBtn) {
  refundCloseBtn.addEventListener("click", () => {
    hideRefundModal();
    // Reset the form for another conversion
    setSelectedFiles([]);
    updateSelectionUI();
    unlimitedToggle.checked = false;
  });
}

outputFormatInputs.forEach((input) => {
  input.addEventListener("change", () => {
    updateSelectionUI();
  });
});

uploader.addEventListener("dragover", (event) => {
  event.preventDefault();
  uploader.style.borderColor = "#ef5b1f";
});

uploader.addEventListener("dragleave", () => {
  uploader.style.borderColor = "#e4b690";
});

uploader.addEventListener("drop", (event) => {
  (async () => {
    event.preventDefault();
    uploader.style.borderColor = "#e4b690";

    const droppedItems = event.dataTransfer;
    if (!droppedItems) {
      return;
    }

    setStatus("Scanning dropped files and folders...");
    const files = await collectDroppedFiles(droppedItems);

    if (!files.length) {
      setStatus("No supported images found in the dropped selection.", true);
      return;
    }

    setSelectedFiles(files);
  })().catch(() => {
    setStatus("Could not read dropped items. Try using Choose Files or Folder.", true);
    uploader.style.borderColor = "#e4b690";
  });
});

async function recoverPendingFlow() {
  const pendingJobId = localStorage.getItem("pendingJobId") || "";
  const flowState = readFlowState();
  if (!pendingJobId) {
    return;
  }

  try {
    const status = await getConversionJobStatus(pendingJobId);

    if (status.status === "completed" && status.downloadUrl) {
      showLoader("Resuming your ZIP");
      setLoaderStage("download");
      setStatus("Recovered completed job. Preparing your download...");
      setLoaderSubtext("Download is ready...", { pin: true });
      clearFlowState();
      window.location.href = status.downloadUrl;
      return;
    }

    if (status.status === "processing" || status.status === "queued") {
      showLoader("Resuming your ZIP");
      setLoaderStage("convert");
      setStatus("Recovered an in-progress job. Continuing conversion...");
      setLoaderSubtext("Reconnecting to conversion status...", { pin: true });

      const paymentSessionId = paidSession?.sessionId || String(flowState?.paymentSessionId || "");
      if (status.status === "queued") {
        await startConversionJob(pendingJobId, paymentSessionId);
      }

      const downloadUrl = await waitForJobAndDownload(pendingJobId);
      setLoaderStage("download");
      setLoaderSubtext("Download is ready...", { pin: true });
      clearFlowState();
      window.location.href = downloadUrl;
      return;
    }

    if (status.status === "awaiting_upload") {
      setStatus("Upload was interrupted. Please choose files again to continue.", true);
      clearFlowState();
    }
  } catch (_error) {
    setStatus("Could not recover the previous job automatically. You can retry from your current selection.", true);
  }
}

convertBtn.addEventListener("click", handleConvertClick);

paidSession = readPaidSession();
updatePaidBadge();
updateSelectionUI();
refreshFreeQuotaInfo();

if (paidSession?.jobId) {
  finalizePaidJob().catch((error) => {
    setStatus(error.message || "Unable to finalize paid job.", true);
    convertBtn.disabled = false;
  });
} else {
  recoverPendingFlow().catch(() => {
    setStatus("Could not recover previous progress. You can safely continue.", true);
  });
}

window.addEventListener("beforeunload", () => {
  clearPreviewObjectUrls();
});
