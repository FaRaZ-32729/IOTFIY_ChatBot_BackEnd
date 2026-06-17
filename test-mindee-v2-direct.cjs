const axios = require('axios');
const FormData = require('form-data');

async function test() {
  const modelId = 'c7f1a486-8f56-43f3-af62-b631535d60b3';
  const apiKey = 'md_5nhFrKQwTnyOx6ecbO1bnVSDtaIN5348B77nhIXs8Cs';
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const fileBuffer = Buffer.from(pngBase64, 'base64');

  const formData = new FormData();
  formData.append('model_id', modelId);
  formData.append('file', fileBuffer, { filename: 'test.png', contentType: 'image/png' });

  try {
    const enqueueRes = await axios.post(
      `https://api-v2.mindee.net/v2/products/extraction/enqueue`, // v2 SDK uses this
      formData,
      {
        headers: { Authorization: apiKey, ...formData.getHeaders() }
      }
    );
    console.log('Success API v2 (enqueue):', enqueueRes.data);
  } catch (err) {
    console.error('Error API v2 (enqueue):', err.message, err.response?.data);
  }
}
test();
