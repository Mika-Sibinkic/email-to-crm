// Prepare Extraction Request
//
// Builds the request for the local model. The model is asked to reason about who the
// forwarder wants logged, not to collect every address in the thread, so this node
// does the groundwork first: it trims the thread to the sections that carry contact
// signals, classifies where each outside address appears, works out the scope of
// the instruction (a named person, a type, "both", a company, or nothing), and puts
// that in front of the email text. It also OCRs large inline images, which is where
// some newsletters keep their contact cards.
//
// Input: Email Parser items, one per email.
// Output: { requestBody, inlineOcrText, pruningStats, instructionScope,
// contactClassifications, ... } per email, or aiSkipped=true when nothing is left
// to read. Skip items pass through.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
const OWN_COMPANY_NAMES = ['Your Company'];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const OWN_DOMAIN_RE = [...OWN_DOMAINS].map(escapeRe).join('|');

const allItems = $input.all();
const allResults = [];

for (const _item of allItems) {

// Map Outlook already rejected this email.
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

const input = _item.json;
let _inlineOcrText = '';
const fullBody = (input.fullBody || input.body || '').trim();
const subject = input.originalSubject || input.subject || '';
const fromEmail = input.forwarderEmail || input.fromEmail || '';
const externalEmails = input.externalEmails || [];
const forwarderInstruction = input.forwarderInstruction || '';
const rawForwarderInstruction = input.rawForwarderInstruction || '';
const forwarderPreamble = input.forwarderPreamble || '';
const suggestedType = input.suggestedType || '';

// Contact signals decide which sections of a long thread are worth sending.

function hasPhoneNumber(text) {
  if (/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(text)) return true;
  if (/\+\d{1,3}[\s.\-]\(?\d{1,4}\)?[\s.\-]\d{2,4}[\s.\-]\d{3,4}/.test(text)) return true;
  if (/(?:phone|tel|cell|mobile|office|direct|fax)\s*[:.]\s*[\d(+]/i.test(text)) return true;
  return false;
}

function hasStreetAddress(text) {
  if (/\d{1,6}\s+[A-Z][a-z]+\s+(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Rd|Road|Ln|Lane|Way|Ct|Court|Pl|Place|Pkwy|Parkway|Cir|Circle|Hwy|Highway)\b/i.test(text)) return true;
  if (/\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/.test(text)) return true;
  if (/\bP\.?O\.?\s*Box\s+\d+/i.test(text)) return true;
  return false;
}

function hasRelevantTitle(text) {
  return /\b(?:president|vice\s*president|vp|director|manager|ceo|cfo|coo|cto|cio|founder|co-founder|partner|managing\s+director|principal|officer|advisor|adviser|analyst|associate|broker|attorney|lawyer|counsel|captain|appraiser|consultant|specialist|coordinator|administrator|executive|head\s+of|chief|senior|sr\.|svp|evp|avp|wealth\s+manag|financial\s+advis|portfolio\s+manag|relationship\s+manag|loan\s+officer|account\s+exec|business\s+develop|private\s+bank|trust\s+officer|estate\s+plan|investment\s+bank)\b/i.test(text);
}

function hasExternalEmail(text, externalEmails) {
  for (const email of externalEmails) {
    if (text.toLowerCase().includes(email.toLowerCase())) return true;
  }
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const found = text.match(emailPattern) || [];
  return found.some(e => ![...OWN_DOMAINS].some(d => e.toLowerCase().includes(d)));
}

function hasUrl(text) {
  return /(?:https?:\/\/|www\.)[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/i.test(text);
}

// Three or more legal terms in one paragraph means a disclaimer, not contact data.

function isComplianceBoilerplate(text) {
  const legalTerms = [
    /\bconfidential\b/i, /\bprivilege/i, /\bunauthorized\b/i,
    /\bprohibit/i, /\bdisclaim/i, /\bintended\s+(only|solely)\b/i,
    /\bnotify\s+the\s+sender\b/i, /\bdelete\b/i, /\bdestroy\b/i,
    /\bSEC[- ]registered\b/i, /\bFINRA\b/, /\bSIPC\b/,
    /\bbroker[\s/-]*dealer\b/i, /\binvestment\s+advis/i,
    /\bregistered\s+(investment|broker)/i, /\blicensed\s+insurance/i,
    /\bseparate\s+and\s+distinct\b/i, /\bgoverned\s+by\s+different/i,
    /\bBroker\s*Check\b/i, /\bAdviser\s*Check\b/i,
    /\bdo\s+not\s+(copy|distribute|forward|disseminate|print|retain)\b/i,
    /\breceived\s+this\s+(e-?mail|message)\s+in\s+error\b/i,
    /\bstrictly\s+prohibited\b/i
  ];
  return legalTerms.filter(re => re.test(text)).length >= 3;
}

function stripBoilerplate(text) {
  const paragraphs = text.split(/\n{2,}/);
  const cleaned = [];
  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;
    if (isComplianceBoilerplate(trimmed)) continue;
    if (/you don'?t often get email from/i.test(trimmed)) continue;
    if (/learn why this is important/i.test(trimmed)) continue;
    cleaned.push(trimmed);
  }
  return cleaned.join('\n\n');
}

// Every reply repeats the same signature; only its first copy is worth tokens.

function normalizeForHash(text) {
  return text.replace(/\s+/g, ' ').toLowerCase().trim();
}

function extractSignatureBlock(sectionText) {
  const lines = sectionText.split('\n');
  let sigStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (hasPhoneNumber(line) || hasStreetAddress(line) ||
        /^www\./i.test(line) || /^https?:\/\//i.test(line) ||
        /^\d{3}[.\-]\d{3}[.\-]\d{4}/.test(line)) {
      if (sigStart === -1) sigStart = Math.max(0, i - 1);
    }
  }
  if (sigStart >= 0) return normalizeForHash(lines.slice(sigStart).join('\n'));
  return null;
}

// Split at each From:, keep sections with signals, cap at 6000 chars for the 4k context.

function extractContactSignals(body, externalEmails) {
  const sectionSplitter = /(?=(?:^|\n)(?:-{3,}|_{3,}|={3,})?\s*\n?From:\s)/i;
  let sections = body.split(sectionSplitter).filter(s => s.trim().length > 20);

  if (sections.length <= 1) {
    const cleaned = stripBoilerplate(body);
    return {
      result: cleaned.substring(0, 6000),
      stats: { originalChars: body.length, finalChars: cleaned.length, sections: 1, kept: 1, skipped: 0, method: 'single-section' }
    };
  }

  const kept = [];
  let skipped = 0;
  const seenSignatures = new Set();
  const seenBodyText = new Set();

  for (const section of sections) {
    let cleaned = stripBoilerplate(section);
    if (cleaned.trim().length < 20) { skipped++; continue; }

    const sigHash = extractSignatureBlock(cleaned);
    let sigIsDuplicate = false;
    if (sigHash && seenSignatures.has(sigHash)) {
      sigIsDuplicate = true;
      const lines = cleaned.split('\n');
      const msgLines = [];
      let hitSig = false;
      for (const line of lines) {
        if (!hitSig && (hasPhoneNumber(line) || /^\d{3}[.\-]\d{3}[.\-]\d{4}/.test(line.trim()))) hitSig = true;
        if (!hitSig) msgLines.push(line);
      }
      cleaned = msgLines.join('\n').trim();
    }
    if (sigHash) seenSignatures.add(sigHash);

    const bodyHash = normalizeForHash(cleaned.substring(0, 300));
    if (bodyHash.length > 50 && seenBodyText.has(bodyHash)) { skipped++; continue; }
    if (bodyHash.length > 50) seenBodyText.add(bodyHash);

    let signalCount = 0;
    if (hasPhoneNumber(cleaned)) signalCount++;
    if (hasStreetAddress(cleaned)) signalCount++;
    if (hasExternalEmail(cleaned, externalEmails)) signalCount++;
    if (hasUrl(cleaned)) signalCount++;
    if (hasRelevantTitle(cleaned)) signalCount++;

    if (signalCount >= 1 || !sigIsDuplicate) {
      kept.push(cleaned.substring(0, 1500));
    } else {
      const fromMatch = section.match(/From:\s*([^\n<]+)/i);
      const sender = fromMatch ? fromMatch[1].trim() : 'unknown';
      kept.push(`[From: ${sender} — duplicate/no new info]`);
      skipped++;
    }
  }

  let result = kept.join('\n\n---\n\n');
  result = result.substring(0, 6000);

  if (result.length < 200 && body.length > 500) {
    const fallback = stripBoilerplate(body);
    return {
      result: fallback.substring(0, 6000),
      stats: { originalChars: body.length, finalChars: fallback.length, sections: sections.length, kept: sections.length, skipped: 0, method: 'safety-fallback' }
    };
  }

  return {
    result,
    stats: { originalChars: body.length, finalChars: result.length, sections: sections.length, kept: kept.length, skipped, method: 'signal-extraction-v3' }
  };
}

// Where each outside address appears tells the model who is being shared (the target)
// and who just took part in the thread or made the introduction (usually not).

function preClassifyContacts(fullBody, externalEmails, forwarderPreamble) {
  if (externalEmails.length === 0) return [];

  // Split body into forwarder's area and forwarded content
  const fwdMarkers = [
    /[-_=]{3,}\s*(?:forwarded|original)/i,
    /begin\s+forwarded\s+message/i,
    new RegExp('from:\\s+\\S+@(?!' + OWN_DOMAIN_RE + ')\\S+.*\\nsent:', 'i')
  ];

  let splitIndex = fullBody.length;
  for (const marker of fwdMarkers) {
    const match = fullBody.match(marker);
    if (match && match.index < splitIndex) splitIndex = match.index;
  }
  // The first outside From: also starts the forwarded part.
  const fromExternal = fullBody.match(new RegExp('\\nFrom:\\s+[^\\n]*@(?!' + OWN_DOMAIN_RE + ')[^\\n]+', 'i'));
  if (fromExternal && fromExternal.index < splitIndex) splitIndex = fromExternal.index;

  const forwarderArea = fullBody.substring(0, Math.min(splitIndex, 1000));
  const forwardedContent = fullBody.substring(splitIndex);

  const classifications = [];

  for (const email of externalEmails) {
    const emailLower = email.toLowerCase();
    const localPart = emailLower.split('@')[0];
    const domain = emailLower.split('@')[1];

    // Where does this email appear?
    const inPreamble = forwarderPreamble.toLowerCase().includes(emailLower) ||
                       forwarderPreamble.toLowerCase().includes(localPart.replace(/[._\-]/g, ' '));
    const inForwarderArea = forwarderArea.toLowerCase().includes(emailLower);

    // Check if email appears in signature blocks vs. body text
    const lines = fullBody.split('\n');
    let signatureAppearances = 0;
    let bodyAppearances = 0;
    let inFromHeader = false;

    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(emailLower)) continue;

      // Check if this line is a "From:" header
      if (/^\s*from:\s/i.test(lines[i])) {
        inFromHeader = true;
        continue;
      }

      // Phones, addresses or titles within 3 lines mean a signature block.
      const surrounding = lines.slice(Math.max(0, i - 3), Math.min(lines.length, i + 4)).join('\n');
      const hasSignatureContext = hasPhoneNumber(surrounding) ||
                                  hasStreetAddress(surrounding) ||
                                  hasRelevantTitle(surrounding) ||
                                  /\bwww\.\S+/i.test(surrounding);

      // "Email him at ..." means someone is sharing the address.
      const lineText = lines[i].trim();
      const isSharedInBody = /(?:email|reach|contact)\s*(?:him|her|them|at|is|:)/i.test(
        lines.slice(Math.max(0, i - 2), i + 1).join(' ')
      );

      if (isSharedInBody) {
        bodyAppearances++;
      } else if (hasSignatureContext) {
        signatureAppearances++;
      } else {
        bodyAppearances++;
      }
    }

    // Classify
    let role = 'UNKNOWN';
    if (inPreamble || inForwarderArea) {
      role = 'MENTIONED_BY_FORWARDER';
    } else if (bodyAppearances > 0 && signatureAppearances === 0) {
      role = 'SHARED_IN_BODY';
    } else if (signatureAppearances > 0 && bodyAppearances === 0) {
      role = 'SIGNATURE_ONLY';
    } else if (inFromHeader && signatureAppearances > 0) {
      role = 'CHAIN_PARTICIPANT';
    } else {
      role = 'FOUND_IN_CONTENT';
    }

    classifications.push({
      email: email,
      role: role,
      inPreamble: inPreamble,
      inForwarderArea: inForwarderArea,
      signatureAppearances: signatureAppearances,
      bodyAppearances: bodyAppearances,
      inFromHeader: inFromHeader
    });
  }

  return classifications;
}

