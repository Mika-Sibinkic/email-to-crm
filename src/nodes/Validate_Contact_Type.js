// Validate Contact Type v3.32 — P0 RECIPIENT-LIST FILTER (user paused use Apr 20 2026)
//
// v3.32 RECIPIENT-LIST FILTER (+ safety nets added 2026-04-21 post-regression)
// Observed failure (Apr 20 2026, user paused use):
//   A single-contact email produced 5 contacts (the real contact + 4 people from the original To: line).
//   Only the real contact had a real signature block. The other 4 appear ONLY inside
//   "To:"/"Cc:"/"Subject:" header lines in the forwarded body.
// Filter: when totalContacts > 1, drop contacts whose email appears exclusively in
//   header lines AND who have no corroborating phone/mobile/jobTitle.
//
// 2026-04-21 SAFETY NETS (added after regression analysis against the 166-record Apr-17/18
// baseline surfaced that a forwarded "FW: Checking In" email — "Both of these needs to go into
// ZOHO OEMs" — would have had Contact A wrongly dropped because his email appears
// only in the To: line while Contact B's signature block was the only one with phone/title):
//  A. PLURAL-INTENT SHORT-CIRCUIT — if the forwarder instruction/preamble contains any of
//     {both, these, everyone, all of, all the, the following, attendees, team, group,
//      folks, the crew, the contacts, the people, the three, ...} the filter is skipped
//     for the entire email. Forwarder is explicitly signalling multi-target intent.
//     This alone handles the real Contact A/Contact B case from exec 989 ("Both of these needs to
//     go into ZOHO OEMs"). A domain-match secondary net was considered but proven too
//     aggressive — it also saved a second banker at the same bank domain from a colleague's signature on exec 1342,
//     which is exactly what the user flagged as bad.
//  B. NAME-IN-INSTRUCTION LIFELINE — if the at-risk contact's first or last name appears
//     literally inside the forwarder instruction/preamble, keep it regardless.
//     (Covers the narrower "add John at ACME" singular-intent-but-named-target case.)
//
// Validate Contact Type v3.3.2 + v3.30c post-extraction ghost filter — FUZZY TYPE MATCH FLAG
// v3.3.1 FIX: When forwarder instruction matches after normalization (lowercasing, plural
// stripping, alias resolution) but the ORIGINAL instruction text doesn't exactly match any
// canonical type name, flag for review. E.g., "Family offices" → "Family Office" works
// but gets flagged. Observed failure: type typos not flagged for review.
//
// Validate Contact Type v3.3 — TYPE-RELEVANCE GATE
//
// v3.3 CHANGES:
// - NEW: TYPE-RELEVANCE GATE added after type validation cascade.
//   When the forwarder specifies a type (suggestedType), each contact is evaluated
//   for compatibility based on their company name and email domain.
//
//   EXAMPLE: Forwarder says "Family Office for Zoho". Two contacts extracted:
//     - John Broker (bofa.com, Bank of America) → inferred "Financial Institution" → SKIP
//     - Jane Broker (example-familyoffice.com) → no strong conflict → KEPT as Family Office
//
//   HIGH confidence mismatch (known bank domain, etc.) → skipZohoUpsert = true
//   MEDIUM confidence mismatch (possible but uncertain) → infoNote only
//
//   Expected: the holding group is the family office and NOT Bank of America,
//   so only the one contact would be logged.
//
// v3.2: forwarderInstruction fallback, OEM aliases.
// v3.1: Preserve skipZohoUpsert from upstream, email format validation.
// v3.0: Forwarder instruction always wins, review vs info distinction.
//
// REVIEW = something is genuinely WRONG (no contact data, low AI confidence)
// INFO = noteworthy observation (AI saw different type, optional fields missing)

// Edit to match your CRM's contact-type picklist.
const VALID_TYPES = ["Attorney", "Broker", "Customer", "Employee", "Family Office", "Financial Institution",
  "Industry Resource", "Insurance", "Investment Advisor", "Management Company", "Manufacturer",
  "Marketing", "Partner", "Service Provider"];

// Edit to match your CRM's contact-type picklist.
const VALID_SPECIFIC_TYPES = []; // optional sub-category picklist; empty = disabled

