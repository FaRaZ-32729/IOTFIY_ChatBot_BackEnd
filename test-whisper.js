import fs from 'fs';
import OpenAI from 'openai';
const openai = new OpenAI({ apiKey: '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' });

fs.writeFileSync('dummy_test.wav', 'RIFF...');
openai.audio.transcriptions.create({
  file: fs.createReadStream('dummy_test.wav'),
  model: 'whisper-1'
}).then(console.log).catch(err => console.error(err.message));