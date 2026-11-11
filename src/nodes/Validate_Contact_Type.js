// Validate Contact Type
//
// Last filter before anything is written. Drops contacts that are not real people
// or that belong to your own staff, then settles each contact's type. The
// forwarder's note wins ("Family Office for Zoho"); otherwise the model's guess is
// mapped onto VALID_TYPES through TYPE_ALIASES. When the requested type does not
// seem to fit a contact (a bank domain on a "Family Office" request), the contact
// keeps the forwarder's type and the confirmation notes the mismatch.
//
// Also drops people who only appear on a forwarded To:/Cc: line with no phone or
// title of their own, unless the note asks for several people ("both of these",
// "the team") or names them. A request to remove or delete a contact is never
// written: it is flagged so the sender deletes the record by hand.
//
// needsReview means something is wrong: no usable contact data, low model
// confidence, a removal request. infoNotes are observations: the model suggested a
// different type, optional fields are missing.
//
// Input: Parse AI Response items (through Has Extractable Attachment?) or Parse PDF
// Contacts items, each with a contacts array.
// Output: the same items with validated contacts, type, needsReview, infoNotes,
// and skipZohoUpsert per contact and as a summary.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];
const OWN_COMPANY_NAMES = ['Your Company'];

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
  "funding source": "Financial Institution", "fund source": "Financial Institution",
  "family office": "Family Office", "escrow": "Service Provider",
  "escrow agent": "Service Provider",
  "vendor": "Service Provider"
};

// Edit to match your CRM's contact-type picklist.
const SPECIFIC_TYPE_REMAP = {}; // optional sub-category picklist; empty = disabled

// Type-relevance signals: company-name and domain patterns that show which type a
// contact really is, so a forwarder's type can be checked against each contact.
//
// Three tiers, because only some signals are certain:
//   strongDomains          known institution domains            -> high confidence
//   strongCompanyPatterns  unambiguous words ("Bank", "Law Firm") -> high confidence
//   suggestivePatterns     ambiguous words ("Asset Management", "Financial"),
//                          and domainPatterns                    -> medium, note only
// "Example Asset Management" may well be the Investment Advisor the forwarder says it
// is, so ambiguity never skips a contact. "Bank of America" is a bank, full stop.