// Edit to match your CRM's contact-type picklist.
const TYPE_ALIASES = {
  "dealer broker": "Broker", "dealer": "Broker", "broker": "Broker",
  "bank": "Financial Institution", "lender": "Financial Institution", "banker": "Financial Institution",
  "finance broker": "Partner",
  "private bank": "Financial Institution", "attorney": "Attorney",
  "lawyer": "Attorney", "insurance agent": "Insurance",
  "insurer": "Insurance", "appraiser": "Service Provider",
  "end user": "Customer", "enduser": "Customer",
  "management": "Management Company", "mgmt": "Management Company",
  "finance": "Partner",
  "loan broker": "Partner", "distributor": "Industry Resource",
  "ria": "Investment Advisor",
  "investment advisor": "Investment Advisor",
  "oem": "Manufacturer", "manufacturer": "Manufacturer",
  "maintenance": "Industry Resource",
  "family office": "Family Office", "escrow": "Service Provider",
  "escrow agent": "Service Provider",
  "vendor": "Service Provider"
};

// Edit to match your CRM's contact-type picklist.
const SPECIFIC_TYPE_REMAP = {}; // optional sub-category picklist; empty = disabled

// ═══════════════════════════════════════════════════════════════
// v3.3 NEW: TYPE-RELEVANCE SIGNALS
// Maps each Zoho type to company/domain patterns that indicate
// a contact BELONGS to that industry. Used to detect mismatches
// between the forwarder's instructed type and the contact's actual industry.
// ═══════════════════════════════════════════════════════════════

// THREE-TIER CONFIDENCE:
//   Tier 1 — strongDomains: Known institution domains → SKIP (high confidence)
//   Tier 2 — strongCompanyPatterns: Unambiguous type words in company name
//            ("Bank", "Law Firm", "Insurance Co") → SKIP (high confidence)
//   Tier 3 — suggestivePatterns: Ambiguous keywords ("Asset Management", "Capital",
//            "Financial") that COULD indicate a type but also could be wrong
//            → INFO NOTE only (medium confidence, no skip)
//
// WHY THREE TIERS?
// "Example Asset Management" has "Asset Management" in the name, which is suggestive of
// Family Office. But the forwarder says it's an Investment Advisor — and they're RIGHT. "Asset
// Management" is ambiguous. We can't skip on ambiguity.
// "Bank of America" has "Bank" in the name — that's UNAMBIGUOUS. A bank is a
// Financial Institution, period. We CAN skip on certainty.

