import express from "express";
import multer from "multer";
import pdf from "pdf-parse";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

// --- OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- OCR helper using OCR.space with Blob/FormData ---
async function performOcrOnPdf(filePath) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) {
    throw new Error("OCR_SPACE_API_KEY not configured");
  }

  // Read file and wrap in a Blob for Node's built-in FormData/fetch
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

  if (!res.ok) {
    throw new Error(`OCR API error: HTTP ${res.status}`);
  }

  const data = await res.json();

  if (data.OCRExitCode !== 1 || !data.ParsedResults || !data.ParsedResults.length) {
    throw new Error("OCR did not return parsed text");
  }

  const parsedText = data.ParsedResults.map((r) => r.ParsedText || "").join("\n");
  return parsedText;
}

// --- AI parser using OpenAI Responses API ---
async function analyzeWithAI(extractedText) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not configured");
  }

  const prompt = `
You are an expert at reading INDIAN credit bureau reports (CIBIL / Experian / CRIF / Equifax).

From the TEXT of the report below, extract:

- exact CREDIT SCORE (3 digits, 300–900) when visible
- total number of CREDIT ENQUIRIES
- DPD / overdues summary: a short human-readable sentence
- detailed LOAN / CREDIT ACCOUNT list
- TOTALS:
  - loanSanctioned: sum of sanctioned amounts of all TERM / LOAN accounts (home loan, LAP, auto, PL, etc.)
  - loanOutstanding: sum of current outstanding / current balance of all TERM / LOAN accounts
  - cardLimit: sum of credit limits of all CREDIT CARD accounts
  - cardOutstanding: sum of current outstanding balances of all CREDIT CARD accounts

Return STRICT JSON with this schema (no extra fields):

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

If something is missing in the text, put 0 or null accordingly.

================= REPORT TEXT START =================
${extractedText}
================= REPORT TEXT END =================
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    response_format: { type: "json_object" },
  });

  const raw = response.output[0].content[0].text;
  let parsed;

  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("Error parsing AI JSON:", e, raw);
    throw new Error("AI parser returned invalid JSON");
  }

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

// ---- Main analyze endpoint ----
app.post("/analyze", upload.single("pdf"), async (req, res) => {
  let filePath;
  try {
    if (!req.file) {
      return res.json({
        success: false,
        message: "No PDF file received.",
      });
    }

    filePath = req.file.path;

    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdf(dataBuffer);
    let extractedText = pdfData.text || "";

    console.log("Initial extracted text length:", extractedText.length);

    // If very little text (likely scanned), use OCR
    if (!extractedText || extractedText.trim().length < 300) {
      console.log("Text too short, attempting OCR...");
      try {
        extractedText = await performOcrOnPdf(filePath);
        console.log("OCR extracted text length:", extractedText.length);
      } catch (ocrErr) {
        console.error("OCR failed:", ocrErr);
        return res.json({
          success: false,
          message:
            "We could not read this report automatically (OCR failed). Please upload the original PDF downloaded from the bureau website (not a photo or screenshot).",
        });
      }
    }

    if (!extractedText || extractedText.trim().length < 100) {
      return res.json({
        success: false,
        message:
          "We could not extract enough text from this report. Please upload a clearer PDF directly downloaded from the bureau.",
      });
    }

    // Use AI to interpret the text
    let aiResult;
    try {
      aiResult = await analyzeWithAI(extractedText);
    } catch (aiErr) {
      console.error("AI parsing failed:", aiErr);
      return res.json({
        success: false,
        message: "AI parsing error: " + aiErr.message,
      });
    }

    res.json({
      success: true,
      message: "PDF parsed successfully by AI",
      result: aiResult,
    });
  } catch (err) {
    console.error("Unexpected error in /analyze:", err);
    res.status(500).json({
      success: false,
      message: "Error parsing PDF",
    });
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
      } catch (e) {
        console.error("Error deleting temp file:", e);
      }
    }
  }
});

app.get("/", (req, res) => {
  res.send("Bureau Parser API Working with AI Parser");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
