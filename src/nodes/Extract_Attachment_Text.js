// Extract Attachment Text
//
// Turns PDF and image attachments (including inline CID images such as photographed
// business cards) into text: pdftotext for PDFs, tesseract OCR for images.
// Input: the Graph attachment download ({ value: [...] }), plus Parse AI Response
// for the email context. Output: one item with pdfText, counts, attachmentNames,
// and the email fields Prepare PDF Extraction needs.

// A failed download should not lose the email; continue without the attachment.
const dlInput = $input.first().json;
if (dlInput.error || dlInput.statusCode >= 400) {
  const emailData = $('Parse AI Response').first().json;
  return [{ json: { ...emailData, attachmentDownloadFailed: true, extractedText: '' } }];
}
const prevData = $input.all()[0].json;
const attachments = prevData.value || [];

let allExtractedText = '';
const largeAttachmentsSkipped = [];
let pdfCount = 0;
let imageCount = 0;
const attachmentNames = [];

const fs = require('fs');
const { execSync } = require('child_process');

// A vCard (2.1, 3.0 or 4.0) rendered as the labeled lines of a signature block.
function vcardToText(raw) {
  const out = [];
  let name = '', nParts = [];
  // Folded lines continue with a leading space or tab.
  for (const line of raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    const m = line.match(/^(?:[\w-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const prop = m[1].toUpperCase(), params = m[2].toUpperCase();
    const parts = m[3].split(/(?<!\\);/).map(p => p.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim());
    const val = parts.join(' ').replace(/^tel:/i, '').trim();
    if (!val) continue;
    if (prop === 'FN') name = val;
    else if (prop === 'N') nParts = parts;
    else if (prop === 'ORG') out.push('Company: ' + parts.filter(Boolean).join(', '));
    else if (prop === 'TITLE') out.push('Title: ' + val);
    else if (prop === 'EMAIL') out.push('Email: ' + val);
    else if (prop === 'TEL') out.push((/CELL|MOBILE/.test(params) ? 'Mobile: ' : /FAX/.test(params) ? 'Fax: ' : 'Office: ') + val);
    else if (prop === 'URL') out.push('Website: ' + val);
    else if (prop === 'ADR') {
      // pobox; extended; street; city; region; postal code; country
      const [po, ext, street, city, region, code, country] = parts;
      out.push('Address: ' + [po, ext, street, city, [region, code].filter(Boolean).join(' '), country].filter(Boolean).join(', '));
    }
  }
  if (!name && nParts.length) name = [nParts[1], nParts[0]].filter(Boolean).join(' ');
  if (name) out.unshift('Name: ' + name);
  return out.join('\n');
}

for (const att of attachments) {
  const contentType = (att.contentType || '').toLowerCase();
  const name = att.name || 'unnamed';
  const base64Content = att.contentBytes || '';
  if (!base64Content) continue;
  
  const isPdf = contentType.includes('pdf') || name.toLowerCase().endsWith('.pdf');
  
  const isImage = contentType.includes('image') || /\.(jpg|jpeg|png|gif|tiff|bmp)$/i.test(name);

  const isVcard = contentType.includes('vcard') || /\.vcf$/i.test(name);
  if (isVcard && base64Content.length < 1024 * 1024) {
    attachmentNames.push(name);
    allExtractedText += '\n=== VCARD: ' + name + ' ===\n' + vcardToText(Buffer.from(base64Content, 'base64').toString('utf8'));
    continue;
  }
  
  // Large files would time out the node. Tesseract copes with big JPEGs, so images
  // get a higher limit than PDFs. The skip is recorded in the extracted text.
  const MAX_PDF_BYTES = 1024 * 1024;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const maxBytes = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  const estimatedBytes = Math.floor(base64Content.length * 0.75);
  if (estimatedBytes > maxBytes) {
    const sizeMB = (estimatedBytes / (1024 * 1024)).toFixed(1);
    const limitMB = (maxBytes / (1024 * 1024)).toFixed(0);
    allExtractedText += '\n=== ' + name + ' === [SKIPPED: ' + sizeMB + 'MB exceeds ' + limitMB + 'MB limit — contact info may be in this file]';
    attachmentNames.push(name + ' (skipped: ' + sizeMB + 'MB)');
    largeAttachmentsSkipped.push({ name: name, sizeMB: sizeMB });
    if (isPdf) pdfCount++;
    else if (isImage) imageCount++;
    continue;
  }
  
  // Calendar files, archives and the like carry no extractable text.
  if (!isPdf && !isImage) continue;
  
  // Tiny images are signature logos and icons. About 15KB decoded; set low enough
  // that small business-card photos still get through.
  if (isImage && base64Content.length < 20000) continue;
  
  const tmpPath = '/tmp/email_to_crm_att_' + Date.now() + '_' + (pdfCount + imageCount);
  
  try {
    if (isPdf) {
      pdfCount++;
      attachmentNames.push(name);
      const pdfPath = tmpPath + '.pdf';
      fs.writeFileSync(pdfPath, Buffer.from(base64Content, 'base64'));
      
      try {
        const text = execSync('pdftotext "' + pdfPath + '" - 2>/dev/null || echo "[pdftotext not installed — run: apt-get install -y poppler-utils]"',
          { encoding: 'utf8', timeout: 30000 });
        allExtractedText += '\n=== PDF: ' + name + ' ===\n' + text.substring(0, 10000);
      } catch(e) {
        allExtractedText += '\n=== PDF: ' + name + ' === [extraction failed]';
      }
      try { fs.unlinkSync(pdfPath); } catch(e) {}
      
    } else if (isImage) {
      imageCount++;
      attachmentNames.push(name);
      const ext = name.match(/\.(\w+)$/)?.[1] || 'png';
      const imgPath = tmpPath + '.' + ext;
      fs.writeFileSync(imgPath, Buffer.from(base64Content, 'base64'));
      
      // The container may not ship English OCR data; fetch it once into /data.
      const tessDataDir = '/data/tessdata';
      const tessDataFile = tessDataDir + '/eng.traineddata';
      if (!fs.existsSync(tessDataFile)) {
        try {
          if (!fs.existsSync(tessDataDir)) fs.mkdirSync(tessDataDir, { recursive: true });
          execSync('wget -q -O "' + tessDataFile + '" "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"', { timeout: 60000 });
        } catch (dlErr) {
          try { execSync('curl -sL -o "' + tessDataFile + '" "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"', { timeout: 60000 }); }
          catch (dlErr2) { allExtractedText += '\n=== ' + name + ' === [tessdata download failed]'; }
        }
      }
      
      try {
        // Without the downloaded data, tesseract's own installed language data is the fallback.
        const tessPrefix = fs.existsSync(tessDataFile) ? 'TESSDATA_PREFIX=' + tessDataDir + ' ' : '';
        const text = execSync(tessPrefix + 'tesseract "' + imgPath + '" stdout 2>&1 || echo "[tesseract OCR failed]"',
          { encoding: 'utf8', timeout: 60000 });
        // On failure the output is tesseract's error text, which the model would read as a card.
        allExtractedText += text.includes('[tesseract OCR failed]')
          ? '\n=== IMAGE OCR: ' + name + ' === [OCR failed]'
          : '\n=== IMAGE OCR: ' + name + ' ===\n' + text.substring(0, 8000);
      } catch(e) {
        allExtractedText += '\n=== IMAGE OCR: ' + name + ' === [OCR failed]';
      }
      try { fs.unlinkSync(imgPath); } catch(e) {}
    }
  } catch(writeErr) {
    allExtractedText += '\n=== ' + name + ' === [processing failed]';
  }
}

// Carry the email context forward; this node's input is the raw download response.
const parseData = $('Parse AI Response').first().json;
const fieldsToPass = ['contacts','contactCount','originalSubject','forwarderInstruction','suggestedType',
  'email_id','thread_id','received_date','forwarderEmail','detectionFlags','extractionStrategy',
  'needsReview','reviewReason','infoNotes','primaryUrl','hasAttachments','attachmentHints',
  'needsWebResearch','allUrls','hasUrls','fullBody'];
const passData = {};
for (const f of fieldsToPass) {
  passData[f] = parseData[f] ?? prevData[f] ?? '';
}

return [{
  json: {
    ...passData,
    pdfText: allExtractedText,
    pdfCount: pdfCount,
    largeAttachmentsSkipped: largeAttachmentsSkipped,
    imageCount: imageCount,
    attachmentNames: attachmentNames,
    hasPdfText: allExtractedText.length > 50
  }
}];