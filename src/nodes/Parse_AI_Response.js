// Parse AI Response (single-stage pipeline)
//
// Turns the local model's JSON reply into contact records, then checks each field
// against the email text so a value the model made up never reaches the CRM. Most of
// this file is a signature scanner that runs whether or not the model succeeded: it
// reads the lines around each external email address for name, title, company,
// phones, and address, and merges what it finds with the model's answer.
//
// Input: one Ollama response per email, index-matched to Email Parser's items.
// Output: { contacts: [...], contactCount, ...email metadata } per email.
//
// If the model call failed, the scanner still runs and its contacts still go out.
//
// Edit the Organization settings block below for your organization.
// docs/edge-cases.md lists the signature formats this was tuned on.

// Organization settings
// n8n Code nodes cannot import, so every node that needs these keeps its own copy.
const OWN_DOMAINS = new Set(['yourcompany.com']);
// Last 10 digits of your own office, mobile and fax lines, so a staff number in a forwarded
// signature is never captured as the contact's phone.
const OWN_PHONES = new Set(['5550100100', '5550100101', '5550100102']);
// Staff whose signatures appear in forwarded mail and must never become contacts.
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];
const OWN_STAFF_FIRST = OWN_STAFF.map(s => s.name.split(/\s+/)[0].toLowerCase());
const OWN_STAFF_LAST = OWN_STAFF.map(s => s.name.split(/\s+/).slice(-1)[0].toLowerCase());
const OWN_STAFF_FULL = OWN_STAFF.map(s => s.name.toLowerCase());
// Your company name and signature tagline; never accepted as a contact's company.
const OWN_COMPANY_NAMES = ['Your Company'];
const OWN_TAGLINE = 'Your Company Tagline Here';
const OWN_BRAND_NAMES = [...OWN_COMPANY_NAMES, OWN_TAGLINE];

// MULTI-ITEM WRAPPER - Process each AI response independently

const allItems = $input.all();
const allResults = [];
// Pre-fetch Email Parser items for index-based correlation
let emailParserItems = [];
try { emailParserItems = $('Email Parser').all(); } catch(e) {
  try { emailParserItems = $('Email Parser').all(); } catch(e2) {}
}

