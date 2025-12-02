/* ===========================================================
   KALKI FINSERV – BUREAU PARSER BACKEND (NO OPENAI – RULE BASED)
   =========================================================== */

import express from "express";
import multer from "multer";
import pdf from "pdf-parse";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

// File upload directory
const upload = multer({ dest: "uploads/" });

// ---------- Utility Helpers ----------
function parseAmount(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function cleanText(t) {
  return (t || "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[^\S\r\n]+/g, " ");
}

// ---------- OCR SPACE (optional, if you have key) ----------
async function performOcrOnPdf(filePath) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    console.warn("OCR_SPACE_API_KEY not configured – skipping OCR");
    return "";
  }

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer], { type: "application/pdf" });

  const formData = new FormData();
  formData.append("apikey", apiKey);
  formData.append("file", blob, "bureau.pdf");
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    console.error("OCR HTTP error:", res.status, await res.text());
    throw new Error("OCR API error");
  }

  const data = await res.json();

  if (data.OCRExitCode !== 1 || !data.ParsedResults?.length) {
    console.error("OCR bad response:", data);
    throw new Error("OCR failed");
  }

  return data.ParsedResults.map((r) => r.ParsedText || "").join("\n");
}

// ---------- Extract main score ----------
function extractScore(text) {
  const t = cleanText(text);
  const patterns = [
    /(Experian|CIBIL|CRIF|Equifax)\s+(?:credit\s+)?score\s*[:\-]?\s*(\d{3})/i,
    /Credit\s+Score\s*[:\-]?\s*(\d{3})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[2]) return parseInt(m[2], 10);
  }
  // fallback: first 3-digit number between 300–900 near top
  const lines = t.split("\n").slice(0, 30).join(" ");
  const m2 = lines.match(/(\d{3})/g);
  if (m2) {
    const num = m2.map((x) => parseInt(x, 10)).find((n) => n >= 300 && n <= 900);
    if (num) return num;
  }
  return 0;
}

// ---------- Extract Total Current Bal. amt ----------
function extractTotalCurrentBalance(text) {
  const t = cleanText(text);
  const patterns = [
    /Total\s+Current\s+Bal\.?\s*amt[^\d]{0,30}([\d,]+)/i,
    /Total\s+Current\s+Balance[^\d]{0,30}([\d,]+)/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) return parseAmount(m[1]);
  }
  return 0;
}

// ---------- Find block between markers ----------
function sliceBetween(text, startMarker, endMarkers = []) {
  const lower = text.toLowerCase();
  const startIdx = lower.indexOf(startMarker.toLowerCase());
  if (startIdx === -1) return "";
  let endIdx = text.length;
  for (const em of endMarkers) {
    const i = lower.indexOf(em.toLowerCase(), startIdx + startMarker.length);
    if (i !== -1 && i < endIdx) endIdx = i;
  }
  return text.slice(startIdx, endIdx);
}

// ---------- Parse loans from SUMMARY: CREDIT ACCOUNT INFORMATION ----------
function parseLoansFromSummary(text) {
  const block = sliceBetween(
    text,
    "SUMMARY: CREDIT ACCOUNT INFORMATION",
    ["CREDIT ACCOUNT INFORMATION DETAILS", "CREDIT ENQUIRIES", "SUMMARY: CREDIT ENQUIRIES"]
  );

  if (!block) return [];

  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

  // Find header line (contains lender + account + current)
  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (
      (l.includes("lender") || l.includes("member")) &&
      l.includes("account") &&
      (l.includes("current") || l.includes("sanction"))
    ) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const headerLine = lines[headerIndex];
  const headerCols = headerLine.split(/\s{2,}/).map((h) => h.trim());

  const idx = {
    lender: headerCols.findIndex((h) => /lender|member/i.test(h)),
    accountType: headerCols.findIndex((h) => /account\s*type/i.test(h)),
    accountNumber: headerCols.findIndex((h) => /account\s*no|account\s*number/i.test(h)),
    ownership: headerCols.findIndex((h) => /ownership/i.test(h)),
    accountStatus: headerCols.findIndex((h) => /status/i.test(h)),
    dateOpened: headerCols.findIndex((h) => /date\s*opened/i.test(h)),
    dateReported: headerCols.findIndex((h) => /date\s*reported/i.test(h)),
    dateClosed: headerCols.findIndex((h) => /date\s*closed/i.test(h)),
    sanction: headerCols.findIndex((h) => /sanction|highest\s*credit/i.test(h)),
    current: headerCols.findIndex((h) => /current\s*balance|current\s*bal/i.test(h)),
    overdue: headerCols.findIndex((h) => /amount\s*overdue/i.test(h)),
  };

  function getCol(cols, idxVal) {
    if (idxVal === -1) return "";
    return cols[idxVal] || "";
  }

  const loans = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^total/i.test(line)) break;
    if (/^summary: credit account information/i.test(line)) continue;
    if (/^credit account information details/i.test(line)) break;

    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length < 3) continue;

    const lender = getCol(cols, idx.lender);
    const accountType = getCol(cols, idx.accountType);
    const accountNumber = getCol(cols, idx.accountNumber);
    const ownership = getCol(cols, idx.ownership);
    const accountStatus = getCol(cols, idx.accountStatus);
    const dateOpened = getCol(cols, idx.dateOpened);
    const dateReported = getCol(cols, idx.dateReported);
    const dateClosed = getCol(cols, idx.dateClosed);
    const sanctionStr = getCol(cols, idx.sanction);
    const currentStr = getCol(cols, idx.current);
    const overdueStr = getCol(cols, idx.overdue);

    // skip header repeats / non-numeric sanction & current
    if (!sanctionStr && !currentStr && !overdueStr) continue;

    const sanctionAmount = parseAmount(sanctionStr);
    const currentBalance = parseAmount(currentStr);
    const amountOverdue = parseAmount(overdueStr);

    const type = accountType || "Account";
    const status = accountStatus || "Unknown";

    const lineSummary = `${lender} • ${type} • ${status}`;

    loans.push({
      type,
      status,
      line: lineSummary,
      details: {
        lender,
        accountType,
        accountNumber,
        ownership,
        accountStatus,
        dateOpened,
        dateReported,
        dateClosed,
        sanctionAmount,
        currentBalance,
        amountOverdue,
        emiAmount: 0,
        securityOrCollateral: "",
        dpdHistory: "", // we are not parsing month-wise DPD here in rule-based version
      },
    });
  }

  return loans;
}

