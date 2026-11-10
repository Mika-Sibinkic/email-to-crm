// Stage 2b: Parse Identity Resolver Response
//
// Turns the identity resolver's reply into contact records for Stage 3.
//
// Input: Ollama response + passthrough
// Output: { contacts: [...], contactCount, ...passthrough }

const input = $input.first().json;

// Handle no-fragments pass-through
if (input.stage === 'NO_FRAGMENTS') {
  return [{
    json: {
      ...input,
      contacts: [],
      contactCount: 0,
      extractionStrategy: 'MULTI_STAGE_V4',
    }
  }];
}

// Parse Ollama response
const ollamaResponse = input.message?.content || input.response || '';
let contacts = [];

try {
  let parsed = JSON.parse(ollamaResponse);
  // Handle all possible formats from the AI:
  // 1. {"contacts": [...]} - preferred wrapper format
  // 2. [...] - bare array
  // 3. {"firstName": ...} - single object (model ignored array instruction)
  // 4. {"contacts": {"firstName": ...}} - wrapper with single object instead of array
  if (parsed && Array.isArray(parsed.contacts)) {
    contacts = parsed.contacts;
  } else if (parsed && parsed.contacts && typeof parsed.contacts === 'object' && !Array.isArray(parsed.contacts)) {
    // Single contact wrapped as {"contacts": {firstName:...}}
    contacts = [parsed.contacts];
  } else if (Array.isArray(parsed)) {
    contacts = parsed;
  } else if (parsed && typeof parsed === 'object' && parsed.firstName) {
    contacts = [parsed];
  }
} catch (e) {
  // Try markdown code block extraction
  const jsonMatch = ollamaResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      contacts = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e2) { /* continue */ }
  }

  // Last resort: find array
  if (contacts.length === 0) {
    const arrayMatch = ollamaResponse.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        contacts = JSON.parse(arrayMatch[0]);
      } catch (e3) { /* give up */ }
    }
  }
}

// Post-processing sanity checks

// Filter out any internal contacts that slipped through
const internalDomains = ['yourcompany.com', 'example-consultancy.com'];
// Populate with the firm's own staff so their signatures are never extracted as contacts.
const internalNames = ['alex example', 'pat example', 'taylor example', 'morgan example',
  'casey example', 'robin example', 'lee example', 'jordan'];

contacts = contacts.filter(c => {
  const email = (c.email || '').toLowerCase();
  const name = `${(c.firstName || '')} ${(c.lastName || '')}`.toLowerCase().trim();

  // Filter by domain
  for (const domain of internalDomains) {
    if (email.endsWith('@' + domain)) return false;
  }

  // Filter by name
  for (const intName of internalNames) {
    if (name === intName) return false;
  }

  return true;
});

// Filter out generic/fake emails
const genericPrefixes = ['example', 'test', 'fraud', 'noreply', 'no-reply', 'admin',
  'support', 'sales', 'contact', 'webmaster', 'info', 'postmaster', 'abuse'];
const fakeDomains = ['example.com', 'example.org', 'example.net', 'test.com', 'fake.com',
  'placeholder.com', 'sample.com', 'foo.com', 'bar.com'];
const fakeNames = ['john doe', 'jane doe', 'jane smith', 'bob johnson', 'test user',
  'sample contact', 'example user', 'first last', 'abc corporation'];

contacts = contacts.filter(c => {
  const email = (c.email || '').toLowerCase();
  const fullName = `${(c.firstName || '')} ${(c.lastName || '')}`.toLowerCase().trim();

  // Filter by fake/placeholder names
  if (fakeNames.includes(fullName)) return false;

  // Filter by fake domains
  if (email) {
    const domain = email.split('@')[1];
    if (fakeDomains.includes(domain)) return false;
    const localPart = email.split('@')[0];
    if (genericPrefixes.includes(localPart)) return false;
  }

  return true;
});

// Ensure no name-in-title or name-in-company contamination
for (const c of contacts) {
  const fullName = `${(c.firstName || '')} ${(c.lastName || '')}`.trim().toLowerCase();

  // Clean title: strip the contact's own name if it appears
  if (c.title) {
    let title = c.title;
    // Handle "Name | Title | Dept | Division" pipe-separated patterns
    if (title.includes('|')) {
      const parts = title.split('|').map(p => p.trim()).filter(p => p.length > 0);
      // Filter out parts that ARE the contact's name (exact or partial match)
      const lastName = (c.lastName || '').toLowerCase();
      const titleKW = /\b(?:officer|director|president|manager|chief|head|lead|senior|junior|vice|vp|svp|evp|ceo|cfo|cto|coo|partner|counsel|advisor|analyst|specialist|coordinator|engineer|architect|consultant|associate|assistant)\b/i;
      const nonNameParts = parts.filter(p => {
        const pLower = p.toLowerCase();
        // If it contains a title keyword, it's NOT a name - keep it
        if (titleKW.test(pLower)) return true;
        // If it matches the contact's name, it IS the name - filter it out
        return pLower !== fullName &&
               pLower !== (c.firstName || '').toLowerCase() &&
               !(lastName.length >= 3 && pLower.includes(lastName) && pLower.split(/\s+/).length <= 3);
      });
      if (nonNameParts.length > 0) {
        // First non-name part is the title (format: Name | Title | Dept | Company)
        title = nonNameParts[0];
        // If company is empty and there are more parts, use last as company hint
        if (!c.company && nonNameParts.length > 1) {
          c.company = nonNameParts[nonNameParts.length - 1];
        }
      }
    }
    // Strip leading name if present (non-pipe format: "John Smith CEO")
    if (title.toLowerCase().startsWith(fullName)) {
      title = title.substring(fullName.length).replace(/^[\s,|:\-]+/, '').trim();
    }
    c.title = title;
  }

  // Clean company: if it equals the title, derive from email domain instead
  if (c.company && c.title && c.company.toLowerCase() === c.title.toLowerCase()) {
    if (c.email) {
      const domain = c.email.split('@')[1];
      if (domain) {
        const companyFromDomain = domain.split('.')[0]
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, l => l.toUpperCase());
        c.company = companyFromDomain;
        c._companyDerived = true;
      }
    } else {
      c.company = ''; // Clear it - better empty than wrong
    }
  }

  // If company is missing entirely, try domain derivation
  if (!c.company && c.email) {
    const domain = c.email.split('@')[1];
    if (domain && !internalDomains.includes(domain)) {
      const companyFromDomain = domain.split('.')[0]
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, l => l.toUpperCase());
      c.company = companyFromDomain;
      c._companyDerived = true;
    }
  }

  // If phone === mobile, clear mobile (don't duplicate)
  if (c.phone && c.mobile && c.phone.replace(/\D/g, '') === c.mobile.replace(/\D/g, '')) {
    c.mobile = '';
  }
}

// Build output

// Strip internal fields from passthrough
const output = {
  contacts,
  contactCount: contacts.length,
  extractionStrategy: 'MULTI_STAGE_V4',
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
  stage: 'IDENTITY_RESOLVED',
};

return [{ json: output }];