// What the forwarder is asking for: NAMED_PERSON, TYPE_MATCH, MULTI_EXPLICIT,
// COMPANY_REFERENCE, or OPEN. Checked from most to least explicit.

function detectInstructionScope(preamble, rawInstruction, forwarderInstruction, externalEmails) {
  const searchText = (preamble + ' ' + rawInstruction).trim();
  if (!searchText) return { scope: 'OPEN', details: '' };

  const searchLower = searchText.toLowerCase();

  // Check for explicit multi: "add both", "add all", "add these"
  if (/\b(?:add|put|log|enter)\s+(?:both|all|these|them|everyone)\b/i.test(searchText)) {
    return { scope: 'MULTI_EXPLICIT', details: 'Forwarder requested multiple contacts' };
  }

  // An address pasted into the note ("jdoe@acme.example for Zoho") is the most explicit
  // naming there is, so it is checked first, including near-misses like jane.doe vs jdoe.
  const directEmailMatches = [];
  for (const extEmail of externalEmails) {
    if (searchLower.includes(extEmail.toLowerCase())) {
      directEmailMatches.push(extEmail);
    }
  }
  // A pasted address that differs slightly from the one in the thread still counts when
  // the domain matches and the local parts overlap.
  if (directEmailMatches.length === 0) {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const preambleEmails = searchText.match(emailPattern) || [];
    for (const pEmail of preambleEmails) {
      // Check if this email's domain matches any external email's domain
      const pDomain = pEmail.split('@')[1]?.toLowerCase();
      const pLocal = pEmail.split('@')[0]?.toLowerCase();
      for (const extEmail of externalEmails) {
        const extDomain = extEmail.split('@')[1]?.toLowerCase();
        const extLocal = extEmail.split('@')[0]?.toLowerCase();
        if (pDomain === extDomain) {
          // "jdoe" vs "jane.doe" share "doe".
          if (pLocal === extLocal || pLocal.includes(extLocal) || extLocal.includes(pLocal)) {
            directEmailMatches.push(extEmail);
          } else {
            const pParts = pLocal.split(/[._\-]/).filter(p => p.length >= 3);
            const eParts = extLocal.split(/[._\-]/).filter(p => p.length >= 3);
            const overlap = pParts.some(pp => eParts.some(ep => pp.includes(ep) || ep.includes(pp)));
            if (overlap) directEmailMatches.push(extEmail);
          }
        }
      }
    }
  }
  if (directEmailMatches.length > 0) {
    return { scope: 'NAMED_PERSON', details: directEmailMatches.join(', ') };
  }

  // Names in the note: "add Jane", "Jane Doe for Zoho", "Jane as Family Office".
  const namePatterns = [
    /\b(?:add|put|log|enter|get|include)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:for|to|in|into)\s+(?:zoho|crm|z\b)/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:as\s+(?:a\s+)?)/gi
  ];

  // Type words, so "Financial Institution for Zoho" is not read as a person's name.
  // Edit to match your CRM's contact-type picklist.
  const skipWords = new Set(['the', 'this', 'that', 'them', 'these', 'those', 'our', 'his', 'her',
    'zoho', 'crm', 'family', 'office', 'funding', 'source', 'dealer', 'broker', 'new', 'contact',
    'person', 'client', 'prospect', 'sure', 'make', 'please', 'need', 'both', 'all',
    'insurance', 'attorney', 'appraiser', 'industry',
    'finance', 'end', 'user', 'management', 'escrow', 'marketing', 'manufacturer',
    'financial', 'institution', 'partner', 'customer', 'service', 'provider']);

  const preambleOriginal = preamble + ' ' + rawInstruction;
  const foundNames = [];

  for (const pattern of namePatterns) {
    let match;
    pattern.lastIndex = 0;
    while ((match = pattern.exec(preambleOriginal)) !== null) {
      const name = match[1].trim();
      const nameParts = name.toLowerCase().split(/\s+/);
      if (nameParts.every(p => skipWords.has(p))) continue;
      if (name.length >= 3) foundNames.push(name);
    }
  }

  // A first name alone ("Jane") counts when it matches part of an outside address (jane.doe@).
  for (const email of externalEmails) {
    const localPart = email.split('@')[0].toLowerCase();
    const nameParts = localPart.split(/[._\-]/);
    for (const part of nameParts) {
      if (part.length >= 3 && !skipWords.has(part)) {
        const nameRegex = new RegExp('\\b' + part + '\\b', 'i');
        if (nameRegex.test(preambleOriginal)) {
          const contextRegex = new RegExp('\\b(' + part + '(?:\\s+[A-Z][a-z]+)?)\\b', 'i');
          const contextMatch = preambleOriginal.match(contextRegex);
          if (contextMatch && !foundNames.includes(contextMatch[1].trim())) {
            foundNames.push(contextMatch[1].trim());
          }
        }
      }
    }
  }

  if (foundNames.length > 0) {
    // The patterns also catch phrases like "to go" or "be added"; keep only candidates that
    // match an outside address or look like a first and last name.
    const validatedNames = foundNames.filter(name => {
      const nameLower = name.toLowerCase();
      const actionWords = new Set(['add', 'go', 'be', 'put', 'get', 'set', 'let', 'do', 'run',
        'added', 'going', 'update', 'mail', 'email', 'check', 'need', 'needs',
        'source', 'broker', 'dealer', 'type', 'zoho', 'crm', 'industry',
        'to add', 'be added', 'to go', 'to zoho', 'in zoho', 'for zoho',
        'industry add', 'source add', 'office add', 'both of']);
      if (actionWords.has(nameLower)) return false;
      const nameWords = nameLower.split(/\s+/);
      const matchesEmail = externalEmails.some(email => {
        const local = email.split('@')[0].toLowerCase();
        const localParts = local.split(/[._\-]/);
        return nameWords.some(nw => nw.length >= 3 && localParts.some(lp => lp.includes(nw) || nw.includes(lp)));
      });
      const looksLikeName = nameWords.length >= 2 && nameWords.some(w => w.length >= 3 && !actionWords.has(w));
      return matchesEmail || looksLikeName;
    });
    if (validatedNames.length > 0) {
      return { scope: 'NAMED_PERSON', details: validatedNames.join(', ') };
    }
  }

  // "the guy from Acme", "someone at Example Bank".
  const companyMatch = searchText.match(/\b(?:from|at|with)\s+([A-Z][A-Za-z\s&.]+?)(?:\s+(?:for|to|in|as)\b|$)/);
  if (companyMatch) {
    return { scope: 'COMPANY_REFERENCE', details: companyMatch[1].trim() };
  }

  // A company named by its domain ("Acme" in the note, acme.example in the thread).
  for (const email of externalEmails) {
    const domain = email.split('@')[1]?.toLowerCase() || '';
    const domainBase = domain.split('.')[0];
    if (domainBase.length >= 3) {
      const domainRegex = new RegExp('\\b' + domainBase + '\\b', 'i');
      if (domainRegex.test(searchText)) {
        return { scope: 'COMPANY_REFERENCE', details: domainBase.toUpperCase() + ' (' + email + ')' };
      }
    }
  }

  // Type only ("Financial Institution for Zoho"): prefer Email Parser's clean type over the raw line.
  if (forwarderInstruction && !foundNames.length) {
    // suggestedType comes from the enclosing scope.
    const cleanType = suggestedType || forwarderInstruction;
    return { scope: 'TYPE_MATCH', details: cleanType };
  }

  return { scope: 'OPEN', details: '' };
}

