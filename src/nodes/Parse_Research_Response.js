// Parse Research Response
//
// Turns the local model's reply about the fetched page into the shape Merge Research
// Results reads: discoveredContacts (discovery mode) or research (supplement mode).
// A small model often returns slightly broken JSON, so a repair pass runs before
// giving up, and a full name crammed into firstName is split back out. Large fields
// (page HTML, the request body) are dropped from the output.
//
// Input: the Ollama response (/api/generate or /api/chat shape), plus Prepare
//        Research Request's item.
// Output: { discoveredContacts, contacts, researchFound, isDiscoveryMode,
//           needsFollowUp, followUrl, ... } or { research, researchFound, ... },
//         or researchFound: false with an error or parseError flag.

const resInput = $input.first().json;

// Ollama answers { response } on /api/generate and { message: { content } } on /api/chat.
const hasGenerateResponse = !!resInput.response;
const hasChatResponse = !!(resInput.message && resInput.message.content);

if (resInput.error || resInput.statusCode >= 400 || (!hasGenerateResponse && !hasChatResponse)) {
  let prepData = {};
  try { prepData = $('Prepare Research Request').first().json || {}; } catch (e) {
    try { prepData = $('Prepare Research Request').first().json || {}; } catch (e2) { prepData = {}; }
  }
  return [{ json: {
    ...prepData,
    // Drop large fields
    requestBody: undefined, pageHtml: undefined, data: undefined,
    discoveredContacts: [],
    researchResult: { error: 'AI_FAILURE', message: resInput.error || 'Research AI unavailable' },
    researchFound: false,
    needsFollowUp: false,
    isDiscoveryMode: prepData.isDiscoveryMode || false
  }}];
}

const rawResponse = resInput.response || (resInput.message && resInput.message.content) || '';

const validateData = $('Validate Contact Type').first().json;

let prepData = {};
try { prepData = $('Prepare Research Request').first().json || {}; } catch (e) {
  try { prepData = $('Prepare Research Request').first().json || {}; } catch (e2) { prepData = {}; }
}

const isDiscovery = prepData.isDiscoveryMode ||
  (prepData.extractionStrategy === 'URL_DISCOVERY') ||
  (validateData.extractionStrategy === 'URL_DISCOVERY') ||
  false;

const suggestedType = prepData.suggestedType || validateData.suggestedType || '';
const discoveryUrl = prepData.discoveryUrl || prepData.researchUrl || '';

// The model sometimes refuses to "share personal information" even for public pages.
function isResearchRefusal(text) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase().trim();
  const refusalPatterns = [
    /i (?:cannot|can't|can not|won't|will not) (?:provide|share|give|extract|help|assist)/,
    /i'm (?:not able|unable) to (?:provide|share|help|assist|extract)/,
    /(?:sorry|apologies),?\s+(?:but\s+)?i (?:cannot|can't|won't)/,
    /(?:personal|private|sensitive) (?:contact )?information/,
    /is there anything else i can help/
  ];
  for (const pattern of refusalPatterns) {
    if (pattern.test(lower)) return true;
  }
  // Short prose with no JSON at all is a refusal in practice
  if (!lower.includes('{') && !lower.includes('[') && lower.length < 200) {
    return true;
  }
  return false;
}

if (isResearchRefusal(rawResponse)) {
  return [{ json: {
    ...prepData,
    requestBody: undefined, pageHtml: undefined, data: undefined,
    discoveredContacts: [],
    researchResult: { error: 'AI_REFUSAL', message: rawResponse.substring(0, 200) },
    researchFound: false,
    needsFollowUp: false,
    isDiscoveryMode: isDiscovery,
    aiRefused: true
  }}];
}

// Fix the JSON mistakes small models commonly make, so one quirk does not lose the page.
function repairJson(str) {
  if (!str) return str;
  let fixed = str;

  // "key:""value"" -> "key":"value" (colon inside the key, doubled quotes)
  fixed = fixed.replace(/"(\w+):""([^"]*)""/g, '"$1":"$2"');

  // Same with a space: "key:" "value"
  fixed = fixed.replace(/"(\w+):"\s+"([^"]*)"/g, '"$1":"$2"');

  // Trailing commas before } or ]
  fixed = fixed.replace(/,\s*([}\]])/g, '$1');

  // All-single-quote JSON. Only when there are no double quotes, so apostrophes survive.
  if (!fixed.includes('"') && fixed.includes("'")) {
    fixed = fixed.replace(/'/g, '"');
  }

  // Missing commas between objects in an array: }{ -> },{
  fixed = fixed.replace(/\}\s*\{/g, '},{');

  return fixed;
}

let parsed = null;
let jsonRepaired = false;
try {
  let jsonStr = rawResponse.trim();
  jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    let candidate = jsonMatch[0];
    try {
      parsed = JSON.parse(candidate);
    } catch (e1) {
      const repaired = repairJson(candidate);
      try {
        parsed = JSON.parse(repaired);
        jsonRepaired = true;
      } catch (e2) {
        // Last resort: salvage just the contacts array
        const arrayMatch = rawResponse.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
          try {
            const repairedArray = repairJson(arrayMatch[0]);
            const arr = JSON.parse(repairedArray);
            if (Array.isArray(arr) && arr.length > 0) {
              parsed = { discoveredContacts: arr, subPageLinks: [], pageType: 'unknown' };
              jsonRepaired = true;
            }
          } catch (e3) { /* all attempts failed */ }
        }
      }
    }
  }
} catch(e) { /* parse failed */ }

