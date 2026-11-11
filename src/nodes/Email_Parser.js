// Email Parser
//
// Reads what the forwarder asked for before any model sees the email. Pulls out the
// forwarder's own note at the top of the body (with their signature trimmed off),
// the line that mentions the CRM ("Family Office for Zoho"), and a contact type from
// that line or the subject. Also lists URLs and email addresses, splits own-domain
// from external addresses, and picks an extraction strategy (body, PDF, image, URL).
//
// Input: Map Outlook to Standard Format items, one per email.
// Output: { originalSubject, fullBody, forwarderInstruction, rawForwarderInstruction,
// forwarderPreamble, suggestedType, externalEmails, detectionFlags,
// extractionStrategy, ...email metadata } per email; skip items pass through.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];
const OWN_TAGLINE = 'Your Company Tagline Here';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_DOMAIN_RE = [...OWN_DOMAINS].map(escapeRe).join('|');
const OWN_TAGLINE_LOWER = OWN_TAGLINE.toLowerCase();
const OWN_FIRST_NAMES = OWN_STAFF.map(s => s.name.split(' ')[0].toLowerCase());
const hasOwnDomain = text => [...OWN_DOMAINS].some(d => text.toLowerCase().includes(d));

const allItems = $input.all();
const allResults = [];

for (const _item of allItems) {

// Map Outlook already rejected this email.
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

const email = _item.json;
const subject = email.subject || '';
const body = email.body || '';
const fullContent = `${subject}\n${body}`;

// The forwarder's note sits at the top of the body, before any "From:", separator or
// forwarded-message marker. It is the raw instruction ("Add Jane Doe as Family Office
// in Zoho") and later nodes read it to decide who the target is.

const bodyLines = body.split(/\r?\n/);
const forwarderPreambleLines = [];

// Outlook forwards often start with the forwarder's own header block:
//   From: Pat Staffer <pat@yourcompany.com>
//   Sent: Thursday, January 2, 2025 10:30 AM
//   To: contacts@yourcompany.com
//   Subject: Fw: Family Office for Zoho
//   <blank line>
//   <the actual note>
// Skip it, or the preamble would be empty.

let startIndex = 0;

const firstLineTrimmed = (bodyLines[0] || '').trim();
const startsWithInternalFrom = /^from:\s/i.test(firstLineTrimmed) &&
  hasOwnDomain(firstLineTrimmed);

if (startsWithInternalFrom) {
  // Skip past From/Sent/To/Subject/CC header lines + trailing blanks
  for (let i = 0; i < Math.min(bodyLines.length, 20); i++) {
    const line = bodyLines[i].trim();
    if (/^(?:from|sent|to|cc|bcc|date|subject|reply-to):\s/i.test(line)) {
      startIndex = i + 1;
      continue;
    }
    // Skip blank lines immediately after header block
    if (!line && startIndex > 0 && i === startIndex) {
      startIndex = i + 1;
      continue;
    }
    // Past the header block: stop skipping.
    if (startIndex > 0 && line) break;
  }
}

const preambleStopPatterns = [
  /^-{3,}\s*(forwarded|original)/i,
  /^_{3,}/,
  /^={3,}/,
  /^begin\s+forwarded\s+message/i,
  new RegExp('^from:\\s+[^@]*@(?!' + OWN_DOMAIN_RE + ')', 'i'),   // an outside From: starts the forwarded content
  /^on\s+\w{3},\s+\w{3}\s+\d/i,              // "On Mon, Jan 6..." = quoted reply header
  /^sent:\s/i,
  new RegExp('^to:\\s+[^@]*@(?!' + OWN_DOMAIN_RE + ')', 'i')
];

for (let i = startIndex; i < bodyLines.length; i++) {
  const line = bodyLines[i].trim();

  // Stop at forwarded content markers
  if (preambleStopPatterns.some(p => p.test(line))) break;

  // An outside address on a header-like line means the forwarded part has begun.
  if (/^(?:from|to|cc|bcc):\s/i.test(line) && !hasOwnDomain(line)) break;

  // Leading blank lines are not part of the note.
  if (line || forwarderPreambleLines.length > 0) {
    forwarderPreambleLines.push(line);
  }

  // A real note is a few lines; past 15 we are reading something else.
  if (forwarderPreambleLines.length > 15) break;
}

// Trim trailing blank lines
while (forwarderPreambleLines.length > 0 && !forwarderPreambleLines[forwarderPreambleLines.length - 1]) {
  forwarderPreambleLines.pop();
}

// The collected note usually ends with the forwarder's own signature (name, title,
// tagline, phones, address, URL, disclaimer). Its staff phones and names would
// otherwise look like a contact, so cut at the first line where the signature starts.

function trimInternalSignature(lines) {
  if (lines.length <= 1) return lines;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue; // blanks decide nothing; look at what follows

    const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : '';

    // A name alone on a line followed by a title, phone, tagline or URL.
    const looksLikeName = /^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){0,2}$/.test(line)
                          && line.length < 40;
    if (looksLikeName) {
      const nextIsSignature =
        /^(?:president|vice|vp|director|ceo|cfo|coo|cto|managing|principal|founder|partner|sr\.|svp|evp|avp)/i.test(nextLine) ||
        /^(?:mobile|office|cell|fax|tel|phone|direct)\s*:/i.test(nextLine) ||
        /^(?:the\s+largest|www\.|http)/i.test(nextLine) ||
        nextLine.toLowerCase().startsWith(OWN_TAGLINE_LOWER) ||
        /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(nextLine);

      if (nextIsSignature) {
        let cutPoint = i;
        while (cutPoint > 0 && !lines[cutPoint - 1].trim()) cutPoint--;
        return lines.slice(0, cutPoint);
      }
    }

    // A labeled phone line ("mobile: 555.010.0101") with no name directly above.
    if (/^(?:mobile|office|cell|fax|tel|phone|direct)\s*:\s*[\d(+]/i.test(line)) {
      let cutPoint = i;
      // The name and title above it belong to the same signature.
      while (cutPoint > 0) {
        const prevLine = lines[cutPoint - 1].trim();
        if (!prevLine) { cutPoint--; continue; }
        const prevIsNameOrTitle =
          (/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){0,2}$/.test(prevLine) && prevLine.length < 40) ||
          /^(?:president|vice|vp|director|ceo|cfo|coo|cto|managing|principal|founder|partner|sr\.|svp|evp|avp)/i.test(prevLine);
        if (prevIsNameOrTitle) { cutPoint--; } else break;
      }
      return lines.slice(0, cutPoint);
    }

    // Disclaimer boilerplate ("This e-mail contains CONFIDENTIAL INFORMATION...").
    if (/^this\s+(?:e-?mail|message|communication|email)\s+(?:contains|is|may)/i.test(line)) {
      let cutPoint = i;
      while (cutPoint > 0 && !lines[cutPoint - 1].trim()) cutPoint--;
      return lines.slice(0, cutPoint);
    }

    // A company tagline ("Your Company Tagline Here", "The Leading ...").
    if ((/^(?:the\s+largest|america'?s\s+|#1\s+|leading\s+)/i.test(line) || line.toLowerCase().startsWith(OWN_TAGLINE_LOWER)) && line.length < 80) {
      let cutPoint = i;
      while (cutPoint > 0) {
        const prevLine = lines[cutPoint - 1].trim();
        if (!prevLine) { cutPoint--; continue; }
        const prevIsNameOrTitle =
          (/^[A-Z][a-z]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]+){0,2}$/.test(prevLine) && prevLine.length < 40) ||
          /^(?:president|vice|vp|director|ceo|cfo|coo|cto|managing|principal|founder|partner|sr\.|svp|evp|avp)/i.test(prevLine);
        if (prevIsNameOrTitle) { cutPoint--; } else break;
      }
      return lines.slice(0, cutPoint);
    }
  }

  return lines;
}

