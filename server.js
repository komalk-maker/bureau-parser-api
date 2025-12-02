// ================================
// KALKI FINSERV – AI BUREAU PARSER BACKEND
// ================================

import express from "express";
import multer from "multer";
import pdf from "pdf-parse";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

// File upload directory
const upload = multer({ dest: "uploads/" });

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------- Helpers ----------
function parseAmount(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// ==============================================
// OCR SPACE (for scanned PDFs)
// ==============================================
async function performOcrOnPdf(filePath) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) throw new Error("OCR_SPACE_API_KEY not configured");

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer], { type: "application/pdf" });

  const formData = new FormData();
  formData.append("apikey", apiKey);
  formData.append("file", blob, "report.pdf");
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) throw new Error("OCR API error: " + res.status);
  const data = await res.json();

  if (data.OCRExitCode !== 1 || !data.ParsedResults?.length) {
    throw new Error("OCR did not return parsed text");
  }

  return data.ParsedResults.map((r) => r.ParsedText || "").join("\n");
}

// ==============================================
// EXPERIAN: TOTAL CURRENT BALANCE (for O/s)
// ==============================================
function extractTotalCurrentBalance(text) {
  const t = text.replace(/\r/g, "").replace(/\u00a0/g, " ");
  const patterns = [
    /Total\s+Current\s+Bal\.?\s*amt[^\d]{0,30}([\d,]+)/i,
    /Total\s+Current\s+Balance[^\d]{0,30}([\d,]+)/i,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m && m[1]) {
      return parseAmount(m[1]);
    }
  }
  return 0;
}