// Carry only the lightweight pipeline fields forward
const baseOutput = {};
const fieldsToKeep = [
  'extractionStrategy', 'isDiscoveryMode', 'forceDiscovery', 'discoveryTrigger',
  'discoveryUrl', 'researchUrl', 'forwarderInstruction', 'suggestedType',
  'originalSubject', 'forwarderEmail', 'email_id', 'contacts', 'allUrls',
  'htmlStats', 'urlSource'
];
for (const key of fieldsToKeep) {
  if (prepData[key] !== undefined) baseOutput[key] = prepData[key];
}

// Small models sometimes put the full name in firstName and repeat the surname in
// lastName: "Pat Example" + "Example" -> "Pat" + "Example".
function repairName(contact) {
  const fn = (contact.firstName || '').trim();
  const ln = (contact.lastName || '').trim();
  if (fn.includes(' ') && ln) {
    const parts = fn.split(/\s+/);
    const lastPart = parts[parts.length - 1].toLowerCase();
    if (lastPart === ln.toLowerCase()) {
      return { firstName: parts.slice(0, -1).join(' '), lastName: ln };
    }
    // Multi-word firstName with a separate lastName: keep only the first word
    if (parts.length >= 2) {
      return { firstName: parts[0], lastName: ln || parts[parts.length - 1] };
    }
  }
  return { firstName: fn, lastName: ln };
}

if (isDiscovery && parsed) {
  // Discovery
  const rawDiscovered = parsed.discoveredContacts || [];
  const subLinks = (parsed.subPageLinks || []).slice(0, 5);

  const discoveredContacts = rawDiscovered
    .filter(c => c.firstName || c.lastName || c.email)
    .slice(0, 15)
    .map(c => {
      const { firstName, lastName } = repairName(c);
      const email = (c.email || '').trim().toLowerCase();
      const phone = (c.phone || '').trim();
      const jobTitleRaw = (c.title || c.jobTitle || '').trim();
      const companyNameRaw = (c.companyName || c.company || '').trim();
      const website = (c.website || discoveryUrl || '').trim();
      const confidence = c.confidence || 'medium';

      return {
        // Pipeline-standard names (what Prepare Upsert reads)
        firstName, lastName, email, phone,
        mobile: '',
        jobTitle: jobTitleRaw,
        companyName: companyNameRaw,
        city: '', state: '', address: '', country: '',
        type: suggestedType || c.type || '',
        specificType: '',
        confidence: confidence,
        website: website,
        // Older names, still read by Merge Research Results
        title: jobTitleRaw,
        company: companyNameRaw,
        source: c.source || 'team_page',
        discoveredFrom: discoveryUrl,
        verifiedFields: [
          ...(firstName ? ['firstName'] : []),
          ...(lastName ? ['lastName'] : []),
          ...(email ? ['email'] : []),
          ...(phone ? ['phone'] : []),
          ...(jobTitleRaw ? ['jobTitle'] : []),
          ...(companyNameRaw ? ['companyName'] : [])
        ],
        unverifiedFields: [],
        clearedFields: [],
        verificationScore: 100, // came straight from the web page
        skipZohoUpsert: false,
        infoNotes: ['Discovered via web research from ' + (parsed.pageType || 'team page')]
      };
    });

  const needsFollowUp = discoveredContacts.some(c => !c.email && !c.phone) && subLinks.length > 0;

  return [{ json: {
    ...baseOutput,
    discoveredContacts: discoveredContacts,
    // Same list under the pipeline-standard name
    contacts: discoveredContacts,
    contactCount: discoveredContacts.length,
    researchFound: discoveredContacts.length > 0,
    isDiscoveryMode: true,
    needsFollowUp: needsFollowUp,
    followUrl: needsFollowUp ? subLinks[0].url : '',
    subPageLinks: subLinks,
    discoveryPageType: parsed.pageType || 'unknown',
    totalPeopleFound: parsed.totalPeopleFound || discoveredContacts.length,
    jsonRepaired: jsonRepaired
  }}];

} else if (!isDiscovery && parsed) {
  // Supplement
  const result = parsed;
  const hasData = !!(result.email || result.phone || result.title || result.companyName);

  const research = {
    email: (result.email || '').trim().toLowerCase(),
    phone: (result.phone || '').trim(),
    title: (result.title || result.jobTitle || '').trim(),
    jobTitle: (result.title || result.jobTitle || '').trim(),
    companyName: (result.companyName || result.company || '').trim(),
    website: (result.website || discoveryUrl || '').trim(),
    confidence: result.confidence || 'medium',
    firstName: (result.firstName || '').trim(),
    lastName: (result.lastName || '').trim()
  };

  return [{ json: {
    ...baseOutput,
    research: research,
    researchData: research, // alias some Merge Research Results versions read
    researchResult: research,
    researchFound: hasData,
    isDiscoveryMode: false,
    needsFollowUp: !!(result.followUrl),
    followUrl: result.followUrl || '',
    discoveredContacts: []
  }}];

} else {
  // Parse failed
  return [{ json: {
    ...baseOutput,
    discoveredContacts: [],
    research: {},
    researchFound: false,
    isDiscoveryMode: isDiscovery,
    needsFollowUp: false,
    parseError: true,
    rawResponsePreview: rawResponse.substring(0, 500)
  }}];
}
