import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 👇 Use the vector store you already created
const VECTOR_STORE_ID = "vs_693473eeab30819190e07a471b50fe6b";

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY missing in .env");
  }

  console.log("Using vector store:", VECTOR_STORE_ID);

  const files = [
    "./merged_latest.pdf",
    "./merged_schemes (1).pdf",
    "./Merged_Schemes.pdf",
  ];

  for (const path of files) {
    console.log("\nUploading file:", path);

    // 1) Upload the file to the Files API
    const file = await client.files.create({
      file: fs.createReadStream(path),
      purpose: "assistants",
    });

    console.log("  → File uploaded with id:", file.id);

    // 2) Attach the file to the vector store
    const vsFile = await client.vectorStores.files.create(VECTOR_STORE_ID, {
      file_id: file.id,
    });

    console.log("  → Added to vector store as:", vsFile.id);
  }

  console.log("\nAll PDFs uploaded and attached to vector store successfully!");
}

main().catch((err) => {
  console.error("Error in uploadGovtFiles:", err);
  process.exit(1);
});