// The model reads the intent (note, scope, address positions) before the email itself.

function buildThreadContext(body, subject, fromEmail, externalEmails, preamble, instruction, scope, classifications) {
  let context = 'THREAD CONTEXT:\n';
  context += `- Subject: "${subject}"\n`;
  if (fromEmail) context += `- Forwarded by: ${fromEmail} (internal staff)\n`;

  if (preamble) {
    context += `\nFORWARDER'S NOTE:\n"${preamble.substring(0, 400)}"\n`;
  } else if (instruction) {
    // Preamble extraction can fail on unusual layouts; the instruction line still helps.
    context += `\nFORWARDER'S INSTRUCTION:\n"${instruction.substring(0, 400)}"\n`;
  }

  if (scope.scope === 'NAMED_PERSON') {
    context += `\n>>> EXTRACTION TARGET: The forwarder named "${scope.details}". Extract ONLY this person. <<<\n`;
  } else if (scope.scope === 'TYPE_MATCH') {
    context += `\n>>> EXTRACTION TARGET: Find the ONE person who is a "${scope.details}". Skip intermediaries. <<<\n`;
  } else if (scope.scope === 'COMPANY_REFERENCE') {
    context += `\n>>> EXTRACTION TARGET: Find the contact from "${scope.details}". Skip intermediaries. <<<\n`;
  } else if (scope.scope === 'MULTI_EXPLICIT') {
    context += `\n>>> EXTRACTION TARGET: ${scope.details}. Extract only people matching valid contact types. Skip intermediaries. <<<\n`;
  } else {
    context += `\n>>> EXTRACTION TARGET: Identify the contact(s) the forwarder wants logged. Use email structure and business context. Skip intermediaries. <<<\n`;
  }

  if (classifications.length > 0) {
    context += '\nEXTERNAL EMAILS FOUND (with position analysis):\n';
    for (const c of classifications) {
      let hint = '';
      if (c.role === 'MENTIONED_BY_FORWARDER') hint = '← mentioned in forwarder note (likely target)';
      else if (c.role === 'SHARED_IN_BODY') hint = '← info shared in body text (likely target)';
      else if (c.role === 'SIGNATURE_ONLY') hint = '← appears only in email signature (may be chain participant — evaluate their role)';
      else if (c.role === 'CHAIN_PARTICIPANT') hint = '← active in email chain (could be the target OR a chain participant — evaluate context)';
      else hint = '← found in content (evaluate their role)';
      context += `  ${c.email} ${hint}\n`;
    }
  }

  return context;
}

