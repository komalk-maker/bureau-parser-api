// parser.js

export function parseBureauReport(rawText) {
  // Normalise text a bit
  const text = rawText.replace(/\r/g, "").replace(/[^\S\r\n]+/g, " ");

  // ---------- CREDIT SCORE ----------
  let score = null;

  const scorePatterns = [
    /(experian|cibil|crif|equifax)[^\d]{0,40}(\d{3})/i,
    /(credit\s+score)[^\d]{0,40}(\d{3})/i,
    /\bscore\s*[:\-]?\s*(\d{3})\b/i
  ];

  for (const re of scorePatterns) {
    const m = text.match(re);
    if (m) {
      const val = parseInt(m[m.length - 1], 10);
      if (val >= 300 && val <= 900) {
        score = val;
        break;
      }
    }
  }

  // Fallback: pick first 3-digit number between 300–900
  if (score === null) {
    const allNums = text.match(/\b\d{3}\b/g) || [];
    for (const n of allNums) {
      const val = parseInt(n, 10);
      if (val >= 300 && val <= 900) {
        score = val;
        break;
      }
    }
  }

  // ---------- LOANS / ACCOUNTS ----------
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const loanKeywords = [
    "loan",
    "credit card",
    "card",
    "housing finance",
    "hfl",
    "mortgage",
    "overdraft",
    "od",
    "auto loan",
    "vehicle loan",
    "personal loan",
    "home loan",
    "lap"
  ];

  const statusKeywords = [
    { key: "closed", value: "Closed" },
    { key: "active", value: "Active" },
    { key: "open", value: "Active" },
    { key: "settled", value: "Settled" },
    { key: "written off", value: "Written Off" }
  ];

  const loans = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const lowered = line.toLowerCase();
    if (!loanKeywords.some(k => lowered.includes(k))) continue;

    // Rough classification
    let type = "Other";
    if (/home loan/i.test(line)) type = "Home Loan";
    else if (/personal loan/i.test(line)) type = "Personal Loan";
    else if (/credit card/i.test(line) || /\bcard\b/i.test(line)) type = "Credit Card";
    else if (/overdraft|od/i.test(line)) type = "Overdraft";
    else if (/vehicle|auto/i.test(line)) type = "Auto / Vehicle Loan";

    // Find status in current + next line (some reports split it)
    let status = "Unknown";
    const windowText = (line + " " + (lines[i + 1] || "")).toLowerCase();

    for (const s of statusKeywords) {
      if (windowText.includes(s.key)) {
        status = s.value;
        break;
      }
    }

    loans.push({
      type,
      status,
      line
    });
  }

  // Remove near-duplicate loan lines (same text repeated)
  const uniqueLoans = [];
  const seen = new Set();
  for (const l of loans) {
    if (!seen.has(l.line)) {
      seen.add(l.line);
      uniqueLoans.push(l);
    }
  }

  // ---------- ENQUIRIES ----------
  // Very simple approximation: count lines containing "enquiry date" or "enquiry amount"
  let enquiryCount = 0;
  for (const line of lines) {
    if (/enquiry date|enquiry amount|enquiries/i.test(line)) {
      enquiryCount++;
    }
  }

  // ---------- DPD / OVERDUE ----------
  // Look for patterns of 30/60/90 past due in context of DPD/Days Past Due
  let dpd = "0 - Clean";
  const dpdContext = text.match(/(dpd|days past due|payment history)[\s\S]{0,300}/i);

  if (dpdContext) {
    const ctx = dpdContext[0];
    if (/\b(30|60|90|120|150|180)\b/.test(ctx)) {
      dpd = "Possible delinquencies (30+ DPD found, manual review needed)";
    }
  }

  return {
    score,
    loans: uniqueLoans,
    enquiryCount,
    dpd
  };
}
