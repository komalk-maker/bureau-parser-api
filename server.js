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
