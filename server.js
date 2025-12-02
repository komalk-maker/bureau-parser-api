/* ===========================================================
   KALKI FINSERV – AI BUREAU PARSER BACKEND (FULL WORKING FILE)
   =========================================================== */

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

// ---------- Utility Helpers ----------
function parseAmount(str) {
  if (!str) return 0;
  const cleaned = String(str).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// ---------- OCR SPACE ----------
async function performOcrOnPdf(filePath) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey) throw new Error("OCR_SPACE_API_KEY not configured");

  const buffer = await fs.promises.readFile(filePath);
  const blob = new Blob([buffer], { type: "application/pdf" });

  const formData = new FormData();
  formData.append("apikey", apiKey);
  formData.append("file", blob, "bureau.pdf");
  formData.append("language", "eng");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: formData,
  });

  const data = await res.json();

  if (data.OCRExitCode !== 1 || !data.ParsedResults?.length) {
    throw new Error("OCR failed");
  }

  return data.ParsedResults.map(r => r.ParsedText || "").join("\n");
}

// ---------- Extract Total Current Bal. amt ----------
function extractTotalCurrentBalance(text) {
  const t = text.replace(/\r/g, "").replace(/\u00a0/g, " ");

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

// =====================================================
// AI PARSER — SCORE, LOANS (WITH DETAILS), ENQUIRIES
// =====================================================
async function analyzeWithAI(extractedText) {
  const prompt = `
You are an expert reader of Indian credit bureau reports (Experian/CIBIL/CRIF/Equifax).

Extract the following strictly in JSON:

1) score — main bureau score only  
2) enquiryCount  
3) dpd — summary of overdues  
4) loans[] — include details from "CREDIT ACCOUNT INFORMATION DETAILS"  
5) enquiries[] — from "CREDIT ENQUIRIES"  
6) totals — rough values (backend overrides later)

The JSON format MUST MATCH this schema exactly:

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
                      dpdHistory: { type: "string" }
                    },
                    required: [
                      "lender",
                      "accountType",
                      "accountNumber",
                      "ownership",
                      "accountStatus",
                      "dateOpened",
                      "dateReported",
                      "dateClosed",
                      "sanctionAmount",
                      "currentBalance",
                      "amountOverdue",
                      "emiAmount",
                      "securityOrCollateral",
                      "dpdHistory"
                    ],
                    additionalProperties: false
                  }
                },
                required: ["type", "status", "line", "details"],
                additionalProperties: false
              }
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
                  status: { type: "string" }
                },
                required: [
                  "institution",
                  "enquiryType",
                  "date",
                  "amount",
                  "status"
                ],
                additionalProperties: false
              }
            }
          },
          required: [
            "score",
            "enquiryCount",
            "dpd",
            "totals",
            "loans",
            "enquiries"
          ],
          additionalProperties: false
        }
      }
    }
  });

  const raw = response.output[0].content[0].text;
  let parsed = JSON.parse(raw);

  // Normalize
  parsed.score ||= 0;
  parsed.enquiryCount ||= 0;
  parsed.dpd ||= "0 - Clean";

  return parsed;
}

// =====================================================
// AI — SUM OF ACTIVE "Sanction Amt / Highest Credit"
// =====================================================
async function computeSanctionTotalActiveWithAI(extractedText) {
  const lower = extractedText.toLowerCase();
  const marker = "summary: credit account information";
  const idx = lower.indexOf(marker);

  const block = idx !== -1
    ? extractedText.slice(idx, idx + 6000)
    : extractedText;

  const prompt = `
Read ONLY this credit account summary.

Extract: totalSanctionedActive = sum of "Sanction Amt / Highest Credit" for ACTIVE accounts only.

Return ONLY:

{"totalSanctionedActive": number}

TEXT:
${block}
`;

  const response = await openai.responses.create({
    model: "gpt-4.1-mini",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "sanction_sum",
        strict: true,
        schema: {
          type: "object",
          properties: {
            totalSanctionedActive: { type: "number" }
          },
          required: ["totalSanctionedActive"],
          additionalProperties: false
        }
      }
    }
  });

  const raw = response.output[0].content[0].text;
  let parsed = JSON.parse(raw);

  return parseAmount(parsed.totalSanctionedActive);
}

// =====================================================
// MAIN ENDPOINT: /analyze
// =====================================================
app.post("/analyze", upload.single("pdf"), async (req, res) => {
  let filePath;
  try {
    if (!req.file) return res.json({ success: false, message: "No PDF provided" });

    filePath = req.file.path;

    let extractedText = (await pdf(fs.readFileSync(filePath))).text || "";

    // If PDF text too short → OCR
    if (extractedText.trim().length < 300) {
      extractedText = await performOcrOnPdf(filePath);
    }

    if (extractedText.trim().length < 100) {
      return res.json({ success: false, message: "Unreadable PDF" });
    }

    // 1) AI extraction: score / loans / enquiries / rough totals
    const ai = await analyzeWithAI(extractedText);

    // 2) Override OUTSTANDING total
    ai.totals.loanOutstanding = extractTotalCurrentBalance(extractedText);

    // 3) Override SANCTIONED from ACTIVE accounts
    ai.totals.loanSanctioned =
      await computeSanctionTotalActiveWithAI(extractedText);

    res.json({ success: true, message: "Parsed OK", result: ai });

  } catch (e) {
    console.error(e);
    res.json({ success: false, message: "Error parsing PDF" });

  } finally {
    if (filePath) fs.unlinkSync(filePath);
  }
});

// ---------- Test Route ----------
app.get("/", (req, res) =>
  res.send("Kalki Finserv Bureau Parser API is LIVE 🚀")
);

// ---------- Start Server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on", PORT));