let { result: extractedBody, stats } = extractContactSignals(fullBody, externalEmails);

// Some newsletters and cards are a hosted image with no text. OCR up to three large
// remote images and append any contact-like text. CID images are handled by the
// attachment path instead. Any failure here just means no OCR text.
try {
  const rawHtml = input.rawHtml || input.fullHtml || input.htmlBody || '';
  if (rawHtml.length > 100) {
    const imgUrls = [];
    const imgRegex = /<img[^>]+src=["']?(https?:\/\/[^"'\s>]+)["'\s>]/gi;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(rawHtml)) !== null) {
      imgUrls.push(imgMatch[1]);
    }

    const SKIP_PATTERNS = [
      /googleapis\.com.*\/social\//i,        // Social media icons
      /\/social[_-]?(icon|button|share)/i,     // Social buttons
      /tracking|pixel|beacon|analytics/i,       // Tracking pixels
      /spacer|transparent|blank/i,              // Layout spacers
      /logo.*small|favicon|icon/i,              // Tiny logos
      /unsubscribe|optout|mailchimp/i,          // Unsubscribe buttons
      /badge|seal|certification/i,              // Trust badges
      /emoji|smiley|emoticon/i,                 // Emojis
    ];

    const candidateUrls = imgUrls.filter(url => {
      const urlLower = url.toLowerCase();
      if (SKIP_PATTERNS.some(p => p.test(urlLower))) return false;
      if (/googleapis\.com\/preview-production/i.test(url)) return false;
      return true;
    });

    if (candidateUrls.length > 0) {
      const https = require('https');
      const http = require('http');
      const fs = require('fs');
      const { execSync } = require('child_process');
      const urlModule = require('url');

      // HEAD first so icons and huge files are never downloaded.
      let ocrTexts = [];
      const MAX_INLINE_OCR = 3; // OCR is slow; three covers a card plus a banner or two
      let ocrCount = 0;

      for (const imgUrl of candidateUrls) {
        if (ocrCount >= MAX_INLINE_OCR) break;

        try {
          const sizeResult = await new Promise((resolve, reject) => {
            const parsed = urlModule.parse(imgUrl);
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.request({
              hostname: parsed.hostname,
              port: parsed.port,
              path: (parsed.pathname || '/') + (parsed.search || ''),
              method: 'HEAD',
              timeout: 5000,
              rejectUnauthorized: false
            }, (res) => {
              const size = parseInt(res.headers['content-length'] || '0', 10);
              const type = (res.headers['content-type'] || '').toLowerCase();
              resolve({ size, type, status: res.statusCode });
            });
            req.on('error', () => resolve({ size: 0, type: '', status: 0 }));
            req.on('timeout', () => { req.destroy(); resolve({ size: 0, type: '', status: 0 }); });
            req.end();
          });

          // Under 30KB is an icon; over 3MB is a photo, not a card.
          if (sizeResult.size < 30000 || sizeResult.size > 3000000) continue;
          if (!sizeResult.type.includes('image')) continue;

          const imgData = await new Promise((resolve, reject) => {
            const parsed = urlModule.parse(imgUrl);
            const lib = parsed.protocol === 'https:' ? https : http;
            const req = lib.request({
              hostname: parsed.hostname,
              port: parsed.port,
              path: (parsed.pathname || '/') + (parsed.search || ''),
              method: 'GET',
              timeout: 15000,
              rejectUnauthorized: false
            }, (res) => {
              const chunks = [];
              res.on('data', chunk => chunks.push(chunk));
              res.on('end', () => resolve(Buffer.concat(chunks)));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.end();
          });

          if (!imgData || imgData.length < 30000) continue;

          const ext = imgUrl.match(/\.(png|jpg|jpeg|gif|bmp|tiff?)$/i)?.[1] || 'png';
          const tmpPath = '/tmp/email_to_crm_inline_' + Date.now() + '_' + ocrCount + '.' + ext;
          fs.writeFileSync(tmpPath, imgData);

          // The container image may not ship English tessdata; fetch it once.
          const tessDataDir = '/data/tessdata';
          const tessDataFile = tessDataDir + '/eng.traineddata';
          if (!fs.existsSync(tessDataFile)) {
            try {
              if (!fs.existsSync(tessDataDir)) fs.mkdirSync(tessDataDir, { recursive: true });
              execSync('wget -q -O "' + tessDataFile + '" "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"', { timeout: 30000 });
            } catch(e) {
              try { execSync('curl -sL -o "' + tessDataFile + '" "https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata"', { timeout: 30000 }); } catch(e2) {}
            }
          }

          try {
            const ocrText = execSync('TESSDATA_PREFIX=' + tessDataDir + ' /usr/bin/tesseract "' + tmpPath + '" stdout 2>/dev/null', { encoding: 'utf8', timeout: 30000 });
            const cleaned = ocrText.trim();
            // Logos and banners OCR to noise; keep text with an email, phone or title.
            if (cleaned.length > 10 && (
              /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(cleaned) ||
              /\d{3}[\s.\-()]\d{3}[\s.\-]\d{4}/.test(cleaned) ||
              /(?:director|president|manager|vp|ceo|sales|broker|officer|partner)/i.test(cleaned)
            )) {
              ocrTexts.push(cleaned);
              ocrCount++;
            }
          } catch(e) {}

          try { fs.unlinkSync(tmpPath); } catch(e) {}
        } catch(e) {
        }
      }

      if (ocrTexts.length > 0) {
        _inlineOcrText = ocrTexts.join('\n---\n');
        extractedBody += '\n\n=== CONTACT INFO FROM EMAIL IMAGES ===\n' + _inlineOcrText;
      }
    }
  }
} catch(e) {
}

