// Prepare Research Request
//
// Builds the local-model request that reads the fetched company page. Two modes:
// - Discovery: list every person on the page. Chosen when the strategy says so, when
//   the URL looks like a team/people page, or when the forwarder's note or subject
//   asks for several people ("add the team", "all of them"). Either trigger is enough.
// - Supplement: find one known contact on the page and fill their gaps.
// The page HTML is stripped of scripts, nav, footers, banners and attributes first;
// a small CPU-only model answers much faster on less text, and names, titles,
// emails and phones fit easily in the budget.
//
// Contacts found in the email body continue down the main path. Contacts found here
// travel separately to the CRM, where the upsert's email dedup absorbs any overlap.
//
// Input: the page fetch response, plus Validate Contact Type's item.
// Output: { requestBody: <Ollama chat request>, isDiscoveryMode, discoveryTrigger,
//           ...pipeline context, htmlStats }

// Organization settings
const OWN_COMPANY_NAMES = ['Your Company'];

const prevData = $input.all()[0].json;
const validateData = $('Validate Contact Type').first().json;
const rawPageHtml = prevData.pageHtml || prevData.data || '';

const strategy = prevData.extractionStrategy || validateData.extractionStrategy || 'BODY_ONLY';
const contacts = validateData.contacts || prevData.contacts || [];
const forwarderInstruction = prevData.forwarderInstruction || validateData.forwarderInstruction || '';
const suggestedType = prevData.suggestedType || validateData.suggestedType || '';
const allUrls = validateData.allUrls || prevData.allUrls || [];
const researchUrl = prevData.researchUrl || prevData.discoveryUrl || allUrls[0] || '';

