import fs from 'fs';
import { BufferInput, Base64Input, Client, product } from 'mindee';

async function test() {
  const client = new Client({ apiKey: 'md_5nhFrKQwTnyOx6ecbO1bnVSDtaIN5348B77nhIXs8Cs' });
  const modelId = 'c7f1a486-8f56-43f3-af62-b631535d60b3'; // the UUID from env
  
  const fileBuffer = fs.readFileSync('data/Mushaba Rag.pdf'); // just a dummy file
  const inputSource = new BufferInput({
    buffer: fileBuffer,
    filename: 'test.pdf',
  });

  try {
    console.log("Enqueueing...");
    const response = await client.enqueueAndGetResult(
      product.extraction.Extraction,
      inputSource,
      { modelId },
      {
        initialDelaySec: 2,
        delaySec: 1.5,
        maxRetries: 4,
      }
    );
    console.log("Success:", response.inference.result.fields);
  } catch (error) {
    console.error("Error:", error);
  }
}

test();
