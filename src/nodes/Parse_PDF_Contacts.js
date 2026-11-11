// Parse PDF Contacts
//
// Parses the local model's reply for attachment text and merges those contacts into
// the ones already found in the email body. A contact whose email is already known
// only fills empty fields; new people are appended with extractionMethod PDF_OCR.
// Input: the Ollama response, plus Parse AI Response for the body contacts.
// Output: one item with the merged contacts[] and the email metadata.

// Organization settings
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];

// If the model call failed, keep the body contacts rather than losing the email.
const pdfAiInput = $input.first().json;
if (pdfAiInput.error || pdfAiInput.statusCode >= 400 || (!pdfAiInput.response && !(pdfAiInput.message && pdfAiInput.message.content))) {
  const emailData = $('Parse AI Response').first().json;
  return [{ json: { ...emailData, pdfExtractionFailed: true } }];
}
const prevData = $input.all()[0].json;
const rawResponse = prevData.message?.content || prevData.response || prevData.data || '';
const parseAIData = $('Parse AI Response').first().json;

// Deep copy so enriching a contact here never mutates Parse AI Response's output.
let contacts = JSON.parse(JSON.stringify(parseAIData.contacts || []));
const suggestedType = parseAIData.suggestedType || prevData.suggestedType || '';

// Small models often wrap the JSON in prose, so take the outermost {...} block.
let pdfContacts = [];
try {
  const responseStr = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);
  const jsonMatch = responseStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]);
    pdfContacts = parsed.contacts || [parsed];
  }
} catch(e) {}

const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()).filter(Boolean));
// What the model was shown; an address in neither text was invented (OCR failed, empty scan).
let sourceText = (parseAIData.fullBody || '').toLowerCase();
try { sourceText += '\n' + ($('Extract Attachment Text').first().json.pdfText || '').toLowerCase(); } catch (e) {}

