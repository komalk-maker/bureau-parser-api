/* ===========================================================
   KALKI FINSERV – AI BUREAU PARSER BACKEND (SINGLE AI CALL)
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
// Vector store for Govt scheme PDFs
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
  if (!str) return 0;
  const cleaned = String(str).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return Number.isFinite(num) ? num : 0;
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
5) enquiries[] — from "CREDIT ENQUIRIES".
6) totals — rough values (backend/frontend may override parts).

For each loan, include a "details" object. For dpdHistory, output a compact month/year view like:
"2023-01: 30, 2023-03: 60" or "" if none.

STRICT JSON shape:

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

  const raw = response.output[0].content[0].text;
  let parsed = JSON.parse(raw);

  // Normalize
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

  parsed.loans = parsed.loans.map((l) => ({
    ...l,
    details: l.details || {},
  }));

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

      // Make rate-limit error more friendly
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

    // NOTE:
    // We no longer do a second AI call for sanctioned sum.
    // Frontend already computes:
    //  - Sanctioned = sum of sanctionAmount for ACTIVE loans (from ai.loans.details)
    //  - Credit card totals from ACTIVE credit card accounts.

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

    // Expect an array like [{ role: "user", content: "..." }, ...]
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
        ...messages, // [{role, content}, ...] from frontend
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

    const answer =
      extractResponseText(response) || "I could not generate a reply.";

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
