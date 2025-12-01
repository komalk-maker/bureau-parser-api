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
// AI PARSER – EXTRACT SCORE, LOANS, TOTALS, ETC.
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

4) totals
   You MUST prioritise the summary boxes that bureaus provide.
   DO NOT try to manually sum many lines if a summary is already present.

   Specifically, for Experian:

   - Look for sections named "REPORT SUMMARY" and "Current Balance Amount Summary".
   - Inside that, look for:
       "Total Current Bal. amt"  --> this is the TOTAL OUTSTANDING across all accounts.
       "Secured Accounts amt"
       "Unsecured Accounts amt"
   - If "Total Current Bal. amt" exists, use that directly as the total outstanding across ALL accounts.

   Fill the totals object as:

   - loanOutstanding:
       - Prefer:
           * "Total Current Bal. amt" from the Current Balance Amount Summary (all accounts),
         OR if that doesn't exist,
           * Secured + Unsecured current balance amounts from the same summary,
         OR if no summary exists,
           * then approximate by summing outstanding/current balance of all TERM/LOAN accounts.
       - Do NOT double count. Prefer the single summary number when available.

   - loanSanctioned:
       - Prefer any overall "Total Sanctioned Amount", "Total Disbursed Amount" or similar loan summary number.
       - If there is a summary row for "Total Sanctioned Amt" or "Total Disbursed Amt" for all loans, use that.
       - ONLY if no such summary exists, approximate by summing sanctioned/disbursed amounts of loan/OD/LAP accounts.

   - cardLimit:
       - Prefer summary values such as:
           "Total Credit Card Limit", "Total CC/CO High Credit / Limit", or similar for credit card accounts.
       - ONLY if no summary exists, approximate by summing the limits/high credit for all credit card accounts.

   - cardOutstanding:
       - Prefer summary values such as:
           "Total Credit Card Current Balance", "Total CC/CO current balance" or similar.
       - ONLY if no summary exists, approximate by summing current balance of all credit card accounts.

   IMPORTANT:
   - Always return numeric values as plain numbers (e.g. 4088632), NOT formatted with commas.
   - If a particular total cannot be determined, set it to 0 (do NOT omit the field).

5) loans
   - A concise list of credit facilities (loans and credit cards).
   - Each item:
       - type: e.g. "Home Loan", "LAP", "Personal Loan", "Auto Loan", "Credit Card", "OD", etc.
       - status: e.g. "Active", "Closed", "Settled", "Written Off".
       - line: a short snippet from the report that clearly identifies the account (bank + product or similar).

Return STRICT JSON with exactly this shape (no extra fields, no comments, no trailing text):

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
      "line": string
    }
  ]
}

Now read the report text below and fill this JSON:

REPORT TEXT:
${extractedText}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "bureau_summary",
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
                cardOutstanding: { type: "number" }
              },
              required: [
                "loanSanctioned",
                "loanOutstanding",
                "cardLimit",
                "cardOutstanding"
              ],
              additionalProperties: false
            },
            loans: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string" },
                  status: { type: "string" },
                  line: { type: "string" }
                },
                required: ["type", "status", "line"],
                additionalProperties: false
              }
            }
          },
          required: ["score", "enquiryCount", "dpd", "totals", "loans"],
          additionalProperties: false
        }
      }
    }
  });

  const raw = response.output[0].content[0].text;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("AI JSON Error:", raw);
    throw new Error("AI returned invalid JSON");
  }

  // Safety defaults / normalisation
  parsed.score = typeof parsed.score === "number" ? parsed.score : 0;
  parsed.enquiryCount = typeof parsed.enquiryCount === "number" ? parsed.enquiryCount : 0;
  parsed.dpd = parsed.dpd || "0 - Clean";

  if (!parsed.totals) {
    parsed.totals = {
      loanSanctioned: 0,
      loanOutstanding: 0,
      cardLimit: 0,
      cardOutstanding: 0
    };
  }

  parsed.totals.loanSanctioned = Number(parsed.totals.loanSanctioned || 0);
  parsed.totals.loanOutstanding = Number(parsed.totals.loanOutstanding || 0);
  parsed.totals.cardLimit = Number(parsed.totals.cardLimit || 0);
  parsed.totals.cardOutstanding = Number(parsed.totals.cardOutstanding || 0);

  parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];

  return parsed;
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

    // Run AI interpretation
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