// ==============================================
// AI PARSER – SCORE, ENQUIRIES, LOANS (WITH DETAILS), ROUGH TOTALS
// ==============================================
async function analyzeWithAI(extractedText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const prompt = `
You are an expert at reading INDIAN credit bureau reports (Experian, CIBIL, CRIF, Equifax).

You will be given the FULL TEXT of a bureau report (tables flattened as text).
Read it like a human and extract exactly the following fields:

1) score
   - The MAIN credit score shown in the score section (e.g. Experian Credit Score 750).
   - This is usually printed once near a gauge and the text "Credit Score" or "Experian Credit Score".
   - Ignore any other 3-digit numbers or ranges.
   - If you cannot find it, use 0.

2) enquiryCount
   - Total number of credit enquiries.
   - Prefer any "Credit Enquiry Summary" / "Last 180 days credit enquiries" / "Total credit enquiries" section.
   - If not present, count the number of enquiry rows in enquiry tables.
   - If unclear, use 0.

3) dpd
   - A short text summary of delinquencies / overdues / DPD.
   - If the report or summary says it's clean, return exactly "0 - Clean".
   - Example: "30+ DPD in 1 account", "No DPD in last 24 months", etc.

4) loans
   - This comes primarily from the sections:
       "SUMMARY: CREDIT ACCOUNT INFORMATION" and
       "CREDIT ACCOUNT INFORMATION DETAILS" (or similar names).
   - Return one item per credit facility (loan / card / OD / LAP etc).
   - Each item has:
       - type: high-level type such as "Home Loan", "LAP", "Personal Loan", "Auto Loan", "Credit Card", "OD", etc.
       - status: e.g. "Active", "Closed", "Settled", "Written Off".
       - line: a short one-line description for display (e.g. "HDFC Bank • Home Loan • ACTIVE").
       - details: object with as many of the following fields as you can fill from "CREDIT ACCOUNT INFORMATION DETAILS":
           * lender
           * accountType
           * accountNumber
           * ownership
           * accountStatus
           * dateOpened
           * dateReported
           * dateClosed
           * sanctionAmount         (numeric, no commas)
           * currentBalance         (numeric, no commas)
           * amountOverdue          (numeric, no commas)
           * emiAmount              (numeric, no commas)
           * securityOrCollateral   (string if present)
           * dpdHistory             (string summary, e.g. "No DPD in last 24 months")

5) enquiries
   - From the "CREDIT ENQUIRIES" section.
   - Each enquiry item should have:
       - institution: name of the lender/bank/NBFC.
       - enquiryType: e.g. "Credit Card", "Personal Loan", "Auto Loan", etc.
       - date: enquiry date as it appears (e.g. "15-11-2025" or "2025-11-15").
       - amount: enquiry amount if present (numeric, no commas).
       - status: e.g. "Approved", "Pending", "Rejected" if visible, otherwise "".

6) totals
   - Just give a reasonable approximation of:
       loanSanctioned, loanOutstanding, cardLimit, cardOutstanding.
   - The backend will override some of these with deterministic logic from the raw text.
   - Always return numeric values (no commas).

Return STRICT JSON (no comments, no extra fields):

{
  "score": number,
  "enquiryCount": number,
  "dpd": string,
  "totals": {
    "loanSanctioned": number,
    "loanOutstanding": number,
    "cardLimit": number,
    "cardOutstanding": number
  },
  "loans": [
    {
      "type": string,
      "status": string,
      "line": string,
      "details": {
        "lender": string,
        "accountType": string,
        "accountNumber": string,
        "ownership": string,
        "accountStatus": string,
        "dateOpened": string,
        "dateReported": string,
        "dateClosed": string,
        "sanctionAmount": number,
        "currentBalance": number,
        "amountOverdue": number,
        "emiAmount": number,
        "securityOrCollateral": string,
        "dpdHistory": string
      }
    }
  ],
  "enquiries": [
    {
      "institution": string,
      "enquiryType": string,
      "date": string,
      "amount": number,
      "status": string
    }
  ]
}

REPORT TEXT:
${extractedText}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "bureau_summary_with_details",
        strict: true,
        schema: {
          type: "object",
          properties: {
            score: { type: "number" },
            enquiryCount: { type: "number" },
            dpd: { type: "string" },
            totals: {
              type: "object",
              properties: {
                loanSanctioned: { type: "number" },
                loanOutstanding: { type: "number" },
                cardLimit: { type: "number" },
                cardOutstanding: { type: "number" },
              },
              required: [
                "loanSanctioned",
                "loanOutstanding",
                "cardLimit",
                "cardOutstanding",
              ],
              additionalProperties: false,
            },
            loans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  status: { type: "string" },
                  line: { type: "string" },
                  details: {
                    type: "object",
                    properties: {
                      lender: { type: "string" },
                      accountType: { type: "string" },
                      accountNumber: { type: "string" },
                      ownership: { type: "string" },
                      accountStatus: { type: "string" },
                      dateOpened: { type: "string" },
                      dateReported: { type: "string" },
                      dateClosed: { type: "string" },
                      sanctionAmount: { type: "number" },
                      currentBalance: { type: "number" },
                      amountOverdue: { type: "number" },
                      emiAmount: { type: "number" },
                      securityOrCollateral: { type: "string" },
                      dpdHistory: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
                required: ["type", "status", "line"],
                additionalProperties: false,
              },
            },
            enquiries: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  institution: { type: "string" },
                  enquiryType: { type: "string" },
                  date: { type: "string" },
                  amount: { type: "number" },
                  status: { type: "string" },
                },
                required: [
                  "institution",
                  "enquiryType",
                  "date",
                  "amount",
                  "status",
                ],
                additionalProperties: false,
              },
            },
          },
          required: [
            "score",
            "enquiryCount",
            "dpd",
            "totals",
            "loans",
            "enquiries",
          ],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = response.output[0].content[0].text;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("AI JSON Error:", raw);
    throw new Error("AI returned invalid JSON");
  }

  // Normalise / defaults
  parsed.score = typeof parsed.score === "number" ? parsed.score : 0;
  parsed.enquiryCount =
    typeof parsed.enquiryCount === "number" ? parsed.enquiryCount : 0;
  parsed.dpd = parsed.dpd || "0 - Clean";

  if (!parsed.totals) {
    parsed.totals = {
      loanSanctioned: 0,
      loanOutstanding: 0,
      cardLimit: 0,
      cardOutstanding: 0,
    };
  }

  parsed.totals.loanSanctioned = parseAmount(parsed.totals.loanSanctioned);
  parsed.totals.loanOutstanding = parseAmount(parsed.totals.loanOutstanding);
  parsed.totals.cardLimit = parseAmount(parsed.totals.cardLimit);
  parsed.totals.cardOutstanding = parseAmount(parsed.totals.cardOutstanding);

  parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
  parsed.enquiries = Array.isArray(parsed.enquiries) ? parsed.enquiries : [];

  // Ensure each loan has a details object
  parsed.loans = parsed.loans.map((l) => ({
    ...l,
    details: l.details || {},
  }));

  return parsed;
}

// ==============================================
// AI HELPER – SUM "Sanction Amt / Highest Credit" FOR ACTIVE ONLY
// FROM "SUMMARY: CREDIT ACCOUNT INFORMATION"
// ==============================================
async function computeSanctionTotalActiveWithAI(extractedText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  // Locate the SUMMARY: CREDIT ACCOUNT INFORMATION block
  const lower = extractedText.toLowerCase();
  const marker = "summary: credit account information";
  const startIdx = lower.indexOf(marker);
  let summaryBlock;

  if (startIdx !== -1) {
    // take a generous slice after the marker (e.g. next 6000 chars)
    summaryBlock = extractedText.slice(startIdx, startIdx + 6000);
  } else {
    // fallback: use whole text
    console.warn("Could not locate 'SUMMARY: CREDIT ACCOUNT INFORMATION' block");
    summaryBlock = extractedText;
  }

  const prompt = `
You are reading the "SUMMARY: CREDIT ACCOUNT INFORMATION" table from an Experian-style bureau report.

The columns include (in some order):
- Lender
- Account type
- Account No
- Ownership
- Date Reported
- Account Status
- Date Opened
- Sanction Amt / Highest Credit
- Current Balance
- Amount Overdue

Your TASK:

1. Consider ONLY rows where **Account Status is "ACTIVE"**.
2. For each ACTIVE row, read the numeric value in the **"Sanction Amt / Highest Credit"** column.
3. Sum all those values (active accounts only).
4. Ignore CLOSED / SETTLED / WRITTEN-OFF rows completely.
5. Parse Indian-style amounts like "7,50,000" or "33,25,000" correctly.

Return STRICT JSON only:

{
  "totalSanctionedActive": number
}

Rules:
- If you are unsure about a row, skip it rather than guessing.
- If you cannot find any ACTIVE rows or sanction amounts, return 0.
- Do NOT include any explanation text, just the JSON.

Here is the text block:

${summaryBlock}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "sanction_total_active",
        strict: true,
        schema: {
          type: "object",
          properties: {
            totalSanctionedActive: { type: "number" },
          },
          required: ["totalSanctionedActive"],
          additionalProperties: false,
        },
      },
    },
  });

  const raw = response.output[0].content[0].text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("SanctionTotalActive AI JSON Error:", raw);
    throw new Error("AI returned invalid JSON for sanction total");
  }

  return parseAmount(parsed.totalSanctionedActive);
}