const trimmedPreambleLines = trimInternalSignature(forwarderPreambleLines);
const forwarderPreamble = trimmedPreambleLines.join('\n').trim();

// The instruction is the first line that mentions the CRM ("for Zoho", "in CRM", "to Z").

let forwarderInstruction = '';
let rawForwarderInstruction = '';   // the whole line, before trailing chatter is cut

const zohoLineRegex = /\b(?:zoho|crm)\b|\b(?:for|to|in|into)\s+z\b/i;
const skipPatterns = [
  /^\s*(?:from|to|cc|bcc|sent|date|subject):/i,
  new RegExp(OWN_DOMAIN_RE, 'i'),
  /confidential/i,
  // Staff signature lines ("Pat Staffer, Managing Director") and the tagline are never the instruction.
  ...OWN_STAFF.map(s => new RegExp('\\b' + escapeRe(s.name).replace(/\s+/g, '\\s+') + '\\b.*\\b' + escapeRe(s.title).replace(/\s+/g, '\\s+'), 'i')),
  new RegExp('\\b' + escapeRe(OWN_TAGLINE_LOWER).replace(/\s+/g, '\\s+'), 'i'),
  /^\s*\[/,
  /^\s*$/
];

const candidates = [];
for (let i = 0; i < bodyLines.length; i++) {
  const line = bodyLines[i].trim();
  if (!line) continue;
  if (!zohoLineRegex.test(line)) continue;
  if (skipPatterns.some(p => p.test(line))) continue;
  if (/^[a-z]+@/i.test(line)) continue;
  candidates.push({ line, index: i });
}

if (candidates.length > 0) {
  rawForwarderInstruction = candidates[0].line;
  forwarderInstruction = candidates[0].line;

  const commaAfterZoho = forwarderInstruction.match(/^(.+?(?:zoho|crm|\bz\b)[\s,.]*)(.*)$/i);
  if (commaAfterZoho && commaAfterZoho[2]) {
    const afterPart = commaAfterZoho[2].trim();
    // "Family Office for Zoho, Pat please check" keeps only the part up to the CRM word.
    if (new RegExp('^(?:' + OWN_FIRST_NAMES.map(escapeRe).join('|') + '|please|you|we|they|make|get|check)', 'i').test(afterPart)) {
      forwarderInstruction = commaAfterZoho[1].trim().replace(/[,.:]+$/, '').trim();
    }
  }
} else {
  // No CRM word: fall back to an early short line that reads like a request ("add", "needs").
  for (let i = 0; i < Math.min(bodyLines.length, 10); i++) {
    const line = bodyLines[i].trim();
    if (!line) continue;
    if (skipPatterns.some(p => p.test(line))) continue;
    if (/^[a-z]+@/i.test(line)) continue;
    // The length cap keeps forwarded paragraphs out; a line of the forwarder's own note is the note.
    if ((line.length < 120 || forwarderPreamble.includes(line)) && /\b(add|put|make sure|needs|should|get|database|data base)\b/i.test(line)) {
      rawForwarderInstruction = line;
      forwarderInstruction = line;
      break;
    }
  }
}

// Contact type: exact type names win over keywords, the cleaned instruction over the raw
// line, and the instruction over the subject. Order inside each list matters: first hit wins.

// Edit to match your CRM's contact-type picklist.
const VALID_TYPES = ["Attorney", "Broker", "Customer", "Employee", "Family Office", "Financial Institution",
  "Industry Resource", "Insurance", "Investment Advisor", "Management Company", "Manufacturer",
  "Marketing", "Partner", "Service Provider"];

// Edit to match your CRM's contact-type picklist.
const TYPE_KEYWORDS = {
  "dealer broker": "Broker", "dealer": "Broker", "broker": "Broker",
  "bank": "Financial Institution", "lender": "Financial Institution", "funding source": "Financial Institution",
  "funding": "Financial Institution", "finance broker": "Partner", "finance": "Partner",
  "insurance": "Insurance", "attorney": "Attorney",
  "lawyer": "Attorney", "legal": "Attorney",
  "appraiser": "Service Provider",
  "management": "Management Company", "mgmt": "Management Company",
  "escrow": "Service Provider",
  "title company": "Service Provider",
  "manufacturer": "Manufacturer", "customer": "Customer", "end user": "Customer",
  "family office": "Family Office", "ria": "Investment Advisor",
  "investment advisor": "Investment Advisor",
  "vendor": "Service Provider"
};

let suggestedType = '';
let typeFromSubject = false;

if (forwarderInstruction) {
  let typeCandidate = forwarderInstruction
    .replace(/\b(?:for|got|to|into|in|our|the|this|from|needs?|should|be|added|put|make\s*sure)\b/gi, ' ')
    .replace(/\b(?:zoho|crm|database|data\s*base)\b/gi, ' ')
    .replace(/\bz\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  const cleanLower = typeCandidate.toLowerCase();
  const origLower = forwarderInstruction.toLowerCase();
  for (const type of VALID_TYPES) {
    if (cleanLower.includes(type.toLowerCase())) { suggestedType = type; break; }
  }
  if (!suggestedType) {
    for (const [keyword, type] of Object.entries(TYPE_KEYWORDS)) {
      if (cleanLower.includes(keyword)) { suggestedType = type; break; }
    }
  }
  if (!suggestedType) {
    for (const type of VALID_TYPES) {
      if (origLower.includes(type.toLowerCase())) { suggestedType = type; break; }
    }
  }
  if (!suggestedType) {
    for (const [keyword, type] of Object.entries(TYPE_KEYWORDS)) {
      if (origLower.includes(keyword)) { suggestedType = type; break; }
    }
  }
}

// A note with no CRM word or request verb can still end by naming the type ("Met him at the
// expo. Broker"). Only a bare type at the end of a line of the forwarder's own note counts.
if (!suggestedType && !forwarderInstruction) {
  const bareType = new RegExp('(?:^|[.!?;:]\\s+)(' + VALID_TYPES.map(escapeRe).join('|') + ')\\s*[.!]?$', 'i');
  for (const line of trimmedPreambleLines) {
    const m = line.trim().match(bareType);
    if (m) { suggestedType = VALID_TYPES.find(t => t.toLowerCase() === m[1].toLowerCase()); break; }
  }
}

if (!suggestedType && subject) {
  const subjectLower = subject.toLowerCase().replace(/^(re|fw|fwd):\s*/gi, '');
  for (const type of VALID_TYPES) {
    if (subjectLower.includes(type.toLowerCase())) { suggestedType = type; typeFromSubject = true; break; }
  }
  if (!suggestedType) {
    for (const [keyword, type] of Object.entries(TYPE_KEYWORDS)) {
      // Word start only: "refinance" in a subject is not the "finance" keyword.
      if (new RegExp('\\b' + escapeRe(keyword)).test(subjectLower)) { suggestedType = type; typeFromSubject = true; break; }
    }
  }
}

// URLs feed web research; mail-provider and own-company links never identify a contact.

const urlRegex = /https?:\/\/[^\s<>"')\]]+/gi;
const subjectUrls = [...new Set((subject.match(urlRegex) || []))];
const bodyUrls = [...new Set((body.match(urlRegex) || []))];

const skipDomains = [
  ...OWN_DOMAINS, 'outlook.com', 'office.com', 'microsoft.com',
  'google.com', 'gmail.com', 'aka.ms', 'office365.com', 'live.com',
  'microsoftonline.com', 'sharepoint.com'
];
const filterUrls = (urls) => urls.filter(u => {
  const lower = u.toLowerCase();
  return !skipDomains.some(d => lower.includes(d));
});

const relevantSubjectUrls = filterUrls(subjectUrls);
const relevantBodyUrls = filterUrls(bodyUrls);
const allRelevantUrls = [...new Set([...relevantSubjectUrls, ...relevantBodyUrls])];


const emailRegex2 = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const allEmails = [...new Set(fullContent.match(emailRegex2) || [])];
const internalDomains = [...OWN_DOMAINS];
const internalEmails = allEmails.filter(e => internalDomains.some(d => e.toLowerCase().includes(d)));
const externalEmails = allEmails.filter(e => !internalDomains.some(d => e.toLowerCase().includes(d)));

// The target is usually in the last forwarded section that has an outside address.

const sectionMarkers = [
  /[-]{3,}\s*forwarded\s+message/i, /begin\s+forwarded\s+message/i,
  /from:\s*[^\n]+\n/i, /on\s+[a-z]{3},\s+[a-z]{3}\s+\d+/i
];

let sections = [body];
for (const marker of sectionMarkers) {
  const newSections = [];
  for (const section of sections) {
    const parts = section.split(marker);
    newSections.push(...parts);
  }
  if (newSections.length > sections.length) sections = newSections;
}

const externalSections = sections.filter(section =>
  externalEmails.some(email => section.includes(email))
);
const targetSection = externalSections.length > 0
  ? externalSections[externalSections.length - 1] : body;


const detectionFlags = [];

const hasImageAttachment = (email.attachmentHints || []).includes('IMAGE');
if (hasImageAttachment && externalEmails.length === 0) detectionFlags.push('IMAGE_ONLY');

const hasPdfAttachment = (email.attachmentHints || []).includes('PDF');
if (hasPdfAttachment) detectionFlags.push('PDF_ATTACHMENT');

const hasImageAttachmentFile = (email.attachmentHints || []).includes('IMAGE');
if (hasImageAttachmentFile && !detectionFlags.includes('IMAGE_ONLY')) {
  detectionFlags.push('IMAGE_ATTACHMENT');
}

const hasUrls = allRelevantUrls.length > 0;
if (hasUrls && externalEmails.length === 0) detectionFlags.push('URL_ONLY');

const multiHints = /\b(team|all|these|everyone|group|staff|members|them)\b/i;
if (multiHints.test(forwarderInstruction) || multiHints.test(body.substring(0, 200)) || externalEmails.length > 1) {
  detectionFlags.push('MULTI_CONTACT');
}

const forwarderLower = (email.forwarderEmail || '').toLowerCase();
if (forwarderLower && !hasOwnDomain(forwarderLower)) {
  detectionFlags.push('EXTERNAL_FORWARDER');
}


const determineExtractionStrategy = () => {
  const flags = detectionFlags;
  const hasBodyContact = externalEmails.length > 0;

  if ((hasImageAttachment || hasPdfAttachment) && hasBodyContact) return 'MIXED_SOURCES';
  if (flags.includes('IMAGE_ONLY')) return 'IMAGE_OCR';
  if (hasPdfAttachment && !hasBodyContact) return 'PDF_EXTRACTION';
  if (flags.includes('URL_ONLY')) return 'URL_DISCOVERY';
  if (externalEmails.length > 1) return 'MULTI_CONTACT_BODY';
  if (hasUrls && hasBodyContact) return 'BODY_ONLY';

  return 'BODY_ONLY';
};

const extractionStrategy = determineExtractionStrategy();
const forceWebResearch = extractionStrategy === 'URL_DISCOVERY';

allResults.push({
  json: {
    originalSubject: subject,
    fullBody: body,
    forwarderInstruction: forwarderInstruction,
    rawForwarderInstruction: rawForwarderInstruction,
    forwarderPreamble: forwarderPreamble,
    suggestedType: suggestedType,
    typeFromSubject: typeFromSubject,
    subjectUrls: relevantSubjectUrls,
    bodyUrls: relevantBodyUrls,
    allUrls: allRelevantUrls,
    hasUrls: hasUrls,
    primaryUrl: relevantSubjectUrls[0] || relevantBodyUrls[0] || '',
    allEmailsFound: allEmails,
    internalEmails: internalEmails,
    externalEmails: externalEmails,
    targetSection: targetSection,
    totalSectionsFound: sections.length,
    externalSectionsFound: externalSections.length,
    hasTypeHint: suggestedType !== '',
    detectionFlags: detectionFlags,
    hasDetectionFlags: detectionFlags.length > 0,
    skipZohoUpsert: false,
    extractionStrategy: extractionStrategy,
    forceWebResearch: forceWebResearch,
    hasAttachments: email.hasAttachments || false,
    attachmentHints: email.attachmentHints || [],
    email_id: email.email_id || '',
    thread_id: email.thread_id || '',
    received_date: email.received_date || '',
    forwarderEmail: email.forwarderEmail || '',
    forwarderName: email.forwarderName || '',
    rawHtml: email.rawHtml || ''
  }
});

} // end of per-email loop

return allResults;
