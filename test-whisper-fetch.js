import fs from 'fs';
import FormData from 'form-data';
import fetch from 'node-fetch';

const form = new FormData();
form.append('file', fs.createReadStream('dummy_test.wav'));
form.append('model', 'whisper-1');

fetch('https://api.openai.com/v1/audio/transcriptions', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer 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',
    ...form.getHeaders()
  },
  body: form
}).then(res => res.text()).then(console.log).catch(err => console.error(err.message));