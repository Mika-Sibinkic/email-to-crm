// Stage 3: Validate & Enrich
//
// Deterministic checks on the resolved contacts, in order: a minimum of name plus
// email or phone; phone normalization; splitting run-together company names taken
// from a domain ("acmeprivatewealth" -> "Acme Private Wealth"); flagging stubs for
// web research; type from the forwarder's note; name cleanup ("Doe, Jane" -> Jane Doe).
//
// Input: resolved contacts from Stage 2
// Output: validated contacts for CSV, Zoho, and the confirmation

const input = $input.first().json;
const contacts = input.contacts || [];
const forwarderInstruction = input.forwarderInstruction || '';
const suggestedType = input.suggestedType || '';

// Known company word dictionaries for domain splitting
// When company is derived from domain (e.g., "smithoneill" -> "Smith O'Neill"),
// we try known word boundaries and common business suffixes.

const commonWords = new Set([
  'air', 'capital', 'finance', 'financial',
  'group', 'global', 'world', 'bank', 'trust', 'wealth', 'asset', 'invest',
  'management', 'consulting', 'solutions', 'services', 'partners', 'associates',
  'tech', 'systems', 'digital', 'data', 'cloud', 'net', 'web', 'soft',
  'legal', 'law', 'counsel', 'insurance', 'property', 'real', 'estate',
  'media', 'creative', 'design', 'build', 'construct', 'energy', 'power',
  'health', 'care', 'medical', 'pharma', 'bio', 'life', 'science',
  'transport', 'logistics', 'ocean', 'scope',
  'micro', 'logic', 'macro', 'nano', 'mega', 'terra',
  'north', 'south', 'east', 'west', 'pacific', 'atlantic',
  'first', 'prime', 'elite', 'apex', 'peak', 'summit',
  'one', 'two', 'three', 'four', 'five', 'star', 'pro',
  'premier', 'trailer', 'broker', 'trading', 'supply', 'enterprises',
]);

function splitDomainCompany(domainName) {
  if (!domainName) return domainName;

  // Already has spaces? Return as-is
  if (/\s/.test(domainName)) return domainName;

  // Try camelCase split first
  const camelSplit = domainName.replace(/([a-z])([A-Z])/g, '$1 $2');
  if (camelSplit !== domainName) return camelSplit;

  // Try dictionary-based word boundary detection
  const lower = domainName.toLowerCase();
  let bestSplit = domainName;
  let bestScore = 0;

  // Try splitting at each position
  for (let i = 2; i < lower.length - 1; i++) {
    const left = lower.substring(0, i);
    const right = lower.substring(i);

    const leftMatch = commonWords.has(left) || left.length >= 4;
    const rightMatch = commonWords.has(right) || right.length >= 4;

    if (leftMatch && rightMatch) {
      const score = (commonWords.has(left) ? 2 : 1) + (commonWords.has(right) ? 2 : 1);
      if (score > bestScore) {
        bestScore = score;
        bestSplit = domainName.substring(0, i) + ' ' + domainName.substring(i);
      }
    }
  }

  // Capitalize each word
  if (bestScore > 0) {
    return bestSplit.replace(/\b\w/g, l => l.toUpperCase());
  }

  return domainName; // Can't split - return original
}

// Phone normalization helpers

function normalizePhone(phone) {
  if (!phone) return '';
  let p = phone.trim();
  // Strip common label prefixes: "M|", "O|", "F|", "C|", "W|", "D|"
  p = p.replace(/^[MOFCWD]\|\s*/i, '').trim();
  // Strip trailing labels: "office", "cell", "mobile", "work", "direct", "fax"
  p = p.replace(/\s*(office|cell|mobile|work|direct|fax)\s*$/i, '').trim();
  // Normalize "EXT:" / "ext." / "x" extension markers
  p = p.replace(/\s*(?:ext\.?|extension)\s*:?\s*/i, ' ext ').trim();
  return p;
}

function isUKPhone(phone) {
  return /^(?:\+?44|0)\s*\d{3,5}\s+\d{5,7}$/i.test(phone.trim());
}

// Name normalization

