const apiBase = document.body.dataset.apiBase || "http://localhost:5000";

const jumpToUploaderBtn = document.getElementById("jumpToUploader");
const chooseFilesBtn = document.getElementById("chooseFilesBtn");
const fileInput = document.getElementById("fileInput");
const uploader = document.getElementById("uploader");
const convertBtn = document.getElementById("convertBtn");
const countLabel = document.getElementById("countLabel");
const priceLabel = document.getElementById("priceLabel");
const statusMessage = document.getElementById("statusMessage");
const paidBadge = document.getElementById("paidBadge");

let selectedFiles = [];
let paidSession = null;

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

  paidBadge.textContent = `Payment verified for ${paidSession.count} images. Re-upload the same count to convert.`;
  paidBadge.classList.remove("hidden");
}

function updateSelectionUI() {
  const count = selectedFiles.length;
  const cents = getPriceCents(count);

  countLabel.textContent = String(count);
  priceLabel.textContent = formatPriceLabel(cents);

  if (count === 0) {
    convertBtn.textContent = "Convert & Download ZIP";
    setStatus("Select images to begin.");
    return;
  }

  convertBtn.textContent = cents === 0 ? "Convert & Download ZIP" : "Continue to Payment";
  setStatus("Ready to process your batch.");
}

function setSelectedFiles(fileList) {
  selectedFiles = Array.from(fileList || []);
  updateSelectionUI();
}

async function startCheckout(imageCount) {
  const response = await fetch(`${apiBase}/api/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageCount }),
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

    if (count === 0) {
      setStatus("Please choose at least one image.", true);
      return;
    }

    const cents = getPriceCents(count);

    if (paidSession) {
      if (count !== Number(paidSession.count)) {
        setStatus(`This payment covers ${paidSession.count} images. Please match that count.`, true);
        return;
      }

      setStatus("Uploading and converting...");
      convertBtn.disabled = true;
      await convertNow(selectedFiles, paidSession.sessionId);
      localStorage.removeItem("paidSession");
      paidSession = null;
      updatePaidBadge();
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }

    if (cents === 0) {
      setStatus("Uploading and converting...");
      convertBtn.disabled = true;
      await convertNow(selectedFiles);
      setSelectedFiles([]);
      fileInput.value = "";
      setStatus("Download ready.");
      return;
    }

    setStatus("Redirecting to secure Stripe checkout...");
    convertBtn.disabled = true;
    await startCheckout(count);
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
