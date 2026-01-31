import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

async function initVector() {
  const vector = await openai.vectorStores.create({
    name: "govt_schemes_india"
  });

  console.log("✅ GOVT VECTOR CREATED");
  console.log("VECTOR_ID =", vector.id);
}

initVector().catch(console.error);
