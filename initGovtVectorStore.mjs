import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function main() {
  // 1. Create vector store
  const vs = await client.vectorStores.create({
    name: "Kalki Govt Loan Schemes – 3 PDFs",
  });

  console.log("Created vector store:", vs.id);

  // 2. Upload your 3 scheme PDFs here.
  //    👉 Update paths as per actual location on server
  const files = [
    "./merged_latest.pdf",
    "./merged_schemes(1).pdf",
    "./Merged_Schemes.pdf",
  ];

  for (const path of files) {
    console.log("Uploading", path);
    await client.vectorStores.files.create(vs.id, {
      file: fs.createReadStream(path),
    });
  }

  console.log("\nAll files uploaded.");
  console.log("Save this as GOVT_SCHEMES_VECTOR_STORE_ID =", vs.id);
}

main().catch(err => {
  console.error("Error in initGovtVectorStore:", err);
  process.exit(1);
});