for (const pc of pdfContacts) {
  // Small models write placeholders like "null" or "N/A" instead of leaving a field empty.
  for (const key of ['email', 'phone', 'mobile', 'firstName', 'lastName', 'title', 'jobTitle', 'companyName', 'city', 'state', 'country', 'website', 'address']) {
    if (pc[key] && typeof pc[key] === 'string') {
      const lower = pc[key].toLowerCase().trim();
      if (lower === 'null' || lower === 'none' || lower === 'n/a' || lower === 'undefined' || lower === 'not found' || lower === 'not available') {
        pc[key] = '';
      }
    }
  }
  
  // The model sometimes nests phones by label, e.g. {"office": "555-0100"}.
  if (pc.phone && typeof pc.phone === 'object') {
    const phoneVals = Object.values(pc.phone).filter(v => typeof v === 'string' && v.trim());
    const officeKeys = ['office', 'business', 'direct', 'work', 'main', 'tel', 'phone'];
    const mobileKeys = ['mobile', 'cell', 'cellular', 'personal'];
    let foundPhone = '', foundMobile = '';
    for (const [k, v] of Object.entries(pc.phone)) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const kLower = k.toLowerCase();
      if (mobileKeys.some(mk => kLower.includes(mk))) {
        foundMobile = foundMobile || v.trim();
      } else {
        foundPhone = foundPhone || v.trim();
      }
    }
    pc.phone = foundPhone || phoneVals[0] || '';
    if (foundMobile && !pc.mobile) pc.mobile = foundMobile;
  }
  if (pc.mobile && typeof pc.mobile === 'object') {
    pc.mobile = Object.values(pc.mobile).filter(v => typeof v === 'string')[0] || '';
  }
  
  // Labels leak into the value ("555-0100 office, direct", "Cell: 555-0101"); the
  // CRM should get the number only.
  function cleanPhone(val) {
    if (!val || typeof val !== 'string') return '';
    return val
      .replace(/\s*(?:office|direct|cell|mobile|home|work|fax|main|business|telephone|tel|phone|,\s*direct|,\s*cell|,\s*mobile|cell\/mobile|office,\s*direct)\s*$/i, '')
      .replace(/^\s*(?:office|direct|cell|mobile|home|work|fax|main|business|telephone|tel|phone)\s*[:.]\s*/i, '')
      .trim();
  }
  if (pc.phone && typeof pc.phone === 'string') pc.phone = cleanPhone(pc.phone);
  if (pc.mobile && typeof pc.mobile === 'string') pc.mobile = cleanPhone(pc.mobile);
  
  const email = (pc.email || '').toLowerCase().trim();
  const firstName = (pc.firstName || '').trim();
  const lastName = (pc.lastName || '').trim();
  
  if (!firstName && !lastName && !email) continue;
  
  // Your own staff appear on letterheads and signatures but are never contacts.
  const fullName = (firstName + ' ' + lastName).toLowerCase();
  if (OWN_STAFF.map(s => s.name.toLowerCase()).some(emp => fullName.includes(emp))) continue;
  
  if (email && !sourceText.includes(email)) continue;

  if (email && existingEmails.has(email)) {
    const existing = contacts.find(c => (c.email || '').toLowerCase() === email);
    if (existing) {
      if (!existing.jobTitle && (pc.title || pc.jobTitle)) existing.jobTitle = (pc.title || pc.jobTitle).trim();
      // A body company that never appears in the body text was guessed from the domain
      // ("Hollis Brandt" for hollisbrandt.example); the document's letterhead is real evidence.
      const squash = t => (t || '').toLowerCase().replace(/\s+/g, ' ');
      const guessed = existing.companyName && !squash(parseAIData.fullBody).includes(squash(existing.companyName).trim());
      if ((!existing.companyName || guessed) && pc.companyName) existing.companyName = pc.companyName.trim();
      if (!existing.phone && pc.phone) existing.phone = pc.phone.trim();
      if (!existing.mobile && pc.mobile) existing.mobile = pc.mobile.trim();
      if (!existing.city && pc.city) existing.city = pc.city.trim();
      if (!existing.state && pc.state) existing.state = pc.state.trim();
      if (!existing.website && pc.website) existing.website = pc.website.trim();
    }
    continue;
  }
  
  contacts.push({
    firstName: firstName,
    lastName: lastName,
    email: email,
    phone: (pc.phone || '').trim(),
    mobile: (pc.mobile || '').trim(),
    companyName: (pc.companyName || '').trim(),
    jobTitle: (pc.title || pc.jobTitle || '').trim(),
    city: (pc.city || '').trim(),
    state: (pc.state || '').trim(),
    address: (pc.address || '').trim(),
    country: (pc.country || '').trim(),
    website: (pc.website || '').trim(),
    type: suggestedType || pc.type || '',
    specificType: '',
    confidence: pc.confidence || 'medium',
    extractionMethod: 'PDF_OCR',
    infoNotes: ['Extracted from PDF/image attachment via OCR'],
    nickname: '',
    originalAiType: pc.type || ''
  });
  if (email) existingEmails.add(email);
}

// Limits how many CRM writes one document full of names can trigger.
const MAX = 15;
if (contacts.length > MAX) contacts = contacts.slice(0, MAX);

const fieldsToPass = ['originalSubject','forwarderInstruction','suggestedType','email_id','thread_id',
  'received_date','forwarderEmail','detectionFlags','extractionStrategy','needsReview',
  'reviewReason','infoNotes','primaryUrl','hasAttachments','attachmentHints',
  'needsWebResearch','allUrls','hasUrls','fullBody','largeAttachmentsSkipped'];
const passData = {};
for (const f of fieldsToPass) {
  passData[f] = parseAIData[f] ?? prevData[f] ?? '';
}

return [{
  json: {
    ...passData,
    contacts: contacts,
    contactCount: contacts.length,
    pdfExtracted: true,
    pdfContactsFound: pdfContacts.length,
    // Cleared so the attachment branch does not run a second time.
    hasPdfAttachment: false
  }
}];