// ==============================================
// MAIN API ENDPOINT: /analyze
// ==============================================
app.post("/analyze", upload.single("pdf"), async (req, res) => {
  let filePath;

  try {
    if (!req.file) {
      return res.json({ success: false, message: "No PDF received." });
    }

    filePath = req.file.path;

    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdf(dataBuffer);
    let extractedText = pdfData.text || "";

    console.log("Initial text length:", extractedText.length);

    // If text is very short, assume scanned PDF → OCR
    if (!extractedText || extractedText.trim().length < 300) {
      console.log("Running OCR...");
      try {
        extractedText = await performOcrOnPdf(filePath);
        console.log("OCR text length:", extractedText.length);
      } catch (ocrErr) {
        console.error("OCR Error:", ocrErr);
        return res.json({
          success: false,
          message:
            "OCR failed. Please upload the original bureau PDF (not a photo or screenshot).",
        });
      }
    }

    if (!extractedText || extractedText.trim().length < 100) {
      return res.json({
        success: false,
        message:
          "Unreadable PDF. Please upload a clearer report downloaded directly from the bureau.",
      });
    }

    // 1) Run AI interpretation (score, loans + details, enquiries, rough totals)
    let aiResult;
    try {
      aiResult = await analyzeWithAI(extractedText);
    } catch (aiErr) {
      console.error("AI ERROR:", aiErr);
      return res.json({
        success: false,
        message: "AI parsing error: " + aiErr.message,
      });
    }

    if (!aiResult.totals) aiResult.totals = {};

    // 2) Total Debt O/s (O/s) = Total Current Bal. amt from summary
    const totalCurrentBal = extractTotalCurrentBalance(extractedText);
    if (totalCurrentBal) {
      aiResult.totals.loanOutstanding = totalCurrentBal;
    } else {
      aiResult.totals.loanOutstanding =
        aiResult.totals.loanOutstanding || 0;
    }

    // 3) Total Debt O/s (Sanctioned) = sum of "Sanction Amt / Highest Credit" for ACTIVE accounts only
    try {
      const sanctionTotalActive = await computeSanctionTotalActiveWithAI(
        extractedText
      );
      if (sanctionTotalActive) {
        aiResult.totals.loanSanctioned = sanctionTotalActive;
      } else {
        aiResult.totals.loanSanctioned =
          aiResult.totals.loanSanctioned || 0;
      }
    } catch (sanErr) {
      console.error("Sanction sum (ACTIVE) AI error:", sanErr);
      aiResult.totals.loanSanctioned =
        aiResult.totals.loanSanctioned || 0;
    }

    res.json({
      success: true,
      message: "PDF parsed successfully",
      result: aiResult,
    });
  } catch (err) {
    console.error("Fatal Error:", err);
    return res.status(500).json({
      success: false,
      message: "Error parsing PDF",
    });
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error("File cleanup error:", e);
      }
    }
  }
});

// Home test route
app.get("/", (req, res) => {
  res.send("Bureau Parser API with AI is LIVE 🚀");
});

// Server start
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