// Edit to match your CRM's contact-type picklist.
const TYPE_SIGNALS = {
  "Financial Institution": {
    // TIER 2: "Bank" in name = definitely a financial institution, not a family office/broker
    strongCompanyPatterns: [
      /\bbank\b/i, /\bcredit\s*union\b/i, /\bnational\s+bank\b/i,
      /\bsavings\s+(?:bank|association|institution)\b/i,
      /\bfederal\s+(?:savings|credit)\b/i, /\btrust\s+(?:company|bank)\b/i
    ],
    // TIER 3: ambiguous — "Capital" could be family office, "Financial" could be anything
    suggestivePatterns: [
      /\blending\b/i, /\bmortgage\b/i, /\bfinancial\s+(?:group|corp|services)\b/i
    ],
    domainPatterns: [/bank/, /credit/, /lending/, /mortgage/, /savings/],
    // TIER 1: Known major bank/financial institution domains
    strongDomains: [
      'bofa.com', 'bankofamerica.com', 'chase.com', 'jpmorgan.com', 'jpmchase.com',
      'wellsfargo.com', 'wf.com', 'citi.com', 'citigroup.com', 'citibank.com',
      'usbank.com', 'tdbank.com', 'td.com', 'regions.com', 'keybank.com',
      'key.com', 'fifththird.com', '53.com', 'huntington.com',
      'truist.com', 'suntrust.com', 'bbt.com', 'ally.com', 'allyfinancial.com',
      'capitalone.com', 'discover.com', 'synchrony.com',
      'goldmansachs.com', 'gs.com', 'morganstanley.com', 'ms.com',
      'schwab.com', 'fidelity.com', 'vanguard.com', 'ameriprise.com',
      'rbc.com', 'scotiabank.com', 'bmo.com', 'cibc.com',
      'hsbc.com', 'barclays.com', 'db.com', 'ubs.com',
      'pnc.com', 'comerica.com', 'zions.com', 'bok.com',
      'synovus.com', 'firsthorizon.com', 'citizens.com', 'citizensbank.com',
      'websterbank.com', 'eastwest.com', 'firstrepublic.com'
    ]
  },
  "Family Office": {
    strongCompanyPatterns: [
      /\bfamily\s+office\b/i, /\bmulti[\s-]?family\s+office\b/i,
      /\bsingle[\s-]?family\s+office\b/i
    ],
    suggestivePatterns: [
      /\bwealth\s+(?:management|advisory|advisors?)\b/i,
      /\bprivate\s+(?:wealth|equity|capital|client)\b/i,
      /\basset\s+management\b/i
    ],
    domainPatterns: [/familyoffice/],
    strongDomains: []
  },
  "Attorney": {
    strongCompanyPatterns: [
      /\blaw\s+(?:firm|office|group|practice)\b/i,
      /\battorney(?:s)?\s+at\s+law\b/i,
      /\b(?:LLP|Esq\.?)\b/i,
      /\b[A-Z][a-z]+\s*(?:&|and)\s*[A-Z][a-z]+\s*,?\s*(?:LLP|LLC|PA|PC|PLC)\b/
    ],
    suggestivePatterns: [
      /\blaw\b/i, /\blegal\b/i, /\battorney\b/i, /\bcounsel\b/i
    ],
    domainPatterns: [/law/, /legal/],
    strongDomains: []
  },
  "Insurance": {
    strongCompanyPatterns: [
      /\binsurance\s+(?:company|group|agency|services|corp|inc)\b/i,
      /\bunderwriters?\b/i, /\bindemnity\b/i, /\bsurety\b/i
    ],
    suggestivePatterns: [
      /\binsurance\b/i, /\brisk\s+(?:management|services)\b/i
    ],
    domainPatterns: [/insurance/, /insure/, /underwrite/],
    strongDomains: []
  },
  "Management Company": {
    strongCompanyPatterns: [],
    suggestivePatterns: [/\bmaintenance\b/i],
    domainPatterns: [],
    strongDomains: []
  },
  "Service Provider": {
    strongCompanyPatterns: [
      /\bescrow\s+(?:company|services|agent|group)\b/i,
      /\btitle\s+(?:company|services|agency)\b/i,
      /\bappraisal\s+(?:company|services|group)\b/i
    ],
    suggestivePatterns: [/\bescrow\b/i, /\bapprais/i, /\bvaluation\b/i],
    domainPatterns: [/escrow/, /apprais/],
    strongDomains: []
  },
  "Investment Advisor": {
    strongCompanyPatterns: [
      /\bregistered\s+investment\b/i, /\bRIA\b/
    ],
    suggestivePatterns: [
      /\binvestment\s+advis/i, /\bfinancial\s+(?:planning|advisory|advisors?)\b/i
    ],
    domainPatterns: [/advisory/, /ria/],
    strongDomains: []
  }
};

// ═══════════════════════════════════════════════════════════════
// TYPE INFERENCE ENGINE — Three-tier confidence
//
// Returns: { type, confidence: 'high'|'medium', source, detail } or null
//
// high = WILL SKIP (strongDomains or strongCompanyPatterns)
// medium = INFO NOTE only (suggestivePatterns or domainPatterns)
// ═══════════════════════════════════════════════════════════════

function inferTypeFromCompany(companyName, email) {
  const company = (companyName || '').trim();
  const domain = (email || '').split('@')[1] || '';
  const domainLower = domain.toLowerCase();
  const domainBase = domainLower.replace(/\.(com|net|org|bank|co|io|us|ca|uk)$/, '');

  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    // TIER 1 — HIGH confidence: exact known domain
    if (signals.strongDomains && signals.strongDomains.length > 0) {
      for (const sd of signals.strongDomains) {
        const sdBase = sd.replace(/\.(com|net|org|bank|co|io|us|ca|uk)$/, '');
        if (domainLower === sd || domainLower.endsWith('.' + sd) || domainBase === sdBase) {
          return { type, confidence: 'high', source: 'strong_domain', detail: sd };
        }
      }
    }
    // TIER 2 — HIGH confidence: unambiguous company name pattern
    if (company && signals.strongCompanyPatterns) {
      for (const pattern of signals.strongCompanyPatterns) {
        if (pattern.test(company)) {
          return { type, confidence: 'high', source: 'strong_company', detail: pattern.toString() };
        }
      }
    }
  }

  // Second pass: check suggestive/ambiguous patterns (MEDIUM only)
  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    // TIER 3a — MEDIUM: suggestive company name pattern
    if (company && signals.suggestivePatterns) {
      for (const pattern of signals.suggestivePatterns) {
        if (pattern.test(company)) {
          return { type, confidence: 'medium', source: 'suggestive_company', detail: pattern.toString() };
        }
      }
    }
    // TIER 3b — MEDIUM: domain pattern match
    if (domainBase && domainBase.length >= 3 && signals.domainPatterns) {
      for (const pattern of signals.domainPatterns) {
        if (pattern.test(domainBase)) {
          return { type, confidence: 'medium', source: 'domain_pattern', detail: pattern.toString() };
        }
      }
    }
  }
  return null;
}

