// Final Sanity Clean
//
// Deterministic cleanup applied to every contact, whichever path produced it
// (model, signature scanner, PDF/OCR, web research), because each path has its own
// formatting leaks and fixing them once here is cheaper than in every producer.
// Every step is idempotent, so running it on already-clean data changes nothing.
//
// Cleans: a name repeated inside the title ("Jane Doe | Director | Sales | Acme
// Holdings"), a literal "Title " prefix, the title bleeding into the company
// ("Co-Founder & CEO Acme Group"), run-together company names (Acmeindustrialinc),
// stray brackets, bare domains as company names (acmetrailerleasing.com), labels
// around phone numbers, an address line in the city field, UK country spellings
// (UK, England), and duplicate contacts. Generic mailboxes (info@, test@)
// are flagged, not removed. A contact whose company is not written anywhere in the email gets a
// notice saying so.
//
// Input: Merge Research Results items ({ contacts: [...] }).
// Output: the same items with cleaned contacts and an updated contactCount.

const COMPANY_NOTICE = 'Notice: Company not stated in email';

const TITLE_KW = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|co-?founder|founder|principal|broker|sales|specialist|agent|banker|analyst|controller|accountant|attorney|counsel|advisor|associate|executive|administrator|coordinator|supervisor|consultant|engineer|architect|developer|designer|writer|editor|reporter|correspondent)\b/i;

// Word endings used to split run-together company names. Extend from observed data.
const CONCAT_SUFFIXES = [
  'incorporated','international','corporation','enterprises','consultants',
  'industrial','associates','management',
  'consulting','realestate','investments',
  'capital','finance','partners','ventures','holdings','advisors','advisory',
  'solutions','services','brothers','company','limited','global','group',
  'hongkong','newyork','losangeles','chicago','dallas','houston','miami','denver','seattle',
  'bank','trust','insurance','llc','inc'
];
const CONCAT_PREFIXES = ['the','premier','national','federal','continental','transatlantic','oceanic','pacific','atlantic'];

const GENERIC_EMAIL_PREFIXES = new Set([
  'info','sales','support','admin','contact','contacts','hello','help','office','team',
  'general','marketing','billing','service','noreply','no-reply','donotreply','newsletter',
  'notifications','mail','enquiries','inquiries','reception','hr','jobs','careers','press',
  'media','webmaster','fraud','test','example','admin','abuse','postmaster'
]);

// Calling codes used to store a nationally written number ("01 99 00 41 27", "082 555 0144") in
// international form when the contact's country is known. NANP countries are left out on
// purpose (their numbers stay as written), and so is Italy, whose leading 0 is not a trunk prefix.
const COUNTRY_CALLING_CODES = {
  'united kingdom': '44', 'uk': '44', 'england': '44', 'scotland': '44', 'wales': '44',
  'ireland': '353', 'germany': '49', 'deutschland': '49', 'austria': '43', 'switzerland': '41',
  'france': '33', 'belgium': '32', 'netherlands': '31', 'spain': '34', 'portugal': '351',
  'sweden': '46', 'norway': '47', 'denmark': '45', 'finland': '358', 'poland': '48',
  'mexico': '52', 'm\u00e9xico': '52', 'brazil': '55', 'brasil': '55', 'argentina': '54',
  'chile': '56', 'colombia': '57', 'peru': '51', 'south africa': '27', 'australia': '61',
  'new zealand': '64', 'india': '91', 'japan': '81', 'china': '86', 'hong kong': '852',
  'singapore': '65', 'south korea': '82', 'israel': '972', 'turkey': '90',
  'uae': '971', 'united arab emirates': '971', 'saudi arabia': '966',
};

// Countries whose national numbers start with a 0 trunk prefix. A number written there without
// the 0 is not a national number of that country, so it is left as written.
const TRUNK_ZERO_CODES = new Set(['44', '353', '49', '43', '41', '33', '32', '31', '46', '358', '54', '51',
  '27', '61', '64', '91', '81', '86', '82', '972', '90', '971', '966', '55']);
