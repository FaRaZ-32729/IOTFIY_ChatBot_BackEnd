const axios = require('axios');
const FormData = require('form-data');

async function test() {
  const formData = new FormData();
  const pngBuffer = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
  
  formData.append('image', pngBuffer, {
    filename: 'test.png',
    contentType: 'image/png',
  });

  console.log("Testing endpoint...");
  try {
    const res = await axios.post('http://localhost:5000/api/card-scan', formData, {
      headers: formData.getHeaders(),
      timeout: 30000
    });
    console.log("SUCCESS!");
    console.log(res.data);
  } catch (err) {
    console.log("FULL ERROR:", err);
  }
}

test();
