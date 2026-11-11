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
// around phone numbers, and duplicate contacts. Generic mailboxes (info@, test@)
// are flagged, not removed.
//
// Input: Merge Research Results items ({ contacts: [...] }).
// Output: the same items with cleaned contacts and an updated contactCount.

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

    // Phones: keep the number itself, dropping labels like "M ", "Tel: " or a trailing " office".
    for (const field of ['phone', 'mobile']) {
      if (cc[field]) {
        const match = cc[field].match(/[+(\d][\d\s.()\-+]+\d/);
        cc[field] = match ? match[0].trim() : cc[field];
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
  d.contacts = deduped;
  d.contactCount = deduped.length;
  results.push({ json: d });
}
return results;
