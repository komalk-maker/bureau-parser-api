/* ===========================================================
   KALKI FINSERV – AI BUREAU PARSER BACKEND (SINGLE AI CALL)
   Patched schema fix: details.properties required list includes all keys.
   Also extracts/normalizes: rateOfInterest, repaymentTenure,
   totalWriteOffAmount, principalWriteOff, settlementAmount per loan.
   =========================================================== */

/* ===========================================================
   IMPORTS (CLEAN + Render Safe)
   =========================================================== */
import pkg from "openai/package.json";
console.log("OPENAI VERSION LOADED:", pkg.version);
import express from "express";
import multer from "multer";
import cors from "cors";
import fs from "fs";
import OpenAI from "openai";
import pdf from "pdf-parse"; // ✔ Use ONLY this for bank statements

// NO pdfjs-dist required unless you extract page layout manually
// REMOVE all pdfjsLib and worker imports

import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

// File upload handler
const upload = multer({ dest: "uploads/" });

// OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// optional future use
const GOVT_VECTOR_ID = process.env.GOVT_SCHEMES_VECTOR_STORE_ID;

// Helper to pull plain text out of Responses API output
function extractResponseText(resp) {
  if (!resp || !resp.output) return "";
  const chunks = [];
  for (const item of resp.output) {
    if (!item.content) continue;
    for (const c of item.content) {
      // new style
      if (c.type === "output_text" && c.text?.value) {
        chunks.push(c.text.value);
      }
      // fallback
      else if (c.type === "text" && typeof c.text === "string") {
        chunks.push(c.text);
      }
    }
  }
  return chunks.join("\n\n");
}

// ---------- Utility Helpers ----------
function parseAmount(str) {
  if (str == null) return 0;
  const s = String(str).trim();
  const m = s.match(/-?\d+(\.\d+)?/);
  if (m) {
    const num = parseFloat(m[0]);
    return Number.isFinite(num) ? num : 0;
  }
  const cleaned = s.replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
}

// Normalize tenure string to integer months where possible
function parseTenureToMonths(val) {
  if (val == null) return null;
  if (typeof val === "number" && Number.isFinite(val)) return Math.round(val);
  const s = String(val).trim().toLowerCase();
  let m = s.match(/(\d+)\s*(yr|year|years)/);
  if (m) return parseInt(m[1], 10) * 12;
  m = s.match(/(\d+)\s*(m|mo|month|months)/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/^(\d+)$/);
  if (m) return parseInt(m[1], 10);
  m = s.match(/(\d+(\.\d+)?)/);
  if (m) return Math.round(parseFloat(m[1]));
  return null;
}