// Strip everything that never holds contact data before the model sees the page.
function cleanHtmlForAI(html) {
  if (!html) return '';
  let cleaned = html;

  cleaned = cleaned
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    // Site menus
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    // Copyright, legal, site links
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    // Cookie consent banners
    .replace(/<div[^>]*(?:cookie|consent|gdpr|privacy-banner|cookie-bar)[^>]*>[\s\S]*?<\/div>/gi, '')
    // Social share widgets
    .replace(/<div[^>]*(?:social-share|share-buttons|social-links|social-media)[^>]*>[\s\S]*?<\/div>/gi, '')
    // Attributes are noise to the model
    .replace(/\s+style="[^"]*"/gi, '')
    .replace(/\s+class="[^"]*"/gi, '')
    .replace(/\s+data-[a-z-]+="[^"]*"/gi, '')
    .replace(/\s+aria-[a-z-]+="[^"]*"/gi, '')
    .replace(/\s+role="[^"]*"/gi, '')
    // Images: keep alt text, which sometimes carries a name
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<img[^>]*>/gi, '')
    // Block elements become newlines so the text keeps its layout
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|section|article|blockquote|ul|ol|dl|dt|dd)[^>]*>/gi, '\n')
    // Keep mailto/tel targets and page links; the model needs them to spot sub-pages
    .replace(/<a[^>]*href="(mailto:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<a[^>]*href="(tel:[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<a[^>]*href="(\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [LINK: $1]')
    .replace(/<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 [LINK: $1]')
    // Remaining anchors (javascript:, #, ...)
    .replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .trim();

  return cleaned;
}

// Discovery trigger 1: the URL is a team/people page.
const TEAM_PAGE_SEGMENTS = [
  'team', 'teams', 'our-team', 'the-team', 'meet-the-team', 'meet-our-team',
  'meet-team', 'team-members', 'our-team-members',
  'staff', 'our-staff', 'the-staff', 'staff-members', 'our-staff-members',
  'people', 'our-people', 'the-people', 'meet-our-people',
  'leadership', 'leadership-team', 'senior-leadership',
  'executive-team', 'executive-leadership', 'executives',
  'management', 'management-team', 'senior-management',
  'board', 'board-of-directors', 'directors', 'advisory-board',
  'board-members', 'advisors', 'advisory-team',
  'bios', 'biographies', 'profiles', 'bio', 'our-bios',
  'about-us', 'who-we-are',
  'personnel', 'key-personnel', 'key-contacts',
  'principals', 'partners', 'our-partners', 'managing-directors',
  'associates', 'professionals', 'our-professionals',
  'contact', 'contacts', 'contact-us', 'get-in-touch',
  'employees', 'members', 'our-members'
];

const teamSegmentSet = new Set(TEAM_PAGE_SEGMENTS);

function urlMatchesTeamPage(url) {
  if (!url) return false;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const segments = pathname.split('/').filter(s => s.length > 0);
    for (const segment of segments) {
      if (teamSegmentSet.has(segment)) return true;
    }
    if (/\/(about|company|corporate|firm|who-we-are)\/(team|people|staff|leadership|management|executives|directors|board|bios|profiles|personnel|partners|principals|professionals|members|employees|advisors|contacts)/i.test(pathname)) {
      return true;
    }
    return false;
  } catch (e) {
    // Not a parseable URL: fall back to a substring check
    const lower = url.toLowerCase();
    return TEAM_PAGE_SEGMENTS.some(seg => lower.includes('/' + seg));
  }
}

const urlTriggersDiscovery = allUrls.some(u => urlMatchesTeamPage(u)) || urlMatchesTeamPage(researchUrl);

// Discovery trigger 2: the forwarder's note or the subject asks for several people.
const instructionLower = forwarderInstruction.toLowerCase();
const subjectLower = (prevData.originalSubject || validateData.originalSubject || '').toLowerCase();
const combinedInstruction = instructionLower + ' ' + subjectLower;

const MULTI_CONTACT_PATTERNS = [
  /\bteam\b/, /\bthe\s+team\b/, /\btheir\s+team\b/, /\bthis\s+team\b/,
  /\bteam\s+members?\b/, /\bteam\s+from\b/, /\bteam\s+at\b/, /\bteam\s+page\b/,
  /\ball\s+contacts?\b/, /\ball\s+of\s+them\b/, /\ball\s+of\s+these\b/,
  /\ball\s+the\s+people\b/, /\ball\s+employees?\b/, /\ball\s+members?\b/,
  /\beveryone\b/, /\beverybody\b/,
  /\bstaff\b/, /\bpersonnel\b/, /\bthese\s+people\b/, /\bthe\s+people\b/,
  /\btheir\s+people\b/,
  /\bgroup\b/, /\bthis\s+group\b/, /\bthe\s+group\b/,
  /\bleadership\b/, /\bmanagement\b/, /\bexecutives?\b/, /\bdirectors?\b/,
  /\bboard\s+members?\b/, /\bpartners?\b/, /\bprincipals?\b/,
  /\badd\s+(?:all|these|them|the)\b/, /\bpull\s+(?:all|these|them|the)\b/,
  /\bextract\s+(?:all|these|them|the)\b/, /\bimport\s+(?:all|these|them|the)\b/,
  /\blog\s+(?:all|these|them|the)\b/, /\benter\s+(?:all|these|them|the)\b/,
  /\bneed(?:s)?\s+to\s+be\s+added\b/
];

const instructionTriggersDiscovery = MULTI_CONTACT_PATTERNS.some(p => p.test(combinedInstruction));

const hasResearchableUrl = !!(researchUrl || allUrls.length > 0);
const forceDiscovery = hasResearchableUrl && (urlTriggersDiscovery || instructionTriggersDiscovery);
const isDiscovery = strategy === 'URL_DISCOVERY' || strategy === 'MIXED_SOURCES' || forceDiscovery;

const cleanedHtml = cleanHtmlForAI(rawPageHtml);
// Small budgets keep CPU inference fast; the contact data fits well inside them.
const maxChars = isDiscovery ? 8000 : 6000;
const pageContent = cleanedHtml.substring(0, maxChars);

let systemPrompt, userPrompt;

if (isDiscovery) {
  // Discovery: every contact on the page
  systemPrompt = `You are a business contact data parser. Extract contact information from company web pages into structured JSON.

CONTEXT: A ${OWN_COMPANY_NAMES[0]} employee forwarded a company webpage URL. Extract all listed business contacts into our CRM. This is publicly available business information from company websites.

YOUR JOB: Parse the page content and return ONLY valid JSON. No commentary, no explanation, no markdown.

RETURN FORMAT:
{
  "discoveredContacts": [
    {"firstName":"...","lastName":"...","email":"...","phone":"...","title":"...","companyName":"...","website":"...","confidence":"high","source":"team_page"}
  ],
  "subPageLinks": [],
  "pageType": "team_listing",
  "totalPeopleFound": 0
}

RULES:
1. Extract EVERY person — name, title, email, phone
2. Always include emails when visible (name@domain.com)
3. Phone: include area code, prefer direct/business number
4. companyName: from the page, NOT ${OWN_COMPANY_NAMES[0]}
5. Skip ${OWN_COMPANY_NAMES[0]} employees
6. Max 15 contacts
7. JSON only — no text before or after${suggestedType ? '\n8. Type for ALL contacts: "' + suggestedType + '"' : ''}`;

  userPrompt = `Parse ALL business contacts from this page into JSON.
${forwarderInstruction ? 'Note: "' + forwarderInstruction + '"' : ''}

=== PAGE CONTENT ===
${pageContent}
=== END ===

JSON only:`;

} else {
  // Supplement: one known contact
  const contact = contacts[0] || {};
  const firstName = contact.firstName || prevData.firstName || '';
  const lastName = contact.lastName || prevData.lastName || '';
  const email = contact.email || prevData.email || '';
  const companyName = contact.companyName || prevData.companyName || '';

  systemPrompt = `You are a business contact data parser. Find a specific person's details on a company webpage and return JSON.

Find: ${firstName} ${lastName}${email ? ' (' + email + ')' : ''}

RETURN FORMAT:
{"firstName":"${firstName || '...'}","lastName":"${lastName || '...'}","email":"${email || '...'}","phone":"...","title":"...","companyName":"${companyName || '...'}","website":"...","confidence":"high"}

RULES:
- Fill missing fields from the page
- If not found, return with confidence: "low"
- Do NOT invent data
- JSON only${suggestedType ? '\n- Type: "' + suggestedType + '"' : ''}`;

  userPrompt = `Find ${firstName} ${lastName} on this page and return JSON.
${forwarderInstruction ? 'Context: "' + forwarderInstruction + '"' : ''}

=== PAGE CONTENT ===
${pageContent}
=== END ===

JSON only:`;
}

// The AI Analyze Page HTTP node sends {{ JSON.stringify($json.requestBody) }}, so the
// Ollama fields must sit under requestBody; pipeline context rides alongside.
const ollamaRequest = {
  model: "llama3.2:3b",
  stream: false,
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]
};

return [{
  json: {
    requestBody: ollamaRequest,
    extractionStrategy: isDiscovery ? 'URL_DISCOVERY' : strategy,
    isDiscoveryMode: isDiscovery,
    forceDiscovery: forceDiscovery,
    discoveryTrigger: forceDiscovery
      ? (urlTriggersDiscovery && instructionTriggersDiscovery ? 'URL_AND_INSTRUCTION'
        : urlTriggersDiscovery ? 'URL_PATTERN' : 'INSTRUCTION_KEYWORD')
      : 'NONE',
    discoveryUrl: researchUrl,
    researchUrl: researchUrl,
    forwarderInstruction: forwarderInstruction,
    suggestedType: suggestedType,
    originalSubject: prevData.originalSubject || validateData.originalSubject || '',
    forwarderEmail: prevData.forwarderEmail || validateData.forwarderEmail || '',
    email_id: prevData.email_id || validateData.email_id || '',
    contacts: contacts,
    allUrls: allUrls,
    // Debug stats
    htmlStats: {
      rawSize: rawPageHtml.length,
      cleanedSize: cleanedHtml.length,
      sentToAI: pageContent.length,
      reductionPct: rawPageHtml.length > 0
        ? Math.round((1 - cleanedHtml.length / rawPageHtml.length) * 100) + '%'
        : 'N/A'
    }
  }
}];