function fixName(firstName, lastName, email) {
  let fn = (firstName || '').trim();
  let ln = (lastName || '').trim();

  // Strip trailing punctuation (comma, period)
  fn = fn.replace(/[,.:;]+$/, '').trim();
  ln = ln.replace(/[,.:;]+$/, '').trim();

  // Detect "Last, First" format: if firstName has comma OR lastName is a single initial
  if (fn.includes(',')) {
    // "Broker, J." -> might be Last, First
    const parts = fn.split(',').map(p => p.trim());
    if (parts.length === 2) {
      // Swap: first part is last name, second is first name
      const possibleLast = parts[0];
      const possibleFirst = parts[1];
      fn = possibleFirst;
      ln = possibleLast;
    }
  }

  // If firstName is a single initial and we have an email, try to resolve
  if (fn.length <= 2 && email) {
    const localPart = email.split('@')[0].toLowerCase();
    // Common patterns: jbroker, jane.broker, j.broker
    const nameFromEmail = localPart.replace(/[._\-]/g, ' ').trim();
    const words = nameFromEmail.split(' ');

    if (words.length >= 2) {
      const emailFirst = words[0];
      // If email first name starts with the initial and is longer
      if (emailFirst.startsWith(fn.toLowerCase().replace('.', '')) && emailFirst.length > 2) {
        fn = emailFirst.charAt(0).toUpperCase() + emailFirst.slice(1);
      }
    } else if (words.length === 1 && words[0].length > 2) {
      // Single word like "jbroker" - try to split if last name matches
      const word = words[0];
      if (ln && word.includes(ln.toLowerCase())) {
        const prefix = word.replace(ln.toLowerCase(), '');
        if (prefix.length >= 2) {
          fn = prefix.charAt(0).toUpperCase() + prefix.slice(1);
        }
      }
    }
  }

  // Strip leading/trailing quotes and whitespace
  fn = fn.replace(/^["']|["']$/g, '').trim();
  ln = ln.replace(/^["']|["']$/g, '').trim();

  // Fix doubled first names: "Jane Jane" -> "Jane"
  if (fn.includes(' ')) {
    const parts = fn.split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
      fn = parts[0]; // Keep just one
    }
  }

  // Fix first name containing last name: "Jane Broker" in firstName -> split
  if (fn.includes(' ') && !ln) {
    const parts = fn.split(/\s+/);
    if (parts.length === 2) {
      fn = parts[0];
      ln = parts[1];
    }
  }

  // Fix doubled last names: "Broker Broker" -> "Broker"
  if (ln.includes(' ')) {
    const parts = ln.split(/\s+/);
    if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) {
      ln = parts[0];
    }
  }

  // Fix last name duplicated in first name: fn="John Broker" ln="Broker" -> fn="John" ln="Broker"
  if (fn.includes(' ') && ln) {
    const parts = fn.split(/\s+/);
    if (parts.length === 2 && parts[1].toLowerCase() === ln.toLowerCase()) {
      fn = parts[0];
    }
  }

  return { firstName: fn, lastName: ln };
}

// Valid contact types

// Edit to match your CRM's contact-type picklist.
const validTypes = [
  'Financial Institution', 'Broker', 'Customer', 'Attorney',
  'Partner', 'Insurance', 'Service Provider', 'Family Office',
  'Consultant', 'Other',
];

function resolveType(suggestedType, forwarderInstruction) {
  // Forwarder instruction takes priority
  const instruction = (forwarderInstruction || suggestedType || '').toLowerCase();

  for (const vt of validTypes) {
    if (instruction.includes(vt.toLowerCase())) return vt;
  }

  // Partial matches
  if (/funding/i.test(instruction)) return 'Financial Institution';
  if (/dealer|broker/i.test(instruction) && /dealer/i.test(instruction)) return 'Broker';
  if (/end\s*user/i.test(instruction)) return 'Customer';
  if (/attorney|lawyer|legal/i.test(instruction)) return 'Attorney';
  if (/finance\s*broker|loan\s*broker/i.test(instruction)) return 'Partner';
  if (/insurance/i.test(instruction)) return 'Insurance';
  if (/apprai|vendor/i.test(instruction)) return 'Service Provider';
  if (/family\s*office/i.test(instruction)) return 'Family Office';
  if (/broker/i.test(instruction)) return 'Broker';

  return suggestedType || '';
}

// Subject-named contact injection
// If the email subject names a specific person (e.g., "... - Jane Broker")
// and that person's email is in the headers but they weren't extracted by AI,
// inject them deterministically. The AI often ignores header-only contacts.
const originalSubject = input.originalSubject || '';
const externalEmails = input.externalEmails || [];
const existingContactEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));

// Extract name from subject: try multiple patterns
// Pattern 1: "- FirstName LastName" at end (e.g., "Request for Updated Quote - Jane Broker")
// Pattern 2: "FirstName LastName" anywhere that matches a header email's local part
const subjectPatterns = [
  /[-–—]\s*([A-Z][a-z]+)\s+([A-Z][a-z]+)\s*$/,           // "- First Last" at end
  /[-–—]\s*([A-Z][a-z]+)\s+([A-Z][a-z]+)/,                // "- First Last" anywhere
  /:\s*([A-Z][a-z]+)\s+([A-Z][a-z]+)/,                    // ": First Last"
];