// ---------- OCR SPACE ----------
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
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing");
  }

  const prompt = `
You are an expert reader of Indian credit bureau reports (Experian/CIBIL/CRIF/Equifax).

Extract the following strictly in JSON:

1) score — the main bureau score only.
2) enquiryCount — total credit enquiries.
3) dpd — a short summary of delinquencies / overdues.
4) loans[] — one item per credit facility, using:
   - "SUMMARY: CREDIT ACCOUNT INFORMATION"
   - "CREDIT ACCOUNT INFORMATION DETAILS"
   For each loan, include a details object. In addition to the usual fields,
   attempt to extract these if present in the credit account details:
     - rateOfInterest: numeric rate of interest (e.g. "Rate of Interest 12.050" or "Rate of Interest 12.05%")
     - repaymentTenure: remaining / reported repayment tenure (string or numeric; months preferred)
     - totalWriteOffAmount: numeric (if the loan has been written off, total write-off amount)
     - principalWriteOff: numeric (principal portion that was written off)
     - settlementAmount: numeric (settlement / compromise amount if listed)

5) enquiries[] — from "CREDIT ENQUIRIES".
6) totals — rough values (backend/frontend may override parts).

For each loan, include "details" with (where available):
  lender, accountType, accountNumber, ownership, accountStatus,
  dateOpened, dateReported, dateClosed, sanctionAmount, currentBalance,
  amountOverdue, emiAmount, securityOrCollateral, dpdHistory,
  rateOfInterest, repaymentTenure, totalWriteOffAmount, principalWriteOff, settlementAmount

STRICT JSON shape (loans.details properties above may be null when absent):

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
        "lender": string | null,
        "accountType": string | null,
        "accountNumber": string | null,
        "ownership": string | null,
        "accountStatus": string | null,
        "dateOpened": string | null,
        "dateReported": string | null,
        "dateClosed": string | null,
        "sanctionAmount": number | null,
        "currentBalance": number | null,
        "amountOverdue": number | null,
        "emiAmount": number | null,
        "securityOrCollateral": string | null,
        "dpdHistory": string | null,
        "rateOfInterest": number | null,
        "repaymentTenure": string | null,
        "totalWriteOffAmount": number | null,
        "principalWriteOff": number | null,
        "settlementAmount": number | null
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
        name: "bureau_summary_with_details_v2_fixed",
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
                      lender: { type: ["string", "null"] },
                      accountType: { type: ["string", "null"] },
                      accountNumber: { type: ["string", "null"] },
                      ownership: { type: ["string", "null"] },
                      accountStatus: { type: ["string", "null"] },
                      dateOpened: { type: ["string", "null"] },
                      dateReported: { type: ["string", "null"] },
                      dateClosed: { type: ["string", "null"] },
                      sanctionAmount: { type: ["number", "null"] },
                      currentBalance: { type: ["number", "null"] },
                      amountOverdue: { type: ["number", "null"] },
                      emiAmount: { type: ["number", "null"] },
                      securityOrCollateral: { type: ["string", "null"] },
                      dpdHistory: { type: ["string", "null"] },

                      // NEW optional fields (allow null)
                      rateOfInterest: { type: ["number", "null"] },
                      repaymentTenure: { type: ["string", "null"] },
                      totalWriteOffAmount: { type: ["number", "null"] },
                      principalWriteOff: { type: ["number", "null"] },
                      settlementAmount: { type: ["number", "null"] }
                    },
                    // REQUIRED must include every key declared in properties per API validation
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
                      "dpdHistory",
                      "rateOfInterest",
                      "repaymentTenure",
                      "totalWriteOffAmount",
                      "principalWriteOff",
                      "settlementAmount"
                    ],
                    additionalProperties: false,
                  },
                },
                required: ["type", "status", "line", "details"],
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

  // The responses.create with json_schema returns structured output; attempt to read raw
  const raw = response.output?.[0]?.content?.[0]?.text || extractResponseText(response);
  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const candidate = raw.match(/\{[\s\S]*\}$/m);
    if (candidate) {
      try {
        parsed = JSON.parse(candidate[0]);
      } catch (e2) {
        console.error("Failed to parse AI output as JSON:", e2);
        throw new Error("AI output parse failure");
      }
    } else {
      console.error("AI output not parseable as JSON:", raw);
      throw new Error("AI returned non-JSON output");
    }
  }

  // Normalize and coerce numeric fields
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
  parsed.totals.cardOutstanding = parseAmount(
    parsed.totals.cardOutstanding
  );

  parsed.loans = Array.isArray(parsed.loans) ? parsed.loans : [];
  parsed.enquiries = Array.isArray(parsed.enquiries)
    ? parsed.enquiries
    : [];

  // Ensure each loan has a details object and parse newly requested fields
  parsed.loans = parsed.loans.map((l) => {
    const details = l.details || {};

    const normalized = {
      lender: details.lender || null,
      accountType: details.accountType || null,
      accountNumber: details.accountNumber || null,
      ownership: details.ownership || null,
      accountStatus: details.accountStatus || null,
      dateOpened: details.dateOpened || null,
      dateReported: details.dateReported || null,
      dateClosed: details.dateClosed || null,
      sanctionAmount: parseAmount(details.sanctionAmount),
      currentBalance: parseAmount(details.currentBalance),
      amountOverdue: parseAmount(details.amountOverdue),
      emiAmount: parseAmount(details.emiAmount),
      securityOrCollateral: details.securityOrCollateral || null,
      dpdHistory: details.dpdHistory || null,

      // NEW fields (coerced)
      rateOfInterest: (() => {
        // accept numeric or numeric-in-string
        const val = details.rateOfInterest ?? details.rate_of_interest ?? details['Rate of Interest'] ?? null;
        return val == null ? null : parseAmount(val);
      })(),
      repaymentTenureRaw: details.repaymentTenure ?? details.repayment_tenure ?? details.tenure ?? null,
      repaymentTenure: (() => {
        const t = details.repaymentTenure ?? details.repayment_tenure ?? details.tenure ?? null;
        const months = parseTenureToMonths(t);
        return months !== null ? months : (t ? String(t) : null);
      })(),
      totalWriteOffAmount: (() => {
        const val = details.totalWriteOffAmount ?? details.total_write_off_amount ?? details.totalWriteoffAmount ?? null;
        return val == null ? 0 : parseAmount(val);
      })(),
      principalWriteOff: (() => {
        const val = details.principalWriteOff ?? details.principal_write_off ?? details.principalWriteoff ?? null;
        return val == null ? 0 : parseAmount(val);
      })(),
      settlementAmount: (() => {
        const val = details.settlementAmount ?? details.settlement_amount ?? details.settlement ?? null;
        return val == null ? 0 : parseAmount(val);
      })()
    };

    return {
      ...l,
      details: normalized,
    };
  });

  return parsed;
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

    // If PDF text too short → try OCR, but don't crash if OCR fails
    if (!extractedText || extractedText.trim().length < 300) {
      console.log("Text short, attempting OCR...");
      try {
        const ocrText = await performOcrOnPdf(filePath);
        if (ocrText && ocrText.trim().length > 100) {
          extractedText = ocrText;
          console.log("OCR text length:", extractedText.length);
        } else {
          console.warn(
            "OCR returned too little text, keeping original extracted text"
          );
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

    // 1) AI extraction: score / loans / enquiries / rough totals
    let ai;
    try {
      ai = await analyzeWithAI(extractedText);
    } catch (aiErr) {
      console.error("AI parsing error:", aiErr);
      let msg =
        aiErr.response?.data?.error?.message ||
        aiErr.message ||
        "Unknown AI error";

      if (msg.includes("Rate limit")) {
        msg =
          "Our AI engine is temporarily busy. Please wait 20–30 seconds and try again.";
      }

      return res.json({
        success: false,
        message: "AI parsing error: " + msg,
      });
    }

    // 2) Override OUTSTANDING total with Total Current Bal. amt
    const totalCurrentBal = extractTotalCurrentBalance(extractedText);
    if (!ai.totals) ai.totals = {};
    ai.totals.loanOutstanding =
      totalCurrentBal || ai.totals.loanOutstanding || 0;

    res.json({
      success: true,
      message: "PDF parsed successfully",
      result: ai,
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
// ================================================
// 📌 BANK STATEMENT ANALYZER API (FIXED)
// ================================================
app.post("/analyze-bank", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF uploaded" });
    }

    console.log("📄 Bank PDF Uploaded:", req.file.originalname);

    // --------------------------
// 1️⃣ Extract PDF → TEXT
// --------------------------
const dataBuffer = fs.readFileSync(req.file.path);
const pdfData = await pdf(dataBuffer);
const fullText = pdfData.text || "";

console.log("📘 Extracted PDF text length:", fullText.length);

if (!fullText || fullText.trim().length < 50) {
  return res.json({
    success: false,
    message: "Unable to read bank statement text"
  });
}



    console.log("📘 Extracted PDF text length:", fullText.length);

    if (!fullText || fullText.trim().length < 50) {
      return res.json({
        success: false,
        message: "Unable to read bank statement text"
      });
    }

    // --------------------------
    // 2️⃣ GPT — Analysis
    // --------------------------
    const prompt = `
