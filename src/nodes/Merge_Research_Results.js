// Merge Research Results
//
// Folds the research branch's findings back into each email's contacts. Research
// applies to the first Validate Contact Type item only; other items pass through
// with their own contacts.
// - Discovery: if the email body had no real contacts, the discovered ones replace
//   them; otherwise new people are added (deduped by email, then by full name).
//   Sub-page results fill gaps on matching people or are added as new contacts.
// - Supplement: fills empty fields on the first contact, and swaps a generic
//   mailbox (info@, sales@) for a personal address when research found one.
// Every value coming from research is validated first, because the model fills
// unknown fields with "hidden", "N/A", placeholder phones, or role mailboxes.
// Contacts are capped at 15 per email.
//
// Input: Validate Contact Type items, Parse Research Response, and (if it ran)
//        AI Extract Sub-Page.
// Output: one item per email: { contacts, contactCount, webResearchAttempted,
//         webResearchSucceeded, urlDiscoveryMode, pagesVisited, ...email metadata }

const GENERIC_EMAIL_PREFIXES = new Set(['info', 'sales', 'support', 'admin', 'contact', 'contacts',
  'hello', 'help', 'office', 'team', 'general', 'marketing', 'billing', 'service',
  'noreply', 'no-reply', 'donotreply', 'newsletter', 'notifications', 'mail', 'enquiries',
  'inquiries', 'reception', 'hr', 'jobs', 'careers', 'press', 'media', 'webmaster']);

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (email.length < 5 || !email.includes('@')) return false;
  // Placeholder words the model uses when it found nothing
  if (/^(hidden|redacted|n\/a|none|unknown|private|confidential|removed|withheld|example|test)/i.test(email)) return false;
  if (/[\(\)\[\]\{\}]/.test(email)) return false;
  // Role mailboxes are not a person
  const local = email.split('@')[0].toLowerCase();
  if (GENERIC_EMAIL_PREFIXES.has(local)) return false;
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

function isValidPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  // Placeholder numbers the model invents
  if (/^\(?123\)?|^555-|^\(?000\)?|^\(?111\)?/.test(phone)) return false;
  if (/hidden|redacted|n\/a|none|unknown/i.test(phone)) return false;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

function isValidField(value) {
  if (!value || typeof value !== 'string') return false;
  if (/^(hidden|redacted|n\/a|none|unknown|private|confidential|N\/A|\(hidden\))/i.test(value.trim())) return false;
  return value.trim().length > 0;
}

const allValidateItems = $('Validate Contact Type').all();
const allResults = [];

// Either node may not have run on this execution path
let researchData = null;
let subPageData = null;
try { researchData = $('Parse Research Response').first().json; } catch(e) {}
try { subPageData = $('AI Extract Sub-Page').first().json; } catch(e) {}

