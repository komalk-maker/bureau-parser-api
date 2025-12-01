export function parseBureauReport(text) {
    
    const extractBetween = (text, start, end) => {
        const s = text.indexOf(start);
        if (s === -1) return null;
        const e = text.indexOf(end, s + start.length);
        if (e === -1) return text.substring(s + start.length).trim();
        return text.substring(s + start.length, e).trim();
    };

    // Score extraction (supports Experian/CIBIL/CRIF layouts)
    const scoreMatch = text.match(/(Credit Score|Experian Credit Score|CIBIL Score)[^\d]*(\d{3})/i);
    const score = scoreMatch ? parseInt(scoreMatch[2]) : null;

    // Extract loan accounts
    const loanLines = text.split("\n").filter(l =>
        l.match(/Loan|Account|Bank|Finance|Credit Card/i)
    );

    const loans = loanLines.map(l => ({
        line: l,
        type: l.match(/Home/i) ? "Home Loan" :
              l.match(/Personal/i) ? "Personal Loan" :
              l.match(/Credit Card/i) ? "Credit Card" :
              l.match(/Consumer/i) ? "Consumer Loan" : "Other",
        status: l.match(/active|open/i) ? "Active" :
                l.match(/closed/i) ? "Closed" : "Unknown"
    }));

    // Extract enquiries
    const enquiryMatch = text.match(/Enquiries|Credit Enquiries/gi);
    const enquiryCount = enquiryMatch ? enquiryMatch.length : 0;

    // Detect late payments
    const dpdMatch = text.match(/30|60|90|120/g);
    const hasDPD = dpdMatch ? "Possible DPD (needs manual check)" : "0 - Clean";

    return {
        score,
        loans,
        enquiryCount,
        dpd: hasDPD
    };
}