for (const pattern of subjectPatterns) {
  const subjectNameMatch = originalSubject.match(pattern);
  if (!subjectNameMatch) continue;

  const subjFirst = subjectNameMatch[1];
  const subjLast = subjectNameMatch[2];
  const subjFullLower = `${subjFirst} ${subjLast}`.toLowerCase();

  // Skip if it matches an own-company staff name
  // Populate with the firm's own staff so their signatures are never extracted as contacts.
  const internalNames = ['alex example', 'pat example', 'taylor example', 'morgan example',
    'casey example', 'robin example', 'lee example'];
  if (internalNames.includes(subjFullLower)) continue;

  // Check if this person is already in contacts
  const alreadyFound = contacts.some(c => {
    const cName = `${(c.firstName || '')} ${(c.lastName || '')}`.toLowerCase().trim();
    return cName === subjFullLower || (c.lastName || '').toLowerCase() === subjLast.toLowerCase();
  });

  if (!alreadyFound) {
    // Find their email in headers
    const headerEmail = externalEmails.find(e => {
      const localPart = e.split('@')[0].toLowerCase().replace(/[._-]/g, ' ');
      return localPart.includes(subjFirst.toLowerCase()) || localPart.includes(subjLast.toLowerCase());
    });

    if (headerEmail && !existingContactEmails.has(headerEmail.toLowerCase())) {
      contacts.push({
        firstName: subjFirst,
        lastName: subjLast,
        email: headerEmail,
        phone: '',
        mobile: '',
        company: '',
        title: '',
        confidence: 'medium',
        _subjectInjected: true,
      });
      break; // Only inject one subject-named contact
    }
  }
}

// PROCESS EACH CONTACT

const validatedContacts = [];
let needsWebResearch = false;

for (const contact of contacts) {
  // Name normalization
  const fixed = fixName(contact.firstName, contact.lastName, contact.email);
  contact.firstName = fixed.firstName;
  contact.lastName = fixed.lastName;

  // Phone normalization
  contact.phone = normalizePhone(contact.phone);
  contact.mobile = normalizePhone(contact.mobile);

  // Phone dedup: if phone and mobile resolve to the same number, clear mobile
  if (contact.phone && contact.mobile) {
    const phoneDigits = contact.phone.replace(/\D/g, '');
    const mobileDigits = contact.mobile.replace(/\D/g, '');
    if (phoneDigits === mobileDigits) {
      contact.mobile = '';
    }
  }

  // Bare domain -> company name (e.g., "exampletrailerleasing.com" -> "Example Trailer Leasing")
  if (contact.company && /^[a-z0-9][-a-z0-9]*\.(com|net|org|co|io|us|uk|ca|de|fr|au|biz|info)$/i.test(contact.company.trim())) {
    const rawDomain = contact.company.trim();
    contact.company = splitDomainCompany(rawDomain.replace(/\.[a-z]+$/i, ''));
    contact._companyDerived = true;
  }

  // Company enrichment - split domain-derived names
  if (contact._companyDerived || !contact.company) {
    contact.company = splitDomainCompany(contact.company || '');
  }

  // Type assignment
  contact.contactType = resolveType(suggestedType, forwarderInstruction);

  // Completeness check
  const hasName = (contact.firstName || contact.lastName);
  const hasContactInfo = (contact.email || contact.phone || contact.mobile);

  if (!hasName) {
    // Skip contacts with no name
    continue;
  }

  // Skip contacts whose "name" looks like a company (contains LLC, Inc, Corp, Ltd, etc.)
  const fullNameStr = `${contact.firstName || ''} ${contact.lastName || ''}`.trim();
  if (/\b(LLC|Inc\.?|Corp\.?|Ltd\.?|PLC|LLP|Company|Co\.)\b/i.test(fullNameStr)) {
    continue;
  }

  // Skip contacts with suspiciously short names (likely AI parsing artifacts like "Wiz", "Wry")
  const fnLen = (contact.firstName || '').trim().length;
  const lnLen = (contact.lastName || '').trim().length;
  if (fnLen <= 3 && lnLen === 0 && !contact.email) {
    // Single short word with no last name and no email - almost certainly garbage
    continue;
  }
  if (fnLen <= 2 && lnLen <= 2) {
    // Both parts are initials or fragments - skip
    continue;
  }

  if (!hasContactInfo) {
    // Stub contact - needs web research
    contact.isStub = true;
    contact.needsWebResearch = true;
    contact.confidence = 'low';
    needsWebResearch = true;
  }

  // Clean up garbage titles - phrases that aren't real job titles
  if (contact.title) {
    const garbageTitles = ['part of the network', 'management', 'n/a', 'none', 'unknown',
      'not specified', 'not available', 'contact', 'person', 'individual'];
    if (garbageTitles.includes(contact.title.toLowerCase().trim())) {
      contact.title = '';
    }
  }

  // Safety net: strip contact's own name from title if it leaked through
  if (contact.title) {
    const fullNameLower = `${contact.firstName || ''} ${contact.lastName || ''}`.trim().toLowerCase();
    let t = contact.title;
    // Handle pipe-separated: "Name | Title | ..."
    if (t.includes('|')) {
      const parts = t.split('|').map(p => p.trim()).filter(p => p.length > 0);
      const clean = parts.filter(p => {
        const pl = p.toLowerCase();
        return pl !== fullNameLower &&
               pl !== (contact.firstName || '').toLowerCase() &&
               pl !== (contact.lastName || '').toLowerCase();
      });
      if (clean.length > 0 && clean.length < parts.length) {
        t = clean[0]; // Take first non-name part as the actual title
      }
    }
    // Handle "Name Title" prefix
    if (fullNameLower && t.toLowerCase().startsWith(fullNameLower)) {
      t = t.substring(fullNameLower.length).replace(/^[\s,|:\-]+/, '').trim();
    }
    contact.title = t;
  }

  // Build missing fields list
  const missingFields = [];
  if (!contact.email) missingFields.push('email');
  if (!contact.phone && !contact.mobile) missingFields.push('phone');
  if (!contact.company) missingFields.push('company');
  if (!contact.title) missingFields.push('title');
  contact.missingFields = missingFields;

  // Flag if web research could help
  if (missingFields.length >= 2 && !contact.isStub) {
    contact.needsWebResearch = true;
    needsWebResearch = true;
  }

  // Clean up internal fields
  delete contact._companyDerived;
  delete contact._chunkId;
  delete contact._chunkIndex;
  delete contact._senderHint;
  delete contact._fragmentIndex;
  delete contact._subjectInjected;

  validatedContacts.push(contact);
}