for (let _vIdx = 0; _vIdx < allValidateItems.length; _vIdx++) {
  const validateData = allValidateItems[_vIdx].json;
  if (validateData.skip) { allResults.push({ json: validateData }); continue; }

  const contacts = JSON.parse(JSON.stringify(validateData.contacts || []));
  const suggestedType = validateData.suggestedType || '';
  const applyResearch = (_vIdx === 0 && researchData);
  const isDiscovery = applyResearch ? (researchData?.isDiscoveryMode || false) : false;

  if (applyResearch && isDiscovery && researchData?.discoveredContacts?.length > 0) {
    const discovered = researchData.discoveredContacts;
    const bodyHasRealContacts = contacts.some(c => c.email || (c.firstName && c.lastName && c.confidence !== 'low'));
    if (!bodyHasRealContacts) {
      contacts.length = 0;
      discovered.forEach(d => {
        if (d.email && !isValidEmail(d.email)) d.email = '';
        if (d.phone && !isValidPhone(d.phone)) d.phone = '';
        contacts.push({ ...d, type: suggestedType || d.type || '', source: 'url_discovery' });
      });
    } else {
      const existingEmails = new Set(contacts.map(c => (c.email || '').toLowerCase()).filter(Boolean));
      discovered.forEach(d => {
        if (d.email && !isValidEmail(d.email)) d.email = '';
        if (d.phone && !isValidPhone(d.phone)) d.phone = '';
        const email = (d.email || '').toLowerCase();
        if (email && !existingEmails.has(email)) {
          contacts.push({ ...d, type: suggestedType || d.type || '', source: 'url_discovery' });
          existingEmails.add(email);
        } else if (!email && d.firstName && d.lastName) {
          const nameExists = contacts.some(c => c.firstName?.toLowerCase() === d.firstName?.toLowerCase() && c.lastName?.toLowerCase() === d.lastName?.toLowerCase());
          if (!nameExists) contacts.push({ ...d, type: suggestedType || d.type || '', source: 'url_discovery' });
        }
      });
    }
    if (subPageData) {
      let subContacts = [];
      try { const subRaw = subPageData.data || ''; const jsonMatch = subRaw.match(/\{[\s\S]*\}/); if (jsonMatch) { const p = JSON.parse(jsonMatch[0]); subContacts = p.contacts || [p]; } } catch(e) {}
      for (const sub of subContacts) {
        if (sub.email && !isValidEmail(sub.email)) sub.email = '';
        if (sub.phone && !isValidPhone(sub.phone)) sub.phone = '';
        const match = contacts.find(c => c.firstName?.toLowerCase() === (sub.firstName || '').toLowerCase() && c.lastName?.toLowerCase() === (sub.lastName || '').toLowerCase());
        if (match) { if (sub.email && !match.email) match.email = sub.email; if (sub.phone && !match.phone) match.phone = sub.phone; if (sub.title && !match.title) match.title = sub.title; match.confidence = 'high'; }
        else if (sub.email || (sub.firstName && sub.lastName)) { contacts.push({ ...sub, type: suggestedType || sub.type || '', source: 'url_discovery_subpage' }); }
      }
    }
  } else if (applyResearch && researchData && !isDiscovery) {
    // Supplement: only fields that pass validation are merged
    const research = researchData.research || researchData.researchData || {};
    if (contacts.length > 0) {
      const c = contacts[0];
      // A personal address found on the web beats a generic mailbox from the email
      if (research.email && isValidEmail(research.email)) {
        if (!c.email || c.isGenericEmail) {
          const researchLocal = research.email.split('@')[0].toLowerCase();
          const isResearchGeneric = GENERIC_EMAIL_PREFIXES.has(researchLocal);
          if (!isResearchGeneric) {
            c.infoNotes = c.infoNotes || [];
            if (c.email) c.infoNotes.push('Upgraded from generic email (' + c.email + ') to personal: ' + research.email);
            c.email = research.email;
            c.isGenericEmail = false;
          }
        }
      }
      if (research.phone && !c.phone && isValidPhone(research.phone)) c.phone = research.phone;
      if (research.title && !c.title && isValidField(research.title)) c.title = research.title;
      if (research.companyName && !c.companyName && isValidField(research.companyName)) c.companyName = research.companyName;
      if (research.website && !c.website && isValidField(research.website)) c.website = research.website;
      if (c.country && !isValidField(c.country)) c.country = '';
      if (research.email || research.phone) c.confidence = 'high';
    }
    if (subPageData) {
      try { const subRaw = subPageData.data || ''; const jsonMatch = subRaw.match(/\{[\s\S]*\}/); if (jsonMatch) { const r = JSON.parse(jsonMatch[0]); if (contacts.length > 0) { const c = contacts[0]; if (r.email && !c.email && isValidEmail(r.email)) c.email = r.email; if (r.phone && !c.phone && isValidPhone(r.phone)) c.phone = r.phone; if (r.title && !c.title && isValidField(r.title)) c.title = r.title; } } } catch(e) {}
    }
  }

  // Final pass: clear any placeholder values still on any contact
  for (const c of contacts) {
    if (c.country && !isValidField(c.country)) c.country = '';
    if (c.email && !isValidEmail(c.email)) c.email = '';
    if (c.phone && !isValidPhone(c.phone)) c.phone = '';
    if (c.mobile && !isValidPhone(c.mobile)) c.mobile = '';
  }

  const prevData = $input.all()[Math.min(_vIdx, $input.all().length - 1)]?.json || {};
  const emailParserData = {};
  const fieldsToPass = ['originalSubject','forwarderInstruction','email_id','thread_id','received_date','forwarderEmail','detectionFlags','extractionStrategy','needsReview','reviewReason','infoNotes','primaryUrl','suggestedType','hasAttachments','attachmentHints','listIssues'];
  for (const f of fieldsToPass) { emailParserData[f] = prevData[f] ?? validateData[f] ?? ''; }

  const MAX_CONTACTS = contacts.some(c => c.extractionMethod === 'LIST_PARSE') ? 100 : 15; // a typed list may hold up to 100 people
  let cappedContacts = contacts.length > MAX_CONTACTS ? contacts.slice(0, MAX_CONTACTS) : contacts;
  allResults.push({ json: { ...emailParserData, contacts: cappedContacts, contactCount: cappedContacts.length, webResearchAttempted: !!applyResearch, webResearchSucceeded: isDiscovery ? (researchData?.discoveredContacts?.length > 0) : (applyResearch ? (researchData?.researchFound || false) : false), urlDiscoveryMode: isDiscovery, pagesVisited: applyResearch ? [researchData?.discoveryUrl, subPageData ? 'sub-page' : null].filter(Boolean).length : 0 }});
}
return allResults;