const classifications = preClassifyContacts(fullBody, externalEmails, forwarderPreamble);
  // Listing and marketplace platforms relay a company's message from their own address.
  // When that is the only outside address, recover the real company name ("Acme Holdings
  // via <platform>") so web research can find the people behind it.
  const DISTRIBUTION_CHANNELS = new Set([
    'listings.example'
  ]);
  
  const allExternalNonChannel = externalEmails.filter(e => {
    const domain = (e.split('@')[1] || '').toLowerCase();
    return !DISTRIBUTION_CHANNELS.has(domain);
  });
  
  const isChannelOnly = externalEmails.length > 0 && allExternalNonChannel.length === 0;
  
  if (isChannelOnly) {
    const viaMatch = fullBody.match(/(?:From|by|Sent by|On Behalf Of)\s+([A-Z][A-Za-z\s&.]+?)\s+via\s+/i) ||
                     extractedBody.match(/^([A-Z][A-Za-z\s&.]+?)\s+via\s+/i);
    const realCompany = viaMatch ? viaMatch[1].trim() : '';
    
    if (realCompany) {
      // A guess at the company's domain, used as the web-research target.
      const companyDomain = realCompany.toLowerCase().replace(/[^a-z0-9]/g, '') + '.com';
      classifications.push({
        email: '',
        role: 'DISTRIBUTION_CHANNEL_TARGET',
        inPreamble: false,
        inForwarderArea: false,
        signatureAppearances: 0,
        bodyAppearances: 1,
        inFromHeader: false,
        realCompany: realCompany,
        derivedDomain: companyDomain
      });
    }
  }

  const scope = detectInstructionScope(forwarderPreamble, rawForwarderInstruction, forwarderInstruction, externalEmails);

  // Nothing left to read and no addresses to classify: the model call would be wasted.
  if (extractedBody.length === 0 && classifications.length === 0) {
    allResults.push({ json: { ...input, requestBody: null, aiSkipped: true, skipReason: 'EMPTY_BODY', contacts: [], contactCount: 0 } });
    continue;
  }

