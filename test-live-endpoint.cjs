const axios = require('axios');
const FormData = require('form-data');

async function test() {
  const formData = new FormData();
  // Create a tiny transparent 1x1 png
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  
  formData.append('image', pngBuffer, {
    filename: 'test.png',
    contentType: 'image/png',
  });

  try {
    console.log("Testing /api/card-scan endpoint (this may take 5-10 seconds)...");
    const response = await axios.post('http://localhost:5000/api/card-scan', formData, {
      headers: formData.getHeaders(),
      timeout: 60000 // 60 seconds
    });
    console.log("Success:", JSON.stringify(response.data, null, 2));
  } catch (error) {
    if (error.response) {
      console.error("Error Response:", error.response.status, error.response.data);
    } else {
      console.error("Error Message:", error.message);
    }
  }
}

test();
