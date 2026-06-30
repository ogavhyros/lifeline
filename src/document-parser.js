const pdfParseLib = require('pdf-parse');
const pdfParse = typeof pdfParseLib === 'function' ? pdfParseLib : pdfParseLib.default;
const mammoth  = require('mammoth');
const fs       = require('fs');
const path     = require('path');

async function parseDocument(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const buf  = fs.readFileSync(filePath);
    const data = await pdfParse(buf);
    return { text: data.text, pages: data.numpages, type: 'pdf' };
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return { text: result.value, type: 'docx' };
  }

  if (mimeType === 'application/msword' || ext === '.doc') {
    try {
      const result = await mammoth.extractRawText({ path: filePath });
      return { text: result.value, type: 'doc' };
    } catch {
      const text = fs.readFileSync(filePath, 'utf8');
      return { text, type: 'doc' };
    }
  }

  if (mimeType === 'text/plain' || mimeType === 'text/markdown' || ext === '.txt' || ext === '.md') {
    const text = fs.readFileSync(filePath, 'utf8');
    return { text, type: 'text' };
  }

  throw new Error('Unsupported file type');
}

function cleanDocumentText(text) {
  let cleaned = text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\d+\s*$/gm, '')
    .trim();

  if (cleaned.length <= 8000) return cleaned;

  const first = cleaned.slice(0, 4000);
  const last  = cleaned.slice(-4000);
  return `${first}\n\n[... middle section truncated ...]\n\n${last}`;
}

module.exports = { parseDocument, cleanDocumentText };