const threadContext = buildThreadContext(
  fullBody, subject, fromEmail, externalEmails,
  forwarderPreamble, forwarderInstruction, scope, classifications
);

// Not used below: the auto-reply guidance is always part of the prompt.
const isAutoReply = /(?:automatic reply|out of (?:the )?office|auto[\s-]?reply|I (?:will be|am) (?:out of|away from)|limited access to email|delayed in responding)/i.test(fullBody);

let systemPrompt = `You are a contact identification assistant for ${OWN_COMPANY_NAMES[0]}.

YOUR TASK: Read this forwarded email and identify the SPECIFIC person(s) the forwarder wants added to Zoho CRM.

CRITICAL: Do NOT extract every external email you find. Use contextual reasoning to determine who the forwarder INTENDS to be logged. Most emails have multiple people in the chain — you must identify which specific person(s) are the target.

HOW TO IDENTIFY THE RIGHT CONTACT:

1. READ THE FORWARDER'S NOTE first (shown in THREAD CONTEXT). This tells you:
   - WHO to add (if they name someone)
   - WHAT TYPE they should be (if they specify)
   - HOW MANY people to add

2. If the forwarder NAMES someone ("add Jane", "Jane Doe for Zoho"):
   → Extract ONLY that named person
   → Use the correct spelling from their email signature, not the forwarder's misspelling

3. If the forwarder specifies only a TYPE ("Financial Institution for Zoho"):
   → Find the ONE person who best matches that type based on their title, company, and role
   → A banker/lender = Financial Institution. A brokerage person = Broker. Etc.
   → Skip intermediaries (receptionists, assistants)

4. If the forwarder says "add both" or "add these":
   → Identify which specific people they mean from context
   → Only extract people whose roles match valid contact types
   → Skip receptionists, assistants, and people who just facilitated the introduction

5. If there is NO clear instruction:
   → Look for the person whose contact info is being SHARED or FORWARDED
   → This is usually NOT the person in the email signatures — it's the person being introduced or discussed
   → If someone says "here's John's info" → extract John
   → If contact details appear explicitly in the body (not as a signature) → that's likely the target
   → Use the POSITION ANALYSIS hints in the thread context

DISTRIBUTION CHANNELS (listing sites, marketplaces, mailing platforms):
- If the email was sent "via" a listing or marketplace platform, the From address (e.g., alerts@listings.example) is NOT the contact.
- The REAL contact is the company/person BEHIND the listing (e.g., "Acme Holdings", "Example Sales Group").
- Extract the company name and any person mentioned in the listing as the contact.
- If no person name is found, extract the company name with confidence "medium" and set website to the company domain.
- The forwarder wants the company or person who posted the listing, not the distribution platform.

WHO TO NEVER EXTRACT:
- ${[...OWN_DOMAINS].map(d => '@' + d).join(', ')} addresses (internal staff)
- Receptionists, secretaries, or administrative assistants who are ONLY intermediaries (not the intended contact)
- People whose role clearly doesn't match any valid contact type`;

