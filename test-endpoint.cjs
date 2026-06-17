const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

async function test() {
  const form = new FormData();
  form.append('image', fs.readFileSync('data/Mushaba Rag.pdf'), 'card.pdf');
  
  try {
    const res = await axios.post('http://localhost:5000/api/card-scan', form, {
      headers: form.getHeaders(),
    });
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error("Status:", err.response?.status);
    console.error("Data:", err.response?.data);
  }
}
test();