// Singular instruction filter
// If the forwarder said "her", "him", "this person", "add [Name]" (singular),
// keep only the BEST contact (most complete fields, highest confidence).
// This prevents over-extraction from CC headers in multi-party emails.
// EXCEPTION: If the subject line names a person who is NOT the best-scored contact,
// the subject person is likely also a target - don't filter down to 1.
const singularInstruction = /\b(her|him|this\s+person|this\s+contact|this\s+one|add\s+[A-Z][a-z]+\s+)/i.test(forwarderInstruction);
const pluralInstruction = /\b(both|all|them|everyone|each|two|three|these|2|3)\b/i.test(forwarderInstruction);

// Check if subject names a specific person (e.g., "Request for Updated Quote - Jane Broker")
const subjectNamedContact = validatedContacts.find(c => {
  const ln = (c.lastName || '').toLowerCase();
  const fn = (c.firstName || '').toLowerCase();
  return ln && originalSubject.toLowerCase().includes(ln);
});
// If subject names a contact, treat as wanting multiple (the subject person + the "her/him" person)
const subjectImpliesMultiple = subjectNamedContact && validatedContacts.length > 1;

if (singularInstruction && !pluralInstruction && !subjectImpliesMultiple && validatedContacts.length > 1) {
  // Score each contact by completeness
  const scored = validatedContacts.map(c => {
    let score = 0;
    if (c.email) score += 3;
    if (c.phone || c.mobile) score += 2;
    if (c.company) score += 1;
    if (c.title) score += 1;
    if (c.confidence === 'high') score += 2;
    else if (c.confidence === 'medium') score += 1;
    return { contact: c, score };
  });
  scored.sort((a, b) => b.score - a.score);

  // Keep only the best
  const best = scored[0].contact;
  validatedContacts.length = 0;
  validatedContacts.push(best);
}

// Output

return [{
  json: {
    contacts: validatedContacts,
    contactCount: validatedContacts.length,
    needsWebResearch,
    extractionStrategy: 'MULTI_STAGE_V4',
    needsReview: false,
    reviewReason: '',
    infoNotes: [],
    // Passthrough
    originalSubject: input.originalSubject || '',
    email_id: input.email_id || '',
    thread_id: input.thread_id || '',
    received_date: input.received_date || '',
    forwarderEmail: input.forwarderEmail || '',
    forwarderName: input.forwarderName || '',
    forwarderInstruction: input.forwarderInstruction || '',
    rawForwarderInstruction: input.rawForwarderInstruction || '',
    forwarderPreamble: input.forwarderPreamble || '',
    suggestedType: input.suggestedType || '',
    hasAttachments: input.hasAttachments || false,
    attachmentHints: input.attachmentHints || [],
    externalEmails: input.externalEmails || [],
    fullBody: input.fullBody || '',
    totalChunks: input.totalChunks || 1,
    totalFragments: input.totalFragments || 0,
    chunkSummaries: input.chunkSummaries || [],
    stage: 'VALIDATED',
  }
}];
