import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const VECTOR_ID = process.env.GOVT_VECTOR_ID;

async function upload() {
  if (!VECTOR_ID) {
    throw new Error("Missing GOVT_VECTOR_ID");
  }

  const files = [
    "./docs/CGTMSE - Scheme Document CGS I_updated as on Apr 1 2025.pdf"
    // add more later
  ];

  for (const path of files) {
    const stream = fs.createReadStream(path);

    await openai.vectorStores.fileBatches.uploadAndPoll(
      VECTOR_ID,
      { files: [stream] }
    );

    console.log("📄 Uploaded:", path);
  }
}

upload().catch(console.error);