systemPrompt += `

AUTO-REPLY / OUT-OF-OFFICE MESSAGES:
- If the email is an auto-reply or OOO message, the person who SET the auto-reply is likely the contact to extract
- Their name and email are in the "From:" header of the auto-reply
- Look for alternate contacts they mention ("please contact X at Y") — these may ALSO be targets
- The forwarder's note tells you who to actually add`;

systemPrompt += `

IMPORTANT NUANCE:
- A chain participant (someone who sent/received emails in the chain) CAN still be the intended target. Evaluate their role — if they are a banker, broker, attorney, etc. and the context suggests they should be logged, extract them.
- "Signature only" contacts are less likely targets but not automatically excluded — consider whether the forwarder's intent points to them.
- Use the POSITION ANALYSIS as hints, not hard rules. Context always wins.

VALID CONTACT TYPES:
Attorney, Broker, Customer, Family Office, Financial Institution, Industry Resource, Insurance, Investment Advisor, Management Company, Manufacturer, Marketing, Partner, Service Provider

TYPE INFERENCE:
- Bank/lending/credit → Financial Institution
- Brokerage/sales → Broker
- Private wealth/family office/RIA → Family Office
- Law firm/attorney → Attorney
- Insurance company → Insurance
- Appraisal company → Service Provider
- Management company → Management Company
- If unclear, use "Industry Resource" as last resort

EXTRACT THESE FIELDS for each identified contact:
firstName, lastName, email, phone, mobile, company, title, city, state, country, type, confidence

PHONE NUMBER RULES:
- "phone" = office/business/direct number (labeled "office:", "direct:", "tel:", "phone:", or "P:")
- "mobile" = cell/mobile number (labeled "cell:", "mobile:", "m:")
- If the contact has multiple phone numbers, put the OFFICE number in "phone" and CELL number in "mobile"
- If there is only one number with no label, put it in "phone"
- NEVER put phone numbers in the "company" field

COUNTRY RULES:
- If the contact's address includes a country other than the United States, extract it in "country"
- For US contacts, leave country as ""
- Common examples: "TURKEY", "Canada", "United Kingdom", "Australia"
- If a country name appears in a state-like position (e.g., "Ankara - TURKEY"), use "Ankara" as city and "TURKEY" as country, leave state as ""

RULES:
- Parse names correctly: "J. Jane Doe" → firstName: "Jane", lastName: "Doe"
- Use REAL spelling from signatures/email addresses, not misspellings from notes
- If a field is not found, use empty string ""
- confidence: "high" if clearly the intended contact, "medium" if likely but uncertain, "low" if guessing`;

if (suggestedType) {
  systemPrompt += `\n\nThe forwarder specified the contact type: "${suggestedType}". Use this type.`;
}

systemPrompt += `

OUTPUT FORMAT (JSON array, no markdown, no explanation):
[{"firstName":"...","lastName":"...","email":"...","phone":"...","mobile":"...","company":"...","title":"...","city":"...","state":"...","country":"...","type":"...","confidence":"..."}]

If NO valid contact can be identified, return: []`;

const userMessage = `${threadContext}\n\nEMAIL CONTENT:\n${extractedBody}`;

allResults.push({
  json: {
    requestBody: {
      model: 'llama3.2:3b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: false,
      options: {
        temperature: 0,
        num_predict: 1024,
        num_ctx: 4096,
        num_thread: 6
      }
    },
    inlineOcrText: _inlineOcrText || '',
    pruningStats: stats,
    instructionScope: scope,
    contactClassifications: classifications,
    forwarderPreamble: forwarderPreamble.substring(0, 200),
    extractedBodyPreview: extractedBody.substring(0, 500) + '...'
  }
});

} // end of per-email loop

return allResults;