// A US/Canada number in its usual shape ("(212) 555-0100", "1-212-555-0100") is not national
// to a foreign contact's country, so it never gets that country's code.
const NANP_SHAPE = /^(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]\d{4}$/;

// "+44 (0)20 7946 0000" drops the (0) trunk prefix, "0034 ..." becomes "+34 ...", and a national
// number gets the country's code.
function internationalPhone(phone, country) {
  const p = phone.replace(/^00(?=[1-9])/, '+').replace(/^(\+\d{1,3})\s*\(0\)\s*/, '$1 ');
  const code = COUNTRY_CALLING_CODES[(country || '').trim().toLowerCase().replace(/\./g, '')];
  if (!code || /^\+/.test(p)) return p;
  const bare = p.replace(/\s*x\d+$/, '').trim();
  const digits = bare.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 11) return p;
  if (NANP_SHAPE.test(bare)) return p;
  if (TRUNK_ZERO_CODES.has(code) && !/^\(?0/.test(p)) return p;
  return '+' + code + ' ' + p.replace(/^\(?0\)?\s*/, '').replace(/[()]/g, '').trim();
}

// The UK and its constituent countries are stored under one CRM country value.
const COUNTRY_CANONICAL = {
  'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'gb': 'United Kingdom', 'great britain': 'United Kingdom',
  'england': 'United Kingdom', 'scotland': 'United Kingdom', 'wales': 'United Kingdom',
  'northern ireland': 'United Kingdom',
};

// "Las Condes, Santiago" or "Walnut Tree Close, Guildford": the model copied a whole address
// line into city. Drop a trailing state, country or upper-case region code ("TX", "B.C."), then
// keep the last part. A mixed-case short word is a city ("Lima", "Oslo"), never dropped.
function cleanCity(city, state, country) {
  const parts = city.split(',').map(p => p.trim()).filter(Boolean);
  const drop = new Set([state, country].map(v => (v || '').trim().toLowerCase()).filter(Boolean));
  while (parts.length > 1 && (drop.has(parts[parts.length - 1].toLowerCase()) || /^(?:[A-Z]{2,3}\.?|(?:[A-Z]\.){2,3})$/.test(parts[parts.length - 1]))) parts.pop();
  return parts.length ? parts[parts.length - 1] : city;
}

