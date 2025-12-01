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
You are an expert at reading INDIAN credit bureau reports (CIBIL / Experian / CRIF / Equifax).

From the TEXT below, extract:

- score: the main credit score (300–900). If not visible, use 0.
- enquiryCount: total number of credit enquiries.
- dpd: short human-readable summary of delinquencies / overdues (e.g. "0 - Clean" or "30+ DPD in one account").
- loans: array of credit facilities, each with:
  - type: e.g. "Home Loan", "Personal Loan", "Credit Card", "Auto Loan", "OD", "LAP", etc.
  - status: e.g. "Active", "Closed", "Settled", "Written Off".
  - line: short snippet from the report that describes this account.
- totals:
  - loanSanctioned: sum of sanctioned amounts of all TERM LOANS (home, LAP, auto, PL, OD with fixed limit, etc.).
  - loanOutstanding: sum of current outstanding / current balance of all TERM LOANS.
  - cardLimit: sum of credit limits of all CREDIT CARD accounts.
  - cardOutstanding: sum of current outstanding balances of all CREDIT CARD accounts.

IMPORTANT:
- Only one score value: the main bureau score. Ignore any sample numbers or ranges.
- If a number is missing for a total, use 0 (do NOT omit the field).
- Always follow the JSON schema exactly (no extra fields, no comments, no text outside JSON).

REPORT TEXT:
${extractedText}
`;

  // NEW: use text.format with json_schema (structured outputs)
  const response = await openai.responses.create({
    model: "gpt-4.1-mini", // cheap + good, you can upgrade later
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

  // Fallbacks / safety
  parsed.score = typeof parsed.score === "number" ? parsed.score : 0;
  parsed.enquiryCount = typeof parsed.enquiryCount === "number" ? parsed.enquiryCount : 0;
  parsed.dpd = parsed.dpd || "0 - Clean";

  if (!parsed.totals) {
    parsed.totals = {
      loanSanctioned: 0,
      loanOutstanding: 0,
      cardLimit: 0,
      cardOutstanding: 0,
    };
  }

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