for (let _idx = 0; _idx < allItems.length; _idx++) {
let _item = allItems[_idx];
let _aiFailureNote = '';

// SKIP_CHECK - Pass through skip signal
if (_item.json.skip) {
  allResults.push({ json: _item.json });
  continue;
}

// OLLAMA_FAILURE_GUARD - Handle AI timeout/crash/garbage
const rawInput = _item.json;

// Safe reference to Email Parser - use index-correlated item for multi-email support
// emailParserItems[_idx] gives us the Email Parser output that corresponds
// to THIS particular AI response (same position in the pipeline).
let prevData = {};
try {
  prevData = (emailParserItems[_idx] || emailParserItems[0] || {}).json || {};
} catch (e) {
  prevData = {};
}

// If Ollama returned an error (continueOnFail caught it), don't crash
if (rawInput.error || rawInput.statusCode >= 400 || (!rawInput.response && !rawInput.message)) {
  // The model call failed (timeout or crash; Ollama may be shared with other workloads). Treat it
  // as an empty AI answer so the signature scanner still runs and its contacts still reach the CRM.
  _aiFailureNote = 'AI_FAILURE: ' + (rawInput.error?.message || rawInput.error || rawInput.statusMessage || 'No response from AI');
  _item = { json: { message: { content: '[]' } } };
}

// DETERMINISTIC SIGNATURE SCANNER
// Runs on EVERY email. Extracts contacts from signature blocks
// using regex - fast, reliable, no AI hallucination possible.

// TITLE CASE NORMALIZATION
// "JANE BROKER" -> "Jane Broker", "PRIVATE BANK" -> "Private Bank"
// Only converts when the ENTIRE string is uppercase (won't touch "McDonald" or "De La Cruz")
function toTitleCase(str) {
  if (!str || str.length < 2) return str;
  // Check if ALL alphabetic chars are uppercase
  const alphaChars = str.replace(/[^a-zA-Z]/g, '');
  if (alphaChars.length < 2 || alphaChars !== alphaChars.toUpperCase()) return str;
  // Convert: "JANE BROKER" -> "Jane Broker"
  return str.toLowerCase().replace(/(?:^|\s|[-'])\w/g, c => c.toUpperCase());
}

function isOwnCompanyPhone(phoneStr) {
  if (!phoneStr) return false;
  const digits = phoneStr.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, '').replace(/\D/g, '');
  // Check last 10 digits (strip country code)
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  return OWN_PHONES.has(last10);
}

// Signature phone labels, including the German, French, Spanish and Portuguese forms
// (Tel. with or without the accent, Telefon, Oficina, Mobil, Port., Cel., Celular, Handy). Office and main lines are
// the phone; a bare "Direct" is the mobile by convention. The phone keeps an extension.
const PHONE_LABEL_RE = /(?:\b(?:T(?:[e\u00e9]l(?:[e\u00e9](?:phone|fono)|efon)?)?|P(?:h(?:one)?)?|O(?:ffice(?:\s*Phone)?|ficina)?|Main|Business|Direct\s+Line)\b|\((?:[tpo])\))[\s.:|]*([\d(+][\d\s.()\-]{6,}\d(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?)/i;
const MOBILE_LABEL_RE = /(?:\b(?:M(?:ob(?:ile?)?|[o\u00f3]vil)?|C(?:el(?:l(?:\s*Phone)?|ular)?)?|Port(?:able)?|Handy|Direct(?!\s+Line))\b|\((?:[mc])\))[\s.:|]*([\d(+][\d\s.()\-]{6,}\d)/i;
// "Cell Phone: ..." must not be read as a Phone label.
const CELL_PHONE_RE = /\bCell\s*Phone\b/i;
const extToX = p => p.replace(/\s*(?:x|ext\.?|extension)\s*(\d+)$/i, ' x$1').trim();

// ANTI-DROP GUARD - when email local-part yields no derivable name, scan body lines
// near the email for a "Mr./Ms./Dr. First Last" or standalone "First Last" pattern. Fixes
// unmatched-local-part class: body has 'Mr. John Broker / Founder... / assistant@example-broker.com'
// but local-part 'assistant' splits to single token, the earlier stub had an empty name and was
// dropped by Validate Contact Type's ghost filter.
// Staff names come from OWN_STAFF so a staff signature is never read as the contact's name.
const ANTI_DROP_FIRST_STOP = new Set(OWN_STAFF_FIRST);
const ANTI_DROP_LAST_STOP = new Set(OWN_STAFF_LAST);
const ANTI_DROP_WORD_STOP = new Set(['the','that','this','with','from','into','about','which','their','there','other','some','these','those','will','been','have','each','make','like','just','over','such','also','back','than','them','then','only','come','made','find','here','know','take','want','does','when','what','your','more','many','very','most','much','after','first','last','before','being','under','could','would','should','because','between','through','during','without','contact','contacts','person','name','found','identified','following','information','field','fields','email','phone','company','title','address','joining','dealer','broker','lending','sincerely','regards','thanks','best','price','drop','motivated','seller','global','mobile','office','direct','cell','founder','head','sales','ceo','president','vice','managing','principal','partner','director','manager']);
function deriveNameFromBodyNear(body, email, forwarderEmail) {
  if (!body || !email) return { firstName: '', lastName: '', phone: '', mobile: '', jobTitle: '' };
  const emailLc = email.toLowerCase();
  const lines = body.split(/\r?\n/);
  const forwarderLocal = ((forwarderEmail || '').split('@')[0] || '').toLowerCase();
  const phoneRe = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].toLowerCase().includes(emailLc)) continue;
    const scanStart = Math.max(0, i - 5);
    const scanEnd = Math.min(lines.length, i + 4);
    let firstName = '', lastName = '', jobTitle = '';
    let phone = '', mobile = '';
    for (let j = scanStart; j < scanEnd; j++) {
      if (j === i) continue;
      const raw = lines[j].trim();
      if (!raw || raw.length > 120) continue;

      // NAME: title-prefixed OR bare "First Last" on its own line
      if (!firstName) {
        const m = raw.match(/^(?:Mr\.?|Ms\.?|Mrs\.?|Miss|Dr\.?|Prof\.?)?\s*([A-Z][a-zA-Z'\u2019\-]+)\s+([A-Z][a-zA-Z'\u2019\-]+)(?:\s+([A-Z][a-zA-Z'\u2019\-]+))?\s*$/);
        if (m) {
          const f = m[1], l = (m[3] ? m[3] : m[2]);
          const fLc = f.toLowerCase(), lLc = l.toLowerCase();
          const nameOk = !ANTI_DROP_WORD_STOP.has(fLc) && !ANTI_DROP_WORD_STOP.has(lLc)
            && !(ANTI_DROP_FIRST_STOP.has(fLc) && ANTI_DROP_LAST_STOP.has(lLc))
            && fLc !== forwarderLocal && lLc !== forwarderLocal
            && !isOwnBranding(f + ' ' + l);
          if (nameOk) { firstName = f; lastName = l; }
        }
      }
      // PHONE / MOBILE: labelled lines near the email
      const phoneMatch = raw.match(phoneRe);
      if (phoneMatch && !isOwnCompanyPhone(phoneMatch[0])) {
        const labeled = raw.toLowerCase();
        if (/mobile|cell|^m\b|^c\b|\(m\)|\(c\)/.test(labeled) && !mobile) {
          mobile = phoneMatch[0].trim();
        } else if (/office|direct|phone|^o\b|^p\b|\(o\)|\(p\)|\(t\)/.test(labeled) && !phone) {
          phone = phoneMatch[0].trim();
        } else if (!phone && !mobile) {
          // unlabeled phone near the email -> fill phone slot
          phone = phoneMatch[0].trim();
        }
      }
      // JOB TITLE: a short line that's not a name, not a phone, not a URL - between name line and email line
      if (!jobTitle && firstName && j > scanStart) {
        if (!/\d/.test(raw) && !raw.includes('@') && raw.length <= 60 && /^[A-Z]/.test(raw)
            && !raw.match(/^(?:Mr\.?|Ms\.?|Mrs\.?|Miss|Dr\.?|Prof\.?)?\s*[A-Z][a-zA-Z'\u2019\-]+\s+[A-Z][a-zA-Z'\u2019\-]+\s*$/)) {
          jobTitle = raw;
        }
      }
    }
    if (firstName && lastName) {
      return { firstName, lastName, phone, mobile, jobTitle };
    }
  }
  return { firstName: '', lastName: '', phone: '', mobile: '', jobTitle: '' };
}

// OWN-COMPANY TAGLINE/BRANDING BLACKLIST
// These strings appear in staff signatures and should NEVER be extracted as company names.
const OWN_COMPANY_BLACKLIST = new Set([
  ...OWN_BRAND_NAMES.map(n => n.toLowerCase()),
  ...OWN_BRAND_NAMES.map(n => n.toLowerCase().replace(/\s+/g, '')),
  'click here to send us files securely',
]);

function isOwnBranding(text) {
  if (!text) return false;
  const lower = text.toLowerCase().trim();
  if (OWN_COMPANY_BLACKLIST.has(lower)) return true;
  // Also catch partial matches
  return OWN_BRAND_NAMES.some(n => lower.includes(n.toLowerCase()));
}

// Detect if a string is primarily a phone number (not a company)
// Only applies vanity conversion when the string starts with phone-like
// characters (digits, parens, +). Pure text like "Example Brokers" is NOT vanity-converted
// because that would falsely turn all letters into digits (ratio 85% -> false positive).
function isPhoneNumber(str) {
  if (!str) return false;
  const trimmed = str.trim();
  // Direct phone pattern check (no vanity needed)
  if (/^\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/.test(trimmed)) return true;
  if (/^\+?\d[\d\s.\-()]{6,}$/.test(trimmed)) return true;
  // Raw digit ratio check (without vanity conversion)
  const rawDigits = str.replace(/\D/g, '');
  if (rawDigits.length >= 7 && rawDigits.length / str.length > 0.4) return true;
  // Vanity conversion ONLY if string starts with a phone-like prefix
  // e.g., "(555) 010-DEAL" or "1-555-GET-DEAL" - NOT "Example Brokers"
  if (/^[\d(+]/.test(trimmed)) {
    const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
    const vanityConverted = str.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch);
    const digits = vanityConverted.replace(/\D/g, '');
    if (digits.length >= 7 && digits.length / str.length > 0.4) return true;
  }
  return false;
}

// A table signature joins cells into one text line, so the phone cell can trail the
// company ("Acme Group M: (555) 010-0100"). Cut the company at the phone.
function stripTrailingPhone(str) {
  return (str || '').replace(/\s+(?:[A-Za-z]{1,6}\s*[:.]\s*)?[+(]?\d[\d\s.()\-]{6,}\d.*$/, '').trim();
}

// ASYNC TLD RESOLVER - web-verified domain resolution
// When an email has no TLD (e.g., "jane.broker@examplegroup"), probe common TLDs
// and verify by fetching the homepage + checking if the company name appears.
async function resolveTldLessEmail(tldLessEmail, companyHint) {
  const https = require('https');
  const dns = require('dns').promises;
  const [localPart, domain] = tldLessEmail.split('@');
  if (!domain || domain.length < 3) return null;

  const CANDIDATE_TLDS = ['com', 'net', 'org', 'co', 'ca', 'io'];
  const companyLower = (companyHint || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const companyWords = companyLower.split(/\s+/).filter(w => w.length >= 3);

  // Phase 1: DNS MX check - which TLDs can actually receive mail?
  const mxCandidates = [];
  await Promise.all(CANDIDATE_TLDS.map(async (tld) => {
    try {
      const mx = await dns.resolveMx(domain + '.' + tld);
      if (mx && mx.length > 0) {
        mxCandidates.push({ tld, mx: mx[0].exchange, priority: mx[0].priority });
      }
    } catch (e) { /* no MX = skip */ }
  }));

  if (mxCandidates.length === 0) return null; // no mail server for any TLD: return nothing rather than invent '@domain.com'
  if (mxCandidates.length === 1) return localPart + '@' + domain + '.' + mxCandidates[0].tld;

  // Phase 2: Multiple MX candidates - verify by homepage content + company name match
  function fetchPage(url, timeout) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        // Follow one redirect
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redir = res.headers.location.startsWith('http') ? res.headers.location : url.split('/').slice(0,3).join('/') + res.headers.location;
          return fetchPage(redir, timeout).then(resolve);
        }
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 50000) res.destroy(); });
        res.on('end', () => resolve(data));
        res.on('error', () => resolve(''));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    });
  }

  let bestTld = null;
  let bestScore = -1;

  for (const candidate of mxCandidates) {
    try {
      const fullDomain = domain + '.' + candidate.tld;
      const html = await fetchPage('https://' + fullDomain, 4000);
      if (!html || html.length < 200) continue; // parked/empty page

      const textContent = html.replace(/<[^>]*>/g, ' ').toLowerCase();
      let score = 0;

      // Score by content size (real sites > parked pages)
      if (html.length > 10000) score += 2;
      if (html.length > 50000) score += 1;

      // Score by company name match
      if (companyWords.length > 0) {
        const matchedWords = companyWords.filter(w => textContent.includes(w));
        score += matchedWords.length * 3; // Strong signal
      }

      // Score by domain appearing in page content (self-references)
      if (textContent.includes(fullDomain)) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestTld = candidate.tld;
      }
    } catch (e) { /* fetch failed - skip */ }
  }

  // Use web-verified TLD if found, otherwise fall back to lowest-priority MX
  if (bestTld) return localPart + '@' + domain + '.' + bestTld;
  mxCandidates.sort((a, b) => a.priority - b.priority);
  return localPart + '@' + domain + '.' + mxCandidates[0].tld;
}

function scanSignatures(body, excludeForwarder) {
  if (!body || body.length < 50) return [];

  const PERSONAL_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
    'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
    'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);

  // Find all unique email addresses in the body
  const emailRegex = /[\w.+-]+@[\w.-]+\.\w{2,}/g;
  // "[cid:image001.png@01DD...]" is an inline-image reference, not a mailbox.
  const allEmails = [...new Set((body.match(emailRegex) || []).map(e => e.toLowerCase()))]
    .filter(e => !body.toLowerCase().includes('cid:' + e));

  // Capture TLD-less emails for later async verification
  // These appear when Outlook truncates the display or domain has no public TLD
  const tldLessRegex = /[\w.+-]+@[a-zA-Z][\w-]{2,}(?=[\s,;>)\]"']|$)/g;
  const tldLessCandidates = (body.match(tldLessRegex) || [])
    .map(e => e.toLowerCase())
    .filter(e => !allEmails.some(full => full.startsWith(e))); // Not already captured with TLD
  // Store for async resolution later - don't guess TLD here
  const _pendingTldLess = [];
  for (const candidate of tldLessCandidates) {
    const domain = candidate.split('@')[1];
    if (domain && domain.length >= 3 && !allEmails.some(e => e.split('@')[1]?.startsWith(domain))) {
      _pendingTldLess.push(candidate);
    }
  }

  // Filter to external, non-personal, non-forwarder emails
  const GENERIC_PREFIXES = new Set(['info','sales','support','admin','contact',
    'help','billing','noreply','no-reply','mailer-daemon','postmaster',
    'webmaster','newsletter','marketing','service','enquiries','enquiry',
    'fraud','abuse','spam','security']);

  const externalEmails = allEmails.filter(e => {
    const domain = e.split('@')[1] || '';
    const localPart = e.split('@')[0] || '';
    return ![...OWN_DOMAINS].some(d => e.endsWith('@' + d)) &&
           !e.endsWith('@example-consultancy.com') &&
           e !== (excludeForwarder || '').toLowerCase() &&
           !PERSONAL_DOMAINS.has(domain) &&
           !GENERIC_PREFIXES.has(localPart.toLowerCase());
  });

  // Infer name hints from the email local part
  // "jane.a.broker" -> { firstHint: "jane", lastHint: "broker" }
  // "jbroker" -> { firstInitial: "j", lastHint: "broker" }
  // "jane" -> { firstInitial: "j", lastHint: "ane", fullLocalAsFirst: "jane" }
  //   fullLocalAsFirst allows matching when the entire local part IS a first name
  function inferNameFromEmail(email) {
    const local = email.split('@')[0].toLowerCase().replace(/^\d+/, '').replace(/\d+$/, '');
    const parts = local.split(/[._-]/);

    if (parts.length >= 3) {
      // first.middle.last or first.m.last - take first and last significant parts
      const sig = parts.filter(p => p.length > 1);
      if (sig.length >= 2) return { firstHint: sig[0], lastHint: sig[sig.length - 1] };
    }
    if (parts.length === 2) {
      if (parts[0].length > 1 && parts[1].length > 1) return { firstHint: parts[0], lastHint: parts[1] };
      if (parts[0].length === 1) return { firstInitial: parts[0], lastHint: parts[1] };
      if (parts[1].length === 1) return { firstHint: parts[0], lastInitial: parts[1] };
    }
    if (parts.length === 1 && local.length > 3) {
      // Single word like "jane" or "jbroker"
      // Could be: (a) full first name "jane@exampleco.com"
      //           (b) first initial + last "jbroker@somecompany.com"
      // Return BOTH interpretations so nameMatchesHints can try each
      return {
        firstInitial: local[0],
        lastHint: local.substring(1),
        fullLocalAsFirst: local  // try entire local as first name
      };
    }
    return null;
  }

  // Check if a candidate name matches email-derived hints
  function nameMatchesHints(first, last, nick, hints) {
    if (!hints) return false;
    const fL = first.toLowerCase(), lL = last.toLowerCase(), nL = (nick || '').toLowerCase();

    // Match 1: Full first + last (e.g., "jane.broker@...")
    if (hints.firstHint && hints.lastHint) {
      const firstOk = (fL === hints.firstHint || nL === hints.firstHint);
      const lastOk = (lL === hints.lastHint);
      if (firstOk && lastOk) return true;
    }

    // Match 2: First initial + last (e.g., "jbroker@..." -> J. Broker)
    if (hints.firstInitial && hints.lastHint) {
      if ((fL[0] === hints.firstInitial || (nL && nL[0] === hints.firstInitial)) && lL === hints.lastHint)
        return true;
    }

    // Match 3: First + last initial (e.g., "jane.b@...")
    if (hints.firstHint && hints.lastInitial) {
      if (fL === hints.firstHint && lL[0] === hints.lastInitial)
        return true;
    }

    // Full local part IS the first name (e.g., "jane@exampleco.com")
    // Accept any candidate whose first name matches the entire email local part
    if (hints.fullLocalAsFirst) {
      if (fL === hints.fullLocalAsFirst || nL === hints.fullLocalAsFirst)
        return true;
    }

    return false;
  }

  // DOMAIN-BASED COMPANY INFERENCE
  // The email domain is the single most reliable signal for company identity.
  // "jbroker@example.bank" -> "Example Bank"
  // "jane@exampleco.com" -> tries to find "Example Co" in nearby lines
  //
  // THREE-LAYER STRATEGY:
  //   Layer 1 - Domain correlation: scan lines for text matching the domain root
  //             "Example Bank" line + domain "example" = match
  //   Layer 2 - Keyword scanning: existing regex approach (Bank, Capital, etc.)
  //   Layer 3 - Domain inference: synthesize name from domain + TLD
  //             example + .bank = "Example Bank"
  const MEANINGFUL_TLDS = {
    'bank': 'Bank', 'insurance': 'Insurance', 'financial': 'Financial',
    'capital': 'Capital', 'fund': 'Fund', 'investments': 'Investments',
    'law': 'Law', 'legal': 'Legal', 'consulting': 'Consulting',
    'realty': 'Realty', 'mortgage': 'Mortgage', 'credit': 'Credit',
    'trust': 'Trust', 'holdings': 'Holdings', 'energy': 'Energy',
    'health': 'Health', 'tech': 'Tech', 'systems': 'Systems',
    'group': 'Group', 'partners': 'Partners', 'ventures': 'Ventures'
  };

  function extractDomainRoot(email) {
    const domain = (email.split('@')[1] || '').toLowerCase();
    const parts = domain.split('.');
    if (parts.length < 2) return null;
    const tld = parts[parts.length - 1];
    // For two-part domains like "example.bank", root is parts[0]
    // For three-part like "mail.example.com", root is parts[parts.length - 2]
    const rootPart = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
    return { root: rootPart, tld, fullDomain: domain };
  }

  // Layer 1: Find a line in the signature that correlates with the email domain
  function findDomainCorrelatedCompany(lines, domainRoot) {
    if (!domainRoot || domainRoot.length < 3) return '';
    const rootLower = domainRoot.toLowerCase();
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
      const line = lines[i];
      if (/^(from|to|cc|date|subject|sent|-----)/i.test(line)) break;
      if (/confidential|privilege|disclaimer/i.test(line)) continue;
      if (line.length > 80 || line.length < 2) continue;
      // Skip email/URL lines
      if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) continue;
      // Skip phone lines
      if (/^(?:T(?:el)?|P(?:h(?:one)?)?|Office|Direct|Mobile|Cell|Fax|M\s)\s*[:\s]?\s*[\d(+]/i.test(line)) continue;
      // Check if this line contains the domain root word
      // e.g., line="Example Bank" contains "example"
      // Space-insensitive match - "Example Logic" matches "examplelogic"
      const lineNoSpaces = line.toLowerCase().replace(/\s+/g, '');
      if (line.toLowerCase().includes(rootLower) || lineNoSpaces.includes(rootLower)) {
        // Extra check: the line should look like a company name, not a sentence
        // Allow trailing "." when preceded by common abbreviations (Inc., Ltd., Corp., Co., etc.)
        const trimmedLine = line.trim();
        const endsWithSentencePunct = /[.!?]$/.test(trimmedLine) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|Dr|Mr|Mrs|Ms|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(trimmedLine);
        if (!endsWithSentencePunct && !/^(good|hi |hello|please|thank|best|regard|we |the |a )/i.test(line)) {
          // If line has pipes, extract just the segment containing the domain root
          if (line.includes('|')) {
            const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
            // Space-insensitive segment matching - "Example Brokers" matches "examplebrokers"
            const match = segments.find(s => {
              const sLower = s.toLowerCase();
              const sNoSpaces = sLower.replace(/\s+/g, '');
              return sLower.includes(rootLower) || sNoSpaces.includes(rootLower);
            });
            if (match && match.length < 50) return match;
          }
          return line;
        }
      }
    }
    return '';
  }

  // Layer 3: Synthesize company name from domain when no line match is found
  function inferCompanyFromDomain(email) {
    const info = extractDomainRoot(email);
    if (!info) return '';
    const { root, tld } = info;
    if (root.length < 3) return '';
    // Iterative word splitting - "acmeprivatewealth" -> "Acme Private Wealth"
    // Scans for known business suffixes and splits at each boundary, handling multiple words
    let name = root;
    // Added 'sales' - "acmeequipmentsales" -> "Acme Equipment Sales"
    const businessSuffixes = ['private', 'wealth', 'capital', 'financial', 'group', 'partners', 'advisors', 'advisory', 'management', 'holdings', 'investments', 'consulting', 'services', 'solutions', 'global', 'international', 'national', 'insurance', 'realty', 'mortgage', 'lending', 'credit', 'trust', 'fund', 'asset', 'bank', 'logic', 'sales', 'properties', 'development', 'construction', 'engineering', 'technology', 'systems', 'industries', 'equipment', 'leasing', 'enterprises', 'resources', 'associates', 'company', 'design', 'logistics', 'transport', 'trading', 'supply', 'energy', 'media', 'broker', 'air'];
    // Split iteratively: find leftmost suffix, split, repeat on remaining parts
    function splitOnSuffixes(str) {
      const lower = str.toLowerCase();
      let bestIdx = -1, bestSuffix = '';
      for (const suffix of businessSuffixes) {
        const idx = lower.indexOf(suffix);
        if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) {
          bestIdx = idx;
          bestSuffix = suffix;
        }
      }
      if (bestIdx > 0) {
        const before = str.substring(0, bestIdx);
        const matched = str.substring(bestIdx, bestIdx + bestSuffix.length);
        const remainder = str.substring(bestIdx + bestSuffix.length);
        const parts = [before.charAt(0).toUpperCase() + before.slice(1),
                       matched.charAt(0).toUpperCase() + matched.slice(1)];
        if (remainder.length > 0) {
          const remainderParts = splitOnSuffixes(remainder);
          if (remainderParts) {
            parts.push(...remainderParts.split(' '));
          } else {
            // Check if remainder itself is a known suffix (starts at idx 0)
            const remLower = remainder.toLowerCase();
            const isFullSuffix = businessSuffixes.some(s => remLower === s);
            if (isFullSuffix) {
              parts.push(remainder.charAt(0).toUpperCase() + remainder.slice(1));
            } else {
              parts[parts.length - 1] += remainder;
            }
          }
        }
        return parts.join(' ');
      }
      return null;
    }
    const split = splitOnSuffixes(name);
    if (split) {
      name = split;
    }
    if (!name.includes(' ')) {
      name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    // Append meaningful TLD if applicable
    const tldWord = MEANINGFUL_TLDS[tld];
    if (tldWord) return name + ' ' + tldWord;
    // For generic TLDs (.com, .net, .org), return just the name
    return name;
  }

  const results = [];
  const bodyLower = body.toLowerCase();

  for (const extEmail of externalEmails) {
    // Find ALL positions of this email in the body
    const positions = [];
    let searchFrom = 0;
    while (true) {
      const idx = bodyLower.indexOf(extEmail, searchFrom);
      if (idx === -1) break;
      positions.push(idx);
      searchFrom = idx + extEmail.length;
    }

    let bestContact = null;
    let bestScore = 0;

    for (const emailIdx of positions) {
      // Skip if this occurrence is on a header line (From:, To:, Cc:, Sent:)
      const lineStart = body.lastIndexOf('\n', emailIdx) + 1;
      const linePrefix = body.substring(lineStart, emailIdx).trim().toLowerCase();
      // "email:" prefix is a signature line, NOT a header - don't skip it
      // German and French forward headers too ("An: Doe, Jane <...>" became a fake contact)
      if (/^(from|to|cc|bcc|sent|date|subject|von|an|gesendet|betreff|kopie|de|\u00e0|envoy\u00e9|objet)\s*:/i.test(linePrefix)) {
        continue;
      }

      const beforeEmail = body.substring(Math.max(0, emailIdx - 1000), emailIdx);
      const afterEmail = body.substring(emailIdx, Math.min(body.length, emailIdx + 500));
      const lines = beforeEmail.split('\n').map(l => l.trim()).filter(l => l.length > 0);

      let firstName = '', lastName = '', nickname = '';
      let fallbackFirst = '', fallbackLast = '', fallbackNick = '';
      let jobTitle = '', companyName = '', companyGuessed = false;
      let phone = '', mobile = '', city = '', state = '', country = '';
      const nameHints = inferNameFromEmail(extEmail);

      // Extract name from email headers as a reliable backup
      let headerFirst = '', headerLast = '';
      const escapedEmail = extEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const headerPattern = new RegExp('From:\\s*"?([^"<]+)"?\\s*<' + escapedEmail + '>', 'i');
      const headerNameMatch = body.match(headerPattern);
      if (headerNameMatch) {
        let rawName = headerNameMatch[1].trim().replace(/^["']|["']$/g, '');
        const hParts = rawName.split(/\s+/);
        if (hParts.length >= 2) {
          if (hParts[0].endsWith(',')) {
            headerLast = hParts[0].replace(',', '');
            headerFirst = hParts[1];
          } else {
            headerFirst = hParts[0];
            headerLast = hParts[hParts.length - 1];
          }
        }
      }

      // Search backwards through lines for signature fields
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 25); i--) {
        const line = lines[i];

        // Stop if we hit email headers (we've gone past the signature)
        if (/^(From|To|Cc|Date|Subject|Sent|Von|An|Gesendet|Betreff|De|\u00c0|Envoy\u00e9|Objet)\s*:|^-----/i.test(line)) break;
        if (/confidential|privilege|disclaimer|intended only/i.test(line)) continue;
        if (line.length > 200) continue; // Skip long paragraphs

        // Phone - added "P" as standalone prefix
        // Handles: "P 555-010-0113", "Ph: 555-1234", "Phone: 555-1234",
        //          "Tel: 555-1234", "Office: 555-1234", "Direct: 555-1234"
        // Also handles bare vanity numbers like "(555) 010-DEAL" or "(555) 011-DEAL"
        // Exclude "Cell Phone" lines (handled by mobile regex below)
        // Skip own-company phone numbers
        if (!phone && !CELL_PHONE_RE.test(line)) {
          // Removed "Direct" - now maps to mobile by convention (office=phone, direct=mobile)
          // Added "Direct Line" - this is an office direct line, not mobile
          const phoneMatch = line.match(PHONE_LABEL_RE);
          if (phoneMatch) {
            const candidate = extToX(phoneMatch[1]);
            if (!isOwnCompanyPhone(candidate)) {
              phone = candidate;
            }
          }
          // Bare vanity phone - "(555) 010-DEAL" or "1-555-GET-DEAL"
          // Line starts with phone-like chars and contains a mix of digits and uppercase letters
          if (!phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              // Convert vanity to digits and validate
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized)) {
                phone = normalized;
              }
            }
          }
          // Number-then-label pattern - "555.010.0109 office"
          if (!phone) {
            const phoneSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            if (phoneSuffix && !isOwnCompanyPhone(phoneSuffix[1])) {
              phone = phoneSuffix[1];
            }
          }
        }

        // Mobile/Cell/Direct - handles "Cell:", "Cell Phone:", "M ", "Mobile:", "Direct:", etc.
        // Added "Direct" - convention: office=phone, direct/cell=mobile
        // "Direct Line" handled above in phone regex; standalone "Direct" stays as mobile
        // Skip own-company phone numbers
        if (!mobile) {
          const mobileMatch = line.match(MOBILE_LABEL_RE);
          if (mobileMatch) {
            const candidate = mobileMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) {
              mobile = candidate;
            }
          }
          // Number-then-label pattern - "555.010.0110 direct"
          if (!mobile) {
            const mobileSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            if (mobileSuffix && !isOwnCompanyPhone(mobileSuffix[1])) {
              mobile = mobileSuffix[1];
            }
          }
        }

        // Standalone phone number fallback - lines that ARE just a phone number
        // e.g., "555.010.0107" on its own line in a signature block
        // Only triggers when no labeled phone was found yet. Must have 7+ digits, no letters.
        // Observed failure: a bank contact -> "555.010.0107" line not captured (exec 460).
        if (!phone && !mobile) {
          const standalonePhone = line.match(/^([\d(+][\d\s.()\-]{6,}\d)\s*$/);
          if (standalonePhone) {
            const digits = standalonePhone[1].replace(/\D/g, '');
            if (digits.length >= 7 && digits.length <= 15 && !isOwnCompanyPhone(standalonePhone[1])) {
              phone = standalonePhone[1];
            }
          }
        }

        // Title: lines containing common title keywords
        // Skip lines containing LLC/Inc/Corp/LLP/Ltd - those are company names, not titles
        // Observed failure: "Example Principal Advisors, LLC" matched as title (has "Principal"+"Advisors")
        if (!jobTitle && /(?:Director|President|Vice|Manager|Advisor|Officer|Partner|Principal|Chief|Counsel|Attorney|Senior|Associate|Analyst|Consultant|Specialist|Executive|Managing|Broker|Banker|Underwriter|Originator|Commercial|VP\b|SVP\b|EVP\b|AVP\b|Sr\b)/i.test(line)) {
          // Make sure it's a short title line, not a sentence, and not a company name
          if (line.length < 100 && !/[.!?]$/.test(line.trim()) && !/^(good|it was|i |please|looking|best|hi |hello|dear|just |thank|we |the )/i.test(line) && !/(?:LLC|Inc|Corp|LLP|Ltd|L\.?L\.?C|P\.?C)\b/i.test(line)) {
            jobTitle = line;
          }
        }

        // Company: lines that look like a company name
        // Explicit "Company:" label prefix - highest priority company detection
        if (!companyName) {
          const companyLabel = line.match(/^(?:Company|Firm|Organization|Employer)\s*:\s*(.+)/i);
          if (companyLabel) {
            const val = companyLabel[1].trim();
            if (val.length > 1 && val.length < 80 && !isOwnBranding(val) && !isPhoneNumber(val)) {
              companyName = val;
            }
          }
        }
        // Skip lines containing @ (email addresses) or URL patterns
        //   "JBROKER@EXAMPLE.BANK | EXAMPLELENDING.COM" contains "BANK" but is NOT a company name
        if (!companyName && line.length < 80 && line.length > 2) {
          if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) {
            // Skip - this is an email address or URL line, not a company name
          } else if ((line.match(/\|/g) || []).length >= 2) {
            // SMART PIPE GUARD - pipe-separated lines are usually nav links
            // ("VIDEOS | CREDIT APPLICATION | CONTACT US") but could contain a
            // company name segment ("Home | Example Bank | Contact").
            // Check if any segment correlates with the email domain root before
            // rejecting the whole line. If a segment matches, extract just that segment.
            const domInfo = extractDomainRoot(extEmail);
            if (domInfo && domInfo.root.length >= 3) {
              const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
              const domSegment = segments.find(s => s.toLowerCase().includes(domInfo.root));
              if (domSegment && domSegment.length < 50 && !isOwnBranding(domSegment) && !isPhoneNumber(domSegment)) {
                companyName = domSegment;
              }
            }
            // If no domain match, skip the whole line (it's nav links)
          } else if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Real Estate|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|American|Pacific|Atlantic|Southern|Northern|Western|Eastern|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
            // Make sure it's not a sentence, email header, or tagline
            // Allow trailing "." for abbreviations (Inc., Ltd., Corp., Co.)
            const kwLineEndsPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(line.trim());
            if (!/^(from|to|cc|date|subject|sent|good|hi |hello|please|thank|best|regard|we |the |a |mobile|office|fax|email|web|phone)/i.test(line) && !kwLineEndsPunct && !/^\d/.test(line)) {
              if (!isOwnBranding(line) && !isPhoneNumber(line)) {
                companyName = line;
              }
            }
          }
        }

        // EMAIL-HINT-GUIDED NAME DETECTION
        if (line.length < 60) {
          let candFirst = '', candLast = '', candNick = '';

          // Handle "Last, First" format
          // Accept Unicode smart quotes (\u2018\u2019) in names like O'Broker
          const commaName = line.match(/^([A-Z][a-zA-Z'\u2018\u2019-]+),\s+([A-Z][a-zA-Z'\u2018\u2019-]+(?:\s+[A-Z]\.?)?)\s*$/);
          if (commaName) {
            candLast = commaName[1];
            candFirst = commaName[2].split(/\s+/)[0];
          } else {
            // Handle "First (Nick) Last" - e.g., "Jane (Janie) Broker"
            const nameWithNick = line.match(/^([A-Z][a-zA-Z'\u2018\u2019-]+)\s+\(([A-Za-z]+)\)\s+([A-Z][a-zA-Z'\u2018\u2019-]+)\s*$/);
            if (nameWithNick) {
              candFirst = nameWithNick[1];
              candNick = nameWithNick[2];
              candLast = nameWithNick[3];
            } else {
              // Handle "First M. Last" or "First Last"
              // allow credential suffixes ("Jane Doe, CPA", ", CFA, MBA") and accented letters
              const nameLine = line.match(/^([A-Z][a-zA-Z\u00c0-\u00ff'\u2018\u2019-]+)\s+(?:[A-Z]\.?\s+)?([A-Z][a-zA-Z\u00c0-\u00ff'\u2018\u2019-]+)(?:\s*,\s*[A-Z][A-Za-z.]{1,9})*\s*$/);
              if (nameLine && !/^(From|To|Cc|Date|Subject|Sent|When|Where|Good|Best|Thank|Hi|Hello|Dear|Just|We|The|This|Please|Looking)/i.test(nameLine[1])) {
                candFirst = nameLine[1];
                candLast = nameLine[2];
              }
            }
          }

          if (candFirst && candLast) {
            // Don't accept as name if it matches the company we already found
            const fullCand = (candFirst + ' ' + candLast).toLowerCase();
            if (companyName && fullCand === companyName.toLowerCase()) {
              // This line is the company name, not a person - skip
            } else if (nameHints && nameMatchesHints(candFirst, candLast, candNick, nameHints)) {
              // Hint-confirmed match - accept immediately
              firstName = candFirst;
              lastName = candLast;
              nickname = candNick;
            } else {
              // Always overwrite fallback - farthest from email wins
              // In signatures, the person's name is at the TOP of the block (farthest
              // from email address). The company name is closer. By always overwriting,
              // we ensure "Jane Broker" (top) beats "Example Co" (middle).
              fallbackFirst = candFirst;
              fallbackLast = candLast;
              fallbackNick = candNick;
            }
          }
        }

        // City, State from address line - handles "City, ST 12345" and "City ST, 12345"
        // REMOVED isOwnAddress guard - rely on phone blacklist only
        if (!city) {
          const cityState = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
          if (cityState) {
            city = cityState[1]; state = cityState[2];
          }
        }

        // COUNTRY FIELD - detect country names in signature
        if (!country) {
          const countryMatch = line.match(/\b(TURKEY|CANADA|UNITED KINGDOM|UK|AUSTRALIA|GERMANY|FRANCE|BRAZIL|MEXICO|INDIA|JAPAN|CHINA|SOUTH KOREA|ITALY|SPAIN|NETHERLANDS|SWITZERLAND|SWEDEN|NORWAY|DENMARK|IRELAND|SINGAPORE|HONG KONG|NEW ZEALAND|ISRAEL|UAE|UNITED ARAB EMIRATES|QATAR|BAHRAIN|KUWAIT|SAUDI ARABIA|SOUTH AFRICA|CAYMAN ISLANDS|BERMUDA|BAHAMAS|COLOMBIA|CHILE|ARGENTINA|PERU)\b/i);
          if (countryMatch) {
            country = countryMatch[1];
          }
        }

        // STATE/COUNTRY DISAMBIGUATION
        // If "state" value is actually a country name, move it to country
        if (state && !country) {
          const COUNTRIES = new Set(['turkey', 'canada', 'united kingdom', 'uk', 'australia', 'germany', 'france', 'brazil', 'mexico', 'india', 'japan', 'china', 'italy', 'spain', 'netherlands', 'switzerland', 'sweden', 'norway', 'denmark', 'ireland', 'singapore', 'hong kong', 'new zealand', 'israel', 'uae', 'united arab emirates', 'qatar', 'bahrain', 'kuwait', 'saudi arabia', 'south africa', 'cayman islands', 'bermuda', 'bahamas', 'colombia', 'chile', 'argentina', 'peru']);
          if (COUNTRIES.has(state.toLowerCase())) {
            country = state;
            state = '';
          }
        }
      }

      // Name priority chain - hint-matched > header-extracted > fallback
      if (!firstName && headerFirst && headerLast) {
        firstName = headerFirst;
        lastName = headerLast;
      }
      if (!firstName && fallbackFirst) {
        firstName = fallbackFirst;
        lastName = fallbackLast;
        nickname = fallbackNick;
      }

      // Also scan lines AFTER the email for phone/address/company
      const afterLines = afterEmail.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      for (let i = 0; i < Math.min(afterLines.length, 15); i++) {
        const line = afterLines[i];
        if (/^(From|To|Cc|Date|Subject|Sent|Von|An|Gesendet|Betreff|De|\u00c0|Envoy\u00e9|Objet)\s*:|^-----/i.test(line)) break;

        // BOUNDARY - Stop scanning if we hit an own-company staff email
        // This prevents crossing from the contact's signature into the forwarder's own-company signature
        // and picking up the forwarder's city as the contact's city.
        // Only breaks on own-domain emails - NOT on other external emails,
        // because the forwarder sometimes pastes contact info in non-standard order with
        // multiple emails, personal backups, etc. We only need to guard against
        // the forwarder's own-company signature bleeding into the contact's data.
        const lineEmails = line.match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
        const hitsOwnSig = lineEmails.some(e =>
          [...OWN_DOMAINS].some(d => e.toLowerCase().endsWith('@' + d)) ||
          e.toLowerCase() === (excludeForwarder || '').toLowerCase()
        );
        if (hitsOwnSig) break;
        // A staff signature without an email line still starts with the staff name or branding.
        if (OWN_STAFF_FULL.includes(line.toLowerCase()) || isOwnBranding(line)) break;

        // Own-company phone guard applies to after-email scan too
        // Same "P" prefix fix as above
        // Bare vanity phone extraction
        if (!phone && !CELL_PHONE_RE.test(line)) {
          // Removed "Direct" - now maps to mobile by convention (office=phone, direct=mobile)
          // Added "Direct Line" - office phone, not mobile
          const phoneMatch = line.match(PHONE_LABEL_RE);
          if (phoneMatch) {
            const candidate = extToX(phoneMatch[1]);
            if (!isOwnCompanyPhone(candidate)) phone = candidate;
          }
          // Bare vanity phone in after-email scan
          if (!phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized)) {
                phone = normalized;
              }
            }
          }
          // Number-then-label pattern - "555.010.0109 office"
          if (!phone) {
            const phoneSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            if (phoneSuffix && !isOwnCompanyPhone(phoneSuffix[1])) phone = phoneSuffix[1];
          }
        }
        if (!mobile) {
          // Added "Direct" - convention: direct/cell=mobile
          // Negative lookahead excludes "Direct Line" (handled by phone regex)
          const mobileMatch = line.match(MOBILE_LABEL_RE);
          if (mobileMatch) {
            const candidate = mobileMatch[1].replace(/\s*[\(]?(?:ext|x|extension)\.?\s*\d+\)?\s*$/i, '').trim();
            if (!isOwnCompanyPhone(candidate)) mobile = candidate;
          }
          // Number-then-label pattern - "555.010.0110 direct"
          if (!mobile) {
            const mobileSuffix = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            if (mobileSuffix && !isOwnCompanyPhone(mobileSuffix[1])) mobile = mobileSuffix[1];
          }
          // Bare vanity as mobile (second vanity number in signature = mobile/toll-free)
          if (!mobile && phone) {
            const vanityMatch = line.match(/^(\(?\d{3}\)?[\s.\-]?\d{2,3}[\s.\-]?[A-Z]{2,}(?:\s*[-]\s*\([^)]+\))?)/i);
            if (vanityMatch) {
              const raw = vanityMatch[1].replace(/\s*[-]\s*\([^)]+\)\s*$/, '').trim();
              const vMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
              const normalized = raw.replace(/[A-Za-z]/g, ch => vMap[ch.toUpperCase()] || ch);
              const digits = normalized.replace(/\D/g, '');
              if (digits.length >= 7 && !isOwnCompanyPhone(normalized) && normalized !== phone) {
                mobile = normalized;
              }
            }
          }
        }
        // City/state - same boundary applies (won't reach here if boundary hit above)
        if (!city) {
          const cityState = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
          if (cityState) {
            city = cityState[1]; state = cityState[2];
          }
        }
        // Same @ guard for company in after-email scan
        // Smart pipe guard + domain correlation (same as before-email scan)
        if (!companyName && line.length < 80 && line.length > 2) {
          if (/@/.test(line) || /^https?:\/\//i.test(line) || /^www\./i.test(line)) {
            // Skip - email/URL line
          } else if ((line.match(/\|/g) || []).length >= 2) {
            // Smart pipe guard - check for domain-correlated segment first
            const domInfo = extractDomainRoot(extEmail);
            if (domInfo && domInfo.root.length >= 3) {
              const segments = line.split('|').map(s => s.trim()).filter(s => s.length > 0);
              const domSegment = segments.find(s => s.toLowerCase().includes(domInfo.root));
              if (domSegment && domSegment.length < 50 && !isOwnBranding(domSegment) && !isPhoneNumber(domSegment)) {
                companyName = domSegment;
              }
            }
          } else if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Real Estate|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|American|Pacific|Atlantic|Southern|Northern|Western|Eastern|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
            // Allow trailing "." for abbreviations (Inc., Ltd., Corp., Co.)
            const kwAfterEndsPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|Jr|Sr|Esq|LLC|LLP|P\.?C|L\.?C)\.\s*$/i.test(line.trim());
            if (!/^(from|to|cc|date|subject|sent|good|hi |hello|please|thank|best|regard|we |the |a |mobile|office|fax|email|web|phone)/i.test(line) && !kwAfterEndsPunct && !/^\d/.test(line)) {
              if (!isOwnBranding(line) && !isPhoneNumber(line)) {
                companyName = line;
              }
            }
          }
        }
      }

      // THREE-LAYER COMPANY FALLBACK
      // If keyword scanning didn't find a company name, try domain-based methods
      if (!companyName) {
        const domainInfo = extractDomainRoot(extEmail);
        if (domainInfo) {
          // Layer 1: Search lines for text correlating with the email domain
          // e.g., domain "example" -> find line "Example Bank"
          const correlated = findDomainCorrelatedCompany(lines, domainInfo.root);
          if (correlated) {
            companyName = correlated;
          } else {
            // Also check after-email lines
            const afterLines = body.substring(emailIdx, Math.min(body.length, emailIdx + 500))
              .split('\n').map(l => l.trim()).filter(l => l.length > 0);
            const correlatedAfter = findDomainCorrelatedCompany(afterLines, domainInfo.root);
            if (correlatedAfter) {
              companyName = correlatedAfter;
            } else {
              // Layer 3: Synthesize from domain + TLD
              // e.g., "example" + ".bank" = "Example Bank"
              companyName = inferCompanyFromDomain(extEmail);
              companyGuessed = true;
            }
          }
        }
      }

      // Score this extraction - pick the best one across all occurrences
      let score = 0;
      if (firstName) score += 3;
      if (lastName) score += 3;
      if (phone) score += 2;
      if (mobile) score += 2;
      if (jobTitle) score += 1;
      if (companyName) score += 1;
      if (city) score += 1;

      if (score > bestScore && (firstName || lastName)) {
        bestScore = score;
        bestContact = {
          // Title Case normalization - "JANE BROKER" -> "Jane Broker"
          firstName: toTitleCase(firstName),
          lastName: toTitleCase(lastName),
          nickname,
          email: extEmail,
          phone, mobile,
          companyName: stripTrailingPhone(companyName),
          companyGuessed,
          // Title Case for job titles too - "EQUIPMENT FINANCE MANAGER" -> "Equipment Finance Manager"
          jobTitle: toTitleCase(jobTitle),
          city, state,
          address: '', country: country || '',
          website: '',
          type: '', specificType: '',
          confidence: 'high',
          extractionMethod: 'SIGNATURE_SCAN',
          infoNotes: ['Extracted via deterministic signature scan']
        };
      }
    }

    if (bestContact) {
      results.push(bestContact);
    }

    // FROM-HEADER BODY SCAN FALLBACK
    // When external email appears ONLY in From: header of a forwarded message (not in a
    // signature), the position loop above skips it. This fallback extracts the contact name
    // from the From: header and scans the forwarded email body for phone, address, company.
    // Observed failure: a contact (exec 424) - email only in "From: Jane Broker <jane@...>"
    if (!bestContact) {
      const esc = extEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const fromRe = new RegExp('From:[^\\n]*<?' + esc + '>?', 'i');
      const fMatch = body.match(fromRe);
      if (fMatch) {
        // Extract name from From: header
        const nameInFrom = fMatch[0].match(/From:\s*"?([^"<\n]+)"?\s*</i);
        let fbFirst = '', fbLast = '';
        if (nameInFrom) {
          const parts = nameInFrom[1].trim().split(/\s+/);
          if (parts.length >= 2) {
            fbFirst = parts[0];
            fbLast = parts[parts.length - 1];
          }
        }

        // Find the forwarded email body section (after Subject: line)
        const headerIdx = body.indexOf(fMatch[0]);
        const afterHeader = body.substring(headerIdx);
        const subjLine = afterHeader.match(/^Subject:.*$/m);
        const bodyStart = subjLine
          ? afterHeader.indexOf(subjLine[0]) + subjLine[0].length
          : fMatch[0].length;
        const bodySection = afterHeader.substring(bodyStart);

        // Find end boundary (next forwarding marker or disclaimer)
        const boundary = bodySection.match(/\n(?:-{5,}|_{5,}|={5,}|From:\s|---------- Forwarded|Begin forwarded|This e-?mail contains CONFIDENTIAL)/m);
        const endIdx = boundary ? bodySection.indexOf(boundary[0]) : bodySection.length;
        const scanText = bodySection.substring(0, Math.min(endIdx, 2000));
        const fbLines = scanText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length < 200);

        let fbPhone = '', fbMobile = '', fbCompany = '', fbTitle = '';
        let fbCity = '', fbState = '', fbCountry = '', fbWebsite = '';

        for (const line of fbLines) {
          if (/confidential|privilege|disclaimer/i.test(line)) continue;

          // Phone (label-before + number-before patterns)
          if (!fbPhone && !CELL_PHONE_RE.test(line)) {
            const pm1 = line.match(PHONE_LABEL_RE);
            const pm2 = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:office|business|main|work)\b/i);
            const pm = pm1 || pm2;
            if (pm && !isOwnCompanyPhone(pm[1])) fbPhone = extToX(pm[1]);
          }
          // Mobile/Direct
          if (!fbMobile) {
            const mm1 = line.match(MOBILE_LABEL_RE);
            const mm2 = line.match(/([\d(+][\d\s.()\-]{6,}\d)\s+(?:direct|cell|mobile)\b/i);
            const mm = mm1 || mm2;
            if (mm && !isOwnCompanyPhone(mm[1])) fbMobile = mm[1];
          }
          // Standalone phone fallback (same as primary scanner)
          if (!fbPhone && !fbMobile) {
            const sp = line.match(/^([\d(+][\d\s.()\-]{6,}\d)\s*$/);
            if (sp) {
              const digits = sp[1].replace(/\D/g, '');
              if (digits.length >= 7 && digits.length <= 15 && !isOwnCompanyPhone(sp[1])) {
                fbPhone = sp[1];
              }
            }
          }
          // City, State
          if (!fbCity) {
            const cs = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
            if (cs) { fbCity = cs[1]; fbState = cs[2]; }
          }
          // Country
          if (!fbCountry) {
            const cm = line.match(/\b(TURKEY|CANADA|UNITED KINGDOM|UK|AUSTRALIA|GERMANY|FRANCE|BRAZIL|MEXICO|INDIA|JAPAN|CHINA|SOUTH KOREA|ITALY|SPAIN|NETHERLANDS|SWITZERLAND|SWEDEN|NORWAY|DENMARK|IRELAND|SINGAPORE|HONG KONG|NEW ZEALAND|ISRAEL|UAE|UNITED ARAB EMIRATES|QATAR|BAHRAIN|KUWAIT|SAUDI ARABIA|SOUTH AFRICA|CAYMAN ISLANDS|BERMUDA|BAHAMAS|COLOMBIA|CHILE|ARGENTINA|PERU)\b/i);
            if (cm) fbCountry = cm[1];
          }
          // Website: exclude own-company domains
          if (!fbWebsite && /^(?:www\.|https?:\/\/)/i.test(line)) {
            const urlLower = line.trim().toLowerCase();
            const isOwnUrl = [...OWN_DOMAINS].some(d => urlLower.includes(d));
            if (!isOwnUrl) {
              fbWebsite = line.trim();
            }
          }
          // Company
          if (!fbCompany && line.length < 80 && line.length > 2) {
            if (!/@/.test(line) && !/^https?:\/\//i.test(line) && !/^www\./i.test(line) && !/^\d/.test(line)) {
              if (/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Enterprises|Insurance|Realty|Mortgage|Lending|Leasing|Credit|Trust|Fund|Investment|Asset|Global|National|Equipment|Company|Properties|Development|Construction|Engineering|Technology|Systems)/i.test(line)) {
                const endsWithPunct = /[.!?]$/.test(line.trim()) && !/(?:Inc|Ltd|Corp|Co|LLC|LLP)\.\s*$/i.test(line.trim());
                if (!endsWithPunct && !isOwnBranding(line) && !isPhoneNumber(line)) {
                  fbCompany = line;
                }
              }
            }
          }
          // Title
          // Added LLC/Inc/Corp guard (same as primary scanner)
          if (!fbTitle && line.length < 100 && /(?:Director|President|Vice|Manager|Advisor|Officer|Partner|Principal|Chief|Counsel|Attorney|Senior|Associate|Analyst|Consultant|Specialist|Executive|Managing|Broker|Banker|Underwriter|Originator|VP\b|SVP\b|EVP\b)/i.test(line)) {
            if (!/[.!?]$/.test(line.trim()) && !/^(good|it was|please|looking|thank|we |the )/i.test(line) && !/(?:LLC|Inc|Corp|LLP|Ltd|L\.?L\.?C|P\.?C)\b/i.test(line)) {
              fbTitle = line;
            }
          }
        }

        // Company fallback from domain
        const fbCompanyGuessed = !fbCompany;
        if (!fbCompany) {
          fbCompany = inferCompanyFromDomain(extEmail);
        }

        // Only create contact if we got a name + at least one useful field
        if (fbFirst && fbLast && (fbPhone || fbMobile || fbCompany)) {
          bestContact = {
            firstName: toTitleCase(fbFirst),
            lastName: toTitleCase(fbLast),
            nickname: '',
            email: extEmail,
            phone: fbPhone, mobile: fbMobile,
            companyName: stripTrailingPhone(fbCompany),
            companyGuessed: fbCompanyGuessed,
            jobTitle: toTitleCase(fbTitle),
            city: fbCity, state: fbState,
            address: '', country: fbCountry || '',
            website: fbWebsite,
            type: '', specificType: '',
            confidence: 'medium',
            extractionMethod: 'HEADER_BODY_SCAN',
            infoNotes: ['Contact extracted from forwarded email headers + body (no inline signature)']
          };
          results.push(bestContact);
        }
      }
    }
  }

  return { contacts: results, pendingTldLess: _pendingTldLess };
}

