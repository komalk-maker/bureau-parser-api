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
    body: formData
  });

  if (!res.ok) throw new Error("OCR API error: " + res.status);
  const data = await res.json();

  if (data.OCRExitCode !== 1 || !data.ParsedResults?.length)
    throw new Error("OCR did not return parsed text");

  return data.ParsedResults.map(r => r.ParsedText || "").join("\n");
}

// ==============================================
// AI PARSER – EXTRACT SCORE, LOANS, TOTALS, ETC.
// ==============================================
async function analyzeWithAI(extractedText) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error("OPENAI_API_KEY missing");

  const prompt = `
You are an expert at reading INDIAN credit bureau reports.

Extract:

- Score (300–900)
- Enquiry count
- DPD summary
- Loan list
- Totals:
  - loanSanctioned
  - loanOutstanding
  - cardLimit
  - cardOutstanding

Return STRICT JSON:

{
  "score": number | null,
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

REPORT TEXT:
${extractedText}
`;

  // ************* NEW FIX *************
  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: { format: "json" }  // <-- UPDATED
  });

  const raw = response.output[0].content[0].text;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("AI JSON Error:", raw);
    throw new Error("AI returned invalid JSON");
  }

  // Fallbacks
  parsed.score = parsed.score ?? null;
  parsed.enquiryCount = parsed.enquiryCount ?? 0;
  parsed.dpd = parsed.dpd || "0 - Clean";

  parsed.totals = parsed.totals || {
    loanSanctioned: 0,
    loanOutstanding: 0,
    cardLimit: 0,
    cardOutstanding: 0,
  };

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

    // Use OCR if the PDF is scanned / low text
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
            "OCR Failed. Please upload an original PDF (not a photo or screenshot).",
        });
      }
    }

    if (!extractedText || extractedText.trim().length < 100) {
      return res.json({
        success: false,
        message:
          "Unreadable PDF. Please upload a clearer report downloaded from the bureau.",
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
app.listen(PORT, () =>
  console.log(`Server running on port ${PORT}`)
);