// Edit to match your CRM's contact-type picklist.
const TYPE_SIGNALS = {
  "Financial Institution": {
    strongCompanyPatterns: [
      /\bbank\b/i, /\bcredit\s*union\b/i, /\bnational\s+bank\b/i,
      /\bsavings\s+(?:bank|association|institution)\b/i,
      /\bfederal\s+(?:savings|credit)\b/i, /\btrust\s+(?:company|bank)\b/i
    ],
    // "Capital" or "Financial" alone could be a family office or anything else.
    suggestivePatterns: [
      /\blending\b/i, /\bmortgage\b/i, /\bfinancial\s+(?:group|corp|services)\b/i
    ],
    domainPatterns: [/bank/, /credit/, /lending/, /mortgage/, /savings/],
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

// Returns { type, confidence: 'high'|'medium', source, detail } or null. All high-confidence
// tiers are checked across every type before any medium one, so a certain match on a later
// type beats an ambiguous match on an earlier one.

function inferTypeFromCompany(companyName, email) {
  const company = (companyName || '').trim();
  const domain = (email || '').split('@')[1] || '';
  const domainLower = domain.toLowerCase();
  const domainBase = domainLower.replace(/\.(com|net|org|bank|co|io|us|ca|uk)$/, '');

  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    if (signals.strongDomains && signals.strongDomains.length > 0) {
      for (const sd of signals.strongDomains) {
        const sdBase = sd.replace(/\.(com|net|org|bank|co|io|us|ca|uk)$/, '');
        if (domainLower === sd || domainLower.endsWith('.' + sd) || domainBase === sdBase) {
          return { type, confidence: 'high', source: 'strong_domain', detail: sd };
        }
      }
    }
    if (company && signals.strongCompanyPatterns) {
      for (const pattern of signals.strongCompanyPatterns) {
        if (pattern.test(company)) {
          return { type, confidence: 'high', source: 'strong_company', detail: pattern.toString() };
        }
      }
    }
  }

  for (const [type, signals] of Object.entries(TYPE_SIGNALS)) {
    if (company && signals.suggestivePatterns) {
      for (const pattern of signals.suggestivePatterns) {
        if (pattern.test(company)) {
          return { type, confidence: 'medium', source: 'suggestive_company', detail: pattern.toString() };
        }
      }
    }
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

  // "Remove Contact" or "Remove/ Delete Contact: Jane Doe" would otherwise be extracted and
  // added, the opposite of the request. Removal is not automated, so block the write and say so.
  // Only the subject, the instruction and the first lines count: a disclaimer further down
  // ("delete it and contact the sender") must not block an ordinary add.
  const intentText = [data.originalSubject || '', data.forwarderInstruction || '', (data.fullBody || '').substring(0, 120)].join('\n');
  const isRemovalRequest =
    /\b(remove|delete|deactivate)\b[^\n]{0,12}\bcontacts?\b/i.test(intentText) ||
    /\bcontacts?\b[^\n]{0,12}\b(remove|removal|delete|deletion)\b/i.test(intentText) ||
    /^\s*(remove|delete)\s*[\/:]/im.test(intentText);

  // Email Parser's keyword list is shorter than TYPE_ALIASES, so an instruction it could not
  // type ("OEM for Zoho") gets a second chance here.
  if (!data.suggestedType && data.forwarderInstruction) {
    const instrLower = data.forwarderInstruction.toLowerCase();
    for (const [alias, correctType] of Object.entries(TYPE_ALIASES)) {
      if (instrLower.includes(alias)) {
        data.suggestedType = correctType;
        break;
      }
    }
    if (!data.suggestedType) {
      for (const vt of VALID_TYPES) {
        if (instrLower.includes(vt.toLowerCase())) {
          data.suggestedType = vt;
          break;
        }
      }
    }
  }

  let contacts = data.contacts || [data];

    // Staff exclusion runs here so it covers every extraction path (model, PDF/OCR, web
    // research). Full names are matched as pairs: matching first and last names separately
    // would also drop an outside contact who shares one staff first name and another's last.
    const OWN_FIRST = new Set(OWN_STAFF.map(s => s.name.split(' ')[0].toLowerCase()));
    const OWN_LAST = new Set(OWN_STAFF.map(s => s.name.split(' ').slice(-1)[0].toLowerCase()));
    const OWN_FULL = new Set(OWN_STAFF.map(s => s.name.toLowerCase()));
    const ownCompanyKeys = OWN_COMPANY_NAMES.map(n => n.toLowerCase().replace(/\s+/g, ''));

    contacts = contacts.filter(c => {
      const f = (c.firstName || '').toLowerCase().trim();
      const l = (c.lastName || '').toLowerCase().trim();
      const e = (c.email || '').toLowerCase();
      const d = e.split('@')[1] || '';
      const co = (c.companyName || c.company || '').toLowerCase();
      const isOwn = ownCompanyKeys.some(k => co.replace(/\s+/g, '').includes(k));

      if (OWN_DOMAINS.has(d)) return false;
      if (f && l && OWN_FULL.has(f + ' ' + l)) return false;
      if (isOwn) return false;
      if ((!f && OWN_LAST.has(l) && (!e || isOwn)) || (!l && OWN_FIRST.has(f) && (!e || isOwn))) return false;
      return true;
    });

    // Ghost contacts: PDF/OCR/model artifacts the upstream filters miss, such as possessive
    // names ("Pat's"), names with sentence punctuation, very short one-sided names, and staff
    // name tokens with no email of their own.
    contacts = contacts.filter(c => {
      const f = (c.firstName || '').trim();
      const l = (c.lastName || '').trim();
      const e = (c.email || '').trim();
      const co = (c.companyName || c.company || '').trim();
      // Name fields containing : " [ ] { } are parser leaks.
      if (/[:"\[\]\{\}]/.test(f) || /[:"\[\]\{\}]/.test(l)) return false;
      // Possessive 's at the end only (Pat's); mid-name apostrophes (O'Brien, D'Angelo) are real.
      if (/^[A-Za-z]+['’]s$/i.test(f) || /^[A-Za-z]+['’]s$/i.test(l)) return false;
      // "Pat's instruction:" style garbage.
      if (/['’]s\s+/i.test(f) && f.length > 10) return false;
      // A one-sided name of 3 letters or fewer is not enough to be a person.
      if (!l && f.length <= 3) return false;
      if (!f && l.length <= 3) return false;
      // An email with no name at all is not a contact record.
      if (!f && !l) return false;
      if (f.length <= 3 && l.length <= 3 && !e && !co) return false;
      // Staff name tokens leaking in from a signature, with no email of their own.
      const lLow = l.toLowerCase().replace(/['’]s$/i,'').trim();
      const fLow = f.toLowerCase().trim();
      if (!e && OWN_LAST.has(lLow)) return false;
      if (!e && OWN_FIRST.has(fLow) && !l) return false;
      // No email-vs-name mismatch rule: role mailboxes like manager@ would all fail it.
      return true;
    });

    // Recipient-list filter: a forwarded To:/Cc: line lists people the forwarder did not ask
    // for. With several contacts, drop one whose email appears only on header lines and who
    // has no phone or title of their own.
    if (contacts.length > 1 && data.fullBody) {
      // "Both of these", "the team": the forwarder wants several people, so filter nothing.
      const forwarderSignals = [
        data.forwarderInstruction || '',
        data.rawForwarderInstruction || '',
        data.forwarderPreamble || '',
      ].join(' \n ');
      const PLURAL_INTENT = /\b(?:both|these|everyone|everybody|all\s+of|all\s+the|the\s+following|attendees|the\s+team|the\s+group|folks|the\s+crew|the\s+contacts|the\s+people|the\s+three|the\s+four|the\s+five|the\s+guys)\b/i;
      const pluralIntent = PLURAL_INTENT.test(forwarderSignals);

      if (!pluralIntent) {
        const bodyLines = String(data.fullBody).split('\n');
        // German and French clients write forward headers as "Von:/An:" and "De:/A:" (accented in the regex).
        const headerLinePat = /^\s*(From|To|Cc|Bcc|Sent|Subject|Date|Reply-To|Von|An|Gesendet|Betreff|Kopie|De|À|Envoyé|Objet)\s*:/i;

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
          // Named in the note: keep, whatever the headers say.
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
    // Declared first: the unresolved-type branch below pushes to it.
    const reviewReasons = [];
    let extractedType = contact.type || "";
    let originalType = extractedType;
    let aiType = extractedType; // What AI actually found
    let typeValidated = false;
    let typeCorrected = false;
    let specificType = '';

    // Mailing platforms that relay someone else's message; the address is never the person.
    const channelDomains = new Set(['notifications.hubspot.com','communication.microsoft.com','send.example-broker.com']);
    const contactDomain = (contact.email || '').toLowerCase().split('@')[1] || '';
    if (channelDomains.has(contactDomain)) {
      contact.skipZohoUpsert = true;
      contact.infoNotes = contact.infoNotes || [];
      contact.infoNotes.push('Skipped: ' + contact.email + ' is a distribution channel, not a real contact');
      validatedContacts.push({ ...contact, needsReview: false, reviewReason: '' });
      continue;
    }

    // A sub-category the model returned as the type maps back to its parent type.
    const lowerType = extractedType.toLowerCase();
    if (SPECIFIC_TYPE_REMAP[lowerType]) {
      specificType = extractedType;
      extractedType = SPECIFIC_TYPE_REMAP[lowerType];
      typeCorrected = true;
    }

    // The forwarder's type always wins; the model's type is only reported as a note.

    if (data.suggestedType) {
      extractedType = data.suggestedType;
      specificType = ''; // a model-derived sub-category no longer applies
      specificType = '';
      typeValidated = VALID_TYPES.includes(extractedType);

      if (!typeValidated) {
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
        // Unresolvable: falls through to the default below, which flags it for review.
        extractedType = data.suggestedType;
        typeValidated = false; // Will fall through to default below
      }

      typeCorrected = (extractedType !== originalType);
    }

    if (!data.suggestedType) {
      // Model's type: exact, then case-insensitive, then alias, then alias substring.
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

    // Last resort, so the CRM never receives a type outside the picklist.
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

    // The model sometimes returns deal text as the company ("- Buyer: UAE family office"),
    // which would also mislead the type gate below. Clear it.
    const companyStr = (contact.companyName || '').trim();
    // A leading digit is legitimate when the name matches the email domain
    // ("123 Widgets" with 123widgets.example).
    const companyAlnum = companyStr.toLowerCase().replace(/[^a-z0-9]/g, '');
    // Use the registrable label, not the first one ("x@mail.123widgets.com" gives "123widgets").
    const domainParts = ((contact.email || '').split('@')[1] || '').toLowerCase().split('.');
    const emailDomainLabel = domainParts.length >= 3 && ['co', 'com', 'org', 'net', 'ac', 'gov'].includes(domainParts[domainParts.length - 2])
      ? domainParts[domainParts.length - 3] : (domainParts[domainParts.length - 2] || '');
    const digitNameMatchesDomain = emailDomainLabel.length >= 3 && companyAlnum.startsWith(emailDomainLabel);
    const isGarbledCompany = companyStr.startsWith('-') || companyStr.startsWith('•') ||
      companyStr.length > 80 || (/^\d/.test(companyStr) && !digitNameMatchesDomain) ||
      /\b(buyer|seller|borrower|lender|proposed|requested|serial|purchase price)\b/i.test(companyStr);
    if (isGarbledCompany && companyStr) {
      contact.companyName = '';
      contact.infoNotes = contact.infoNotes || [];
      contact.infoNotes.push('Cleared garbled company name: "' + companyStr.substring(0, 50) + '"');
    }

    // Type-relevance gate: when the forwarder gave a type, check each contact's company
    // against it, so one bank contact in a "Family Office" email is noticed.

    let typeRelevanceSkip = false;
    let typeRelevanceNote = '';
    let inferredCompanyType = null;
    if (isRemovalRequest) {
      reviewReasons.push('REMOVAL REQUEST — not added to Zoho. Removal is not automated: delete ' +
        (contact.email || ((contact.firstName || '') + ' ' + (contact.lastName || '')).trim()) + ' in Zoho manually.');
    }

    if (data.suggestedType && contact.email) {
      inferredCompanyType = inferTypeFromCompany(contact.companyName, contact.email);

      if (inferredCompanyType && inferredCompanyType.type !== extractedType) {
        const contactDomain = (contact.email || '').split('@')[1] || '';

        if (inferredCompanyType.confidence === 'high') {
          // The company clearly belongs to another type (bofa.com on a Family Office request).
          // The gate only runs with a forwarder type, and that type wins, so in practice this
          // records a note; the skip branch does not fire.
          if (!data.suggestedType) {
            typeRelevanceSkip = true;
          } else {
            typeRelevanceNote =
              'Company domain suggests "' + inferredCompanyType.type +
              '" but forwarder explicitly instructed "' + data.suggestedType +
              '". Using forwarder type (forwarder always wins).';
          }
          if (typeRelevanceSkip) {
            typeRelevanceNote =
              'Type mismatch: "' + (contact.companyName || contactDomain) +
              '" is a ' + inferredCompanyType.type +
              ' (' + inferredCompanyType.source + ': ' + inferredCompanyType.detail +
              '), but forwarder instructed "' + data.suggestedType +
              '". Contact skipped — not the intended target.';
          }
        } else if (inferredCompanyType.confidence === 'medium') {
          // Possible mismatch: note only.
          typeRelevanceNote =
            'Possible type mismatch: "' + (contact.companyName || contactDomain) +
            '" may be a ' + inferredCompanyType.type +
            ' (' + inferredCompanyType.source +
            '), but forwarder instructed "' + data.suggestedType + '".';
        }
      }
    }

    // Review flags are for real problems only. A type conflict is never one, because the
    // forwarder's type always wins.

    const infoNotes = [...(contact.infoNotes || [])];

    // An instruction that only matched after normalization ("Financial Institutions",
    // a typo) is flagged so a person confirms the type.
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

    if (data.suggestedType && aiType && aiType !== '' &&
        aiType.toLowerCase() !== extractedType.toLowerCase()) {
      infoNotes.push('AI found type "' + aiType + '" but using your instruction: "' + extractedType + '"');
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (contact.email && !emailRegex.test(contact.email)) {
      infoNotes.push('Email format may be invalid: "' + contact.email + '" — verify manually');
    }

    // Without an email or a last name there is nothing to key a CRM record on.
    if (!contact.email && !contact.lastName) {
      reviewReasons.push('NO EMAIL OR NAME: Cannot create Zoho record');
    }

    if (contact.confidence === 'low' && (contact.email || contact.lastName)) {
      reviewReasons.push('LOW CONFIDENCE: AI uncertain about extraction accuracy');
    }

    if (typeCorrected && originalType !== '' &&
        originalType.toLowerCase() !== extractedType.toLowerCase() &&
        !data.suggestedType) {
      infoNotes.push('Type auto-corrected: "' + originalType + '" → "' + extractedType + '"');
    }

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

    const missingOptional = (contact.missingCriticalFields || []).filter(f =>
      !['email', 'firstName', 'lastName', 'type'].includes(f)
    );
    if (missingOptional.length > 0) {
      infoNotes.push('Optional fields not found: ' + missingOptional.join(', '));
    }

    if (!contact.email && contact.lastName) {
      reviewReasons.push('NO EMAIL: Contact created without email — manual lookup needed');
    }

    if (typeRelevanceNote) {
      infoNotes.push(typeRelevanceNote);
    }

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

    // Never unblock: if Parse AI Response held this contact back (source validation failed),
    // that stands. This node can only add reasons to skip.
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
      // Audit trail for the type-relevance gate.
      inferredCompanyType: inferredCompanyType ? inferredCompanyType.type : null,
      inferredTypeConfidence: inferredCompanyType ? inferredCompanyType.confidence : null,
      inferredTypeSource: inferredCompanyType ? inferredCompanyType.source : null,
      skipZohoUpsert: upstreamBlocked || shouldSkipZoho || typeRelevanceSkip || isRemovalRequest
    });
  }

  const anyNeedsReview = validatedContacts.some(c => c.needsReview);
  const allInfoNotes = validatedContacts.flatMap(c => c.infoNotes || []);
  const anySkipZoho = validatedContacts.every(c => c.skipZohoUpsert);

  results.push({
    json: {
      ...data,
      contacts: validatedContacts,
      // Summary for Prepare Upsert and the confirmation email.
      needsReview: anyNeedsReview,
      reviewReason: validatedContacts.filter(c => c.needsReview).map(c => c.reviewReason).join(' || '),
      infoNotes: allInfoNotes,
      skipZohoUpsert: anySkipZoho,
      contactCount: validatedContacts.length
    }
  });
}

return results;
