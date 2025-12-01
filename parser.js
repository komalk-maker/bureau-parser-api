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

  // Fallback: first 3-digit number between 300–900
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

  // ---------- LINES & CONTEXT ----------
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);

  const loanKeywords = [
    "loan",
    "housing finance",
    "hfl",
    "mortgage",
    "overdraft",
    "od",
    "vehicle loan",
    "auto loan",
    "personal loan",
    "home loan",
    "lap"
  ];

  const cardKeywords = [
    "credit card",
    "card type",
    "card account",
    "cc account"
  ];

  const statusKeywords = [
    { key: "closed", value: "Closed" },
    { key: "active", value: "Active" },
    { key: "open", value: "Active" },
    { key: "settled", value: "Settled" },
    { key: "written off", value: "Written Off" }
  ];

  const loans = [];

  // Totals
  let totalLoanSanctioned = 0;
  let totalLoanOutstanding = 0;
  let totalCardLimit = 0;
  let totalCardOutstanding = 0;

  // Helper to parse an amount like "1,23,456.00"
  const parseAmount = str => {
    if (!str) return 0;
    const cleaned = str.replace(/,/g, "");
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
  };

  // Recent lines buffer to guess context
  const recent = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    recent.push(line);
    if (recent.length > 6) recent.shift();

    // ---------- CLASSIFY LINE FOR LOAN LIST ----------
    if (
      loanKeywords.some(k => lower.includes(k)) ||
      cardKeywords.some(k => lower.includes(k))
    ) {
      let type = "Other";
      if (/home loan/i.test(line)) type = "Home Loan";
      else if (/personal loan/i.test(line)) type = "Personal Loan";
      else if (/credit card/i.test(line) || /\bcard\b/i.test(line)) type = "Credit Card";
      else if (/overdraft|od/i.test(line)) type = "Overdraft";
      else if (/vehicle|auto/i.test(line)) type = "Auto / Vehicle Loan";

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

    // ---------- AMOUNT EXTRACTION FOR TOTALS ----------
    // Decide if nearby context is a card or loan
    const windowLines = recent.join(" ").toLowerCase();
    const isCardContext = cardKeywords.some(k => windowLines.includes(k));
    const isLoanContext = !isCardContext && loanKeywords.some(k => windowLines.includes(k));

    // Current Balance / Outstanding
    if (/current balance|curr balance|outstanding balance|amt outstanding|amount outstanding/i.test(lower)) {
      const amtMatch = line.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g);
      if (amtMatch) {
        const amt = parseAmount(amtMatch[amtMatch.length - 1]);
        if (isCardContext) {
          totalCardOutstanding += amt;
        } else {
          totalLoanOutstanding += amt;
        }
      }
    }

    // Sanctioned / Credit Limit / High Credit
    if (/sanctioned amount|amount sanctioned|disbursed amount|credit limit|high credit/i.test(lower)) {
      const amtMatch = line.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/g);
      if (amtMatch) {
        const amt = parseAmount(amtMatch[amtMatch.length - 1]);
        if (isCardContext) {
          totalCardLimit += amt;
        } else {
          totalLoanSanctioned += amt;
        }
      }
    }
  }

  // Remove duplicate loan lines
  const uniqueLoans = [];
  const seen = new Set();
  for (const l of loans) {
    if (!seen.has(l.line)) {
      seen.add(l.line);
      uniqueLoans.push(l);
    }
  }

  // ---------- ENQUIRIES ----------
  let enquiryCount = 0;
  for (const line of lines) {
    if (/enquiry date|enquiry amount|credit enquiries/i.test(line.toLowerCase())) {
      enquiryCount++;
    }
  }

  // ---------- DPD / OVERDUE ----------
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
    dpd,
    totals: {
      loanSanctioned: totalLoanSanctioned,
      loanOutstanding: totalLoanOutstanding,
      cardLimit: totalCardLimit,
      cardOutstanding: totalCardOutstanding
    }
  };
}