function titleCase(s) {
  if (!s) return s;
  return s.split(' ').map(w => w.length <= 2 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function stripNameFromTitle(title, firstName, lastName) {
  if (!title) return title;
  if (!title.includes('|') && !title.includes(',')) return title;
  const delim = title.includes('|') ? '|' : ',';
  const parts = title.split(delim).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return title;
  const fullName = `${firstName || ''} ${lastName || ''}`.trim().toLowerCase();
  const ln = (lastName || '').toLowerCase();
  // If first part is the name (or contains lastName as standalone word), skip it.
  const firstLow = parts[0].toLowerCase();
  const firstHasTitleKW = TITLE_KW.test(firstLow);
  let skipFirst = false;
  if (!firstHasTitleKW) {
    if (fullName && firstLow === fullName) skipFirst = true;
    else if (ln && ln.length >= 3 && new RegExp('\\b' + ln.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(firstLow) && firstLow.split(/\s+/).length <= 3) skipFirst = true;
  }
  const kept = skipFirst ? parts.slice(1) : parts;
  if (kept.length === 0) return title;
  // Commas read better than pipes in the CRM title field.
  return kept.join(', ');
}

function stripTitlePrefix(title) {
  if (!title) return title;
  // "Title President" -> "President", "title: Manager" -> "Manager"
  return title.replace(/^(?:job\s*)?title\s*:?\s*/i, '').trim();
}

function stripTitleFromCompany(company, title) {
  if (!company || !title) return company;
  const tLow = title.toLowerCase().trim();
  const cLow = company.toLowerCase().trim();
  if (tLow && cLow.startsWith(tLow + ' ')) {
    return company.substring(title.length).trim();
  }
  // company="Co-Founder & CEO Acme Group" with title "Co-Founder & CEO": the title is a prefix
  // without a clean word boundary, so strip it as long as something is left.
  if (tLow.length >= 4 && cLow.startsWith(tLow)) {
    const rest = company.substring(title.length).trim();
    if (rest) return rest;
  }
  return company;
}

function stripPunctuation(s) {
  if (!s) return s;
  // Remove stray punctuation like { } [ ] that aren't part of real company names
  return s.replace(/[{}\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

function splitBareDomain(company) {
  if (!company) return company;
  let c = company.trim();
  // "acmetrailerleasing.com" or "ACMETRAILERLEASING.COM"
  const domainMatch = c.match(/^([a-zA-Z][a-zA-Z0-9]+)\.(com|net|org|co|io|biz|us)$/i);
  if (domainMatch) c = domainMatch[1];
  // "ACME.COM | ACMEREALESTATEINVESTMENTS.COM": take the first domain and split it
  if (/\|/.test(c)) {
    const left = c.split('|')[0].trim();
    const lm = left.match(/^([a-zA-Z][a-zA-Z0-9]+)\.?(com|net|org|co|io|biz|us)?/i);
    if (lm && lm[1].length >= 4) c = lm[1];
  }
  // CamelCase fast path
  if (c && /[A-Z]/.test(c.substring(1)) && !/\s/.test(c)) {
    const camelSplit = c.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (camelSplit !== c) return camelSplit;
  }
  if (!c || /\s/.test(c) || !/^[A-Za-z][a-zA-Z]+$/.test(c) || c.length < 6) return c;
  // Greedy: peel known endings off the right, longest first.
  const sortedSfx = [...CONCAT_SUFFIXES].sort((a, b) => b.length - a.length);
  let w = c;
  const parts = [];
  let guard = 0;
  while (w && w.length >= 3 && guard++ < 10) {
    let matched = false;
    for (const sfx of sortedSfx) {
      if (w.length > sfx.length + 1 && w.toLowerCase().endsWith(sfx)) {
        parts.unshift(titleCase(w.slice(-sfx.length)));
        w = w.slice(0, w.length - sfx.length);
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  // Check if a known prefix starts the remaining head
  if (w) {
    for (const pfx of CONCAT_PREFIXES) {
      if (w.toLowerCase().startsWith(pfx) && w.length > pfx.length + 2) {
        parts.unshift(titleCase(w.slice(pfx.length)));
        parts.unshift(titleCase(w.slice(0, pfx.length)));
        w = '';
        break;
      }
    }
    if (w) parts.unshift(titleCase(w));
  }
  if (parts.length <= 1) return titleCase(c);
  return parts.join(' ');
}

function isGenericEmail(email) {
  if (!email) return false;
  const local = email.split('@')[0].toLowerCase();
  return GENERIC_EMAIL_PREFIXES.has(local);
}

const allItems = $input.all();
const results = [];

for (const item of allItems) {
  const d = { ...item.json };
  if (d.skip) { results.push({ json: d }); continue; }
  const contacts = (d.contacts || []).map(c => {
    const cc = { ...c };
    const fn = cc.firstName || '';
    const ln = cc.lastName || '';

    // Title: drop the repeated name and the "Title " label.
    if (cc.jobTitle) {
      let t = cc.jobTitle;
      const before = t;
      t = stripNameFromTitle(t, fn, ln);
      t = stripTitlePrefix(t);
      t = stripPunctuation(t);
      t = t.replace(/\s*\|\s*/g, ', ').replace(/,\s*,/g, ',').replace(/^,|,$/g, '').trim();
      if (t !== before) {
        cc.infoNotes = cc.infoNotes || [];
        cc.infoNotes.push(`Title normalized by sanity clean: "${before}" → "${t}"`);
      }
      cc.jobTitle = t;
      cc.title = t;
    }

    // Company: drop a leading title, stray brackets, and split run-together names.
    if (cc.companyName || cc.company) {
      let co = cc.companyName || cc.company;
      const before = co;
      co = stripTitleFromCompany(co, cc.jobTitle);
      co = stripPunctuation(co);
      co = splitBareDomain(co);
      if (co !== before) {
        cc.infoNotes = cc.infoNotes || [];
        cc.infoNotes.push(`Company normalized by sanity clean: "${before}" → "${co}"`);
      }
      cc.companyName = co;
      cc.company = co;
    }

    if (cc.country) cc.country = COUNTRY_CANONICAL[cc.country.trim().toLowerCase()] || cc.country;
    if (cc.city && cc.city.includes(',')) cc.city = cleanCity(cc.city, cc.state, cc.country);

    // Phones: keep the number and any extension, dropping labels like "M ", "Tel: " or a
    // trailing " office", then store it in international form where the country says how.
    for (const field of ['phone', 'mobile']) {
      if (cc[field]) {
        const match = cc[field].match(/[+(\d][\d\s.()\-+]+\d(?:\s*(?:x|ext\.?|extension)\s*\d{1,6})?/i);
        const num = match ? match[0].trim().replace(/\s*(?:x|ext\.?|extension)\s*(\d+)$/i, ' x$1') : cc[field];
        cc[field] = internationalPhone(num, cc.country);
      }
    }

    // Flag only: upstream nodes decide what a generic mailbox means for the record.
    if (cc.email && isGenericEmail(cc.email)) {
      cc.isGenericEmail = true;
    }

    return cc;
  });

  // Two paths can produce the same person; keep the first and fill its gaps from the copy.
  const seen = new Map();
  const deduped = [];
  for (const c of contacts) {
    const key = `${(c.firstName||'').toLowerCase().trim()}|${(c.lastName||'').toLowerCase().trim()}|${(c.email||'').toLowerCase().trim()}`;
    if (!seen.has(key)) {
      seen.set(key, true);
      deduped.push(c);
    } else {
      const existing = deduped.find(x =>
        (x.firstName || '').toLowerCase().trim() === (c.firstName || '').toLowerCase().trim() &&
        (x.lastName || '').toLowerCase().trim() === (c.lastName || '').toLowerCase().trim() &&
        (x.email || '').toLowerCase().trim() === (c.email || '').toLowerCase().trim()
      );
      if (existing) {
        if (!existing.phone && c.phone) existing.phone = c.phone;
        if (!existing.mobile && c.mobile) existing.mobile = c.mobile;
        if (!existing.jobTitle && c.jobTitle) { existing.jobTitle = c.jobTitle; existing.title = c.jobTitle; }
        if (!existing.companyName && c.companyName) { existing.companyName = c.companyName; existing.company = c.companyName; }
      }
    }
  }
  // Parse AI Response flags companyNotStated only after every company source came up empty. The
  // notice is added here, last, so a company filled later (web research) never carries it.
  for (const c of deduped) {
    if (c.companyNotStated && !c.companyName) {
      c.infoNotes = c.infoNotes || [];
      if (!c.infoNotes.includes(COMPANY_NOTICE)) c.infoNotes.push(COMPANY_NOTICE);
    } else if (c.companyDomainOnly && !c.companyName) {
      c.infoNotes = c.infoNotes || [];
      c.infoNotes.push('Company name not written in email (only the domain ' + c.companyDomainOnly + ')');
    }
    delete c.companyNotStated; delete c.companyDomainOnly;
  }
  d.contacts = deduped;
  d.contactCount = deduped.length;
  results.push({ json: d });
}
return results;