You are an expert bank statement analyzer.  
Extract the following only from this bank statement text:

{
  "totalCredits": number,
  "emiBounceCount": number,
  "latestMonthEMIs": [
    { "lender": string, "amount": number, "emiDate": string }
  ],
  "avgBalance12M": number,
  "cashflow": [
    { "month": "Jan-2024", "credits": number, "debits": number }
  ],
  "salaryDetection": {
    "isSalaried": boolean,
    "salaryBank": string | null
  },
  "odUsage": {
    "used": boolean,
    "maxOverdraft": number
  }
}

TEXT:
${fullText}
`;

    const ai = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0
    });

    let json;
    try {
      json = JSON.parse(ai.choices[0].message.content);
    } catch (e) {
      return res.status(500).json({ error: "LLM returned non-JSON output" });
    }

    console.log("✅ Parsed Bank Summary:", json);

    // --------------------------
    // 3️⃣ Return Final JSON
    // --------------------------
    res.json({
      success: true,
      data: json
    });

  } catch (err) {
    console.error("❌ Error analyzing bank:", err);
    res.status(500).json({ error: "Server error analyzing bank statement" });
  }
});


// =====================================================
// CHAT ENDPOINT: /chat  (Existing bureau Q&A assistant)
// =====================================================
app.post("/chat", async (req, res) => {
  try {
    const { question, analysis, extras } = req.body || {};

    if (!question || typeof question !== "string") {
      return res.json({
        success: false,
        message: "Missing question for chat.",
      });
    }

    const safeAnalysis =
      typeof analysis === "object" && analysis ? analysis : {};

    const safeExtras =
      typeof extras === "object" && extras ? extras : {};

    const systemMessage = `
