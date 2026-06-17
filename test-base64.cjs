const { Base64Input, Client, product } = require('mindee');

async function test() {
  const client = new Client({ apiKey: 'md_5nhFrKQwTnyOx6ecbO1bnVSDtaIN5348B77nhIXs8Cs' });
  const modelId = 'c7f1a486-8f56-43f3-af62-b631535d60b3'; 
  
  // Create a base64 string
  const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  
  const base64Source = new Base64Input({ inputString: pngBase64, filename: 'test.png' });

  try {
    const response = await client.enqueueAndGetResult(
      product.extraction.Extraction,
      base64Source,
      { modelId },
      { initialDelaySec: 2, delaySec: 1.5, maxRetries: 2 }
    );
    console.log("Success");
  } catch (err) {
    console.error("Failed:", err.message);
  }
}

test();