// Use just the current item from the outer loop (not re-reading all items)
const items = [_item];
const results = [];

let _outerTldLessPending = []; // outer-scope for post-inner-for TLD resolution
for (const item of items) {
  const data = item.json;
  let jsonText = '';

  try {
    // Step 1: Extract raw text from AI response
    if (data.message && data.message.content) {
      jsonText = data.message.content;
    } else if (data.response) {
      jsonText = data.response;
    } else if (data.content) {
      jsonText = data.content;
    } else if (typeof data === 'string') {
      jsonText = data;
    } else {
      jsonText = JSON.stringify(data);
    }

    // Step 2: Strip markdown code fences
    jsonText = jsonText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();

    // Step 3: Extract JSON from response text
    let jsonMatch = null;

    // Strategy A: Find outermost array [...]
    const arrayStart = jsonText.indexOf('[');
    const arrayEnd = jsonText.lastIndexOf(']');
    if (arrayStart !== -1 && arrayEnd > arrayStart) {
      const candidate = jsonText.substring(arrayStart, arrayEnd + 1);
      try {
        JSON.parse(candidate);
        jsonMatch = candidate;
      } catch (e) {}
    }

    // Strategy B: Find outermost object {...}
    if (!jsonMatch) {
      const objStart = jsonText.indexOf('{');
      const objEnd = jsonText.lastIndexOf('}');
      if (objStart !== -1 && objEnd > objStart) {
        const candidate = jsonText.substring(objStart, objEnd + 1);
        try {
          JSON.parse(candidate);
          jsonMatch = candidate;
        } catch (e) {}
      }
    }

    // Strategy C: Try parsing the whole text as-is
    if (!jsonMatch) {
      try {
        JSON.parse(jsonText);
        jsonMatch = jsonText;
      } catch (e) {}
    }

    if (jsonMatch) jsonText = jsonMatch;

    // Wrap JSON.parse in its own try-catch so the scanner
    // can still run when the AI returns prose instead of JSON. Previously, the
    // JSON.parse throw propagated to the outer catch which returned contacts: []
    // and the scanner (line ~718) never got a chance to execute.
    let parsed = null;
    let aiParseError = false;
    let aiErrorMessage = '';
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      aiParseError = true;
      aiErrorMessage = parseErr.message;
      // Don't throw - fall through so the scanner can run
    }

    // Step 4: Normalize to contacts array
    let contacts = [];
    if (parsed) {
      if (Array.isArray(parsed)) {
        contacts = parsed;
      } else if (parsed.contacts && Array.isArray(parsed.contacts)) {
        contacts = parsed.contacts;
      } else if (parsed.email || parsed.firstName || parsed.lastName || parsed.name) {
        contacts = [parsed];
      }
    }

    // Filter out any entries that are clearly not contact objects
    contacts = contacts.filter(c => c && typeof c === 'object' && !Array.isArray(c));

    // Declare fullBody early - needed by the firstName header fallback below
    // Previously declared at line ~1345 (personal domain filter), causing ReferenceError
    // when any contact had empty firstName. Observed failure: a contact with empty firstName -> 0 contacts (exec 458).
    const fullBody = prevData.fullBody || '';

    // FIELD NORMALIZATION - Map AI field names to pipeline field names
    for (const contact of contacts) {
      // The AI sometimes nests values (phone: {office, mobile}). That threw a TypeError in string
      // handling, sent the email down the error path and lost the scanner's contacts too.
      if (contact.phone && typeof contact.phone === 'object' && !Array.isArray(contact.phone)) {
        const p = contact.phone;
        if (!contact.mobile && (p.mobile || p.cell)) contact.mobile = String(p.mobile || p.cell);
        contact.phone = String(p.office || p.work || p.phone || p.direct || '');
      }
      for (const [k, v] of Object.entries(contact)) {
        if (v === null || v === undefined) contact[k] = '';
        else if (Array.isArray(v)) contact[k] = v.filter(x => typeof x !== 'object').join(', ');
        else if (typeof v === 'object') contact[k] = Object.values(v).filter(x => typeof x !== 'object').join(' ');
        else if (typeof v !== 'string') contact[k] = String(v);
      }
      // company -> companyName (pipeline standard)
      if (contact.company && !contact.companyName) {
        contact.companyName = contact.company;
      }

      // title -> jobTitle (pipeline standard)
      if (contact.title && !contact.jobTitle) {
        contact.jobTitle = contact.title;
      }

      // Handle "name" field -> firstName + lastName
      if (contact.name && (!contact.firstName || !contact.lastName)) {
        const nameParts = contact.name.trim().split(/\s+/);
        if (nameParts.length >= 2) {
          contact.firstName = contact.firstName || nameParts[0];
          contact.lastName = contact.lastName || nameParts[nameParts.length - 1];
        } else if (nameParts.length === 1) {
          contact.lastName = contact.lastName || nameParts[0];
        }
      }

      // CLEAR BAD COMPANY BEFORE PIPE SPLIT
      // Must run before title-pipe split so the split can fire as fallback
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }

      // AI-EXTRACTED COMPANY GUARD
      // Guard BEFORE pipe split so pipe split can provide company as fallback
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }

      // TITLE-PIPE SPLIT (name-aware)
      // "Senior Sales Director | Example Brokers" -> title = "Senior Sales Director", company = "Example Brokers"
      // "Jane Broker | Director | Finance | Example Co" -> title = "Director", company = "Example Co"
      if (contact.jobTitle && contact.jobTitle.includes('|')) {
        const parts = contact.jobTitle.split('|').map(p => p.trim()).filter(p => p.length > 0);
        if (parts.length >= 2) {
          // Check if first part is the contact's name - if so, skip it
          const _fullNameLower = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim().toLowerCase();
          const _firstPartLower = parts[0].toLowerCase();
          const _lnLower = (contact.lastName || '').toLowerCase();
          const _titleKW = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|counsel|advisor|analyst|specialist|coordinator|engineer|architect|consultant|associate|assistant)\b/i;
          // If first part contains a title keyword, it's NOT a name - safe to keep as title
          let _isNameFirst = false;
          if (!_titleKW.test(_firstPartLower)) {
            _isNameFirst = _fullNameLower && (
              _firstPartLower === _fullNameLower ||
              (_lnLower.length >= 3 && _firstPartLower.includes(_lnLower) && _firstPartLower.split(/\s+/).length <= 3)
            );
          }
          const _titleParts = _isNameFirst ? parts.slice(1) : parts;
          if (_titleParts.length >= 1) {
            contact.jobTitle = _titleParts[0];
            contact.title = _titleParts[0];
            if (!contact.companyName && !contact.company && _titleParts.length >= 2) {
              contact.companyName = _titleParts[_titleParts.length - 1];
              contact.company = _titleParts[_titleParts.length - 1];
            }
          }
        }
      }

      // PHONE LABEL STRIPPING
      function cleanPhoneLabel(phoneStr) {
        if (!phoneStr) return phoneStr;
        return phoneStr
          .replace(/\s*(?:office|direct|cell|mobile|home|work|fax|main|ext\.?\s*\d*)\s*$/i, '')
          .replace(/^\s*(?:office|direct|cell|mobile|home|work|fax|main)\s*[:.]\s*/i, '')
          .trim();
      }

      // phone: if it contains multiple numbers, split into phone + mobile
      if (contact.phone && !contact.mobile) {
        const phoneStr = contact.phone;
        const phoneNumbers = phoneStr.match(/[\d(+][\d\s.()\-]+\d/g) || [];
        if (phoneNumbers.length >= 2) {
          contact.phone = phoneNumbers[0].trim();
          contact.mobile = phoneNumbers[1].trim();
        } else {
          contact.phone = cleanPhoneLabel(contact.phone);
        }
      }
      if (contact.mobile) {
        contact.mobile = cleanPhoneLabel(contact.mobile);
      }

      // JOB TITLE / TYPE ECHO DETECTION
      if (contact.jobTitle && contact.type) {
        const titleNorm = contact.jobTitle.toLowerCase().trim();
        const typeNorm = contact.type.toLowerCase().trim();
        if (titleNorm === typeNorm) {
          contact.jobTitle = '';
          contact.title = '';
        }
      }

      // address: build from city/state if no explicit address
      if (!contact.address) {
        contact.address = '';
      }

      // country: default to empty if not provided
      if (!contact.country) {
        contact.country = '';
      }

      // website: leave empty for now - enriched below per-contact
      if (!contact.website) {
        contact.website = '';
      }

      // Title Case normalization for AI-extracted names
      if (contact.firstName) contact.firstName = toTitleCase(contact.firstName);
      if (contact.lastName) contact.lastName = toTitleCase(contact.lastName);
      if (contact.jobTitle) contact.jobTitle = toTitleCase(contact.jobTitle);

      // Fallback - extract name from email headers (From/To/Cc) when AI returns empty firstName
      if (!contact.firstName && contact.email) {
        const escEmail = contact.email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Stay on the header line ([^<\\n], [ \\t]); spanning lines read company words as the name
        const headerNameRe = new RegExp('(?:From|To|Cc):[^<\\n]*?([A-Z][a-zA-Z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff.\'\\-]+(?:[ \\t]+[A-Z][a-zA-Z\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff.\'\\-]+)+)[ \\t]*<?(?:[^<\\n]*,[ \\t]*)?<?["\']?' + escEmail, 'i');
        const hMatch = fullBody.match(headerNameRe);
        if (hMatch) {
          const rawName = hMatch[1].trim().replace(/^["']|["']$/g, '');
          const nameParts = rawName.split(/\s+/).filter(p => p.length > 0);
          // Outlook "SURNAME Given" order ("DOE Jane", "DE LA CRUZ Maria")
          let nCaps = 0;
          while (nCaps < nameParts.length && nameParts[nCaps] === nameParts[nCaps].toUpperCase() && /[A-Z]{2}/.test(nameParts[nCaps])) nCaps++;
          if (nCaps > 0 && nCaps < nameParts.length) {
            contact.firstName = nameParts.slice(nCaps).join(' ');
            contact.lastName = toTitleCase(nameParts.slice(0, nCaps).join(' '));
          } else if (nameParts.length >= 2) {
            contact.firstName = nameParts[0];
            contact.lastName = contact.lastName || nameParts[nameParts.length - 1];
          }
          if (contact.firstName) {
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Name extracted from email header (AI returned empty firstName)');
          }
        }
      }

      // Ensure all expected fields exist (prevent undefined errors downstream)
      contact.firstName = contact.firstName || '';
      contact.lastName = contact.lastName || '';
      contact.email = contact.email || '';
      contact.phone = contact.phone || '';
      contact.mobile = contact.mobile || '';
      contact.companyName = contact.companyName || '';
      contact.jobTitle = contact.jobTitle || '';
      contact.city = contact.city || '';
      contact.state = contact.state || '';
      contact.address = contact.address || '';
      contact.country = contact.country || '';
      contact.type = contact.type || '';
      contact.specificType = contact.specificType || '';
      contact.confidence = contact.confidence || '';
      contact.website = contact.website || '';

      // Strip trailing punctuation from names
      contact.firstName = (contact.firstName || '').replace(/[,;:]+$/, '').trim();
      contact.lastName = (contact.lastName || '').replace(/[,;:]+$/, '').trim();

      // Detect "Last, First" pattern - e.g., "Broker, J." stored as firstName="Broker," lastName="J."
      // If firstName contains a comma, it's likely "Last, First" format - swap them
      if (contact.firstName && contact.firstName.includes(',')) {
        const parts = (contact.firstName + ' ' + contact.lastName).split(',').map(s => s.trim());
        if (parts.length === 2 && parts[0] && parts[1]) {
          contact.lastName = parts[0];  // "Broker"
          contact.firstName = parts[1]; // "J."
        }
      }

      // Clean up alias fields to avoid confusion
      if (contact.name) delete contact.name;

      // Fix zip-in-state - if state looks like a zip code, move it to zip
      // and clear state. Do NOT try to infer state from city - many city names
      // exist in multiple states (Miami FL/OH/AZ, Portland OR/ME, etc.)
      if (contact.state && /^\d{4,5}(-\d{4})?$/.test(contact.state.trim())) {
        if (!contact.zip) contact.zip = contact.state;
        contact.state = '';
      }
      // Also catch state fields that are just numbers with spaces/dashes
      if (contact.state && /^\d[\d\s-]+$/.test(contact.state.trim())) {
        if (!contact.zip) contact.zip = contact.state.trim();
        contact.state = '';
      }
      // Validate state is a real state abbreviation or name (not a zip, phone, or junk)
      if (contact.state) {
        const s = contact.state.trim();
        // Valid: 2-letter abbreviation or full state/province name (3+ alpha chars)
        const isValidState = /^[A-Za-z]{2}$/.test(s) || (/^[A-Za-z\s]{3,}$/.test(s) && s.length <= 30);
        if (!isValidState) {
          // Not a recognizable state format - clear it
          contact.state = '';
        }
      }
    }

    // POST-PROCESSING: Filter out non-contacts

    // 1. Remove contacts matching the forwarder's email
    const forwarderEmail = (prevData.forwarderEmail || '').toLowerCase();
    if (forwarderEmail) {
      contacts = contacts.filter(c => {
        const contactEmail = (c.email || '').toLowerCase();
        return contactEmail !== forwarderEmail;
      });
    }

    // 2. Remove any own-company internal emails the AI missed
    contacts = contacts.filter(c => {
      const contactEmail = (c.email || '').toLowerCase();
      return ![...OWN_DOMAINS].some(d => contactEmail.endsWith('@' + d));
    });

    // 3. Remove personal-email chain participants.
    //    When forwarderEmail is a shared inbox (intake@example.com),
    //    the actual person who forwarded (e.g., a personal gmail.com address) isn't
    //    caught by filter #1. But they're still a chain participant, not a contact.
    //
    //    We can't simply filter all From: header emails - legitimate external
    //    contacts like Jane Broker also appear in From: lines in the inner message.
    //
    //    TARGETED APPROACH: Filter contacts with PERSONAL email domains (gmail,
    //    yahoo, etc.) that appear in the forwarding chain headers. Business-domain
    //    contacts (example.bank, exampleco.com) are never caught by this.
    const PERSONAL_DOMAINS_FILTER = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
      'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
      'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);
    // fullBody already declared earlier
    // Collect all emails from From:/Sent:/To: header lines
    const chainEmails = new Set();
    const headerLineRegex = /^(?:From|Sent|To)\s*:.*$/gim;
    let headerMatch;
    while ((headerMatch = headerLineRegex.exec(fullBody)) !== null) {
      const lineEmails = headerMatch[0].match(/[\w.+-]+@[\w.-]+\.\w{2,}/g) || [];
      for (const he of lineEmails) chainEmails.add(he.toLowerCase());
    }
    contacts = contacts.filter(c => {
      const contactEmail = (c.email || '').toLowerCase();
      if (!contactEmail) return true;
      const domain = contactEmail.split('@')[1] || '';
      // Only filter PERSONAL domain emails that appear in chain headers
      // Business domains (example.bank, etc.) are never filtered here
      if (PERSONAL_DOMAINS_FILTER.has(domain) && chainEmails.has(contactEmail)) {
        return false; // Personal email in forwarding chain = not an external contact
      }
      return true;
    });

    // ALWAYS-ON SIGNATURE SCANNER + AI MERGE

    const _scanResult = scanSignatures(prevData.fullBody || '', forwarderEmail);
    const scannedContacts = _scanResult.contacts || _scanResult; // backward compat
    _outerTldLessPending = _scanResult.pendingTldLess || [];

    // Build map of AI contacts by email (lowercase)
    const aiByEmail = new Map();
    const aiNoEmail = [];
    for (const ai of contacts) {
      const key = (ai.email || '').toLowerCase();
      if (key) {
        aiByEmail.set(key, ai);
      } else {
        aiNoEmail.push(ai);
      }
    }

    // The scanner can pick the forwarder's instruction line ("Manufacturer for Zoho") or a
    // department as company while the AI had the right one ("Acme Industries"). Prefer the
    // candidate matching the email domain; never use the forwarder instruction as a company.
    function pickCompany(scCo, aiCo, email, title) {
      const alnum = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const instr = alnum(prevData.forwarderInstruction);
      const label = ((email || '').split('@')[1] || '').toLowerCase().split('.')[0];
      const matchesDomain = s => !!s && label.length >= 3 &&
        (alnum(s).startsWith(label) || s.toLowerCase().split(/[^a-z0-9]+/).includes(label));
      // A candidate equal to the AI's job title is the title line read as company ("Principal");
      // keeping it lets the company === title cleanup replace it with the bare domain.
      const cands = [scCo, aiCo].filter(s => s && !(instr && alnum(s) === instr) && !(title && alnum(s) === alnum(title)));
      return cands.find(matchesDomain) || cands[0] || '';
    }

    // When the forwarder named who to add ("Please add Jane Doe") and the AI found that person,
    // other thread participants the scanner finds were not asked for.
    let namedScope = '';
    try {
      const s = $('Prepare Extraction Request').all()[_idx].json.instructionScope;
      if (s && s.scope === 'NAMED_PERSON') namedScope = (s.details || '').toLowerCase();
    } catch (e) {}
    const isNamedPerson = c => {
      const em = (c.email || '').toLowerCase(), local = em.split('@')[0];
      const first = (c.firstName || '').toLowerCase(), last = (c.lastName || '').toLowerCase();
      return !!namedScope && namedScope.split(/\s*,\s*/).some(n => n.includes('@') ? n === em :
        n.split(/\s+/).some(w => w.length >= 3 && (w === first || w === last || local.includes(w))));
    };
    const namedFoundByAi = contacts.some(isNamedPerson);

    // Merge: scanner contacts are primary, AI contacts are supplementary
    const mergedByEmail = new Map();

    // Add scanner contacts first (authoritative for name/phone)
    for (const sc of scannedContacts) {
      const key = sc.email.toLowerCase();
      const ai = aiByEmail.get(key);
      const scGuessed = sc.companyGuessed;
      delete sc.companyGuessed;

      if (ai) {
        // Both found this contact - merge (scanner wins for name/phone, AI wins for type)
        // If scanner's name matches the job title, it's a misidentified title - prefer AI
        let useFirstName = sc.firstName || ai.firstName;
        let useLastName = sc.lastName || ai.lastName;
        if (sc.firstName && sc.lastName && sc.jobTitle) {
          const scannerFullName = (sc.firstName + ' ' + sc.lastName).toLowerCase().trim();
          const titleLower = sc.jobTitle.toLowerCase().trim();
          if (scannerFullName === titleLower && ai.firstName) {
            useFirstName = ai.firstName;
            useLastName = ai.lastName || sc.lastName;
          }
        }
        // One line read as both title and company ("Acme Partners" hits both keyword lists)
        // means the scanner could not tell them apart; a company guessed from the domain is
        // weaker than one the model found in the text. The model's values win in both cases.
        const scAmbiguous = !!sc.jobTitle && sc.jobTitle.toLowerCase() === (sc.companyName || '').toLowerCase();
        // In a "Name | Title | Company" line the company is the last segment.
        const scPipeCompany = scAmbiguous && sc.companyName.includes('|') ? sc.companyName.split('|').pop().trim() : '';
        const scCompany = scPipeCompany || ((scAmbiguous || scGuessed) && ai.companyName ? '' : sc.companyName);
        mergedByEmail.set(key, {
          firstName: useFirstName,
          lastName: useLastName,
          email: sc.email,
          phone: sc.phone || ai.phone,
          mobile: sc.mobile || ai.mobile,
          companyName: pickCompany(scCompany, ai.companyName, sc.email, ai.jobTitle),
          jobTitle: (scAmbiguous && ai.jobTitle) || sc.jobTitle || ai.jobTitle,
          city: sc.city || ai.city,
          state: sc.state || ai.state,
          address: ai.address || '',
          country: sc.country || ai.country || '',
          website: ai.website || sc.website || '',
          type: ai.type || '',
          specificType: ai.specificType || '',
          confidence: 'high',
          extractionMethod: 'MERGED_SCAN_AND_AI',
          infoNotes: ['Contact verified by both signature scan and AI extraction'],
          nickname: sc.nickname || ''
        });
        aiByEmail.delete(key); // Mark as merged
      } else {
        // Scanner-only contact (AI missed it entirely)
        if (namedFoundByAi && !isNamedPerson(sc)) continue;
        mergedByEmail.set(key, {
          ...sc,
          extractionMethod: 'SIGNATURE_SCAN',
          infoNotes: ['Extracted via signature scan (AI missed this contact)']
        });
      }
    }

    // Add remaining AI-only contacts (scanner didn't find them)
    for (const [key, ai] of aiByEmail) {
      mergedByEmail.set(key, {
        ...ai,
        extractionMethod: ai.extractionMethod || 'AI_ONLY'
      });
    }

    // Deduplicate no-email AI contacts against scanner contacts by name
    const alreadyMergedNames = new Set(
      [...mergedByEmail.values()].map(c => ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim())
    );
    const dedupedNoEmail = aiNoEmail.filter(c => {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      return key && !alreadyMergedNames.has(key);
    });
    contacts = [...mergedByEmail.values(), ...dedupedNoEmail];

    // Full name-based dedup - when multiple contacts share the same name,
    // keep the one with the best data. Fixes triple-duplicate bug (#661).
    const nameGroups = new Map();
    for (const c of contacts) {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      if (!key) continue;
      if (!nameGroups.has(key)) nameGroups.set(key, []);
      nameGroups.get(key).push(c);
    }
    contacts = [];
    for (const [name, group] of nameGroups) {
      const genericPrefixes = ['info','sales','support','admin','contact','help','billing',
        'noreply','no-reply','fraud','abuse','spam','security','postmaster','webmaster'];
      // Two same-named people at different companies are different people; don't merge them
      const realDomains = new Set(group.map(c => (c.email || '').toLowerCase())
        .filter(e => e.includes('@') && !genericPrefixes.includes(e.split('@')[0])).map(e => e.split('@')[1]));
      if (group.length === 1 || realDomains.size > 1) {
        contacts.push(...group);
        continue;
      }
      // Score each: prefer non-generic email, most fields, highest confidence
      const scored = group.map(c => {
        let score = 0;
        const email = (c.email || '').toLowerCase();
        const localPart = email.split('@')[0] || '';
        if (email && !genericPrefixes.includes(localPart)) score += 10;
        if (c.phone) score += 2;
        if (c.mobile) score += 2;
        if (c.companyName) score += 2;
        if (c.jobTitle) score += 2;
        if (c.city) score += 1;
        if (c.website) score += 1;
        if (c.confidence === 'high') score += 3;
        else if (c.confidence === 'medium') score += 1;
        return { contact: c, score };
      });
      scored.sort((a, b) => b.score - a.score);
      // Keep the best, merge any unique fields from others into it
      const best = { ...scored[0].contact };
      for (let i = 1; i < scored.length; i++) {
        const other = scored[i].contact;
        if (!best.phone && other.phone) best.phone = other.phone;
        if (!best.mobile && other.mobile) best.mobile = other.mobile;
        if (!best.companyName && other.companyName) best.companyName = other.companyName;
        if (!best.jobTitle && other.jobTitle) best.jobTitle = other.jobTitle;
        if (!best.website && other.website) best.website = other.website;
        if (!best.city && other.city) best.city = other.city;
        if (!best.state && other.state) best.state = other.state;
        if (!best.country && other.country) best.country = other.country;
      }
      contacts.push(best);
    }
    // Also add back any contacts that had no name (anonymous/email-only)
    for (const c of [...mergedByEmail.values(), ...dedupedNoEmail]) {
      const key = ((c.firstName || '') + ' ' + (c.lastName || '')).toLowerCase().trim();
      if (!key && !contacts.includes(c)) contacts.push(c);
    }

    // AI NARRATIVE HEADER FALLBACK
    // When AI returned narrative text (not JSON) and mentioned email addresses that the
    // scanner missed because they only appear on From:/To:/Cc: header lines, extract
    // those contacts as a fallback. Observed failure: header-only contact (exec 577).
    if (aiParseError && jsonText) {
      const narrativeEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
      const narrativeEmails = (jsonText.match(narrativeEmailRegex) || []);
      const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()));
      const OWN_DOMAINS_FALLBACK = new Set([...OWN_DOMAINS, 'example-consultancy.com']);
      const PERSONAL_DOMAINS_FALLBACK = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com']);

      for (const nEmail of narrativeEmails) {
        const nEmailLower = nEmail.toLowerCase();
        const nDomain = nEmailLower.split('@')[1] || '';
        // Skip if already found, or internal/personal
        if (existingEmails.has(nEmailLower)) continue;
        if (OWN_DOMAINS_FALLBACK.has(nDomain)) continue;
        if (PERSONAL_DOMAINS_FALLBACK.has(nDomain)) continue;
        if (nEmailLower === (forwarderEmail || '').toLowerCase()) continue;

        // Check if this email exists anywhere in the original email body (even on header lines)
        const bodyCheck = (prevData.fullBody || '').toLowerCase();
        if (!bodyCheck.includes(nEmailLower)) continue;

        // Try to extract name from the header line where this email appears
        let fallbackFirst = '', fallbackLast = '';
        const escapedNEmail = nEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // Match patterns like: "LASTNAME FirstName <email>" or "FirstName LastName <email>"
        const headerNameRegex = new RegExp('(?:From|To|Cc|Bcc)\\s*:[^\\n]*?([^"<,;\\n]+?)\\s*<?\\s*' + escapedNEmail, 'im');
        const headerNameMatch = (prevData.fullBody || '').match(headerNameRegex);
        if (headerNameMatch) {
          const rawName = headerNameMatch[1].trim().replace(/^["']|["']$/g, '');
          // Handle "LASTNAME FirstName" (all-caps last name pattern) and "FirstName LastName"
          const nameParts = rawName.split(/\s+/).filter(p => p.length > 0);
          if (nameParts.length >= 2) {
            // Check if first part is all uppercase (European style: LASTNAME FirstName)
            if (nameParts[0] === nameParts[0].toUpperCase() && nameParts[0].length > 1) {
              fallbackLast = nameParts[0].charAt(0) + nameParts[0].slice(1).toLowerCase();
              // Handle hyphenated last names like "SMITH-JONES"
              fallbackLast = nameParts.slice(0, -1).map(p =>
                p.split('-').map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase()).join('-')
              ).join(' ');
              fallbackFirst = nameParts[nameParts.length - 1].charAt(0).toUpperCase() +
                nameParts[nameParts.length - 1].slice(1).toLowerCase();
            } else {
              fallbackFirst = nameParts[0];
              fallbackLast = nameParts.slice(1).join(' ');
            }
          }
        }

        contacts.push({
          firstName: fallbackFirst,
          lastName: fallbackLast,
          nickname: '',
          email: nEmail,
          phone: '', mobile: '',
          companyName: '',
          jobTitle: '',
          city: '', state: '', address: '', country: '',
          website: '',
          type: '', specificType: '',
          confidence: 'medium',
          extractionMethod: 'AI_NARRATIVE_HEADER_FALLBACK',
          infoNotes: ['Contact extracted from AI narrative text + email header (scanner skipped header-only emails)']
        });
        existingEmails.add(nEmailLower);
      }
    }

    // Post-merge title/company cleanup
    const TITLE_KEYWORDS = /president|director|manager|officer|founder|partner|member|professional|advisor|broker|sales|marketing|vp|svp|ceo|cfo|coo|cto|licensed|managing|senior|executive|associate|consultant|specialist|principal|chairman|head|lead|coordinator/i;

    for (const contact of contacts) {
      // Fix 3a: Pipe-split in title or company fields
      const pipeFields = ['jobTitle', 'companyName'];
      for (const field of pipeFields) {
        const val = contact[field] || '';
        if (val.includes(' | ') || val.includes(' | ')) {
          const parts = val.split(/\s*[|]\s*/);
          if (parts.length === 2) {
            const hasTitleA = TITLE_KEYWORDS.test(parts[0]);
            const hasTitleB = TITLE_KEYWORDS.test(parts[1]);
            if (hasTitleA && !hasTitleB) {
              contact.jobTitle = parts[0];
              if (!contact.companyName || contact.companyName === val) contact.companyName = parts[1];
            } else if (hasTitleB && !hasTitleA) {
              contact.jobTitle = parts[1];
              if (!contact.companyName || contact.companyName === val) contact.companyName = parts[0];
            }
          }
        }
      }

      // Fix 3b: Company === Title - clear company, derive from domain
      if (contact.companyName && contact.jobTitle &&
          contact.companyName.trim().toLowerCase() === contact.jobTitle.trim().toLowerCase()) {
        // Title is more likely correct for role descriptions
        contact.companyName = '';
        // Try to derive company from email domain
        if (contact.email) {
          const domain = contact.email.split('@')[1] || '';
          if (domain) {
            const domainBase = domain.split('.')[0];
            if (domainBase && domainBase.length > 2) {
              // Capitalize: "examplebank" -> "Examplebank"
              contact.companyName = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
            }
          }
        }
      }

      // Fix 3c: Company is the person's name - clear it
      if (contact.companyName && contact.firstName && contact.lastName) {
        const compLower = contact.companyName.toLowerCase().trim();
        const nameLower = (contact.firstName + ' ' + contact.lastName).toLowerCase().trim();
        const nameReversed = (contact.lastName + ' ' + contact.firstName).toLowerCase().trim();
        if (compLower === nameLower || compLower === nameReversed ||
            compLower.startsWith(nameLower + ' |') || compLower.startsWith(nameReversed + ' |')) {
          contact.companyName = '';
          // Derive from domain
          if (contact.email) {
            const domain = contact.email.split('@')[1] || '';
            const domainBase = domain.split('.')[0] || '';
            if (domainBase && domainBase.length > 2) {
              contact.companyName = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
            }
          }
        }
      }
    }

    // Drop incomplete PDF OCR duplicates
    // If a PDF_OCR contact has no lastName AND no email, and another contact
    // shares the same firstName with higher confidence, drop the OCR contact
    contacts = contacts.filter((c, idx) => {
      if (c.extractionMethod !== 'PDF_OCR') return true;
      if (c.lastName && c.email) return true; // Has enough data, keep it
      if (!c.firstName) return false; // No name at all, drop

      const fnLower = c.firstName.toLowerCase();
      const hasBetterDuplicate = contacts.some((other, otherIdx) => {
        if (otherIdx === idx) return false;
        if (other.extractionMethod === 'PDF_OCR') return false; // Don't compare OCR to OCR
        return (other.firstName || '').toLowerCase() === fnLower;
      });

      if (hasBetterDuplicate && (!c.lastName || !c.email)) {
        return false; // Drop this incomplete OCR contact
      }
      return true;
    });

    // POST-MERGE COMPANY GUARD + PIPE SPLIT
    // The merge may have restored bad company values from the scanner.
    // Re-apply the same guards that ran during normalization.
    for (const contact of contacts) {
      // Guard: clear own-company branding or phone-number company
      if (contact.companyName && (isOwnBranding(contact.companyName) || isPhoneNumber(contact.companyName))) {
        contact.companyName = '';
        contact.company = '';
      }
      // Re-apply pipe split on jobTitle if company is empty (name-aware)
      if (contact.jobTitle && contact.jobTitle.includes('|') && !contact.companyName) {
        const pipeParts = contact.jobTitle.split('|').map(p => p.trim()).filter(p => p.length > 0);
        if (pipeParts.length >= 2) {
          const _fn2 = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim().toLowerCase();
          const _ln2 = (contact.lastName || '').toLowerCase();
          const _fp2 = pipeParts[0].toLowerCase();
          const _tkw2 = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|counsel|advisor|analyst|specialist|coordinator|engineer|architect|consultant|associate|assistant)\b/i;
          let _isName = false;
          if (!_tkw2.test(_fp2)) {
            _isName = _fn2 && (
              _fp2 === _fn2 ||
              (_ln2.length >= 3 && _fp2.includes(_ln2) && _fp2.split(/\s+/).length <= 3)
            );
          }
          const _tParts = _isName ? pipeParts.slice(1) : pipeParts;
          if (_tParts.length >= 1) {
            contact.jobTitle = _tParts[0];
            contact.title = _tParts[0];
            if (_tParts.length >= 2) {
              contact.companyName = _tParts[_tParts.length - 1];
              contact.company = _tParts[_tParts.length - 1];
            }
          }
        }
      }
    }

    // A staff signature quoted in the thread carries the office address. A city that only
    // ever appears next to a staff phone is ours, not the contact's, whoever extracted it.
    const addrLines = fullBody.split('\n').map(l => l.trim()).filter(Boolean);
    const ownCities = new Set(), otherCities = new Set();
    addrLines.forEach((line, i) => {
      const m = line.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s*,?\s*([A-Z]{2})\s*,?\s*\d{5}/);
      if (!m) return;
      const nearOwnPhone = addrLines.slice(Math.max(0, i - 2), i + 3)
        .some(l => (l.match(/[\d(+][\d\s.()\-]{6,}\d/g) || []).some(isOwnCompanyPhone));
      (nearOwnPhone ? ownCities : otherCities).add(m[1].toLowerCase());
    });
    for (const contact of contacts) {
      const cityLower = (contact.city || '').trim().toLowerCase();
      if (cityLower && ownCities.has(cityLower) && !otherCities.has(cityLower)) {
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('Cleared own-office city "' + contact.city + '"');
        contact.city = '';
        contact.state = '';
      }
    }

    // PHONE/MOBILE SANITY CHECK
    // Count vanity letters as digits for validation (DEAL=3325 = 4 more digits)
    function countPhoneDigits(phoneStr) {
      if (!phoneStr) return 0;
      const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
      const converted = phoneStr.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch);
      return converted.replace(/\D/g, '').length;
    }
    // Normalize vanity phone to digits for Zoho storage
    function normalizeVanityPhone(phoneStr) {
      if (!phoneStr) return phoneStr;
      // Only convert if it contains a mix of digits and letters in phone-like pattern
      if (!/^[\d(+]/.test(phoneStr.trim())) return phoneStr;
      // Set an extension aside first: 'ext' was being converted like a vanity word (e=3, x=9, t=8)
      const ext = phoneStr.match(/\s*(?:ext\.?|extension|x)\s*(\d+)\s*$/i);
      if (ext) phoneStr = phoneStr.slice(0, ext.index);
      const vanityMap = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
      return phoneStr.replace(/[A-Za-z]/g, ch => vanityMap[ch.toUpperCase()] || ch) + (ext ? ' x' + ext[1] : '');
    }
    for (const contact of contacts) {
      if (contact.phone) {
        // Block own-company staff phones from leaking into contact records
        if (isOwnCompanyPhone(contact.phone)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company internal phone "' + contact.phone + '"');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'phone', hadValue: contact.phone, reason: 'Own-company internal phone' });
          contact.phone = '';
        } else {
          const digits = countPhoneDigits(contact.phone);
          if (digits < 7) {
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Cleared invalid phone "' + contact.phone + '" (too few digits \u2014 likely truncated)');
            contact.phone = '';
          } else {
            // Normalize vanity letters to digits for storage
            contact.phone = normalizeVanityPhone(contact.phone);
          }
        }
      }
      if (contact.mobile) {
        // Block own-company staff phones from leaking into contact records
        if (isOwnCompanyPhone(contact.mobile)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company internal mobile "' + contact.mobile + '"');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'mobile', hadValue: contact.mobile, reason: 'Own-company internal phone' });
          contact.mobile = '';
        } else {
          const digits = countPhoneDigits(contact.mobile);
          if (digits < 7) {
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Cleared invalid mobile "' + contact.mobile + '" (too few digits \u2014 likely an extension)');
            contact.mobile = '';
          } else {
            contact.mobile = normalizeVanityPhone(contact.mobile);
          }
        }
      }
    }

    // PHONE DEDUP
    // If phone and mobile are the same number, clear mobile
    for (const contact of contacts) {
      if (contact.phone && contact.mobile) {
        const _phoneD = contact.phone.replace(/\D/g, '');
        const _mobileD = contact.mobile.replace(/\D/g, '');
        if (_phoneD === _mobileD) {
          contact.mobile = '';
        }
      }
    }

    // GHOST CONTACT FILTER
    // Remove contacts with very short names and no email (AI parsing artifacts like "Wiz", "Wry")
    contacts = contacts.filter(c => {
      const _fn = (c.firstName || '').trim();
      const _ln = (c.lastName || '').trim();
      const _hasEmail = !!(c.email || '').trim();
      if (_fn.length <= 3 && _ln.length === 0 && !_hasEmail) return false;
      if (_fn.length <= 2 && _ln.length <= 2) return false;
      return true;
    });

    // 3. Apply suggestedType override from forwarder's instruction
    const suggestedType = prevData.suggestedType || '';
    if (suggestedType) {
      for (const contact of contacts) {
        contact.originalAiType = contact.type || '';
        contact.type = suggestedType;
        contact.typeSource = 'forwarder_hint';
      }
    }

    // 3a. OWN-COMPANY STAFF NAME EXCLUSION - catch when AI extracts internal staff
    const OWN_EMPLOYEE_FIRST_NAMES = new Set(OWN_STAFF_FIRST);
    const OWN_EMPLOYEE_LAST_NAMES = new Set(OWN_STAFF_LAST);
    // Exact staff name pairs: a first x last cross-product also dropped real contacts who share
    // a first or last name with a staff member.
    const OWN_EMPLOYEE_FULL_NAMES = new Set(OWN_STAFF_FULL);
    const OWN_BLOCKED_DOMAINS = new Set([...OWN_DOMAINS, 'example-consultancy.com']);
    
    contacts = contacts.filter(contact => {
      const fName = (contact.firstName || '').toLowerCase().trim();
      const lName = (contact.lastName || '').toLowerCase().trim();
      const cEmail = (contact.email || '').toLowerCase();
      const cDomain = cEmail.split('@')[1] || '';
      const company = (contact.companyName || contact.company || '').toLowerCase();
      
      // Block by email domain (own company + known hallucinated variants)
      if (OWN_BLOCKED_DOMAINS.has(cDomain)) {
        console.log('Excluded own-company/hallucinated domain: ' + cEmail);
        return false;
      }
      
      // Block by full name match
      if (fName && lName && OWN_EMPLOYEE_FULL_NAMES.has(fName + ' ' + lName)) {
        console.log('Excluded own-company staff by name: ' + fName + ' ' + lName);
        return false;
      }
      
      // Block partial name + own-company context
      const isOwnCompany = /yourcompany|your\s+company/i.test(company);
      if (isOwnCompany) {
        // If company is own-company-related, this is almost certainly an internal employee
        console.log('Excluded own-company contact: ' + fName + ' ' + lName + ' at ' + company);
        return false;
      }
      
      // Block single-name matches when combined with own-company context
      // (catches a staff first name with no last name, or a staff last name with no first name, when from own-company context)
      const isSingleEmployeeName = (!fName && OWN_EMPLOYEE_LAST_NAMES.has(lName)) || 
                                    (!lName && OWN_EMPLOYEE_FIRST_NAMES.has(fName));
      if (isSingleEmployeeName && (isOwnCompany || !cEmail || cDomain === '')) {
        console.log('Excluded likely own-company staff (partial name): ' + fName + ' ' + lName);
        return false;
      }
      
      return true;
    });

    // 3a1b. DISTRIBUTION CHANNEL EMAIL FILTER
    // Emails from newsletter/listing platforms are NOT real contacts.
    // When the forwarder sends "Acme Holdings via a listing platform", the contact is Acme Holdings,
    // not listings@example.com. Filter these out so the real broker can be found.
    const DISTRIBUTION_CHANNEL_DOMAINS = new Set([
      'jato.com', 'send.example-broker.com',
      'notifications.hubspot.com', 'communication.microsoft.com'
    ]);
    const DISTRIBUTION_CHANNEL_PREFIXES = new Set([
      'noreply', 'no-reply', 'info=', 'newsletter', 'notifications', 'feedback'
    ]);
    
    const preChannelCount = contacts.length;
    contacts = contacts.filter(contact => {
      const email = (contact.email || '').toLowerCase();
      if (!email) return true; // Keep contacts without email (name-only)
      const domain = email.split('@')[1] || '';
      const localPart = email.split('@')[0] || '';
      
      if (DISTRIBUTION_CHANNEL_DOMAINS.has(domain)) {
        console.log('Filtered distribution channel: ' + email);
        return false;
      }
      if (DISTRIBUTION_CHANNEL_PREFIXES.has(localPart.split('=')[0])) {
        console.log('Filtered noreply/newsletter: ' + email);
        return false;
      }
      return true;
    });
    
    // If ALL contacts were filtered (only channel addresses found),
    // and there's a real company name in the body, flag for web research
    if (preChannelCount > 0 && contacts.length === 0) {
      // The email had contacts but they were all distribution channels.
      // The REAL contact is the company behind the listing.
      // Web Research will pick this up via the DISTRIBUTION_CHANNEL_TARGET classification.
    }

    // 3a2. OWN-COMPANY SIGNATURE GUARD - catch when scanner grabs own-company tagline as company
    const OWN_COMPANY_PATTERNS = [
      /your\s+company\s+tagline\s+here/i,
      /yourcompany/i,
      /your\s+company/i,
      /anytown,?\s+st\s+00000/i
    ];
    for (const contact of contacts) {
      const comp = contact.companyName || contact.company || '';
      if (comp && OWN_COMPANY_PATTERNS.some(p => p.test(comp))) {
        // Try to derive real company from email domain
        const email = contact.email || '';
        const domain = email.split('@')[1] || '';
        const domainBase = domain.split('.')[0] || '';
        if (domain && !['gmail.com','hotmail.com','icloud.com','yahoo.com'].includes(domain)) {
          // Smart word splitting for domain-derived company names
          // e.g. "acmeproperties" -> "Acme Properties"
          const bizWords = ['properties','capital','financial','group','holdings',
            'securities','partners','advisors','advisory','wealth','management','solutions',
            'corp','enterprises','insurance','realty','mortgage','lending',
            'leasing','credit','trust','fund','investment','asset','global','national',
            'equipment','company','development','construction','engineering','technology',
            'systems','services','industries','consulting',
            'air','broker','sales','energy','media',
            'design','logistics','transport','trading','supply','resources','associates'];
          let companyFromDomain = domainBase;
          for (const bw of bizWords) {
            const idx = domainBase.toLowerCase().indexOf(bw);
            if (idx > 0 && idx + bw.length === domainBase.length) {
              const prefix = domainBase.substring(0, idx);
              companyFromDomain = prefix.charAt(0).toUpperCase() + prefix.slice(1) + ' ' + bw.charAt(0).toUpperCase() + bw.slice(1);
              break;
            }
          }
          if (companyFromDomain === domainBase) {
            companyFromDomain = domainBase.charAt(0).toUpperCase() + domainBase.slice(1);
          }
          contact.companyName = companyFromDomain;
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Company corrected from own-company tagline to "' + contact.companyName + '" (derived from email domain)');
        } else {
          contact.companyName = '';
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared own-company tagline from company field');
        }
      }
    }

    // 3b. TITLE-AS-NAME GUARD - catch when AI puts title in name fields
    // e.g., firstName: "Vice", lastName: "President" or firstName: "Director", lastName: "of Sales"
    const TITLE_PATTERNS = [
      /^(?:vice|senior|junior|executive|assistant|associate|managing|regional|chief)$/i,
      /^(?:president|director|manager|officer|partner|chairman|founder|ceo|cfo|coo|cto|svp|evp|vp|avp)$/i,
      /^(?:of|the|and|for)$/i
    ];
    const FULL_TITLE_PATTERNS = [
      /^vice\s+president$/i, /^managing\s+director$/i, /^sales\s+director$/i,
      /^director\s+of\s+/i, /^senior\s+vice\s+president$/i, /^assistant\s+vice\s+president$/i,
      /^chief\s+\w+\s+officer$/i, /^regional\s+(?:sales\s+)?director$/i,
      /^executive\s+vice\s+president$/i, /^sr\.?\s+vice\s+president$/i,
      /^evp[,\s]/i, /^svp[,\s]/i, /^vp[,\s]/i
    ];
    
    for (const contact of contacts) {
      const fullName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim();
      const isTitleAsName = FULL_TITLE_PATTERNS.some(p => p.test(fullName)) ||
        (TITLE_PATTERNS.some(p => p.test(contact.firstName || '')) && TITLE_PATTERNS.some(p => p.test(contact.lastName || '')));
      
      if (isTitleAsName && contact.email) {
        // Try to recover real name from email local part
        const local = contact.email.split('@')[0].replace(/[._-]/g, ' ').trim();
        const parts = local.split(/\s+/);
        if (parts.length >= 2) {
          const recoveredFirst = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
          const recoveredLast = parts[parts.length - 1].charAt(0).toUpperCase() + parts[parts.length - 1].slice(1).toLowerCase();
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Name recovered from email: AI returned "' + fullName + '" (title, not name) \u2192 corrected to "' + recoveredFirst + ' ' + recoveredLast + '"');
          // Move the original values to title if title is empty
          if (!contact.jobTitle && fullName.length > 3) {
            contact.jobTitle = fullName;
          }
          contact.firstName = recoveredFirst;
          contact.lastName = recoveredLast;
        } else {
          // Can't recover from email - flag for review
          contact.needsReview = true;
          contact.reviewReason = (contact.reviewReason ? contact.reviewReason + ' | ' : '') + 
            'TITLE_AS_NAME: AI extracted "' + fullName + '" as name \u2014 likely a title, not a person name';
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Possible title extracted as name: "' + fullName + '"');
        }
      }
    }

    // 4. Cap contacts at 15 per email to prevent API flooding
    const MAX_CONTACTS = 15;
    if (contacts.length > MAX_CONTACTS) {
      const excess = contacts.length - MAX_CONTACTS;
      contacts = contacts.slice(0, MAX_CONTACTS);
      contacts[MAX_CONTACTS - 1].infoNotes = contacts[MAX_CONTACTS - 1].infoNotes || [];
      contacts[MAX_CONTACTS - 1].infoNotes.push(excess + ' additional contact(s) found but capped at ' + MAX_CONTACTS + ' \u2014 add remaining manually');
    }

    // SMART WEBSITE ENRICHMENT
    const personalDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com'];

    // Own-company domains excluded from auto-website
    const ownDomains = OWN_DOMAINS;
    for (const contact of contacts) {
      if (!contact.website && contact.email) {
        const domain = contact.email.split('@')[1];
        if (domain && !personalDomains.includes(domain.toLowerCase()) && !ownDomains.has(domain.toLowerCase())) {
          contact.website = 'https://' + domain;
        }
      }

      if (!contact.website && prevData.primaryUrl && contact.email) {
        try {
          const urlDomain = new URL(prevData.primaryUrl).hostname.replace(/^www\./, '').toLowerCase();
          const emailDomain = contact.email.split('@')[1]?.toLowerCase() || '';
          if (urlDomain === emailDomain || urlDomain.includes(emailDomain.split('.')[0]) || emailDomain.includes(urlDomain.split('.')[0])) {
            contact.website = prevData.primaryUrl;
          }
        } catch (e) {
          // URL parsing failed - skip
        }
      }
    }

    // NAME RECOVERY - derive missing names from email/subject/body
    // When Ollama returns empty firstName/lastName but has email/company,
    // try multiple strategies to recover the name.
    for (const contact of contacts) {
      if ((!contact.firstName || !contact.lastName) && contact.email) {
        const emailLocal = contact.email.split('@')[0] || '';
        const bodyLower = (prevData.fullBody || '').toLowerCase();
        const subjectLower = (prevData.originalSubject || '').toLowerCase();
        
        // Strategy 1: Derive from email local part (first.last@domain, first_last@domain)
        const emailParts = emailLocal.split(/[._-]/);
        if (emailParts.length >= 2 && emailParts[0].length >= 2 && emailParts[1].length >= 2) {
          const emailFirst = emailParts[0].charAt(0).toUpperCase() + emailParts[0].slice(1).toLowerCase();
          const emailLast = emailParts[emailParts.length - 1].charAt(0).toUpperCase() + emailParts[emailParts.length - 1].slice(1).toLowerCase();
          
          // Verify these names appear in body or subject
          if (bodyLower.includes(emailFirst.toLowerCase()) && bodyLower.includes(emailLast.toLowerCase())) {
            if (!contact.firstName) {
              contact.firstName = emailFirst;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('firstName recovered from email address + body verification');
            }
            if (!contact.lastName) {
              contact.lastName = emailLast;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('lastName recovered from email address + body verification');
            }
          }
        }
        // Strategy 1b: Single-part email (jane@domain) - use as firstName, find lastName in context
        else if (emailParts.length === 1 && emailParts[0].length >= 2) {
          const emailName = emailParts[0].charAt(0).toUpperCase() + emailParts[0].slice(1).toLowerCase();
          // Verify against text with email addresses removed (the address itself always
          // "contains" its local part), and skip initial+lastName locals ("jdoe" = J. Doe)
          // so Strategy 2 finds the real first name instead of producing firstName "Jdoe".
          const nameWord = new RegExp('\\b' + emailName.toLowerCase().replace(/[^a-z0-9]/g, '') + '\\b');
          const bodyNoEmails = bodyLower.replace(/\S+@\S+/g, ' ');
          const subjectNoEmails = subjectLower.replace(/\S+@\S+/g, ' ');
          const isInitialPlusLast = !!contact.lastName && emailName.length > contact.lastName.length &&
            emailName.toLowerCase().endsWith(contact.lastName.toLowerCase());
          if (!isInitialPlusLast && (nameWord.test(bodyNoEmails) || nameWord.test(subjectNoEmails))) {
            if (!contact.firstName) {
              contact.firstName = emailName;
              contact.infoNotes = contact.infoNotes || [];
              contact.infoNotes.push('firstName recovered from email address');
            }
            // Try to find lastName from subject: "welcomes Jane Broker" or "Subject: Jane Broker"
            if (!contact.lastName) {
              // Match firstName followed by exactly ONE capitalized word (the lastName)
              // Use case-SENSITIVE regex to only match proper names (uppercase start)
              const nameRegex = new RegExp(emailName + '\\s+([A-Z][a-z]{1,20})', '');
              const subjectMatch = (prevData.originalSubject || '').match(nameRegex);
              const bodyMatch = (prevData.fullBody || '').match(nameRegex);
              const match = subjectMatch || bodyMatch;
              if (match) {
                const candidate = match[1].trim();
                // Reject common non-name words that might follow a name
                const NON_NAMES = new Set(['The','And','For','From','With','Has','Was','Are','His',
                  'Her','Our','This','That','Into','Over','About','After','Also','Just',
                  'Welcome','Welcomes','Enhancing','Enhacing','Expertise','Experience',
                  'Capital','Properties','Director','Manager',
                  'President','Sales','Service','Support','Team','Group','New','All']);
                if (!NON_NAMES.has(candidate)) {
                  contact.lastName = candidate;
                  (contact.infoNotes = contact.infoNotes || []).push('lastName recovered from subject/body context'); // infoNotes may not exist yet when the AI supplied firstName
                }
              }
            }
          }
        }
        
        // Strategy 2: If we still have no firstName but have lastName, check body first line
        if (!contact.firstName && contact.lastName) {
          const bodyLines = (prevData.fullBody || '').split('\n').filter(l => l.trim());
          for (const line of bodyLines.slice(0, 10)) {
            const trimmed = line.trim();
            if (trimmed.toLowerCase().includes(contact.lastName.toLowerCase()) && trimmed.length < 60 && !trimmed.includes('@')) {
              // Line contains the lastName - extract firstName(s) before it
              const lastIdx = trimmed.toLowerCase().indexOf(contact.lastName.toLowerCase());
              if (lastIdx > 0) {
                // drop a "Contact Name:" style label before the name
                const beforeLast = trimmed.substring(0, lastIdx).replace(/^.*:\s*/, '').trim();
                // Filter out non-name content
                if (beforeLast.length >= 2 && beforeLast.length < 40 && /^[A-Z\u00c0-\u00d6\u00d8-\u00dd]/.test(beforeLast)) {
                  contact.firstName = beforeLast;
                  contact.infoNotes = contact.infoNotes || [];
                  contact.infoNotes.push('firstName recovered from body line containing lastName');
                  break;
                }
              }
            }
          }
        }
      }
    }

    // COMPREHENSIVE SOURCE-TEXT VALIDATION

    // Include inline image OCR text in source validation
    // Try multiple methods to get OCR text. Read this email's item, not .first(): batches mixed OCR.
    let inlineOcr = '';
    try { inlineOcr = $('Prepare Extraction Request').all()[_idx].json.inlineOcrText || ''; } catch(e) {}
    // Fallback: check if extractedBodyPreview has OCR markers
    if (!inlineOcr) {
      try {
        const preview = $('Prepare Extraction Request').all()[_idx].json.extractedBodyPreview || '';
        if (preview.includes('CONTACT INFO FROM EMAIL IMAGES')) {
          inlineOcr = preview.split('CONTACT INFO FROM EMAIL IMAGES')[1] || '';
        }
      } catch(e) {}
    }
    const sourceText = (prevData.fullBody || '') + ' ' + (prevData.originalSubject || '') + ' ' + inlineOcr;
    const sourceLower = sourceText.toLowerCase();

    function valueInSource(value, minLength = 3) {
      if (!value || value.length < minLength) return true;
      return sourceLower.includes(value.toLowerCase());
    }

    // Punctuation/whitespace-insensitive match. The AI joins signature lines ("Sr. Vice President"
    // + newline + "Private Banking" -> "Sr. Vice President, Private Banking"), which failed the
    // exact substring check and cleared the whole title.
    const sourceLoose = ' ' + sourceLower.replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
    function looseInSource(value) {
      const v = (value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (v.length < 3) return true;
      return sourceLoose.includes(' ' + v + ' ');
    }

    // A vanity number ("(855) 555-ACME") is stored as digits, so it is also checked against the
    // source with letters that follow a digit group converted the same way.
    const VANITY_KEYS = {A:2,B:2,C:2,D:3,E:3,F:3,G:4,H:4,I:4,J:5,K:5,L:5,M:6,N:6,O:6,P:7,Q:7,R:7,S:7,T:8,U:8,V:8,W:9,X:9,Y:9,Z:9};
    const sourceVanity = sourceText.replace(/(\d[\s.\-]?)([A-Z]{2,7})\b/g, (m, p, l) => p + l.replace(/[A-Z]/g, ch => VANITY_KEYS[ch]));
    function phoneInSource(phone) {
      if (!phone) return true;
      const digits = phone.replace(/\D/g, '');
      if (digits.length < 7) return false; // not a phone (the AI put an email address in 'mobile' and it passed as verified)
      // Strategy 0: separators allowed between ANY two digits. The 3-digit grouping below
      // only allows separators at 3-digit boundaries, so "+41 70 000 00 00" (2-digit groups)
      // was rejected and the mobile cleared.
      const anySepPattern = digits.split('').join('[\\s.()\\-+]*');
      if (new RegExp(anySepPattern).test(sourceText)) return true;
      if (new RegExp(anySepPattern).test(sourceVanity)) return true;
      // Strategy 1: Check if the digits (in order) appear with any separators between them
      // Split into groups of 2-3 for flexible matching
      const digitGroups = digits.match(/.{1,3}/g) || [];
      const flexiblePattern = digitGroups.join('[\\s.()\\-+]*');
      if (new RegExp(flexiblePattern).test(sourceText)) return true;
      // Strategy 2: For international numbers, try last 10 digits
      if (digits.length > 10) {
        const last10 = digits.slice(-10);
        const groups10 = last10.match(/.{1,3}/g) || [];
        const pattern10 = groups10.join('[\\s.()\\-+]*');
        if (new RegExp(pattern10).test(sourceText)) return true;
      }
      // Strategy 3: Try consecutive digit sequences of 4+ from the phone
      // This catches "+90 555 010 0 112" where digits are "905550100112"
      // and source has "555 010 0 112" - check if any 7+ consecutive digit substring exists
      for (let len = Math.min(digits.length, 10); len >= 7; len--) {
        for (let start = 0; start <= digits.length - len; start++) {
          const sub = digits.substring(start, start + len);
          const subGroups = sub.match(/.{1,3}/g) || [];
          const subPattern = subGroups.join('[\\s.()\\-+]*');
          if (new RegExp(subPattern).test(sourceText)) return true;
        }
      }
      return false;
    }

    // The AI sometimes drops the area code ("(646) 555-0127" -> "(555) 0127"). The short form
    // passes phoneInSource as a substring, so restore the one full number in the email it ends.
    function fullPhoneInSource(phone) {
      const d = (phone || '').replace(/\D/g, '');
      if (d.length < 7 || d.length >= 10) return phone;
      const hits = new Set();
      for (const m of sourceText.matchAll(/(?<![\d-])\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?![\d-])/g)) {
        if (m[0].replace(/\D/g, '').endsWith(d)) hits.add(m[0]);
      }
      return hits.size === 1 ? [...hits][0] : phone;
    }

    function nameInSource(name) {
      if (!name || name.length < 2) return true;
      if (sourceLower.includes(name.toLowerCase())) return true;
      const nameClean = name.toLowerCase().replace(/[^a-z]/g, '');
      if (nameClean.length >= 3 && sourceLower.includes(nameClean)) return true;
      return false;
    }

    function companyInSource(company) {
      if (!company || company.length < 3) return true;
      const compLower = company.toLowerCase();
      if (sourceLower.includes(compLower)) return true;
      const words = compLower.split(/\s+/).filter(w => w.length >= 3);
      const skipWords = new Set(['the', 'and', 'inc', 'llc', 'ltd', 'corp', 'group', 'company', 'services']);
      const significantWords = words.filter(w => !skipWords.has(w));
      if (significantWords.length === 0) return true;
      return significantWords.every(w => sourceLower.includes(w));
    }

    for (const contact of contacts) {
      contact.verifiedFields = [];
      contact.unverifiedFields = [];
      contact.clearedFields = [];

      // Validate email
      if (contact.email) {
        // Flag generic/role-based emails but KEEP them - they may be the only contact
        // (sole proprietors, small businesses, etc.). Web research may find a personal email later.
        const emailLocal = (contact.email.split('@')[0] || '').toLowerCase();
        const GENERIC_PREFIXES = new Set(['info', 'sales', 'support', 'admin', 'contact', 'contacts',
          'hello', 'help', 'office', 'team', 'general', 'marketing', 'billing', 'service',
          'noreply', 'no-reply', 'donotreply', 'newsletter', 'notifications', 'mail', 'enquiries',
          'inquiries', 'reception', 'hr', 'jobs', 'careers', 'press', 'media', 'webmaster']);
        if (GENERIC_PREFIXES.has(emailLocal)) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('NOTE: Generic email (' + contact.email + ') \u2014 may not be a personal address');
          contact.isGenericEmail = true;
          contact.confidence = 'medium';
          // Still trigger web research to try finding a personal email
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'email', hadValue: contact.email, reason: 'generic email \u2014 kept but flagging for research' });
        }
        // Reject obviously invalid email values (AI hallucinations like "(hidden)", "N/A", etc.)
        else if (/^[^a-zA-Z0-9]|[\(\)\[\]{}]/.test(contact.email) || 
                 /^(hidden|redacted|n\/a|none|unknown|private|confidential|removed|withheld)/i.test(contact.email) ||
                 !contact.email.includes('@') || contact.email.length < 5) {
          contact.infoNotes = contact.infoNotes || [];
          contact.infoNotes.push('Cleared invalid email "' + contact.email + '" \u2014 not a valid address');
          contact.clearedFields = contact.clearedFields || [];
          contact.clearedFields.push({ field: 'email', hadValue: contact.email, reason: 'invalid/hallucinated' });
          contact.email = '';
        }
        else if (valueInSource(contact.email)) {
          contact.verifiedFields.push('email');
        } else {
          // Name-email correlation - if email matches verified name + company domain, trust it
          const emailLocal = (contact.email.split('@')[0] || '').toLowerCase();
          const emailDomain = (contact.email.split('@')[1] || '').toLowerCase().split('.')[0];
          const nameInLocal = (contact.firstName && emailLocal.includes(contact.firstName.toLowerCase())) ||
                             (contact.lastName && emailLocal.includes(contact.lastName.toLowerCase()));
          const companyInDomain = contact.companyName && emailDomain.includes(
            contact.companyName.toLowerCase().replace(/[^a-z]/g, '').substring(0, 6));
          
          if (nameInLocal && companyInDomain) {
            // Email pattern matches name + company - high confidence it's real
            contact.verifiedFields.push('email');
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('Email validated via name-domain correlation (matches name + company)');
          } else {
            contact.unverifiedFields.push('email');
            contact.confidence = 'low';
            contact.infoNotes = contact.infoNotes || [];
            contact.infoNotes.push('WARNING: Email not found in source \u2014 possible hallucination');
          }
        }
      }

      // Validate firstName
      if (contact.firstName) {
        if (nameInSource(contact.firstName)) {
          contact.verifiedFields.push('firstName');
        } else {
          contact.clearedFields.push({ field: 'firstName', hadValue: contact.firstName });
          contact.firstName = '';
        }
      }

      // Validate lastName
      if (contact.lastName) {
        if (nameInSource(contact.lastName)) {
          contact.verifiedFields.push('lastName');
        } else {
          contact.clearedFields.push({ field: 'lastName', hadValue: contact.lastName });
          contact.lastName = '';
        }
      }

      // Validate phone
      if (contact.phone) contact.phone = fullPhoneInSource(contact.phone);
      if (contact.mobile) contact.mobile = fullPhoneInSource(contact.mobile);
      if (contact.phone) {
        if (phoneInSource(contact.phone)) {
          contact.verifiedFields.push('phone');
        } else {
          contact.clearedFields.push({ field: 'phone', hadValue: contact.phone });
          contact.phone = '';
        }
      }

      // Validate mobile
      if (contact.mobile) {
        if (phoneInSource(contact.mobile)) {
          contact.verifiedFields.push('mobile');
        } else {
          contact.clearedFields.push({ field: 'mobile', hadValue: contact.mobile });
          contact.mobile = '';
        }
      }

      // BARE DOMAIN -> COMPANY NAME CONVERSION
      // When company looks like a raw domain (e.g., "exampletrailerleasing.com"),
      // strip the TLD and run word splitting to get a proper name.
      if (contact.companyName && /^[a-z0-9][-a-z0-9]*\.(com|net|org|co|io|us|uk|ca|de|fr|au|biz|info)$/i.test(contact.companyName.trim())) {
        const rawDomain = contact.companyName.trim();
        const rootName = rawDomain.replace(/\.[a-z]+$/i, '');
        // Use the domain splitting logic from inferCompanyFromDomain
        const splitResult = (function(str) {
          const lower = str.toLowerCase();
          const suffixes = ['private', 'wealth', 'capital', 'financial', 'group', 'partners', 'advisors', 'advisory', 'management', 'holdings', 'investments', 'consulting', 'services', 'solutions', 'global', 'international', 'national', 'insurance', 'realty', 'mortgage', 'lending', 'credit', 'trust', 'fund', 'asset', 'bank', 'logic', 'sales', 'properties', 'development', 'construction', 'engineering', 'technology', 'systems', 'industries', 'equipment', 'leasing', 'enterprises', 'resources', 'associates', 'company', 'design', 'logistics', 'transport', 'trading', 'supply', 'energy', 'media', 'broker', 'air', 'premier', 'trailer'];
          let bestIdx = -1, bestSuffix = '';
          for (const s of suffixes) {
            const idx = lower.indexOf(s);
            if (idx > 0 && (bestIdx === -1 || idx < bestIdx)) { bestIdx = idx; bestSuffix = s; }
          }
          if (bestIdx > 0) {
            const parts = [];
            const before = str.substring(0, bestIdx);
            parts.push(before.charAt(0).toUpperCase() + before.slice(1));
            let rest = str.substring(bestIdx);
            while (rest.length > 0) {
              let found = false;
              for (const s of suffixes) {
                if (rest.toLowerCase().startsWith(s)) {
                  parts.push(s.charAt(0).toUpperCase() + s.slice(1));
                  rest = rest.substring(s.length);
                  found = true;
                  break;
                }
              }
              if (!found) {
                parts[parts.length - 1] += rest;
                break;
              }
            }
            return parts.join(' ');
          }
          return str.charAt(0).toUpperCase() + str.slice(1);
        })(rootName);
        contact.companyName = splitResult;
        contact.company = splitResult;
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('Converted bare domain "' + rawDomain + '" to company name "' + splitResult + '"');
      }

      // Validate companyName
      // Own-company branding blacklist + phone-in-company guard (applied to AI output)
      if (contact.companyName) {
        if (isOwnBranding(contact.companyName)) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'Own-company branding/tagline' });
          contact.companyName = '';
          contact.company = '';
        } else if (isPhoneNumber(contact.companyName)) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'Phone number in company field' });
          contact.companyName = '';
          contact.company = '';
        }
      }
      // AI COMMENTARY GUARD
      if (contact.companyName) {
        const compLower = contact.companyName.toLowerCase();
        const isAiCommentary = /(?:does not appear|not found|this funding|please note|no (?:company|information|data)|unknown|n\/a|none|not available|not provided|see above|see below|refer to)/i.test(contact.companyName);
        const isTooLong = contact.companyName.length > 60 && !/(?:Bank|Capital|Financial|Group|Holdings|Securities|Partners|Advisors|Advisory|Wealth|Management|Corp|Inc|LLC|LLP|Associates|Insurance)/i.test(contact.companyName);

        if (isAiCommentary || isTooLong) {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName, reason: 'AI commentary detected' });
          contact.companyName = '';
          contact.company = '';
        } else if (companyInSource(contact.companyName)) {
          contact.verifiedFields.push('companyName');
        } else {
          contact.clearedFields.push({ field: 'companyName', hadValue: contact.companyName });
          contact.companyName = '';
          contact.company = '';
        }
      }

      // Validate jobTitle
      if (contact.jobTitle) {
        if (valueInSource(contact.jobTitle) || looseInSource(contact.jobTitle)) {
          contact.verifiedFields.push('jobTitle');
        } else if (/[,|;\/]/.test(contact.jobTitle) &&
                   contact.jobTitle.split(/\s*[,|;\/]\s*/).filter(s => s && looseInSource(s)).length > 0) {
          // keep only the segments that really appear in the email
          contact.jobTitle = contact.jobTitle.split(/\s*[,|;\/]\s*/).filter(s => s && looseInSource(s)).join(', ');
          contact.verifiedFields.push('jobTitle');
        } else {
          contact.clearedFields.push({ field: 'jobTitle', hadValue: contact.jobTitle });
          contact.jobTitle = '';
        }
      }

      // Employer over department. Bank signatures stack department lines above the legal entity,
      // and the AI or scanner picked the department ("Wealth Management Banking Group") instead of
      // the entity ("Acme Bank USA, N.A."). When the company doesn't match the email domain but a
      // nearby signature line does, use that line.
      if (contact.email && contact.email.includes('@')) {
        const domain = contact.email.split('@')[1].toLowerCase();
        const labels = domain.split('.');
        let root = labels.length >= 2 ? labels[labels.length - 2] : '';
        if (['co', 'com', 'org', 'net', 'ac', 'gov', 'or', 'ne'].includes(root) && labels.length >= 3) {
          root = labels[labels.length - 3];
        }
        const FREEMAIL = new Set(['gmail', 'yahoo', 'hotmail', 'outlook', 'aol', 'icloud', 'me', 'live',
          'msn', 'protonmail', 'mail', 'zoho', 'yandex', 'gmx', 'comcast', 'att', 'verizon', 'bellsouth', 'sbcglobal']);
        if (root.length >= 3 && !FREEMAIL.has(root)) {
          const alnum = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const matchesRoot = s => {
            const tokens = (s || '').toLowerCase().split(/[^a-z0-9]+/);
            const n = alnum(s);
            return tokens.includes(root) || n.startsWith(root) || (root.length >= 6 && n.includes(root));
          };
          if (!contact.companyName || !matchesRoot(contact.companyName)) {
            const bodyLines = (prevData.fullBody || '').split(/\r?\n/).map(l => l.replace(/[\u200b\u2002\u00a0]/g, ' ').trim());
            const emailIdx = bodyLines.findIndex(l => l.toLowerCase().includes(contact.email.toLowerCase()));
            if (emailIdx >= 0) {
              const fullName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim().toLowerCase();
              const candidate = bodyLines.slice(Math.max(0, emailIdx - 8), emailIdx + 6).find(l =>
                l.length >= 3 && l.length <= 60 &&
                /[a-z]/i.test(l) &&
                !/@|https?:|www\.|\.(com|net|org|io|co)\b/i.test(l) &&
                l.replace(/\D/g, '').length < 7 &&
                !/^(from|to|cc|sent|subject|date|von|an|gesendet|betreff)\s*:/i.test(l) &&
                !(fullName && l.toLowerCase().includes(fullName)) &&
                l.toLowerCase() !== (contact.jobTitle || '').toLowerCase() &&
                matchesRoot(l)
              );
              if (candidate) {
                const cleaned = candidate.replace(/[|,;:]+$/, '').trim();
                contact.infoNotes = contact.infoNotes || [];
                contact.infoNotes.push('Company set to "' + cleaned + '" (matches email domain)' +
                  (contact.companyName ? ' instead of "' + contact.companyName + '"' : ''));
                contact.companyName = cleaned;
                contact.company = cleaned;
                if (!contact.verifiedFields.includes('companyName')) contact.verifiedFields.push('companyName');
                // Prepare Upsert omits any field listed in clearedFields, so un-clear the one we just filled
                contact.clearedFields = contact.clearedFields.filter(f => (f.field || f) !== 'companyName');
              }
            }
          }
        }
      }

      // Cell / mobile / direct label goes to mobile. The rule is office=phone, direct/cell=mobile;
      // when the AI put a number labelled "Cell:" or "Direct:" into phone, move it to mobile.
      if (contact.phone && !contact.mobile) {
        const pDigits = contact.phone.replace(/\D/g, '');
        const tail = pDigits.slice(-10);
        if (tail.length >= 7) {
          const phoneLine = (prevData.fullBody || '').split(/\r?\n/).find(l => l.replace(/\D/g, '').includes(tail));
          if (phoneLine) {
            // up to the first digit, minus the number's own '(' or '+' (otherwise '(m) 555...' loses its '(m)' label)
            const labelPart = phoneLine.slice(0, Math.max(0, phoneLine.search(/\d/))).replace(/[\s(+]+$/, '');
            // A label written after the number ("(615) 555-0166 mobile"), read up to the next digit.
            const numM = phoneLine.match(new RegExp(tail.split('').join('[^\\d\\n]{0,3}')));
            const suffixPart = numM ? phoneLine.slice(numM.index + numM[0].length).split(/\d/)[0] : '';
            const isSuffixMobile = !labelPart && /^[\s)|:-]*(cell(ular)?|mobile|mob)\b/i.test(suffixPart);
            const isMobileLabel = isSuffixMobile || /\b(cell(ular)?|mobile|mob|direct)\b/i.test(labelPart) && !/\bdirect\s+line\b/i.test(labelPart) ||
              /^\s*[mc]\s*[:|.]?\s*$/i.test(labelPart) || /\((?:m|c)\)\s*$/i.test(labelPart);
            const isOfficeLabel = /\b(office|tel|telephone|phone|main|work|business|fax)\b/i.test(labelPart) && !/\bcell\s*phone\b/i.test(labelPart);
            if (isMobileLabel && !isOfficeLabel) {
              contact.mobile = contact.phone;
              contact.phone = '';
              contact.clearedFields = contact.clearedFields.filter(f => (f.field || f) !== 'mobile'); // see the employer block above
              const vi = contact.verifiedFields.indexOf('phone');
              if (vi >= 0) contact.verifiedFields[vi] = 'mobile';
            }
          }
        }
      }

      // Title that is just the person's name (the AI wrote "Jane Doe" as her title; it then
      // counted as corroboration and kept a header-only thread participant)
      const _alpha = v => (v || '').toLowerCase().replace(/[^a-z]/g, '');
      if (contact.jobTitle && _alpha(contact.firstName + contact.lastName) && _alpha(contact.jobTitle) === _alpha(contact.firstName + contact.lastName)) {
        contact.clearedFields.push({ field: 'jobTitle', hadValue: contact.jobTitle, reason: "title was the person's own name" });
        contact.jobTitle = '';
      }

      // Validate city
      if (contact.city) {
        if (valueInSource(contact.city)) {
          contact.verifiedFields.push('city');
        } else {
          contact.clearedFields.push({ field: 'city', hadValue: contact.city });
          contact.city = '';
        }
      }

      // Validate state
      if (contact.state) {
        if (valueInSource(contact.state, 2)) {
          contact.verifiedFields.push('state');
        } else {
          contact.clearedFields.push({ field: 'state', hadValue: contact.state });
          contact.state = '';
        }
      }

      // Post-merge state->country promotion
      // If state holds a country name (e.g., AI returned state="TURKEY"), promote it
      if (contact.state && !contact.country) {
        const COUNTRIES_POST = new Set(['turkey', 'canada', 'united kingdom', 'uk', 'australia', 'germany', 'france', 'brazil', 'mexico', 'india', 'japan', 'china', 'south korea', 'italy', 'spain', 'netherlands', 'switzerland', 'sweden', 'norway', 'denmark', 'ireland', 'singapore', 'hong kong', 'new zealand', 'israel', 'uae', 'united arab emirates', 'qatar', 'bahrain', 'kuwait', 'saudi arabia', 'south africa', 'cayman islands', 'bermuda', 'bahamas', 'colombia', 'chile', 'argentina', 'peru']);
        if (COUNTRIES_POST.has(contact.state.toLowerCase())) {
          contact.country = contact.state;
          contact.state = '';
        }
      }

      // Validate address
      if (contact.address) {
        const addressParts = contact.address.match(/\d+\s+[A-Za-z]+/);
        if (addressParts && sourceLower.includes(addressParts[0].toLowerCase())) {
          contact.verifiedFields.push('address');
        } else if (valueInSource(contact.address)) {
          contact.verifiedFields.push('address');
        } else {
          contact.clearedFields.push({ field: 'address', hadValue: contact.address });
          contact.address = '';
        }
      }

      // Compute verification score
      const totalFields = contact.verifiedFields.length + contact.unverifiedFields.length + contact.clearedFields.length;
      contact.verificationScore = totalFields > 0
        ? Math.round((contact.verifiedFields.length / totalFields) * 100)
        : 0;

      // If verification score is critically low, flag the entire contact
      if (contact.verificationScore < 50 && totalFields >= 3) {
        contact.confidence = 'low';
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('LOW VERIFICATION: Only ' + contact.verificationScore + '% of fields found in source text');
      }

      // If email was unverified AND other fields are also unverified, skip Zoho
      if (contact.unverifiedFields.includes('email') && contact.verificationScore < 50) {
        contact.skipZohoUpsert = true;
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('BLOCKED from Zoho: unverified email + low verification score');
      }
    }

    // Step 4b: LAST RESORT STUB CREATION - create stubs from any identifiable fragments
    // Recursive contact completion - create stubs from any fragments
    // Runs ONLY when all extraction paths (AI JSON, retry, scanner, merge, narrative fallback)
    // produced zero contacts. Even a single field (name, company, URL) is enough to create
    // a stub that the Web Research node can enrich.
    if (contacts.length === 0) {
      const stubFragments = [];
      const OWN_STUB_DOMAINS = new Set([...OWN_DOMAINS, 'example-consultancy.com']);
      const OWN_STUB_FULL = new Set(OWN_STAFF_FULL);
      const PERSONAL_STUB_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com','zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);

      // Source 1: Extract from AI narrative (when aiParseError and raw AI text exists)
      if (aiParseError && jsonText) {
        const narrative = jsonText;

        // Scan for names: **BoldName**, firstName: Name, or capitalized 2-3 word near keywords
        // NOTE: Do NOT use /i flag - name capture groups must start with actual uppercase
        const namePatterns = [
          // **Jane O'Broker** - bold markdown names (most reliable in AI narratives)
          /\*\*([A-Z][a-z]+(?:[-'\u2019][A-Z][a-z]+)?(?:\s+[A-Z](?:[-'\u2019]?[A-Za-z]+)){1,2})\*\*/g,
          /\*\*(?:Name|Contact|Person)\*\*\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/g,
          /(?:firstName|first_name)\s*[:\-]?\s*["']?([A-Z][a-z]+)["']?/g,
          /(?:[Nn]ame|[Ii]dentified|[Ff]ound|[Jj]oining)\s*[:\-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z'-]+){1,2})/g,
        ];
        // Common words that should NOT be captured as names
        const STUB_NOT_NAMES = new Set(['the','that','this','with','from','into','about','which','their','there','other','some','these','those','will','been','have','each','make','like','just','over','such','also','back','than','them','then','only','come','made','find','here','know','take','want','does','when','what','your','more','many','very','most','much','after','first','last','before','being','under','could','would','should','because','between','through','during','without','contact','contacts','person','name','found','identified','following','information','field','fields','email','phone','company','title','address','joining','dealer','broker','lending']);
        let stubFirstName = '', stubLastName = '';
        for (const pat of namePatterns) {
          pat.lastIndex = 0; // Reset regex state
          const m = pat.exec(narrative);
          if (m) {
            const parts = m[1].trim().split(/\s+/);
            // Validate: each part must start with uppercase AND not be a common English word
            const validParts = parts.filter(p => /^[A-Z]/.test(p) && !STUB_NOT_NAMES.has(p.toLowerCase()));
            if (validParts.length >= 2) {
              stubFirstName = validParts[0];
              stubLastName = validParts.slice(1).join(' ');
              break;
            } else if (validParts.length === 1 && validParts[0].length >= 2) {
              stubFirstName = validParts[0];
              // Don't break - try to find a fuller match
            }
          }
        }

        // Scan for companies
        let stubCompany = '';
        const companyPatterns = [
          /\*\*(?:Company|Organization|Firm)\*\*\s*[:\-]?\s*([A-Z][A-Za-z\s&.,'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // "company: Example Leasing Limited" with explicit label
          /(?:company|organization|firm)\s*[:\-]\s*([A-Z][A-Za-z\s&'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // "of Example Leasing Limited's" - preposition + company name ending at corporate suffix
          /(?:joining|at|from|of|for)\s+([A-Z][A-Za-z\s&'-]+?(?:Ltd\.?|Limited|LLC|Inc\.?|Corp\.?|Group|International|Capital|Finance|Leasing|Partners|Associates))\b/gi,
          // Fallback: "company: Any Company Name" ending at newline/period (no suffix required)
          /(?:company)\s*[:\-]\s*([A-Z][A-Za-z\s&'-]{2,50}?)(?:\n|\.|\s*$)/gi,
        ];
        for (const pat of companyPatterns) {
          pat.lastIndex = 0;
          const m = pat.exec(narrative);
          if (m) {
            stubCompany = m[1].trim().replace(/[.,]+$/, '').replace(/'s$/i, '');
            if (!isOwnBranding(stubCompany)) break;
            stubCompany = ''; // Reset if it's own-company branding
          }
        }

        // Scan for emails
        let stubEmail = '';
        const emailMatches = narrative.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
        for (const em of emailMatches) {
          const emLower = em.toLowerCase();
          const emDomain = emLower.split('@')[1] || '';
          if (!OWN_STUB_DOMAINS.has(emDomain) && !PERSONAL_STUB_DOMAINS.has(emDomain) &&
              emLower !== (forwarderEmail || '').toLowerCase()) {
            stubEmail = em;
            break;
          }
        }

        // Scan for phones
        let stubPhone = '';
        const phoneMatches = narrative.match(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g) || [];
        for (const ph of phoneMatches) {
          if (!isOwnCompanyPhone(ph)) { stubPhone = ph.trim(); break; }
        }

        if (stubFirstName || stubCompany || stubEmail || stubPhone) {
          stubFragments.push({ firstName: stubFirstName, lastName: stubLastName, email: stubEmail, phone: stubPhone, companyName: stubCompany, website: '', source: 'ai_narrative' });
        }
      }

      // Source 2: Extract from email body (fullBody)
      const stubBody = prevData.fullBody || '';
      if (stubBody && stubFragments.length === 0) {
        // Look for external emails in body that scanner may have filtered (header-line-only rule)
        const bodyEmailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
        const bodyEmails = [...new Set((stubBody.match(bodyEmailRegex) || []).map(e => e.toLowerCase()))];
        const GENERIC_STUB = new Set(['info','sales','support','admin','contact','help','billing','noreply','no-reply','mailer-daemon','postmaster','webmaster','newsletter','marketing','service']);

        for (const be of bodyEmails) {
          const beDomain = be.split('@')[1] || '';
          const beLocal = be.split('@')[0] || '';
          if (OWN_STUB_DOMAINS.has(beDomain)) continue;
          if (PERSONAL_STUB_DOMAINS.has(beDomain)) continue;
          if (GENERIC_STUB.has(beLocal.toLowerCase())) continue;
          if (be === (forwarderEmail || '').toLowerCase()) continue;

          // Try to derive name from email local part (e.g., john.doe@ -> John Doe)
          let beFirst = '', beLast = '';
          let bePhone = '', beMobile = '', beTitle = '';
          let nameSource = 'email_body';
          const localParts = beLocal.replace(/[0-9]/g, '').split(/[._-]/);
          if (localParts.length >= 2 && localParts[0].length >= 2 && localParts[1].length >= 2) {
            beFirst = localParts[0].charAt(0).toUpperCase() + localParts[0].slice(1);
            beLast = localParts[1].charAt(0).toUpperCase() + localParts[1].slice(1);
          } else {
            // ANTI-DROP GUARD - local-part doesn't yield name; scan body lines near the email
            const nearby = deriveNameFromBodyNear(stubBody, be, forwarderEmail);
            if (nearby.firstName && nearby.lastName) {
              beFirst = nearby.firstName;
              beLast = nearby.lastName;
              bePhone = nearby.phone || '';
              beMobile = nearby.mobile || '';
              beTitle = nearby.jobTitle || '';
              nameSource = 'email_body_nearby_scan';
            }
          }

          // Derive company website from domain
          const beWebsite = 'https://' + beDomain;

          stubFragments.push({ firstName: beFirst, lastName: beLast, email: be, phone: bePhone, mobile: beMobile, jobTitle: beTitle, companyName: '', website: beWebsite, source: nameSource });
          break; // One stub from body is enough
        }

        // Look for URLs that could be company websites (when no email fragments found)
        if (stubFragments.length === 0) {
          const urlRegex = /https?:\/\/[^\s<>"')\]]+/g;
          const bodyUrls = stubBody.match(urlRegex) || [];
          const skipDomains = [...OWN_DOMAINS,'google.com','outlook.com','microsoft.com','office365.com','aka.ms','safelinks.protection.outlook.com'];
          for (const u of bodyUrls) {
            try {
              const hostname = new URL(u).hostname.toLowerCase();
              if (skipDomains.some(d => hostname.includes(d))) continue;
              stubFragments.push({ firstName: '', lastName: '', email: '', phone: '', companyName: '', website: u, source: 'email_body_url' });
              break;
            } catch(e) {}
          }
        }
      }

      // Create stub contacts from fragments
      for (const frag of stubFragments) {
        // Apply own-company staff exclusion
        const fNameLower = (frag.firstName || '').toLowerCase().trim();
        const lNameLower = (frag.lastName || '').toLowerCase().trim();
        if (fNameLower && lNameLower && OWN_STUB_FULL.has(fNameLower + ' ' + lNameLower)) continue;
        if (isOwnBranding(frag.companyName)) continue;

        const missingFields = [];
        if (!frag.firstName) missingFields.push('firstName');
        if (!frag.lastName) missingFields.push('lastName');
        if (!frag.email) missingFields.push('email');
        if (!frag.phone) missingFields.push('phone');
        if (!frag.companyName) missingFields.push('companyName');
        if (!frag.website) missingFields.push('website');

        contacts.push({
          firstName: frag.firstName || '',
          lastName: frag.lastName || '',
          nickname: '',
          email: frag.email || '',
          phone: frag.phone || '',
          mobile: frag.mobile || '',
          companyName: frag.companyName || '',
          jobTitle: frag.jobTitle || '',
          city: '', state: '', address: '', country: '',
          website: frag.website || '',
          type: prevData.suggestedType || '',
          specificType: '',
          confidence: 'low',
          extractionMethod: 'STUB_FROM_FRAGMENTS',
          needsWebResearch: true,
          missingFields: missingFields,
          infoNotes: ['Stub contact created from ' + frag.source + ' fragments \u2014 needs web research enrichment'],
          verifiedFields: [],
          unverifiedFields: [],
          clearedFields: []
        });
      }
    }

    // Fill gaps from the contact's own signature or labeled block. Runs after stub creation so
    // stubs benefit too. Values come straight from the source text. Covers typed requests
    // ("Contact Name: ... / Bank Name: ... / Title: ... / Office: ... / Cell: ...") and sentence
    // forms ("cell is (555) 010-0199.") when the AI was distracted (forward chains, noise).
    for (const contact of contacts) {
      if (!contact.email) continue;
      const sigLines = (prevData.fullBody || '').split('\n');
      const own = contact.email.toLowerCase();
      const at = sigLines.findIndex(l => l.toLowerCase().includes(own));
      // header-only participants (their email only on a From:/To:/Cc: line) get nothing filled
      if (at < 0 || /^\s*(from|to|cc|sent|von|an)\s*:/i.test(sigLines[at])) continue;
      const isBoundary = l => /^\s*(from|sent|to|cc|subject|von|gesendet|an|betreff)\s*:/i.test(l) || (l.includes('@') && !l.toLowerCase().includes(own));
      let lo = at, hi = at;
      while (lo > 0 && at - lo < 7 && !isBoundary(sigLines[lo - 1])) lo--;
      while (hi < sigLines.length - 1 && hi - at < 5 && !isBoundary(sigLines[hi + 1])) hi++;
      const block = sigLines.slice(lo, hi + 1);
      const filled = [];
      const label = (re) => { for (const l of block) { const m = l.match(re); if (m && m[1].trim()) return m[1].trim(); } return ''; };
      contact.verifiedFields = contact.verifiedFields || [];
      if (!contact.firstName && !contact.lastName) {
        const nm = label(/^\s*(?:contact\s+)?name\s*:\s*(.+)$/i).split(/\s+/).filter(Boolean);
        if (nm.length >= 2) { contact.firstName = nm.slice(0, -1).join(' '); contact.lastName = nm[nm.length - 1]; filled.push('name'); }
      }
      if (!contact.companyName) {
        const co = label(/^\s*(?:bank\s+name|company(?:\s+name)?|firm|organi[sz]ation)\s*:\s*(.+)$/i);
        if (co) { contact.companyName = co; contact.company = co; filled.push('company'); }
      }
      if (!contact.firstName && contact.lastName) {
        // name recovery earlier only scans the first 10 body lines; the contact's own block is the right place
        const ln = block.find(l => l.toLowerCase().includes(contact.lastName.toLowerCase()) && !l.includes('@') && l.length < 60);
        const before = ln ? ln.slice(0, ln.toLowerCase().indexOf(contact.lastName.toLowerCase())).replace(/^.*:\s*/, '').trim() : '';
        if (/^[A-Z\u00c0-\u00d6\u00d8-\u00dd][\w'\u00c0-\u00ff.\- ]{1,30}$/.test(before)) { contact.firstName = before; filled.push('firstName'); }
      }
      if (!contact.jobTitle) {
        let t = label(/^\s*(?:job\s+)?title\s*:\s*(.+)$/i);
        // unlabeled signature title line (the AI sometimes returns the contact TYPE as the title)
        // only lines ABOVE the email: below it sits the forwarder's own signature (the forwarder's title leaked in)
        if (!t) t = sigLines.slice(lo, at).find(l => l.trim().length <= 60 && !/[@\d]/.test(l) && !/:/.test(l) &&
          /\b(president|vice president|vp|svp|evp|director|manager|officer|partner|analyst|head|chief|ceo|cfo|coo|cto|founder|owner|principal|associate|executive|counsel|attorney|broker|advisor|specialist|consultant|coordinator|treasurer|controller)\b/i.test(l) &&
          !(contact.companyName && l.toLowerCase().includes(contact.companyName.toLowerCase())))?.trim() || '';
        if (t) { contact.jobTitle = t; filled.push('title'); }
      }
      if (!contact.address) {
        const a = label(/^\s*address\s*:\s*(.+)$/i);
        if (a) { contact.address = a; filled.push('address'); }
      }
      if (!contact.phone && !contact.mobile) {
        for (const line of block) {
          for (const m of line.matchAll(/([+(]?\d[\d\s.()\-]{6,}\d)/g)) {
            const num = m[1].trim(), nd = num.replace(/\D/g, '');
            if (nd.length < 10 || nd.length > 15 || isOwnCompanyPhone(num)) continue;
            const lab = line.slice(0, m.index).toLowerCase();
            if (/\bfax\b/.test(lab)) continue;
            const isMobile = /\b(cell|mobile|mob|m|c)\b/.test(lab) || (/\bdirect\b/.test(lab) && !/\bdirect\s+line\b/.test(lab));
            if (isMobile && !contact.mobile) { contact.mobile = num; filled.push('mobile'); }
            else if (!isMobile && !contact.phone) { contact.phone = num; filled.push('phone'); }
          }
        }
      }
      if (filled.length) {
        contact.infoNotes = contact.infoNotes || [];
        contact.infoNotes.push('Filled from the contact\'s own signature block: ' + filled.join(', '));
        contact.clearedFields = (contact.clearedFields || []).filter(f => !['firstName', 'lastName', 'companyName', 'jobTitle', 'address', 'phone', 'mobile'].includes(f.field || f));
        if (contact.extractionMethod === 'STUB_FROM_FRAGMENTS' && contact.firstName && contact.lastName) contact.needsWebResearch = false;
      }
    }

    // Step 5: Build output
    const hasRealContact = contacts.some(c => !!(c.email || (c.firstName && c.lastName)));
    const shouldForceResearch = !hasRealContact && prevData.hasUrls;
    const allCleared = contacts.flatMap(c => c.clearedFields || []);
    const anyLowConfidence = contacts.some(c => c.confidence === 'low');
    const anyBlocked = contacts.some(c => c.skipZohoUpsert);

    // URL-PRESENT RESEARCH TRIGGER
    const PERSONAL_DOMAINS_CHECK = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
      'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
      'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);
    const hasOnlyPersonalContacts = prevData.hasUrls && contacts.length > 0 &&
      contacts.every(c => {
        const cEmail = (c.email || '').toLowerCase();
        if (!cEmail) return true;
        const cDomain = cEmail.split('@')[1] || '';
        return PERSONAL_DOMAINS_CHECK.has(cDomain);
      });

    // URL discovery activation for forwarded URL-only emails
    // When subject IS a URL (after stripping Fwd:/Fw:/FW:/Re: prefixes) and 0 contacts found,
    // or when body is very short and allUrls has entries, activate URL discovery mode.
    let urlDiscoveryActivated = false;
    let effectivePrimaryUrl = prevData.primaryUrl || '';
    let effectiveHasUrls = prevData.hasUrls || false;
    const effectiveAllUrls = prevData.allUrls || [];

    if (contacts.length === 0) {
      // Strip forward/reply prefixes from subject and check if it's a URL
      const strippedSubject = (prevData.originalSubject || '')
        .replace(/^(?:Fwd|Fw|FW|Re|RE)\s*:\s*/gi, '')
        .replace(/^(?:Fwd|Fw|FW|Re|RE)\s*:\s*/gi, '') // Handle double-prefixed (Fwd: Re:)
        .trim();
      const isSubjectUrl = /^https?:\/\//i.test(strippedSubject);

      if (isSubjectUrl) {
        urlDiscoveryActivated = true;
        if (!effectivePrimaryUrl) {
          effectivePrimaryUrl = strippedSubject;
        }
        effectiveHasUrls = true;
      }

      // Also check: body is very short (URL-only forward) and allUrls has entries
      if (!urlDiscoveryActivated && effectiveAllUrls.length > 0) {
        const bodyForCheck = (prevData.fullBody || '')
          .replace(/^(?:From|To|Cc|Bcc|Sent|Date|Subject)\s*:.*$/gim, '')
          .replace(/[-_=]{3,}/g, '')
          .replace(/\s+/g, '');
        if (bodyForCheck.length < 100) {
          urlDiscoveryActivated = true;
          if (!effectivePrimaryUrl) {
            effectivePrimaryUrl = effectiveAllUrls[0];
          }
          effectiveHasUrls = true;
        }
      }
    }

    results.push({
      json: {
        contacts: contacts,
        contactCount: contacts.length,
        hasPdfAttachment: (prevData.detectionFlags || []).includes('PDF_ATTACHMENT') || (prevData.attachmentHints || []).includes('PDF'),
        hasImageAttachment: (prevData.detectionFlags || []).includes('IMAGE_ONLY') || (prevData.detectionFlags || []).includes('IMAGE_ATTACHMENT') || (prevData.attachmentHints || []).includes('IMAGE'),
        originalSubject: prevData.originalSubject || '',
        forwarderInstruction: prevData.forwarderInstruction || '',
        fullBody: prevData.fullBody || '',
        hasAttachments: prevData.hasAttachments || false,
        attachmentHints: prevData.attachmentHints || [],
        email_id: prevData.email_id || '',
        thread_id: prevData.thread_id || '',
        received_date: prevData.received_date || '',
        forwarderEmail: prevData.forwarderEmail || '',
        allUrls: effectiveAllUrls,
        primaryUrl: effectivePrimaryUrl,
        hasUrls: effectiveHasUrls,
        suggestedType: prevData.suggestedType || '',
        detectionFlags: prevData.detectionFlags || [],
        hasDetectionFlags: prevData.hasDetectionFlags || false,
        skipZohoUpsert: false,
        extractionStrategy: urlDiscoveryActivated ? 'URL_DISCOVERY' : (prevData.extractionStrategy || 'BODY_ONLY'),
        aiSkipped: !!_aiFailureNote, aiFailure: _aiFailureNote, // the AI failed but the scanner still ran
        // Report AI parse failure even when scanner recovered contacts
        parseError: aiParseError,
        errorMessage: aiParseError ? aiErrorMessage : '',
        rawResponse: aiParseError ? (jsonText || '').substring(0, 2000) : '',
        hasCriticalFields: hasRealContact,
        needsWebResearch: shouldForceResearch ||
          prevData.forceWebResearch ||
          urlDiscoveryActivated ||
          (allCleared.length > 0) ||
          (anyLowConfidence && effectiveHasUrls) ||
          (effectiveHasUrls && contacts.length === 0) ||
          hasOnlyPersonalContacts ||
          // Trigger research when contact has name+company but no email
          // Mirrors the manual workflow - find missing info online
          contacts.some(c => (c.firstName || c.lastName) && c.companyName && !c.email) ||
          // Trigger research for any stub contact needing enrichment
          contacts.some(c => c.extractionMethod === 'STUB_FROM_FRAGMENTS'),
        hasBlockedContacts: anyBlocked,
        totalFieldsCleared: allCleared.length
      }
    });
  } catch (error) {
    // Try partial JSON recovery for truncated AI output
    // If Ollama truncated mid-array, extract whatever complete objects exist
    let recoveredContacts = [];
    try {
      const lastComplete = jsonText.lastIndexOf('},');
      if (lastComplete > 0) {
        const truncated = jsonText.substring(0, lastComplete + 1) + ']}';
        const recovered = JSON.parse(truncated);
        recoveredContacts = recovered.contacts || [recovered];
      }
    } catch (e2) { /* recovery failed too */ }
    
    // Always emit this record, carrying any recovered contacts. Skipping the push here loses the
    // whole email.
    for (const c of recoveredContacts) {
      c.infoNotes = c.infoNotes || [];
      c.infoNotes.push('Recovered from truncated AI output \u2014 some contacts may be missing');
    }
    results.push({
      json: {
        contacts: recoveredContacts,
        contactCount: recoveredContacts.length,
        parseError: true,
        errorMessage: error.message,
        rawResponse: (jsonText || JSON.stringify(data)).substring(0, 2000),
        hasCriticalFields: false,
        needsWebResearch: prevData.hasUrls || false,
        allUrls: prevData.allUrls || [],
        primaryUrl: prevData.primaryUrl || '',
        hasUrls: prevData.hasUrls || false,
        suggestedType: prevData.suggestedType || '',
        forwarderInstruction: prevData.forwarderInstruction || '',
        originalSubject: prevData.originalSubject || '',
        fullBody: prevData.fullBody || '',
        email_id: prevData.email_id || '',
        thread_id: prevData.thread_id || '',
        received_date: prevData.received_date || '',
        forwarderEmail: prevData.forwarderEmail || '',
        detectionFlags: prevData.detectionFlags || [],
        hasDetectionFlags: prevData.hasDetectionFlags || false,
        skipZohoUpsert: false,
        extractionStrategy: prevData.extractionStrategy || 'BODY_ONLY',
        aiSkipped: false
      }
    });
  }
}

// ASYNC TLD RESOLUTION - resolve TLD-less emails before output
// For contacts with no email, check if we have a TLD-less candidate and resolve it
if (_outerTldLessPending.length > 0) {
  for (const r of results) {
    const contacts = r.json.contacts || [];
    for (const contact of contacts) {
      if (contact.email) continue; // already has email
      // Find a TLD-less candidate that matches this contact's name or company
      const contactName = ((contact.firstName || '') + ' ' + (contact.lastName || '')).toLowerCase().trim();
      const contactCompany = (contact.companyName || contact.company || '').toLowerCase();
      for (const candidate of _outerTldLessPending) {
        const localPart = candidate.split('@')[0].toLowerCase().replace(/[._-]/g, ' ');
        // Check if the email local part relates to the contact's name
        const nameMatch = contactName && (
          localPart.includes(contact.firstName?.toLowerCase() || '###') ||
          localPart.includes(contact.lastName?.toLowerCase() || '###')
        );
        if (nameMatch) {
          // Found a match - mark for async resolution
          contact._tldLessEmail = candidate;
          contact._companyHint = contact.companyName || contact.company || '';
          break;
        }
      }
    }
  }

  // Run async TLD resolution for all marked contacts
  const resolvePromises = [];
  for (const r of results) {
    const contacts = r.json.contacts || [];
    for (const contact of contacts) {
      if (contact._tldLessEmail) {
        resolvePromises.push(
          resolveTldLessEmail(contact._tldLessEmail, contact._companyHint)
            .then(resolved => {
              if (resolved) {
                contact.email = resolved;
                contact.infoNotes = contact.infoNotes || [];
                contact.infoNotes.push('Email resolved from TLD-less "' + contact._tldLessEmail + '" \u2192 "' + resolved + '" (web-verified)');
                contact.verifiedFields = contact.verifiedFields || [];
                contact.verifiedFields.push('email');
                // Remove skip flags that were set due to missing email
                contact.skipZohoUpsert = false;
                contact.needsWebResearch = false;
              }
              delete contact._tldLessEmail;
              delete contact._companyHint;
            })
            .catch(() => {
              delete contact._tldLessEmail;
              delete contact._companyHint;
            })
        );
      }
    }
  }
  if (resolvePromises.length > 0) {
    await Promise.all(resolvePromises);
  }
}

// Collect this email's results into the allResults array
for (const r of results) { allResults.push(r); }

} // <- end of for (let _idx = 0; _idx < allItems.length; _idx++) loop

return allResults;