const items = $input.all();
const results = [];

for (const item of items) {
  const data = { ...item.json };

  // ═══ v3.2: FORWARDER INSTRUCTION FALLBACK ═══
  // If Email Parser didn't set suggestedType but forwarderInstruction has type keywords,
  // derive suggestedType from the instruction. E.g., "OEM for Zoho" →
  // suggestedType=Manufacturer.
  if (!data.suggestedType && data.forwarderInstruction) {
    const instrLower = data.forwarderInstruction.toLowerCase();
    // Check each alias against the instruction text
    for (const [alias, correctType] of Object.entries(TYPE_ALIASES)) {
      if (instrLower.includes(alias)) {
        data.suggestedType = correctType;
        break;
      }
    }
    // Also check VALID_TYPES directly (case-insensitive)
    if (!data.suggestedType) {
      for (const vt of VALID_TYPES) {
        if (instrLower.includes(vt.toLowerCase())) {
          data.suggestedType = vt;
          break;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MULTI-CONTACT: Process contacts array if present
  // ═══════════════════════════════════════════════════════════════
  let contacts = data.contacts || [data];

    // v3.2.9f: EMPLOYEE EXCLUSION — runs here to catch ALL extraction paths
    // (AI extraction, PDF/OCR extraction, web research discovery)
    // Populate with the firm's own staff so their signatures are never extracted as contacts.
    const OWN_FIRST = new Set(['alex', 'pat', 'taylor', 'morgan', 'casey']);
    const OWN_LAST = new Set(['example', 'sample', 'placeholder', 'demo']);
    const OWN_DOMAINS = new Set(['yourcompany.com']);

    contacts = contacts.filter(c => {
      const f = (c.firstName || '').toLowerCase().trim();
      const l = (c.lastName || '').toLowerCase().trim();
      const e = (c.email || '').toLowerCase();
      const d = e.split('@')[1] || '';
      const co = (c.companyName || c.company || '').toLowerCase();
      const isOwn = /yourcompany|your\s*company/i.test(co);

      if (OWN_DOMAINS.has(d)) return false;
      if (f && l && OWN_FIRST.has(f) && OWN_LAST.has(l)) return false;
      if (isOwn) return false;
      if ((!f && OWN_LAST.has(l) && (!e || isOwn)) || (!l && OWN_FIRST.has(f) && (!e || isOwn))) return false;
      return true;
    });

    // v3.30c+: POST-EXTRACTION GHOST CONTACT FILTER (extended)
    // Catches PDF/OCR/AI artifacts the upstream filters miss:
    //  - Apostrophe-S names ("Alex's", "Pat's") anywhere in name field
    //  - Names containing sentence punctuation (:, ", parens) — parser leaks
    //  - Single-word names ≤3 chars with no opposite-field value
    //  - Own-company staff name tokens bleeding in without proper email
    //  - Email-name mismatch (e.g., firstName="Wry" with email="wiz@...")
    contacts = contacts.filter(c => {
      const f = (c.firstName || '').trim();
      const l = (c.lastName || '').trim();
      const e = (c.email || '').trim();
      const co = (c.companyName || c.company || '').trim();
      // Punctuation artifacts: name fields containing : " ( [ {
      if (/[:"\[\]\{\}]/.test(f) || /[:"\[\]\{\}]/.test(l)) return false;
      // Possessive 's at END of name only (Alex's, Pat's) — NOT mid-name apostrophes (O'Brien, O'Neill)
      if (/^[A-Za-z]+['’]s$/i.test(f) || /^[A-Za-z]+['’]s$/i.test(l)) return false;
      // Also catch "Alex's instruction:" style garbage
      if (/['’]s\s+/i.test(f) && f.length > 10) return false;
      // Very short single-side name (≤3) with empty other side → ghost
      if (!l && f.length <= 3) return false;
      if (!f && l.length <= 3) return false;
      // Zero name + only email (orphan email) — not a real contact
      if (!f && !l) return false;
      // Very short name + no email + no company — ghost
      if (f.length <= 3 && l.length <= 3 && !e && !co) return false;
      // Staff name tokens leaking without legitimate email
      const lLow = l.toLowerCase().replace(/['’]s$/i,'').trim();
      const fLow = f.toLowerCase().trim();
      if (!e && OWN_LAST.has(lLow)) return false;
      if (!e && OWN_FIRST.has(fLow) && !l) return false;
      // (Removed email-name mismatch rule — too aggressive for role emails like manager@)
      return true;
    });

    // v3.32: RECIPIENT-LIST FILTER — drop contacts that only appear inside To:/Cc:/Subject: headers
    // Applied only when multiple contacts are present AND the dropped contact lacks corroborating
    // signature data (phone/mobile/jobTitle), AND no plural-intent safety net triggers.
    if (contacts.length > 1 && data.fullBody) {
      // 2026-04-21 SAFETY NET A — plural-intent short-circuit
      const forwarderSignals = [
        data.forwarderInstruction || '',
        data.rawForwarderInstruction || '',
        data.forwarderPreamble || '',
      ].join(' \n ');
      const PLURAL_INTENT = /\b(?:both|these|everyone|everybody|all\s+of|all\s+the|the\s+following|attendees|the\s+team|the\s+group|folks|the\s+crew|the\s+contacts|the\s+people|the\s+three|the\s+four|the\s+five|the\s+guys)\b/i;
      const pluralIntent = PLURAL_INTENT.test(forwarderSignals);

      if (!pluralIntent) {
        const bodyLines = String(data.fullBody).split('\n');
        const headerLinePat = /^\s*(From|To|Cc|Bcc|Sent|Subject|Date|Reply-To)\s*:/i;

        function emailOnlyInHeaderLines(email) {
          if (!email) return false;
          const needle = email.toLowerCase();
          let foundInHeader = false;
          let foundInSignature = false;
          for (let i = 0; i < bodyLines.length; i++) {
            const raw = bodyLines[i];
            if (!raw.toLowerCase().includes(needle)) continue;
            if (headerLinePat.test(raw)) { foundInHeader = true; continue; }
            if (i > 0 && headerLinePat.test(bodyLines[i - 1])) { foundInHeader = true; continue; }
            const atCount = (raw.match(/@/g) || []).length;
            if (atCount >= 2 && /,\s*['"]?[A-Z]/i.test(raw)) { foundInHeader = true; continue; }
            foundInSignature = true;
          }
          return foundInHeader && !foundInSignature;
        }

        const forwarderSignalsLower = forwarderSignals.toLowerCase();

        contacts = contacts.filter(c => {
          const hasSignatureData = (c.phone && c.phone.trim()) ||
                                   (c.mobile && c.mobile.trim()) ||
                                   (c.jobTitle && c.jobTitle.trim()) ||
                                   (c.title && c.title.trim());
          if (hasSignatureData) return true;
          if (!c.email) return true;
          // Safety net B: name-in-instruction lifeline
          const f = String(c.firstName || '').trim().toLowerCase();
          const l = String(c.lastName || '').trim().toLowerCase();
          if (f && f.length >= 3 && forwarderSignalsLower.indexOf(f) !== -1) return true;
          if (l && l.length >= 3 && forwarderSignalsLower.indexOf(l) !== -1) return true;
          if (emailOnlyInHeaderLines(c.email)) return false;
          return true;
        });
      }
    }
  const validatedContacts = [];

  for (const contact of contacts) {
    let extractedType = contact.type || "";
    let originalType = extractedType;
    let aiType = extractedType; // What AI actually found
    let typeValidated = false;
    let typeCorrected = false;
    let specificType = '';

    // Step -1: Skip distribution channel emails
    const channelDomains = new Set(['notifications.hubspot.com','communication.microsoft.com','send.example-broker.com']);
    const contactDomain = (contact.email || '').toLowerCase().split('@')[1] || '';
    if (channelDomains.has(contactDomain)) {
      contact.skipZohoUpsert = true;
      contact.infoNotes = contact.infoNotes || [];
      contact.infoNotes.push('Skipped: ' + contact.email + ' is a distribution channel, not a real contact');
      validatedContacts.push({ ...contact, needsReview: false, reviewReason: '' });
      continue;
    }

    // Step 0: Check for specific type remap (optional sub-category → contact type)
    const lowerType = extractedType.toLowerCase();
    if (SPECIFIC_TYPE_REMAP[lowerType]) {
      specificType = extractedType;
      extractedType = SPECIFIC_TYPE_REMAP[lowerType];
      typeCorrected = true;
    }

    // ═══════════════════════════════════════════════════════════
    // v3.0 CRITICAL: FORWARDER INSTRUCTION ALWAYS WINS
    // If suggestedType exists from forwarder, USE IT. Period.
    // AI-extracted type is informational only.
    // ═══════════════════════════════════════════════════════════

    if (data.suggestedType) {
      // Forwarder gave a type instruction — this is the final type
      extractedType = data.suggestedType;
      specificType = ''; // v3.2.8: Clear AI-derived specificType when forwarder overrides
      specificType = ''; // v3.2.8: Clear AI-derived specificType when forwarder overrides
      typeValidated = VALID_TYPES.includes(extractedType);

      if (!typeValidated) {
        // Try to resolve forwarder's instruction through aliases
        const aliasKey = extractedType.toLowerCase();
        if (TYPE_ALIASES[aliasKey]) {
          extractedType = TYPE_ALIASES[aliasKey];
          typeValidated = true;
        } else {
          for (const [alias, correctType] of Object.entries(TYPE_ALIASES)) {
            if (extractedType.toLowerCase().includes(alias)) {
              extractedType = correctType;
              typeValidated = true;
              break;
            }
          }
        }
      }

      if (!typeValidated) {
        // Forwarder gave something we can't resolve — still use it, but flag
        extractedType = data.suggestedType;
        typeValidated = false; // Will fall through to default below
      }

      typeCorrected = (extractedType !== originalType);
    }

    // If forwarder didn't provide type, fall through to AI type validation
    if (!data.suggestedType) {
      // Standard validation cascade for AI-extracted type
      if (VALID_TYPES.includes(extractedType)) typeValidated = true;

      if (!typeValidated) {
        const matched = VALID_TYPES.find(t => t.toLowerCase() === extractedType.toLowerCase());
        if (matched) { extractedType = matched; typeValidated = true; typeCorrected = true; }
      }

      if (!typeValidated) {
        const aliasKey = extractedType.toLowerCase();
        if (TYPE_ALIASES[aliasKey]) { extractedType = TYPE_ALIASES[aliasKey]; typeValidated = true; typeCorrected = true; }
      }

      if (!typeValidated) {
        for (const [alias, correctType] of Object.entries(TYPE_ALIASES)) {
          if (extractedType.toLowerCase().includes(alias)) {
            extractedType = correctType; typeValidated = true; typeCorrected = true; break;
          }
        }
      }
    }

    // Last resort: default
    if (!typeValidated) {
      if (data.suggestedType) {
        extractedType = "Industry Resource";
        typeCorrected = true;
        reviewReasons.push('UNRESOLVED TYPE: Forwarder said "' + data.suggestedType + '" but not a valid Zoho type — defaulted to Industry Resource');
      } else {
        extractedType = "Industry Resource";
        typeCorrected = true;
      }
    }

    if (specificType && !VALID_SPECIFIC_TYPES.includes(specificType)) {
      const matched = VALID_SPECIFIC_TYPES.find(t => t.toLowerCase() === specificType.toLowerCase());
      specificType = matched || '';
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.2.8: COMPANY NAME QUALITY CHECK — skip type gate for garbled names
    // AI sometimes extracts proposal text as company name (e.g., "- Buyer: UAE family office")
    const companyStr = (contact.companyName || '').trim();
    const isGarbledCompany = companyStr.startsWith('-') || companyStr.startsWith('•') ||
      companyStr.length > 80 || /^\d/.test(companyStr) ||
      /\b(buyer|seller|borrower|lender|proposed|requested|serial|purchase price)\b/i.test(companyStr);
    if (isGarbledCompany && companyStr) {
      contact.companyName = ''; // Clear garbled company name
      contact.infoNotes = contact.infoNotes || [];
      contact.infoNotes.push('Cleared garbled company name: "' + companyStr.substring(0, 50) + '"');
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.3: TYPE-RELEVANCE GATE
    // When forwarder specified a type, check if this contact's company
    // is compatible. Skip contacts that clearly belong to a different type.
    // ═══════════════════════════════════════════════════════════════

    let typeRelevanceSkip = false;
    let typeRelevanceNote = '';
    let inferredCompanyType = null;
    // v3.3.2: Moved reviewReasons declaration here — was declared after first usage at line ~457
    const reviewReasons = [];

    if (data.suggestedType && contact.email) {
      inferredCompanyType = inferTypeFromCompany(contact.companyName, contact.email);

      if (inferredCompanyType && inferredCompanyType.type !== extractedType) {
        const contactDomain = (contact.email || '').split('@')[1] || '';

        if (inferredCompanyType.confidence === 'high') {
          // HIGH confidence: company clearly belongs to a different type
          // e.g., bofa.com (Financial Institution) being tagged as Family Office → SKIP
          // v3.2.9e: Only skip if forwarder didn't explicitly set a type
          // If the forwarder says "Family Office" for a bank contact, trust the forwarder
          if (!data.suggestedType) {
            typeRelevanceSkip = true;
          } else {
            typeRelevanceNote =
              'Company domain suggests "' + inferredCompanyType.type +
              '" but forwarder explicitly instructed "' + data.suggestedType +
              '". Using forwarder type (forwarder always wins).';
          }
          // v3.3.2: Only set "skipped" note when contact is actually skipped
          if (typeRelevanceSkip) {
            typeRelevanceNote =
              'Type mismatch: "' + (contact.companyName || contactDomain) +
              '" is a ' + inferredCompanyType.type +
              ' (' + inferredCompanyType.source + ': ' + inferredCompanyType.detail +
              '), but forwarder instructed "' + data.suggestedType +
              '". Contact skipped — not the intended target.';
          }
        } else if (inferredCompanyType.confidence === 'medium') {
          // MEDIUM: possible mismatch — info note only, don't skip
          typeRelevanceNote =
            'Possible type mismatch: "' + (contact.companyName || contactDomain) +
            '" may be a ' + inferredCompanyType.type +
            ' (' + inferredCompanyType.source +
            '), but forwarder instructed "' + data.suggestedType + '".';
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.0: REVIEW LOGIC — only genuine problems
    // TYPE CONFLICTS ARE NEVER REVIEW FLAGS (forwarder always wins)
    // ═══════════════════════════════════════════════════════════════

    const infoNotes = [...(contact.infoNotes || [])]; // v3.1: preserve upstream infoNotes

    // v3.3.1 FIX: Fuzzy type match flag — when instruction resolved via normalization
    // but the original text doesn't exactly match any canonical type name, flag for review
    // Edit to match your CRM's contact-type picklist.
    const CANONICAL_TYPES = ["Customer", "Financial Institution", "Broker", "Manufacturer",
      "Industry Resource", "Family Office", "Partner", "Service Provider",
      "Attorney", "Insurance", "Management Company", "Marketing", "Investment Advisor"];
    if (data.suggestedType && typeValidated) {
      const originalInstruction = data.suggestedType;
      const isExactMatch = CANONICAL_TYPES.includes(originalInstruction);
      if (!isExactMatch && extractedType !== originalInstruction) {
        reviewReasons.push('FUZZY TYPE MATCH: "' + originalInstruction + '" → "' + extractedType + '"');
      }
    }

    // INFO ONLY: If AI found a different type than forwarder instructed
    if (data.suggestedType && aiType && aiType !== '' &&
        aiType.toLowerCase() !== extractedType.toLowerCase()) {
      infoNotes.push('AI found type "' + aiType + '" but using your instruction: "' + extractedType + '"');
    }

    // v3.0 AUDIT FIX: Validate email format
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (contact.email && !emailRegex.test(contact.email)) {
      infoNotes.push('Email format may be invalid: "' + contact.email + '" — verify manually');
    }

    // BLOCKING: No email AND no last name (can't create useful Zoho record)
    if (!contact.email && !contact.lastName) {
      reviewReasons.push('NO EMAIL OR NAME: Cannot create Zoho record');
    }

    // BLOCKING: AI confidence is explicitly low AND we have some data
    if (contact.confidence === 'low' && (contact.email || contact.lastName)) {
      reviewReasons.push('LOW CONFIDENCE: AI uncertain about extraction accuracy');
    }

    // INFORMATIONAL: Type was auto-corrected through alias resolution
    if (typeCorrected && originalType !== '' &&
        originalType.toLowerCase() !== extractedType.toLowerCase() &&
        !data.suggestedType) {
      infoNotes.push('Type auto-corrected: "' + originalType + '" → "' + extractedType + '"');
    }

    // INFORMATIONAL: Detection flags
    if (data.hasDetectionFlags && (data.detectionFlags || []).length > 0) {
      const flags = data.detectionFlags;
      if (flags.includes('MULTI_CONTACT')) {
        infoNotes.push('Multiple contacts detected in this email');
      }
      if (flags.includes('PDF_ATTACHMENT')) {
        infoNotes.push('PDF attachment present — extracted from email text');
      }
      if (flags.includes('IMAGE_ONLY')) {
        infoNotes.push('Image attachment — contact extracted from available text');
      }
    }

    // INFORMATIONAL: Missing optional fields
    const missingOptional = (contact.missingCriticalFields || []).filter(f =>
      !['email', 'firstName', 'lastName', 'type'].includes(f)
    );
    if (missingOptional.length > 0) {
      infoNotes.push('Optional fields not found: ' + missingOptional.join(', '));
    }

    // BLOCKING: Missing email only (has name but no email)
    if (!contact.email && contact.lastName) {
      reviewReasons.push('NO EMAIL: Contact created without email — manual lookup needed');
    }

    // v3.3: Type-relevance gate note
    if (typeRelevanceNote) {
      infoNotes.push(typeRelevanceNote);
    }

    // ═══════════════════════════════════════════════════════════════
    // v3.1: INFORMATIONAL — Source-text validation cleared some fields
    // ═══════════════════════════════════════════════════════════════
    if (contact.clearedFields && contact.clearedFields.length > 0) {
      const clearedNames = contact.clearedFields.map(f => f.field || f).join(', ');
      infoNotes.push('Source validation cleared: ' + clearedNames + ' (not found in email text)');
    }

    if (contact.verificationScore !== undefined && contact.verificationScore < 50) {
      infoNotes.push('Low verification score: ' + contact.verificationScore + '% of fields confirmed in source');
    }

    const needsReview = reviewReasons.length > 0;
    const reviewReason = reviewReasons.join(' | ');

    const hasAnyContactData = !!(contact.email || contact.lastName || contact.firstName);

    // ═══════════════════════════════════════════════════════════════
    // v3.1 CRITICAL FIX: MERGE skipZohoUpsert — never UN-BLOCK a contact
    //
    // If Parse AI Response blocked this contact (skipZohoUpsert: true)
    // because source-text validation failed, we MUST preserve that.
    // We can only ADD additional reasons to skip, never remove them.
    //
    // OLD (broken): skipZohoUpsert: shouldSkipZoho  ← overwrote upstream block
    // NEW (fixed):  skipZohoUpsert: upstreamBlocked || shouldSkipZoho
    // ═══════════════════════════════════════════════════════════════
    const upstreamBlocked = contact.skipZohoUpsert === true;
    const shouldSkipZoho = !hasAnyContactData;

    validatedContacts.push({
      ...contact,
      type: extractedType,
      specificType: specificType || contact.specificType || '',
      typeValidated: typeValidated,
      typeCorrected: typeCorrected,
      originalExtractedType: originalType,
      aiExtractedType: aiType,
      needsReview: needsReview,
      reviewReason: reviewReason,
      infoNotes: infoNotes,
      // v3.3: Type-relevance gate fields (audit trail)
      inferredCompanyType: inferredCompanyType ? inferredCompanyType.type : null,
      inferredTypeConfidence: inferredCompanyType ? inferredCompanyType.confidence : null,
      inferredTypeSource: inferredCompanyType ? inferredCompanyType.source : null,
      // v3.1+v3.3: MERGE — blocked stays blocked, add new reasons to skip
      skipZohoUpsert: upstreamBlocked || shouldSkipZoho || typeRelevanceSkip
    });
  }

  // Output: single item with contacts array
  const anyNeedsReview = validatedContacts.some(c => c.needsReview);
  const allInfoNotes = validatedContacts.flatMap(c => c.infoNotes || []);
  const anySkipZoho = validatedContacts.every(c => c.skipZohoUpsert);

  results.push({
    json: {
      ...data,
      contacts: validatedContacts,
      // Top-level summary for downstream nodes
      needsReview: anyNeedsReview,
      reviewReason: validatedContacts.filter(c => c.needsReview).map(c => c.reviewReason).join(' || '),
      infoNotes: allInfoNotes,
      skipZohoUpsert: anySkipZoho,
      contactCount: validatedContacts.length
    }
  });
}

return results;
