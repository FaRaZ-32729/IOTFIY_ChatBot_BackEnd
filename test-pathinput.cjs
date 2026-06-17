const { PathInput, Client, product } = require('mindee');
const fs = require('fs');

async function test() {
  const client = new Client({ apiKey: 'md_5nhFrKQwTnyOx6ecbO1bnVSDtaIN5348B77nhIXs8Cs' });
  const modelId = 'c7f1a486-8f56-43f3-af62-b631535d60b3'; 
  
  const pathSource = new PathInput({ inputPath: 'data/Mushaba Rag.pdf' });

  try {
    const response = await client.enqueueAndGetResult(
      product.extraction.Extraction,
      pathSource,
      { modelId },
      { initialDelaySec: 2, delaySec: 1.5, maxRetries: 2 }
    );
    console.log("Success");
  } catch (err) {
    console.error("Failed:", err.message);
  }
}

test();
