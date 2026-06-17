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
      headers: formData.getHeaders()
    });
    console.log("STATUS:", res.status);
    console.log("DATA:", res.data);
  } catch (err) {
    console.log("ERROR:", err.message);
    if (err.response) console.log("RES DATA:", err.response.data);
  }
}

test();