// ---------- Parse CREDIT ENQUIRIES ----------
function parseEnquiries(text) {
  const block = sliceBetween(
    text,
    "CREDIT ENQUIRIES",
    ["SUMMARY: CREDIT ACCOUNT INFORMATION", "CREDIT ACCOUNT INFORMATION DETAILS", "END OF REPORT"]
  );
  if (!block) return [];

  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);

  let headerIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l.includes("institution") || (l.includes("member") && l.includes("name"))) {
      headerIndex = i;
      break;
    }
  }
  if (headerIndex === -1) return [];

  const headerLine = lines[headerIndex];
  const headerCols = headerLine.split(/\s{2,}/).map((h) => h.trim());

  const idx = {
    institution: headerCols.findIndex((h) => /institution|member/i.test(h)),
    enquiryType: headerCols.findIndex((h) => /type/i.test(h)),
    date: headerCols.findIndex((h) => /date/i.test(h)),
    amount: headerCols.findIndex((h) => /amount/i.test(h)),
    status: headerCols.findIndex((h) => /status/i.test(h)),
  };

  function getCol(cols, idxVal) {
    if (idxVal === -1) return "";
    return cols[idxVal] || "";
  }

  const enquiries = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || /^total/i.test(line)) break;

    const cols = line.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (!cols.length) continue;

    const institution = getCol(cols, idx.institution);
    const enquiryType = getCol(cols, idx.enquiryType);
    const date = getCol(cols, idx.date);
    const amountStr = getCol(cols, idx.amount);
    const status = getCol(cols, idx.status);

    if (!institution && !enquiryType && !date) continue;

    enquiries.push({
      institution,
      enquiryType,
      date,
      amount: parseAmount(amountStr),
      status,
    });
  }

  return enquiries;
}

// ---------- Build DPD summary ----------
function buildDpdSummary(loans) {
  const withOverdue = loans.filter(
    (l) => (l.details.amountOverdue || 0) > 0
  );
  if (!withOverdue.length) return "0 - Clean";
  return `Overdues in ${withOverdue.length} account(s)`;
}

// =====================================================
// MAIN ENDPOINT: /analyze
// =====================================================
app.post("/analyze", upload.single("pdf"), async (req, res) => {
  let filePath;
  try {
    if (!req.file) {
      return res.json({ success: false, message: "No PDF provided" });
    }

    filePath = req.file.path;

    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdf(dataBuffer);
    let extractedText = pdfData.text || "";

    console.log("Initial PDF text length:", extractedText.length);

    // If PDF text too short → try OCR (if key configured)
    if (!extractedText || extractedText.trim().length < 300) {
      console.log("Text short, attempting OCR...");
      try {
        const ocrText = await performOcrOnPdf(filePath);
        if (ocrText && ocrText.trim().length > 100) {
          extractedText = ocrText;
          console.log("OCR text length:", extractedText.length);
        } else {
          console.warn("OCR returned too little text, keeping original extracted text");
        }
      } catch (ocrErr) {
        console.error("OCR Error:", ocrErr);
        // Continue with whatever pdf-parse gave us
      }
    }

    if (!extractedText || extractedText.trim().length < 100) {
      return res.json({
        success: false,
        message:
          "Unreadable PDF. Please upload the original bureau report downloaded as PDF.",
      });
    }

    // ---------- Rule-based parsing ----------

    const score = extractScore(extractedText);
    const loans = parseLoansFromSummary(extractedText);
    const enquiries = parseEnquiries(extractedText);
    const enquiryCount = enquiries.length;
    const dpdSummary = buildDpdSummary(loans);
    const totalCurrentBal = extractTotalCurrentBalance(extractedText);

    // Totals structure expected by frontend
    const totals = {
      loanSanctioned: 0, // frontend recomputes from active loans' sanctionAmount
      loanOutstanding: totalCurrentBal || 0, // O/s from Total Current Bal. amt
      cardLimit: 0,       // frontend recomputes from active credit cards
      cardOutstanding: 0, // frontend recomputes from active credit cards
    };

    const result = {
      score,
      enquiryCount,
      dpd: dpdSummary,
      totals,
      loans,
      enquiries,
    };

    res.json({
      success: true,
      message: "PDF parsed successfully (rule-based, no AI)",
      result,
    });
  } catch (e) {
    console.error("Fatal error in /analyze:", e);
    res.json({ success: false, message: "Error parsing PDF" });
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (cleanupErr) {
        console.error("File cleanup error:", cleanupErr);
      }
    }
  }
});

// ---------- Test Route ----------
app.get("/", (req, res) =>
  res.send("Kalki Finserv Bureau Parser (Rule-based) is LIVE 🚀")
);

// ---------- Start Server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on", PORT));