You are "Kalki AI", an assistant for KalkiFinserv's Bureau Analyzer.

You receive:
- A natural language QUESTION from the borrower.
- ANALYSIS_JSON: machine-readable bureau data (score, loans, enquiries, totals).
- EXTRAS_JSON: optional pre-computed insights from the frontend.

Guidelines:
- Always use the numbers from ANALYSIS_JSON / EXTRAS_JSON when talking about EMIs, totals, FOIR, DSCR or closure suggestions.
- If EXTRAS_JSON already contains specific calculations (e.g. months to reduce outstanding, recommended loans to close), TRUST those numbers and just explain them clearly.
- If something is missing, you may answer qualitatively (rules of thumb, next steps), but DO NOT invent precise rupee amounts or exact EMI breakdowns.
- Keep answers short, practical, and in plain English. Use bullet points when helpful.
- Don't mention JSON, prompts, or that you are an AI model. Speak as a simple loan advisor.
`;

    const userMessage = `
QUESTION:
${question}

ANALYSIS_JSON:
${JSON.stringify(safeAnalysis, null, 2)}

EXTRAS_JSON:
${JSON.stringify(safeExtras, null, 2)}
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage },
      ],
    });

    const answer =
      response.output?.[0]?.content?.[0]?.text ||
      "Sorry, I was not able to prepare a proper reply.";

    res.json({ success: true, answer });
  } catch (err) {
    console.error("Error in /chat:", err);
    res.json({
      success: false,
      message: "Error while generating chat response.",
    });
  }
});

// =====================================================
// GOVT SCHEME CHAT (3 PDFs only, via file_search)
// =====================================================
app.post("/govt-schemes-chat", async (req, res) => {
  try {
    if (!GOVT_VECTOR_ID) {
      return res.json({
        success: false,
        message:
          "Govt schemes vector store not configured. Set GOVT_SCHEMES_VECTOR_STORE_ID in env.",
      });
    }

    const { messages } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({
        success: false,
        message: "Missing messages array for govt schemes chat.",
      });
    }

    const systemPrompt = `
You are "Kalki Govt Scheme Assistant" for Indian Government loan/subsidy/guarantee schemes.

KNOWLEDGE:
- You are ONLY allowed to use information from the three indexed PDFs provided by KalkiFinserv.
- You access those PDFs through the 'file_search' tool and must NOT use any outside knowledge.
- If the PDFs do not clearly cover something, say: "I don't see this clearly in the scheme documents" and stop. Do NOT guess.

BEHAVIOUR:
- Understand natural language questions in English, Hinglish and simple Indian language mix.
- When user asks about a specific scheme, use file_search to find that scheme's section and answer:
  • Eligibility
  • Documents required
  • Benefits / subsidy / guarantee coverage / interest subvention
  • ROI (if written in the PDFs)
  • Tenure, security/collateral, exclusions, claim/settlement process
- When user says "Any scheme for me?" or similar:
  • Ask 2–3 short questions (who are they – MSME/farmer/student/SHG/home buyer etc., loan amount, purpose)
  • Then search in PDFs and suggest 1–3 schemes with brief reasoning, strictly based on the documents.
- When mentioning numbers (subsidy %, max loan, guarantee cover etc.) copy them exactly from the PDFs. Never invent.

FORMAT:
- Answer in clear paragraphs and bullet points.
- Do not mention tools, file_search, PDFs or that you are an AI.
`;

    const response = await openai.responses.create({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      tools: [{ type: "file_search" }],
      tool_config: {
        file_search: {
          vector_store_ids: [GOVT_VECTOR_ID],
        },
      },
      max_output_tokens: 900,
      temperature: 0.2,
    });

    const answer = extractResponseText(response) || "I could not generate a reply.";
    return res.json({ success: true, answer });
  } catch (err) {
    console.error("Error in /govt-schemes-chat:", err);
    return res.json({
      success: false,
      message: "Error while generating govt scheme chat response.",
    });
  }
});

// ---------- Test Route ----------
app.get("/", (req, res) =>
  res.send("Kalki Finserv Bureau Parser API is LIVE 🚀")
);

// ---------- Start Server ----------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log("Server running on", PORT));
