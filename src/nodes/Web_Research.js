// Web Research
//
// First pass of web research for contacts that came out of the email incomplete.
// Runs only when Parse AI Response set needsWebResearch; otherwise passes items
// through. Two modes:
// - Discovery: no contacts, or only personal-domain ones. Scrape the URLs from the
//   email and pull every person off the page (structured text parser first, then the
//   local model, then a strict-prompt retry, then a regex email fallback).
// - Enrichment: known contacts with missing fields. Search, scrape, and ask the
//   local model for just the missing fields of the first contact.
// Every value found on the web is re-checked against the scraped page text, so a
// model guess never reaches the CRM. Stub contacts (company but no email) get
// candidate domains from the company name and, as a last resort, inferred email
// patterns that are flagged as unverified.
//
// Input: one item per email, from Parse AI Response (or the PDF branch).
// Output: the same item with contacts enriched or replaced, plus researchLog,
// pagesVisited, and partialFindings when a page had names but no emails.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
// Last 10 digits of your own numbers, so a scraped page never hands them back as a contact's phone.
const OWN_PHONES = new Set(['5550100100', '5550100101', '5550100102']);

// Process every item; an email can arrive alongside others in one batch.
const allItems = $input.all();
const allResults = [];

for (const _item of allItems) {
const input = _item.json;

// No research requested: forward unchanged.
if (!input.needsWebResearch) {
  allResults.push({ json: { ...input, webResearchAttempted: false } });
  continue;
}

function isOwnCompanyPhone(phoneStr) {
  if (!phoneStr) return false;
  const digits = phoneStr.replace(/\D/g, '');
  const last10 = digits.length > 10 ? digits.slice(-10) : digits;
  return OWN_PHONES.has(last10);
}

// Discovery mode when there is nobody to enrich: no contacts, or only personal-domain ones.
const contacts = input.contacts || [];
const PERSONAL_DOMAINS = new Set(['gmail.com','yahoo.com','hotmail.com','outlook.com',
  'aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com','mail.com',
  'zoho.com','yandex.com','gmx.com','comcast.net','att.net','verizon.net']);

const hasOnlyPersonalContacts = contacts.length > 0 && contacts.every(c => {
  const cEmail = (c.email || '').toLowerCase();
  if (!cEmail) return true;
  const cDomain = cEmail.split('@')[1] || '';
  return PERSONAL_DOMAINS.has(cDomain);
});

const discoveryMode = contacts.length === 0 || hasOnlyPersonalContacts;

// Check for stub contacts that have company names we can derive domains from
const hasStubContacts = contacts.some(c => c.extractionMethod === 'STUB_FROM_FRAGMENTS' || c.needsWebResearch);

// No contacts and no URLs to scrape: nothing to research.
if (contacts.length === 0 && (!input.allUrls || input.allUrls.length === 0) && !input.primaryUrl) {
  allResults.push({ json: { ...input, webResearchAttempted: true, webResearchSucceeded: false, webResearchReason: 'No contacts and no URLs to scrape' } }); continue;
}

// Strip HTML to plain text.
function htmlToText(html) {
  if (!html) return '';
  let text = html
    // Remove script and style blocks entirely
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    // Convert common block elements to newlines
    .replace(/<\/?(div|p|br|h[1-6]|li|tr|td|th|section|article|header|footer|nav|blockquote)[^>]*>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, ' ')
    // Decode common HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
    // Collapse whitespace
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
  return text;
}

// Guess candidate domains from a company name, for stubs that have a company but no email.
// "Acme Widgets Limited" -> ['acmewidgets.com', 'acme.com', 'acme-widgets.com']
function companyToDomains(company) {
  if (!company) return [];
  const SUFFIXES = /\b(ltd|limited|llc|inc|incorporated|corp|corporation|co|company|group|international|plc|sa|gmbh|ag|pty|pvt)\b\.?/gi;
  const cleaned = company.replace(SUFFIXES, '').replace(/[.,&'"-]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!cleaned || cleaned.length < 2) return [];

  const words = cleaned.split(/\s+/);
  const domains = [];

  // All words joined: "acme widgets" -> "acmewidgets.com"
  const allJoined = words.join('');
  if (allJoined.length >= 3) domains.push(allJoined + '.com');

  // First word only: "acme.com"
  if (words.length > 1 && words[0].length >= 3) domains.push(words[0] + '.com');

  // First two words joined, only when there are 3+ words (2 words is already covered above)
  if (words.length >= 3) {
    const twoJoined = words.slice(0, 2).join('');
    if (twoJoined !== allJoined && twoJoined.length >= 3) domains.push(twoJoined + '.com');
  }

  // Hyphenated: "acme-widgets.com"
  if (words.length > 1) {
    const hyphenated = words.join('-');
    domains.push(hyphenated + '.com');
  }

  return [...new Set(domains)];
}

// Common email patterns for a name at a domain. These are guesses, never verified by
// sending, so callers must mark them as unconfirmed.
function inferEmailPatterns(firstName, lastName, domain) {
  if (!firstName || !lastName || !domain) return [];
  const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
  const l = lastName.toLowerCase().replace(/[^a-z]/g, '');
  if (!f || !l) return [];

  return [
    f + '.' + l + '@' + domain,           // john.doe@domain.com
    f + l + '@' + domain,                  // johndoe@domain.com
    f.charAt(0) + l + '@' + domain,        // jdoe@domain.com
    f + '@' + domain,                      // john@domain.com
    f + '_' + l + '@' + domain,            // john_doe@domain.com
    l + '.' + f + '@' + domain,            // doe.john@domain.com
    f.charAt(0) + '.' + l + '@' + domain,  // j.doe@domain.com
  ];
}

// Keep only the lines near phones, emails, titles and addresses, so a long page fits
// in the model's context without losing the contact data.
function extractRelevantSections(text, maxChars = 5000) {
  if (text.length <= maxChars) return text;

  const lines = text.split('\n');
  const relevantLines = [];
  const contextWindow = 3; // lines before/after a match

  // Patterns that indicate contact-relevant content
  const contactPatterns = [
    /\d{3}[\s.\-()]+\d{3}[\s.\-]+\d{4}/,     // Phone numbers
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/, // Emails
    /\b(?:phone|tel|fax|mobile|cell|office|direct|email|address|contact)\s*[:.]/i,
    /\b(?:president|director|ceo|cfo|coo|cto|vp|managing|partner|founder|principal|advisor|officer)\b/i,
    /\b(?:suite|floor|building|blvd|avenue|street|drive|road|lane|way)\b/i,
    /\b[A-Z]{2}\s+\d{5}\b/, // State + ZIP
  ];

  const markedLines = new Set();

  for (let i = 0; i < lines.length; i++) {
    for (const pattern of contactPatterns) {
      if (pattern.test(lines[i])) {
        for (let j = Math.max(0, i - contextWindow); j <= Math.min(lines.length - 1, i + contextWindow); j++) {
          markedLines.add(j);
        }
        break;
      }
    }
  }

  // If we found relevant sections, use them
  if (markedLines.size > 0) {
    const sortedIndices = [...markedLines].sort((a, b) => a - b);
    for (const idx of sortedIndices) {
      relevantLines.push(lines[idx]);
    }
    const result = relevantLines.join('\n').substring(0, maxChars);
    return result;
  }

  // Fallback: first N chars
  return text.substring(0, maxChars);
}

// Fetch with timeout. Uses the Node http/https modules because the n8n Code node
// sandbox has no fetch or AbortController.
const https = require('https');
const http = require('http');
const urlModule = require('url');

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000, _redirectCount = 0) {
    // Only http/https: URLs come from untrusted email bodies.
    const parsedCheck = urlModule.parse(url);
    if (!parsedCheck.protocol || !parsedCheck.hostname) {
      return { ok: false, status: 0, text: 'Invalid URL: ' + url };
    }
    if (parsedCheck.protocol !== 'http:' && parsedCheck.protocol !== 'https:') {
      return { ok: false, status: 0, text: 'Blocked: unsupported protocol ' + parsedCheck.protocol };
    }
    // Block internal/private hosts so an emailed URL cannot probe the local network.
    const host = parsedCheck.hostname;
    // Except our own scraper-bypass and Ollama containers.
    const ALLOWED_INTERNAL = ['cf-bypass', 'email-to-crm-cf-bypass', 'localhost', 'ollama'];
    if ((host === 'localhost' || host === '127.0.0.1' || host.startsWith('10.') ||
        host.startsWith('192.168.') || host.startsWith('169.254.') || host === 'host.docker.internal')
        && !ALLOWED_INTERNAL.includes(host)) {
      return { ok: false, status: 0, text: 'Blocked: internal host ' + host };
    }
  return new Promise((resolve, reject) => {
    const parsed = urlModule.parse(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: (parsed.pathname || '/') + (parsed.search || ''),
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(options.headers || {})
      },
      timeout: timeoutMs,
      rejectUnauthorized: false
    };
    
    const req = lib.request(reqOptions, (res) => {
      // Follow redirects (up to 5)
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (_redirectCount >= 5) { resolve({ ok: false, status: res.statusCode, text: 'Too many redirects' }); return; }
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : parsed.protocol + '//' + parsed.host + res.headers.location;
        fetchWithTimeout(redirectUrl, options, timeoutMs, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }
      
      let body = '';
      let bodyBytes = 0;
      const MAX_BODY = 5 * 1024 * 1024;
      res.setEncoding('utf8');
      res.on('data', chunk => { bodyBytes += chunk.length; if (bodyBytes > MAX_BODY) { req.destroy(); resolve({ ok: false, status: 413, text: 'Response too large' }); return; } body += chunk; });
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => body,
          json: async () => JSON.parse(body)
        });
      });
    });
    
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', (err) => { reject(err); });
    
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// Tiered scraping: escalate only when the cheaper method fails or hits a bot wall.
// Tier 0: Native HTTP (fast, works for ~50% of sites)
// Tier 1: CloudflareBypass Docker container (self-hosted, free)
// Tier 2: Firecrawl cloud API (free 500 pages/mo)
// Tier 3: Wayback Machine cached version (free, may be stale)
async function tieredFetch(url, log) {
  // Tier 0: native HTTP
  try {
    log.push('Tier 0 (native HTTP): ' + url);
    const r0 = await fetchWithTimeout(url, {}, 15000);
    if (r0.ok) {
      const html = await r0.text();
      // Check if we got a real page (not a Cloudflare challenge or empty shell)
      if (html.length > 500 && !html.includes('Just a moment...') && !html.includes('Checking your browser') && !html.includes('cf-browser-verification')) {
        log.push('Tier 0 OK (' + html.length + ' chars)');
        return { ok: true, html, tier: 0 };
      }
      log.push('Tier 0 got challenge page or empty (' + html.length + ' chars)');
    } else {
      log.push('Tier 0 HTTP ' + r0.status);
    }
  } catch (e) {
    log.push('Tier 0 failed: ' + (e.message || 'timeout'));
  }

  // Tier 1: CloudflareBypass container
  // Container runs on internal port 8000, mapped to 8191 externally.
  // Docker-network calls (cf-bypass, email-to-crm-cf-bypass) use internal port 8000.
  // Localhost calls use the mapped external port 8191.
  const CF_HOSTS = [
    { host: 'cf-bypass', port: 8000 },
    { host: 'email-to-crm-cf-bypass', port: 8000 },
    { host: 'localhost', port: 8191 },
  ];
  let tier1Done = false;
  for (const cf of CF_HOSTS) {
    if (tier1Done) break;
    try {
      log.push('Tier 1 (' + cf.host + ':' + cf.port + '): ' + url);
      const bypassUrl = 'http://' + cf.host + ':' + cf.port + '/html?url=' + encodeURIComponent(url);
      const r1 = await fetchWithTimeout(bypassUrl, {}, 30000);
      if (r1.ok) {
        const html = await r1.text();
        if (html.length > 500) {
          log.push('Tier 1 OK via ' + cf.host + ':' + cf.port + ' (' + html.length + ' chars)');
          return { ok: true, html, tier: 1 };
        }
        log.push('Tier 1 ' + cf.host + ' returned short response (' + html.length + ' chars)');
      } else {
        log.push('Tier 1 ' + cf.host + ' HTTP ' + r1.status);
      }
      tier1Done = true; // Got a response (even if not useful), don't try other hosts
    } catch (e) {
      log.push('Tier 1 ' + cf.host + ' failed: ' + (e.message || 'connection refused').substring(0, 60));
    }
  }

  // Tier 2: Firecrawl cloud API, only when FIRECRAWL_API_KEY is set. It receives the public URL only.
  let FIRECRAWL_KEY = '';
  try { if (typeof $env !== 'undefined' && $env.FIRECRAWL_API_KEY) FIRECRAWL_KEY = $env.FIRECRAWL_API_KEY; } catch(e) {}
  if (FIRECRAWL_KEY) {
    try {
      log.push('Tier 2 (Firecrawl): ' + url);
      const r2 = await fetchWithTimeout('https://api.firecrawl.dev/v1/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + FIRECRAWL_KEY,
        },
        body: JSON.stringify({ url, formats: ['html'] }),
      }, 30000);
      if (r2.ok) {
        const data = await r2.json();
        const html = data.data?.html || data.data?.markdown || '';
        if (html.length > 500) {
          log.push('Tier 2 OK (' + html.length + ' chars)');
          return { ok: true, html, tier: 2 };
        }
        log.push('Tier 2 returned short response');
      } else {
        log.push('Tier 2 HTTP ' + r2.status);
      }
    } catch (e) {
      log.push('Tier 2 failed: ' + (e.message || 'error'));
    }
  } else {
    log.push('Tier 2 skipped (no FIRECRAWL_API_KEY)');
  }

  // Tier 3: Wayback Machine snapshot
  try {
    log.push('Tier 3 (Wayback Machine): ' + url);
    const wbCheck = await fetchWithTimeout(
      'https://archive.org/wayback/available?url=' + encodeURIComponent(url), {}, 10000
    );
    if (wbCheck.ok) {
      const wbData = await wbCheck.json();
      const snapshot = wbData.archived_snapshots?.closest;
      if (snapshot && snapshot.available && snapshot.url) {
        log.push('Tier 3 found snapshot from ' + (snapshot.timestamp || '?'));
        const wbPage = await fetchWithTimeout(snapshot.url, {}, 15000);
        if (wbPage.ok) {
          const html = await wbPage.text();
          if (html.length > 500) {
            log.push('Tier 3 OK (' + html.length + ' chars, cached)');
            return { ok: true, html, tier: 3, cached: true, cacheDate: snapshot.timestamp };
          }
        }
      } else {
        log.push('Tier 3: no snapshot available');
      }
    }
  } catch (e) {
    log.push('Tier 3 failed: ' + (e.message || 'timeout'));
  }

  // Every tier failed
  log.push('All tiers exhausted for: ' + url);
  return { ok: false, html: '', tier: -1 };
}

// Work out which fields each contact is missing.
const enrichmentTargets = [];

for (let i = 0; i < contacts.length; i++) {
  const c = contacts[i];
  const clearedFieldNames = (c.clearedFields || []).map(f => typeof f === 'string' ? f : f.field);
  const missingFields = [];

  // Fields that were cleared by source-text validation
  for (const field of clearedFieldNames) {
    missingFields.push(field);
  }

  // Fields that were never extracted
  if (!c.email && !clearedFieldNames.includes('email')) missingFields.push('email');
  if (!c.phone && !clearedFieldNames.includes('phone')) missingFields.push('phone');
  if (!c.companyName && !clearedFieldNames.includes('companyName')) missingFields.push('companyName');
  if (!c.jobTitle && !clearedFieldNames.includes('jobTitle')) missingFields.push('jobTitle');
  if (!c.city && !clearedFieldNames.includes('city')) missingFields.push('city');
  if (!c.state && !clearedFieldNames.includes('state')) missingFields.push('state');

  if (missingFields.length > 0) {
    enrichmentTargets.push({
      index: i,
      contact: c,
      missingFields: missingFields,
      name: ((c.firstName || '') + ' ' + (c.lastName || '')).trim(),
      company: c.companyName || '',
      email: c.email || ''
    });
  }
}

// For stub contacts with company but no email, derive candidate domains as URLs
for (const et of enrichmentTargets) {
  const c = et.contact;
  if ((c.extractionMethod === 'STUB_FROM_FRAGMENTS' || c.needsWebResearch) && !c.email && c.companyName) {
    const derivedDomains = companyToDomains(c.companyName);
    if (derivedDomains.length > 0) {
      // Add derived domains as URLs to try
      if (!input.allUrls) input.allUrls = [];
      for (const d of derivedDomains) {
        const derivedUrl = 'https://' + d;
        if (!input.allUrls.includes(derivedUrl)) {
          input.allUrls.push(derivedUrl);
        }
      }
      if (!input.primaryUrl) input.primaryUrl = 'https://' + derivedDomains[0];
      if (!input.hasUrls) input.hasUrls = true;
    }
  }
  // If stub has email but no name, try to derive name from email local part
  if ((c.extractionMethod === 'STUB_FROM_FRAGMENTS') && c.email && !c.firstName) {
    const local = c.email.split('@')[0] || '';
    const localParts = local.replace(/[0-9]/g, '').split(/[._-]/);
    if (localParts.length >= 2 && localParts[0].length >= 2 && localParts[1].length >= 2) {
      c.firstName = localParts[0].charAt(0).toUpperCase() + localParts[0].slice(1);
      c.lastName = localParts[1].charAt(0).toUpperCase() + localParts[1].slice(1);
      et.name = c.firstName + ' ' + c.lastName;
      c.infoNotes = c.infoNotes || [];
      c.infoNotes.push('Name inferred from email local part');
    }
  }
}

// Nothing to enrich and not in discovery mode: pass through.
if (enrichmentTargets.length === 0 && !discoveryMode) {
  allResults.push({ json: { ...input, webResearchAttempted: true, webResearchSucceeded: true, webResearchReason: 'No missing fields to enrich' } }); continue;
}

// Scrape URLs, then extract with the local model.

let tier1Success = false;
let scrapedText = '';
let scrapedUrl = '';
let pagesVisited = 0;
const researchLog = [];

// DuckDuckGo search (free, no API key) for "[name] [company] email contact", the way a
// person would look someone up. Emails, phones and URLs in the results feed the scrape below.
let searchFoundEmail = '';
let searchFoundPhone = '';
let searchFoundUrls = [];

if (enrichmentTargets.length > 0) {
  const t = enrichmentTargets[0];
  const searchName = t.name || '';
  const searchCompany = t.company || '';
  
  // Also search when only company is known (stub contacts)
  if (searchName && searchCompany) {
    const query = encodeURIComponent('"' + searchName + '" "' + searchCompany + '" email contact');
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + query;
    
    try {
      researchLog.push('DDG search: ' + searchName + ' ' + searchCompany);
      const ddgResponse = await fetchWithTimeout(ddgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, 15000);
      
      if (ddgResponse.ok) {
        const ddgHtml = await ddgResponse.text();
        const ddgText = htmlToText(ddgHtml);
        researchLog.push('DDG returned ' + ddgText.length + ' chars');
        
        // Extract emails from search results
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const foundEmails = [...new Set((ddgText.match(emailPattern) || []))];
        
        // Filter: match contact's name or company domain
        const nameParts = searchName.toLowerCase().split(/\s+/);
        const companyLower = searchCompany.toLowerCase().replace(/[^a-z0-9]/g, '');
        
        for (const email of foundEmails) {
          const emailLower = email.toLowerCase();
          const domain = emailLower.split('@')[1] || '';
          const local = emailLower.split('@')[0] || '';
          
          // Skip personal/generic domains
          if (['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
               'example.com','duckduckgo.com','wikipedia.org'].includes(domain)) continue;
          
          // Check if email matches the person (name parts in local or domain matches company)
          const domainBase = domain.split('.')[0];
          const nameInLocal = nameParts.some(p => p.length >= 3 && local.includes(p));
          const companyInDomain = companyLower.length >= 3 && (domainBase.includes(companyLower) || companyLower.includes(domainBase));
          
          if (nameInLocal || companyInDomain) {
            searchFoundEmail = email;
            researchLog.push('DDG found email: ' + email);
            break;
          }
        }
        
        // Extract phone numbers from search results
        const phonePattern = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;
        const foundPhones = ddgText.match(phonePattern) || [];
        for (const phone of foundPhones) {
          const digits = phone.replace(/\D/g, '');
          if (digits.length >= 10 && !isOwnCompanyPhone(phone)) {
            searchFoundPhone = phone.trim();
            researchLog.push('DDG found phone: ' + searchFoundPhone);
            break;
          }
        }
        
        // Extract useful URLs from search results for follow-up scraping
        const urlPattern = /https?:\/\/[^\s<>"'\)]+/g;
        const foundUrls = ddgText.match(urlPattern) || [];
        const skipDomains = ['duckduckgo.com','google.com','wikipedia.org','facebook.com',
          'twitter.com','linkedin.com','instagram.com','youtube.com','bing.com'];
        for (const url of foundUrls) {
          try {
            const hostname = (urlModule.parse(url).hostname || '').toLowerCase();
            if (!skipDomains.some(d => hostname.includes(d)) && searchFoundUrls.length < 3) {
              searchFoundUrls.push(url);
            }
          } catch(e) {}
        }
        if (searchFoundUrls.length > 0) {
          researchLog.push('DDG found ' + searchFoundUrls.length + ' useful URLs');
        }
      }
    } catch (ddgErr) {
      researchLog.push('DDG search failed: ' + (ddgErr.message || 'timeout'));
    }
  } else if (!searchName && searchCompany) {
    // Company-only search for stub contacts
    const query = encodeURIComponent('"' + searchCompany + '" contact email phone');
    const ddgUrl = 'https://html.duckduckgo.com/html/?q=' + query;

    try {
      researchLog.push('DDG company-only search: ' + searchCompany);
      const ddgResponse = await fetchWithTimeout(ddgUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      }, 15000);

      if (ddgResponse.ok) {
        const ddgHtml = await ddgResponse.text();
        const ddgText = htmlToText(ddgHtml);
        researchLog.push('DDG company search returned ' + ddgText.length + ' chars');

        // Extract emails matching company domain
        const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const foundEmails = [...new Set((ddgText.match(emailPattern) || []))];
        const companyLower = searchCompany.toLowerCase().replace(/[^a-z0-9]/g, '');

        for (const email of foundEmails) {
          const domain = email.toLowerCase().split('@')[1] || '';
          const domainBase = domain.split('.')[0];
          if (['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
               'example.com','duckduckgo.com','wikipedia.org'].includes(domain)) continue;
          if (companyLower.length >= 3 && (domainBase.includes(companyLower) || companyLower.includes(domainBase))) {
            searchFoundEmail = email;
            researchLog.push('DDG company search found email: ' + email);
            break;
          }
        }

        // Extract useful URLs
        const urlPattern = /https?:\/\/[^\s<>"'\)]+/g;
        const foundUrls = ddgText.match(urlPattern) || [];
        const skipDomains = ['duckduckgo.com','google.com','wikipedia.org','facebook.com',
          'twitter.com','linkedin.com','instagram.com','youtube.com','bing.com'];
        for (const url of foundUrls) {
          try {
            const hostname = (urlModule.parse(url).hostname || '').toLowerCase();
            if (!skipDomains.some(d => hostname.includes(d)) && searchFoundUrls.length < 3) {
              searchFoundUrls.push(url);
            }
          } catch(e) {}
        }
      }
    } catch (ddgErr) {
      researchLog.push('DDG company search failed: ' + (ddgErr.message || 'timeout'));
    }
  }
}

// Apply search results immediately if found
if (searchFoundEmail || searchFoundPhone) {
  const t = enrichmentTargets[0];
  const contact = contacts[t.index];
  
  if (searchFoundEmail && !contact.email) {
    contact.email = searchFoundEmail;
    contact.infoNotes = contact.infoNotes || [];
    contact.infoNotes.push('Email found via web search');
    contact.verifiedFields = contact.verifiedFields || [];
    contact.verifiedFields.push('email');
    researchLog.push('Applied DDG email to contact');
  }
  if (searchFoundPhone && !contact.phone) {
    contact.phone = searchFoundPhone;
    contact.infoNotes = contact.infoNotes || [];
    contact.infoNotes.push('Phone found via web search');
    contact.verifiedFields = contact.verifiedFields || [];
    contact.verifiedFields.push('phone');
    researchLog.push('Applied DDG phone to contact');
  }
  
  // Recalculate missing fields
  const idx = enrichmentTargets.findIndex(et => et.index === t.index);
  if (idx >= 0) {
    enrichmentTargets[idx].missingFields = enrichmentTargets[idx].missingFields.filter(f => {
      if (f === 'email' && contact.email) return false;
      if (f === 'phone' && contact.phone) return false;
      return true;
    });
  }
}

// Determine which URLs to try
const urlsToTry = [];
if (input.primaryUrl) urlsToTry.push(input.primaryUrl);
if (input.allUrls && Array.isArray(input.allUrls)) {
  for (const url of input.allUrls) {
    if (!urlsToTry.includes(url)) urlsToTry.push(url);
  }
}

// Add URLs discovered from DDG search results
for (const sUrl of searchFoundUrls) {
  if (!urlsToTry.includes(sUrl)) urlsToTry.push(sUrl);
}

// Also try deriving URL from contact email domains
for (const target of enrichmentTargets) {
  if (target.email) {
    const domain = target.email.split('@')[1];
    const personalDomains = ['gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com','me.com','live.com','msn.com','protonmail.com'];
    if (domain && !personalDomains.includes(domain.toLowerCase())) {
      const derivedUrl = 'https://' + domain;
      if (!urlsToTry.includes(derivedUrl)) urlsToTry.push(derivedUrl);
      // Also try /contact, /about, /team pages
      if (!urlsToTry.includes(derivedUrl + '/contact')) urlsToTry.push(derivedUrl + '/contact');
      if (!urlsToTry.includes(derivedUrl + '/about')) urlsToTry.push(derivedUrl + '/about');
      if (!urlsToTry.includes(derivedUrl + '/team')) urlsToTry.push(derivedUrl + '/team');
    }
  }
}

// Cap at 6 URLs to avoid excessive scraping
const maxUrls = 6;
const urlsToScrape = urlsToTry.slice(0, maxUrls);

// Scrape each URL and collect text
const allScrapedTexts = [];

for (const url of urlsToScrape) {
  try {
    researchLog.push('Fetching: ' + url);
    // Multi-tier scraping with automatic escalation
    const tierResult = await tieredFetch(url, researchLog);

    if (tierResult.ok) {
      const text = htmlToText(tierResult.html);
      pagesVisited++;
      allScrapedTexts.push({ url, text, rawHtml: tierResult.html });
      researchLog.push('Scraped: ' + url + ' (' + text.length + ' chars via tier ' + tierResult.tier + (tierResult.cached ? ', cached' : '') + ')');
    } else {
      researchLog.push('ALL TIERS FAILED: ' + url);
    }
  } catch (error) {
    researchLog.push('Failed: ' + url + ' - ' + (error.message || 'timeout'));
  }
}

// Combine scraped texts (focus on relevant sections)
if (allScrapedTexts.length > 0) {
  // Discovery mode uses 6000-char relevant sections (full text causes Ollama timeout);
  // enrichment mode uses 3000-char focused sections
  const perPageCap = discoveryMode ? 6000 : 3000;
  const combinedText = allScrapedTexts
    .map(s => '--- PAGE: ' + s.url + ' ---\n' + extractRelevantSections(s.text, perPageCap))
    .join('\n\n');
  scrapedText = combinedText.substring(0, 12000); // Cap total for Ollama context
  scrapedUrl = allScrapedTexts[0].url;
}


let tier1Results = {};
let discoveredContacts = [];

if (scrapedText && discoveryMode) {
  // Discovery: pull every person off the scraped pages.
  researchLog.push('DISCOVERY MODE: Extracting all contacts from scraped pages...');

  const discoveryPrompt = `You are extracting ALL contact information from a website page.

WEBSITE CONTENT:
${scrapedText}

INSTRUCTIONS:
- Extract EVERY person you find on this page with their contact details
- Return a JSON ARRAY of contact objects
- Each contact object should have these fields (include only what you find):
  firstName, lastName, email, phone, mobile, companyName, jobTitle, city, state
- Do NOT include generic emails like info@, sales@, support@
- Do NOT guess or fabricate — only extract what is explicitly on the page
- Phone numbers must include area code
- If you find no contacts, return an empty array: []

Return ONLY valid JSON array, nothing else.
Example: [{"firstName": "John", "lastName": "Smith", "email": "jsmith@company.com", "jobTitle": "VP Sales", "phone": "555-010-0100"}]`;

  // Declared outside the try so the retry and regex fallback can use it.
  const GENERIC_PREFIXES = new Set(['info','sales','support','admin','contact',
    'help','billing','noreply','no-reply','mailer-daemon','postmaster',
    'webmaster','newsletter','marketing','service']);

  // Structured text parser, tried before the model because it is fast and does not
  // hallucinate. Finds person-name lines, then scans a window around each for email,
  // phone, title and company in any order, so page layout does not matter.
  try {
    const lines = scrapedText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const structuredContacts = [];

    const NOT_NAMES = new Set(['office','phone','email','address','contact','locations','form',
      'about','home','menu','search','login','our','the','and','for','with',
      'featured','skip','content','social','media','facebook','youtube','instagram','twitter',
      'site','map','cookie','close','submit','all','rights','reserved','news','get','sell',
      'financing','welcome','aboard','team','crew','staff','do','not','my','personal',
      'read','more','learn','view','click','here','back','next','previous','download',
      'subscribe','newsletter','blog','events','services','products','gallery','portfolio',
      'testimonials','reviews','faq','privacy','terms','policy','sitemap','copyright',
      'powered','built','designed','website','careers','jobs','leadership','management',
      'call','send','share','print','save','follow','connect','join','apply','request']);

    // Place-name patterns tested against the whole line, not single words, so
    // "Jordan Example" stays a person while "Springfield, Illinois" is dropped.
    const GEO_PATTERNS = [
      /^(fort|north|south|east|west|new|san|los|las|el|st\.?|mt\.?|palm|boca|cape|port|lake)\s/i,
      /\b(florida|california|texas|illinois|ohio|georgia|virginia|carolina|york|jersey|hampshire|dakota|mexico|island)\s*$/i,
      /\b(city|county|township|village|heights|springs|hills|valley|creek|grove|park|harbor|bay|cove)\s*$/i,
      /^\d/,  // Lines starting with numbers (addresses)
      /,\s*(FL|CA|TX|NY|NJ|GA|VA|NC|SC|OH|PA|IL|MA|CT|MD|WA|OR|CO|AZ|NV|TN|MN|WI|MI|MO|IN|KY|LA|AL|MS|AR|OK|KS|NE|IA|UT|NM|HI|ID|MT|WY|ND|SD|VT|NH|ME|RI|DE|DC|WV|AK)\b/i,  // "City, ST" format
    ];

    const titleKeywords = /president|director|manager|officer|founder|partner|member|professional|advisor|broker|sales|marketing|vp|svp|ceo|cfo|coo|cto|licensed|managing|senior|executive|associate|consultant|specialist|principal|chairman|head|lead|coordinator|analyst|administrator|superintendent|captain|chief|owner|general/i;
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
    const phoneRegex = /[\+]?[\d][\d\s\-\.\(\)]{8,}/;

    // Step 1: Find all person names in the text
    const namePositions = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const words = line.split(/\s+/);
      if (words.length < 2 || words.length > 5) continue;
      if (!words.every(w => /^[A-Z"'\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u201C\u201D\u2018\u2019]/.test(w))) continue;
      if (words.some(w => NOT_NAMES.has(w.toLowerCase().replace(/[^a-z]/g, '')))) continue;
      // Drop place-name lines
      if (GEO_PATTERNS.some(p => p.test(line))) continue;
      if (/[<>{}@\[\]|\\\/()&;:!?0-9,]/.test(line.replace(/["'""\u201C\u201D\u2018\u2019]/g, ''))) continue;
      if (line.length < 5 || line.length > 50) continue;

      // Normalize all-caps names and strip quoted nicknames, e.g. PAT "PJ" EXAMPLE
      const cleanWords = words.map(w => {
        const stripped = w.replace(/['""\u201C\u201D\u2018\u2019]/g, '');
        if (!stripped) return '';
        if (stripped === stripped.toUpperCase() && stripped.length > 2) {
          return stripped.charAt(0) + stripped.slice(1).toLowerCase();
        }
        return stripped;
      }).filter(w => w.length > 0);

      if (cleanWords.length < 2) continue;
      // Filter out quoted single-letter nicknames from the name (keep them for display but use first/last)
      const nameWords = cleanWords.filter(w => w.length > 1 || cleanWords.length <= 2);

      namePositions.push({
        lineIndex: i,
        firstName: nameWords[0] || cleanWords[0],
        lastName: nameWords.length > 1 ? nameWords[nameWords.length - 1] : cleanWords[cleanWords.length - 1],
        fullName: cleanWords.join(' '),
      });
    }

    // Step 2: For each name, scan a window of lines around it for contact fields
    const WINDOW = 6; // Look up to 6 lines before and after the name
    for (const np of namePositions) {
      const windowStart = Math.max(0, np.lineIndex - WINDOW);
      const windowEnd = Math.min(lines.length - 1, np.lineIndex + WINDOW);
      const windowLines = lines.slice(windowStart, windowEnd + 1).join(' ');

      let email = '';
      let phone = '';
      let title = '';
      let company = '';

      // Search window for email
      const emailMatch = windowLines.match(emailRegex);
      if (emailMatch) {
        const found = emailMatch[0].toLowerCase();
        // Skip generic/internal emails
        const genericPrefixes = ['info','sales','support','admin','contact','noreply','no-reply'];
        const internalDomains = [...OWN_DOMAINS, 'example-consultancy.com', 'gmail.com', 'outlook.com'];
        const localPart = found.split('@')[0];
        const domain = found.split('@')[1];
        if (!genericPrefixes.includes(localPart) && !internalDomains.includes(domain)) {
          email = found;
        }
      }

      // Search window for phone (skip the name line itself)
      for (let wi = windowStart; wi <= windowEnd; wi++) {
        if (wi === np.lineIndex) continue;
        const phoneMatch = lines[wi].match(phoneRegex);
        if (phoneMatch) {
          const digits = phoneMatch[0].replace(/\D/g, '');
          if (digits.length >= 7 && digits.length <= 15) {
            phone = phoneMatch[0].trim();
            break;
          }
        }
      }

      // Search for title - prefer the lines just after the name
      // Check the 3 lines after the name first, then expand to full window
      for (let wi = np.lineIndex + 1; wi <= Math.min(np.lineIndex + 3, windowEnd); wi++) {
        if (titleKeywords.test(lines[wi]) && lines[wi].length < 80) {
          title = lines[wi];
          break;
        }
      }
      if (!title) {
        for (let wi = windowStart; wi <= windowEnd; wi++) {
          if (wi === np.lineIndex) continue;
          if (wi >= np.lineIndex + 1 && wi <= np.lineIndex + 3) continue; // already checked
          if (titleKeywords.test(lines[wi]) && lines[wi].length < 80) {
            title = lines[wi];
            break;
          }
        }
      }

      // Search window for company (lines with corporate suffixes)
      const companySuffixes = /\b(?:LLC|Inc|Ltd|Corp|Group|Company|Partners|Associates|Capital|Financial|Bank|Insurance|Holdings|Enterprises|Solutions|Services|International|Global)\b/i;
      for (let wi = windowStart; wi <= windowEnd; wi++) {
        if (wi === np.lineIndex) continue;
        if (companySuffixes.test(lines[wi]) && lines[wi].length < 80 && !titleKeywords.test(lines[wi])) {
          company = lines[wi];
          break;
        }
      }

      structuredContacts.push({
        firstName: np.firstName,
        lastName: np.lastName,
        email: email,
        phone: phone,
        companyName: company,
        jobTitle: title,
        type: '',
        confidence: email ? 'medium' : 'low',
        extractionMethod: 'STRUCTURED_PAGE_PARSE',
      });
    }

    // Deduplicate by name
    const seenNames = new Set();
    const uniqueContacts = structuredContacts.filter(c => {
      const key = (c.firstName + ' ' + c.lastName).toLowerCase();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

    if (uniqueContacts.length >= 2) {
      researchLog.push('Structured parser found ' + uniqueContacts.length + ' contacts - skipping Ollama');

      // Try to find a company name from the page title or prominent text
      let pageCompany = '';
      const companyPattern = /(?:at|of|from|team|crew|staff)\s+(?:the\s+)?([A-Z][A-Za-z\s&']+?)(?:\s*[-\u2013\u2014|]|\s*$)/m;
      const companyMatch = scrapedText.match(companyPattern);
      if (companyMatch) pageCompany = companyMatch[1].trim();

      // Extract phone numbers from tel: links in raw HTML
      const rawHtmlAll = allScrapedTexts.map(s => s.rawHtml || '').join(' ');
      const telPhones = [];
      const telRegex = /href=["']tel:([^"']+)["']/gi;
      let telM;
      while ((telM = telRegex.exec(rawHtmlAll)) !== null) {
        const phone = telM[1].replace(/[^\d+\-().x\s]/g, '').trim();
        const digits = phone.replace(/\D/g, '');
        if (digits.length >= 10) telPhones.push(phone);
      }

      // Extract emails from mailto: links in raw HTML
      const mailtoEmails = [];
      const mailtoRegex = /href=["']mailto:([^"'?\s]+)/gi;
      let mailM;
      while ((mailM = mailtoRegex.exec(rawHtmlAll)) !== null) {
        const em = mailM[1].toLowerCase().trim();
        if (em.includes('@') && !em.endsWith('@')) mailtoEmails.push(em);
      }

      // Try to match phones/emails to contacts by proximity in HTML
      // Simple approach: for each contact, search the raw HTML for their name
      // and look nearby for tel:/mailto: links
      for (const sc of uniqueContacts) {
        if (!sc.companyName && pageCompany) sc.companyName = pageCompany;

        // Search raw HTML for this contact's name and nearby tel:/mailto:
        // Search for the person's last name in HTML (more reliable than first+last with tags between)
        const lastNameEsc = sc.lastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const namePattern = new RegExp(lastNameEsc, 'i');
        const nameMatch = namePattern.exec(rawHtmlAll);
        if (nameMatch) {
          // Search a wide vicinity (1500 chars after name - HTML tags take up space)
          const vicinity = rawHtmlAll.substring(
            Math.max(0, nameMatch.index - 300),
            nameMatch.index + 1500
          );
          // Find tel: in vicinity
          const vicinityTel = vicinity.match(/href=["']tel:([^"']+)["']/i);
          if (vicinityTel && !sc.phone) {
            const ph = vicinityTel[1].replace(/[^\d+\-().x\s]/g, '').trim();
            if (ph.replace(/\D/g, '').length >= 10) sc.phone = ph;
          }
          // Find mailto: in vicinity
          const vicinityMail = vicinity.match(/href=["']mailto:([^"'?\s]+)/i);
          if (vicinityMail && !sc.email) {
            sc.email = vicinityMail[1].toLowerCase().trim();
            sc.confidence = 'medium'; // Upgraded from low since we have a real email
          }
        }

        discoveredContacts.push(sc);
      }

      if (telPhones.length > 0) researchLog.push('Found ' + telPhones.length + ' tel: links in HTML');
      if (mailtoEmails.length > 0) researchLog.push('Found ' + mailtoEmails.length + ' mailto: links in HTML');
      tier1Success = true;
    }
  } catch(e) {
    researchLog.push('Structured parser error: ' + (e.message || ''));
  }

  // Only call Ollama if structured parser didn't find contacts
  if (discoveredContacts.length === 0) {
  try {
    researchLog.push('Calling Ollama for contact discovery...');

    const ollamaResponse = await fetchWithTimeout('http://ollama:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: discoveryPrompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 2048 // More tokens for large team pages
        }
      })
    }, 120000);

    if (ollamaResponse.ok) {
      const ollamaData = await ollamaResponse.json();
      const responseText = ollamaData.response || '';
      researchLog.push('Ollama discovery responded: ' + responseText.substring(0, 300));

      try {
        let jsonStr = responseText.trim();
        jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        // Try array first
        const arrStart = jsonStr.indexOf('[');
        const arrEnd = jsonStr.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd > arrStart) {
          jsonStr = jsonStr.substring(arrStart, arrEnd + 1);
        } else {
          // Try single object
          const objStart = jsonStr.indexOf('{');
          const objEnd = jsonStr.lastIndexOf('}');
          if (objStart !== -1 && objEnd > objStart) {
            jsonStr = '[' + jsonStr.substring(objStart, objEnd + 1) + ']';
          }
        }
        const parsed = JSON.parse(jsonStr);
        const rawDiscovered = Array.isArray(parsed) ? parsed : [parsed];

        // Validate each discovered contact against scraped text
        for (const dc of rawDiscovered) {
          if (!dc || typeof dc !== 'object') continue;
          const firstName = (dc.firstName || '').trim();
          const lastName = (dc.lastName || '').trim();
          const email = (dc.email || '').trim().toLowerCase();
          if (!firstName && !lastName && !email) continue;

          // Validate: name or email must appear in scraped text
          const scLower = scrapedText.toLowerCase();
          const nameFound = (firstName && scLower.includes(firstName.toLowerCase())) ||
                           (lastName && scLower.includes(lastName.toLowerCase()));
          const emailFound = email && scLower.includes(email);

          if (!nameFound && !emailFound) {
            researchLog.push('REJECTED discovered contact: ' + firstName + ' ' + lastName + ' (not in page)');
            continue;
          }

          // Drop our own numbers and any phone not actually on the page
          let phone = (dc.phone || '').trim();
          if (phone) {
            if (isOwnCompanyPhone(phone)) {
              researchLog.push('REJECTED own-company phone for ' + firstName + ': ' + phone);
              phone = '';
            } else {
              const digits = phone.replace(/\D/g, '');
              const digitGroups = digits.match(/.{1,3}/g) || [];
              const flexPattern = digitGroups.join('[\\s.()\\-]*');
              if (digits.length < 7 || !new RegExp(flexPattern).test(scrapedText)) {
                researchLog.push('REJECTED phone for ' + firstName + ': ' + phone);
                phone = '';
              }
            }
          }

          let mobile = (dc.mobile || '').trim();
          if (mobile) {
            if (isOwnCompanyPhone(mobile)) {
              researchLog.push('REJECTED own-company mobile for ' + firstName + ': ' + mobile);
              mobile = '';
            } else {
              const digits = mobile.replace(/\D/g, '');
              const digitGroups = digits.match(/.{1,3}/g) || [];
              const flexPattern = digitGroups.join('[\\s.()\\-]*');
              if (digits.length < 7 || !new RegExp(flexPattern).test(scrapedText)) {
                mobile = '';
              }
            }
          }

          // Skip generic email prefixes
          if (email && GENERIC_PREFIXES.has(email.split('@')[0])) continue;

          // Skip personal domain emails (we already have those from the forwarder)
          if (email) {
            const eDomain = email.split('@')[1] || '';
            if (PERSONAL_DOMAINS.has(eDomain)) continue;
          }

          discoveredContacts.push({
            firstName: firstName,
            lastName: lastName,
            email: email,
            phone: phone,
            mobile: mobile,
            companyName: (dc.companyName || '').trim(),
            jobTitle: (dc.jobTitle || '').trim(),
            city: (dc.city || '').trim(),
            state: (dc.state || '').trim(),
            address: '',
            country: '',
            website: email ? 'https://' + email.split('@')[1] : '',
            type: '',
            specificType: '',
            confidence: 'medium',
            extractionMethod: 'WEB_DISCOVERY',
            verifiedFields: [
              ...(nameFound ? ['firstName', 'lastName'] : []),
              ...(emailFound ? ['email'] : []),
              ...(phone ? ['phone'] : [])
            ],
            unverifiedFields: [],
            clearedFields: [],
            infoNotes: ['Discovered via web research from ' + (scrapedUrl || 'scraped URL')]
          });
          researchLog.push('DISCOVERED: ' + firstName + ' ' + lastName + (email ? ' (' + email + ')' : ''));
        }

        tier1Success = discoveredContacts.length > 0;
        researchLog.push('Discovery found ' + discoveredContacts.length + ' validated contact(s)');
      } catch (parseErr) {
        researchLog.push('Discovery JSON parse failed: ' + parseErr.message);

        // Unparseable reply: retry once with a stricter JSON-only prompt.
        const responseTextForRetry = responseText || '';
        const first50 = responseTextForRetry.substring(0, 50);
        const looksLikeNarrative = !first50.includes('[') && !first50.includes('{');
        if (looksLikeNarrative || parseErr.message) {
          try {
            researchLog.push('Ollama retry (strict prompt): attempting...');
            const strictPrompt = `CRITICAL: Your response must be ONLY a JSON array. No explanations, no markdown, no text before or after. Start with [ and end with ]. Example: [{"firstName":"John","lastName":"Doe","email":"john@example.com","phone":"","title":"CEO","company":"Acme"}]

Extract ALL contacts from this website content:
${scrapedText}`;

            const retryResponse = await fetchWithTimeout('http://ollama:11434/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: 'llama3.2:3b',
                prompt: strictPrompt,
                stream: false,
                options: { temperature: 0.05, num_predict: 2048 }
              })
            }, 120000);

            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              const retryText = (retryData.response || '').trim();
              let retryJson = retryText.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
              const rArrStart = retryJson.indexOf('[');
              const rArrEnd = retryJson.lastIndexOf(']');
              if (rArrStart !== -1 && rArrEnd > rArrStart) {
                retryJson = retryJson.substring(rArrStart, rArrEnd + 1);
              } else {
                const rObjStart = retryJson.indexOf('{');
                const rObjEnd = retryJson.lastIndexOf('}');
                if (rObjStart !== -1 && rObjEnd > rObjStart) {
                  retryJson = '[' + retryJson.substring(rObjStart, rObjEnd + 1) + ']';
                }
              }
              const retryParsed = JSON.parse(retryJson);
              const retryContacts = Array.isArray(retryParsed) ? retryParsed : [retryParsed];

              // Process retry contacts with same validation as original
              for (const dc of retryContacts) {
                if (!dc || typeof dc !== 'object') continue;
                const firstName = (dc.firstName || '').trim();
                const lastName = (dc.lastName || '').trim();
                const email = (dc.email || '').trim().toLowerCase();
                if (!firstName && !lastName && !email) continue;
                const scLower = scrapedText.toLowerCase();
                const nameFound = (firstName && scLower.includes(firstName.toLowerCase())) ||
                                 (lastName && scLower.includes(lastName.toLowerCase()));
                const emailFound = email && scLower.includes(email);
                if (!nameFound && !emailFound) continue;

                let phone = (dc.phone || '').trim();
                if (phone && isOwnCompanyPhone(phone)) phone = '';
                if (phone) {
                  const digits = phone.replace(/\D/g, '');
                  const digitGroups = digits.match(/.{1,3}/g) || [];
                  const flexPattern = digitGroups.join('[\\s.()\\-]*');
                  if (digits.length < 7 || !new RegExp(flexPattern).test(scrapedText)) phone = '';
                }

                let mobile = (dc.mobile || '').trim();
                if (mobile && isOwnCompanyPhone(mobile)) mobile = '';
                if (mobile) {
                  const digits = mobile.replace(/\D/g, '');
                  const digitGroups = digits.match(/.{1,3}/g) || [];
                  const flexPattern = digitGroups.join('[\\s.()\\-]*');
                  if (digits.length < 7 || !new RegExp(flexPattern).test(scrapedText)) mobile = '';
                }

                if (email && GENERIC_PREFIXES.has(email.split('@')[0])) continue;
                if (email) {
                  const eDomain = email.split('@')[1] || '';
                  if (PERSONAL_DOMAINS.has(eDomain)) continue;
                }

                discoveredContacts.push({
                  firstName, lastName, email, phone, mobile,
                  companyName: (dc.companyName || dc.company || '').trim(),
                  jobTitle: (dc.jobTitle || dc.title || '').trim(),
                  city: (dc.city || '').trim(), state: (dc.state || '').trim(),
                  address: '', country: '',
                  website: email ? 'https://' + email.split('@')[1] : '',
                  type: '', specificType: '', confidence: 'medium',
                  extractionMethod: 'WEB_DISCOVERY_RETRY',
                  verifiedFields: [...(nameFound ? ['firstName', 'lastName'] : []), ...(emailFound ? ['email'] : []), ...(phone ? ['phone'] : [])],
                  unverifiedFields: [], clearedFields: [],
                  infoNotes: ['Discovered via web research retry from ' + (scrapedUrl || 'scraped URL')]
                });
              }
              tier1Success = discoveredContacts.length > 0;
              researchLog.push('Ollama retry (strict prompt): ' + (tier1Success ? 'success - ' + discoveredContacts.length + ' contacts' : 'failed - 0 contacts'));
            } else {
              researchLog.push('Ollama retry (strict prompt): failed - HTTP ' + retryResponse.status);
            }
          } catch (retryErr) {
            researchLog.push('Ollama retry (strict prompt): failed - ' + (retryErr.message || 'error'));
          }
        }

        // Both model attempts failed: fall back to plain email regex on the page text.
        if (discoveredContacts.length === 0 && scrapedText.length > 0) {
          researchLog.push('Regex fallback: attempting email extraction from raw text...');
          const emailRx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
          const allEmails = [...new Set((scrapedText.match(emailRx) || []))];
          const SKIP_DOMAINS = new Set([...PERSONAL_DOMAINS, ...OWN_DOMAINS,
            'example.com', 'duckduckgo.com', 'wikipedia.org', 'w3.org', 'schema.org',
            'googletagmanager.com', 'google-analytics.com', 'googleapis.com']);
          const GENERIC_EMAIL_PREFIXES = new Set(['info','sales','support','admin','contact',
            'help','billing','noreply','no-reply','mailer-daemon','postmaster',
            'webmaster','newsletter','marketing','service']);
          const regexContacts = [];
          for (const em of allEmails) {
            const emLower = em.toLowerCase();
            const domain = emLower.split('@')[1] || '';
            const local = emLower.split('@')[0] || '';
            if (SKIP_DOMAINS.has(domain)) continue;
            if (GENERIC_EMAIL_PREFIXES.has(local)) continue;

            // Try to find a name nearby (within 200 chars before/after)
            const emIdx = scrapedText.toLowerCase().indexOf(emLower);
            let nearbyName = { firstName: '', lastName: '' };
            if (emIdx !== -1) {
              const windowStart = Math.max(0, emIdx - 200);
              const windowEnd = Math.min(scrapedText.length, emIdx + em.length + 200);
              const nearby = scrapedText.substring(windowStart, windowEnd);
              // Look for capitalized name patterns
              const nameMatch = nearby.match(/\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/);
              if (nameMatch) {
                nearbyName.firstName = nameMatch[1];
                nearbyName.lastName = nameMatch[2];
              }
            }

            regexContacts.push({
              firstName: nearbyName.firstName, lastName: nearbyName.lastName,
              email: emLower, phone: '', mobile: '',
              companyName: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
              jobTitle: '', city: '', state: '', address: '', country: '',
              website: 'https://' + domain,
              type: '', specificType: '', confidence: 'low',
              extractionMethod: 'REGEX_FALLBACK',
              verifiedFields: ['email'],
              unverifiedFields: nearbyName.firstName ? ['firstName', 'lastName'] : [],
              clearedFields: [],
              infoNotes: ['Email extracted via regex fallback from ' + (scrapedUrl || 'scraped URL')]
            });
          }
          if (regexContacts.length > 0) {
            discoveredContacts.push(...regexContacts);
            tier1Success = true;
          }
          researchLog.push('Regex fallback: found ' + allEmails.length + ' emails, created ' + regexContacts.length + ' contacts');
        }
      }
    } else {
      researchLog.push('Ollama HTTP error: ' + ollamaResponse.status);
    }
  } catch (ollamaErr) {
    researchLog.push('Ollama discovery call failed: ' + (ollamaErr.message || 'unknown'));

    // The model call itself failed: same regex fallback.
    if (discoveredContacts.length === 0 && scrapedText.length > 0) {
      researchLog.push('Regex fallback (after Ollama failure): attempting...');
      const emailRx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const allEmails = [...new Set((scrapedText.match(emailRx) || []))];
      const SKIP_DOMAINS_FB = new Set([...PERSONAL_DOMAINS, ...OWN_DOMAINS,
        'example.com', 'duckduckgo.com', 'wikipedia.org', 'w3.org', 'schema.org',
        'googletagmanager.com', 'google-analytics.com', 'googleapis.com']);
      const GENERIC_PREFIXES_FB = new Set(['info','sales','support','admin','contact',
        'help','billing','noreply','no-reply','mailer-daemon','postmaster',
        'webmaster','newsletter','marketing','service']);
      const regexContacts = [];
      for (const em of allEmails) {
        const emLower = em.toLowerCase();
        const domain = emLower.split('@')[1] || '';
        const local = emLower.split('@')[0] || '';
        if (SKIP_DOMAINS_FB.has(domain)) continue;
        if (GENERIC_PREFIXES_FB.has(local)) continue;
        const emIdx = scrapedText.toLowerCase().indexOf(emLower);
        let nearbyName = { firstName: '', lastName: '' };
        if (emIdx !== -1) {
          const windowStart = Math.max(0, emIdx - 200);
          const windowEnd = Math.min(scrapedText.length, emIdx + em.length + 200);
          const nearby = scrapedText.substring(windowStart, windowEnd);
          const nameMatch = nearby.match(/\b([A-Z][a-z]{1,20})\s+([A-Z][a-z]{1,20})\b/);
          if (nameMatch) { nearbyName.firstName = nameMatch[1]; nearbyName.lastName = nameMatch[2]; }
        }
        regexContacts.push({
          firstName: nearbyName.firstName, lastName: nearbyName.lastName,
          email: emLower, phone: '', mobile: '',
          companyName: domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1),
          jobTitle: '', city: '', state: '', address: '', country: '',
          website: 'https://' + domain,
          type: '', specificType: '', confidence: 'low',
          extractionMethod: 'REGEX_FALLBACK',
          verifiedFields: ['email'], unverifiedFields: nearbyName.firstName ? ['firstName', 'lastName'] : [],
          clearedFields: [],
          infoNotes: ['Email extracted via regex fallback from ' + (scrapedUrl || 'scraped URL')]
        });
      }
      if (regexContacts.length > 0) { discoveredContacts.push(...regexContacts); tier1Success = true; }
      researchLog.push('Regex fallback: found ' + allEmails.length + ' emails, created ' + regexContacts.length + ' contacts');
    }
  }
  } // end: model / retry / regex block

  // Team pages often hold emails on per-person profile pages; crawl those links.
  if (scrapedText && allScrapedTexts.length > 0) {
    const mainHtml = allScrapedTexts[0].text || '';
    const mainUrl = allScrapedTexts[0].url || '';
    let mainHost = '';
    try { mainHost = (urlModule.parse(mainUrl).hostname || '').toLowerCase(); } catch(e) {}

    if (mainHost) {
      // Find profile/team member links in the original HTML (use raw html if available)
      const rawHtml = allScrapedTexts[0]._rawHtml || mainHtml;
      const linkPattern = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi;
      const profilePatterns = [/\/team\//i, /\/staff\//i, /\/people\//i, /\/about\//i, /\/crew\//i, /\/our-team\//i, /\/leadership\//i, /\/management\//i, /\/executives\//i];
      const subPageLinks = [];
      let linkMatch;
      while ((linkMatch = linkPattern.exec(rawHtml)) !== null) {
        const href = linkMatch[1];
        if (!href || href === '#' || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
        let fullUrl = href;
        try {
          if (href.startsWith('/')) {
            const parsedMain = urlModule.parse(mainUrl);
            fullUrl = parsedMain.protocol + '//' + parsedMain.host + href;
          } else if (!href.startsWith('http')) {
            continue;
          }
          const parsedLink = urlModule.parse(fullUrl);
          const linkHost = (parsedLink.hostname || '').toLowerCase();
          if (linkHost !== mainHost) continue;
          // Check if URL matches profile patterns
          const isProfile = profilePatterns.some(p => p.test(fullUrl));
          if (isProfile && !subPageLinks.includes(fullUrl) && fullUrl !== mainUrl) {
            subPageLinks.push(fullUrl);
          }
        } catch(e) {}
        if (subPageLinks.length >= 10) break;
      }

      if (subPageLinks.length > 0) {
        researchLog.push('Sub-page crawl: found ' + subPageLinks.length + ' profile links');
        let subPagesScraped = 0;
        let contactsEnriched = 0;
        const subEmailRx = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
        const subPhoneRx = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g;

        for (const spUrl of subPageLinks) {
          try {
            const spResult = await tieredFetch(spUrl, researchLog);
            if (spResult.ok) {
              subPagesScraped++;
              const spText = htmlToText(spResult.html);
              const spEmails = [...new Set((spText.match(subEmailRx) || []))].map(e => e.toLowerCase());
              const spPhones = (spText.match(subPhoneRx) || []).map(p => p.trim());

              // Match found data to existing discovered contacts
              for (const dc of discoveredContacts) {
                const dcName = ((dc.firstName || '') + ' ' + (dc.lastName || '')).trim().toLowerCase();
                if (!dcName) continue;
                const spLower = spText.toLowerCase();
                if (!spLower.includes(dc.firstName.toLowerCase()) && !spLower.includes(dc.lastName.toLowerCase())) continue;

                // Enrich missing email
                if (!dc.email && spEmails.length > 0) {
                  for (const spe of spEmails) {
                    const spDomain = spe.split('@')[1] || '';
                    if (!PERSONAL_DOMAINS.has(spDomain) && !OWN_DOMAINS.has(spDomain)) {
                      dc.email = spe;
                      dc.verifiedFields = dc.verifiedFields || [];
                      dc.verifiedFields.push('email');
                      dc.infoNotes.push('Email found via sub-page: ' + spUrl);
                      contactsEnriched++;
                      break;
                    }
                  }
                }

                // Enrich missing phone
                if (!dc.phone && spPhones.length > 0) {
                  for (const spp of spPhones) {
                    if (!isOwnCompanyPhone(spp)) {
                      dc.phone = spp;
                      dc.verifiedFields = dc.verifiedFields || [];
                      dc.verifiedFields.push('phone');
                      dc.infoNotes.push('Phone found via sub-page: ' + spUrl);
                      contactsEnriched++;
                      break;
                    }
                  }
                }
              }
            }
          } catch(e) {
            researchLog.push('Sub-page failed: ' + spUrl + ' - ' + (e.message || 'error'));
          }
        }
        researchLog.push('Sub-page crawl: found ' + subPageLinks.length + ' profile links, scraped ' + subPagesScraped + ', enriched ' + contactsEnriched + ' contacts');
      }
    }
  }

} else if (scrapedText && enrichmentTargets.length > 0) {
  // Enrichment: fill the missing fields of the first known contact.
  const target = enrichmentTargets[0];
  const missingList = target.missingFields.join(', ');

  const ollamaPrompt = `You are extracting contact information from a website.

PERSON TO FIND: ${target.name}${target.company ? ' at ' + target.company : ''}${target.email ? ' (' + target.email + ')' : ''}

MISSING FIELDS NEEDED: ${missingList}

WEBSITE CONTENT:
${scrapedText}

INSTRUCTIONS:
- Find ONLY the specific missing fields listed above for this specific person
- Return a JSON object with ONLY the fields you found
- Field names must be exactly: phone, mobile, companyName, jobTitle, city, state, address
- If you cannot find a field, DO NOT include it
- DO NOT guess or fabricate — only extract what is explicitly on the page
- Phone numbers must include area code

Return ONLY valid JSON, nothing else. Example: {"phone": "555-010-0100", "jobTitle": "Managing Director"}`;

  try {
    researchLog.push('ENRICHMENT MODE: Calling Ollama for field extraction...');

    const ollamaResponse = await fetchWithTimeout('http://ollama:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3.2:3b',
        prompt: ollamaPrompt,
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 256
        }
      })
    }, 120000);

    if (ollamaResponse.ok) {
      const ollamaData = await ollamaResponse.json();
      const responseText = ollamaData.response || '';
      researchLog.push('Ollama responded: ' + responseText.substring(0, 200));

      try {
        let jsonStr = responseText.trim();
        jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const objStart = jsonStr.indexOf('{');
        const objEnd = jsonStr.lastIndexOf('}');
        if (objStart !== -1 && objEnd > objStart) {
          jsonStr = jsonStr.substring(objStart, objEnd + 1);
        }
        tier1Results = JSON.parse(jsonStr);
        tier1Success = Object.keys(tier1Results).length > 0;
        researchLog.push('Tier 1 extracted ' + Object.keys(tier1Results).length + ' field(s)');
      } catch (parseErr) {
        researchLog.push('Tier 1 JSON parse failed: ' + parseErr.message);
      }
    } else {
      researchLog.push('Ollama HTTP error: ' + ollamaResponse.status);
    }
  } catch (ollamaErr) {
    researchLog.push('Ollama call failed: ' + (ollamaErr.message || 'unknown'));
  }
}

// Validate Tier 1 results against scraped text
const validatedTier1 = {};
const scrapedLower = scrapedText.toLowerCase();

for (const [field, value] of Object.entries(tier1Results)) {
  if (!value || typeof value !== 'string') continue;
  const valStr = String(value).trim();
  if (!valStr) continue;

  // Never accept our own numbers
  if (field === 'phone' || field === 'mobile') {
    if (isOwnCompanyPhone(valStr)) {
      researchLog.push('REJECTED own-company ' + field + ': ' + valStr);
      continue;
    }
    // Phone validation: check digit sequence
    const digits = valStr.replace(/\D/g, '');
    if (digits.length >= 7) {
      const digitGroups = digits.match(/.{1,3}/g) || [];
      const flexPattern = digitGroups.join('[\\s.()\\-]*');
      if (new RegExp(flexPattern).test(scrapedText)) {
        validatedTier1[field] = valStr;
        researchLog.push('VERIFIED from web: ' + field + ' = ' + valStr);
      } else {
        researchLog.push('REJECTED (not in page): ' + field + ' = ' + valStr);
      }
    }
  } else {
    // Text validation: check if value appears in scraped text
    if (scrapedLower.includes(valStr.toLowerCase())) {
      validatedTier1[field] = valStr;
      researchLog.push('VERIFIED from web: ' + field + ' = ' + valStr);
    } else {
      // Fuzzy: check significant words
      const words = valStr.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
      const allFound = words.length > 0 && words.every(w => scrapedLower.includes(w));
      if (allFound) {
        validatedTier1[field] = valStr;
        researchLog.push('VERIFIED (fuzzy) from web: ' + field + ' = ' + valStr);
      } else {
        researchLog.push('REJECTED (not in page): ' + field + ' = ' + valStr);
      }
    }
  }
}

// Optional Perplexity lookup for fields still missing (enrichment mode only).

let tier2Success = false;
let tier2Results = {};
// Disabled. It sends the contact's name, company and email to a hosted service, so
// enabling it is a privacy decision. If you do, read $env.PERPLEXITY_API_KEY; never paste a key here.
const perplexityKey = '';

// Check what's still missing after Tier 1
// Skip Tier 2 enrichment in discovery mode (discovery contacts are already validated)
const target = enrichmentTargets.length > 0 ? enrichmentTargets[0] : null;
const stillMissing = target ? target.missingFields.filter(f => !validatedTier1[f]) : [];

if (stillMissing.length > 0 && perplexityKey && !discoveryMode) {
  researchLog.push('Tier 2: ' + stillMissing.length + ' fields still missing, calling Perplexity...');

  const searchQuery = `Find contact information for ${target.name}` +
    (target.company ? ` at ${target.company}` : '') +
    (target.email ? ` (email: ${target.email})` : '') +
    `. Specifically looking for: ${stillMissing.join(', ')}.` +
    ` Return ONLY a JSON object with the found fields. Field names: phone, mobile, companyName, jobTitle, city, state, address. Do not guess.`;

  try {
    const pplxResponse = await fetchWithTimeout('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + perplexityKey
      },
      body: JSON.stringify({
        model: 'llama-3.1-sonar-small-128k-online',
        messages: [
          {
            role: 'system',
            content: 'You are a contact information researcher. Return ONLY valid JSON with found fields. Do not fabricate information. If you cannot verify a piece of information from web sources, do not include it.'
          },
          { role: 'user', content: searchQuery }
        ],
        temperature: 0.1,
        max_tokens: 256
      })
    }, 20000); // 20 sec timeout

    if (pplxResponse.ok) {
      const pplxData = await pplxResponse.json();
      const pplxText = pplxData.choices?.[0]?.message?.content || '';
      researchLog.push('Perplexity responded: ' + pplxText.substring(0, 200));

      // Parse JSON from Perplexity response
      try {
        let jsonStr = pplxText.trim();
        jsonStr = jsonStr.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const objStart = jsonStr.indexOf('{');
        const objEnd = jsonStr.lastIndexOf('}');
        if (objStart !== -1 && objEnd > objStart) {
          jsonStr = jsonStr.substring(objStart, objEnd + 1);
        }
        const parsed = JSON.parse(jsonStr);

        // Not checked against a scraped page, so accept only the fields we asked for.
        for (const field of stillMissing) {
          if (parsed[field] && typeof parsed[field] === 'string' && parsed[field].trim()) {
            // Never accept our own numbers
            if ((field === 'phone' || field === 'mobile') && isOwnCompanyPhone(parsed[field])) {
              researchLog.push('REJECTED own-company ' + field + ' from Perplexity: ' + parsed[field]);
              continue;
            }
            tier2Results[field] = parsed[field].trim();
            researchLog.push('Perplexity found: ' + field + ' = ' + parsed[field]);
          }
        }
        tier2Success = Object.keys(tier2Results).length > 0;
      } catch (parseErr) {
        researchLog.push('Perplexity JSON parse failed: ' + parseErr.message);
      }
    } else {
      const errText = await pplxResponse.text().catch(() => '');
      researchLog.push('Perplexity HTTP ' + pplxResponse.status + ': ' + errText.substring(0, 200));
    }
  } catch (pplxErr) {
    researchLog.push('Perplexity call failed: ' + (pplxErr.message || 'unknown'));
  }
} else if (stillMissing.length > 0 && !perplexityKey && !discoveryMode) {
  researchLog.push('Tier 2 skipped: PERPLEXITY_API_KEY not configured');
} else {
  researchLog.push('Tier 2 skipped: ' + (discoveryMode ? 'discovery mode' : 'all fields filled by Tier 1'));
}

// Merge results into contacts.

// If discovery mode found contacts, replace the contact list
if (discoveryMode && discoveredContacts.length > 0) {
  // Keep the original contacts (forwarder info) but add discovered ones
  // Remove personal-domain-only contacts since we now have real business contacts
  const keptContacts = contacts.filter(c => {
    const cEmail = (c.email || '').toLowerCase();
    if (!cEmail) return false;
    const cDomain = cEmail.split('@')[1] || '';
    return !PERSONAL_DOMAINS.has(cDomain);
  });

  // Merge: don't add duplicates (by email)
  const existingEmails = new Set(keptContacts.map(c => (c.email || '').toLowerCase()));
  for (const dc of discoveredContacts) {
    const dcEmail = (dc.email || '').toLowerCase();
    if (dcEmail && existingEmails.has(dcEmail)) continue;
    keptContacts.push(dc);
    if (dcEmail) existingEmails.add(dcEmail);
  }

  // Apply suggestedType from forwarder if available
  const suggestedType = input.suggestedType || '';
  if (suggestedType) {
    for (const c of keptContacts) {
      if (!c.type) {
        c.type = suggestedType;
        c.typeSource = 'forwarder_hint';
      }
    }
  }

  allResults.push({ json: {
    ...input,
    contacts: keptContacts,
    contactCount: keptContacts.length,
    webResearchAttempted: true,
    webResearchSucceeded: true,
    webResearchMode: 'discovery',
    discoveredContactCount: discoveredContacts.length,
    pagesVisited: pagesVisited,
    researchLog: researchLog,
    needsWebResearch: false,
    hasCriticalFields: keptContacts.some(c => !!(c.email || (c.firstName && c.lastName))),
    perplexityConfigured: !!perplexityKey
  }}); continue;
}

// Combine Tier 1 + Tier 2 results (Tier 1 takes priority since it's source-verified)
const mergedResults = { ...tier2Results, ...validatedTier1 };
const enrichedFields = [];

// Phone label stripping (same as Parse AI Response)
function cleanPhoneLabel(phoneStr) {
  if (!phoneStr) return phoneStr;
  return phoneStr
    .replace(/\s*(?:office|direct|cell|mobile|home|work|fax|main|ext\.?\s*\d*)\s*$/i, '')
    .replace(/^\s*(?:office|direct|cell|mobile|home|work|fax|main)\s*[:.]\s*/i, '')
    .trim();
}

// Apply to primary contact (enrichmentTargets[0])
if (Object.keys(mergedResults).length > 0 && enrichmentTargets.length > 0) {
  const targetIdx = enrichmentTargets[0].index;
  const contact = contacts[targetIdx];

  for (const [field, value] of Object.entries(mergedResults)) {
    // Only fill fields that are currently empty
    const currentValue = contact[field] || '';
    if (!currentValue) {
      let cleanValue = value;

      // Clean phone labels
      if (field === 'phone' || field === 'mobile') {
        cleanValue = cleanPhoneLabel(value);
      }

      contact[field] = cleanValue;
      enrichedFields.push({ field, value: cleanValue, source: validatedTier1[field] ? 'url_scrape' : 'perplexity' });

      // Add to verifiedFields if from Tier 1 (source-verified)
      if (validatedTier1[field]) {
        contact.verifiedFields = contact.verifiedFields || [];
        contact.verifiedFields.push(field);
      }

      // Remove from clearedFields if we found a valid value
      if (contact.clearedFields) {
        contact.clearedFields = contact.clearedFields.filter(f => {
          const fName = typeof f === 'string' ? f : f.field;
          return fName !== field;
        });
      }
    }
  }

  // Recalculate verification score
  const verified = (contact.verifiedFields || []).length;
  const unverified = (contact.unverifiedFields || []).length;
  const cleared = (contact.clearedFields || []).length;
  const total = verified + unverified + cleared;
  contact.verificationScore = total > 0 ? Math.round((verified / total) * 100) : 0;

  // If enrichment improved verification enough, un-block from Zoho
  if (contact.skipZohoUpsert && contact.verificationScore >= 50 &&
      !(contact.unverifiedFields || []).includes('email')) {
    contact.skipZohoUpsert = false;
    contact.infoNotes = contact.infoNotes || [];
    contact.infoNotes.push('Un-blocked after web research improved verification to ' + contact.verificationScore + '%');
    researchLog.push('Contact un-blocked from Zoho (verification now ' + contact.verificationScore + '%)');
  }
}

// Stub contacts with a name and a company domain but no email get inferred email
// patterns, stored separately as inferredEmail (low confidence) and never as email.
for (const et of enrichmentTargets) {
  const c = contacts[et.index];
  if (c.extractionMethod === 'STUB_FROM_FRAGMENTS' && !c.email && c.firstName && c.lastName) {
    // Try to determine domain: from website, from company name, or from DDG results
    let inferDomain = '';
    if (c.website) {
      try {
        inferDomain = new URL(c.website).hostname.replace(/^www\./, '');
      } catch(e) {}
    }
    if (!inferDomain && c.companyName) {
      const candidateDomains = companyToDomains(c.companyName);
      if (candidateDomains.length > 0) inferDomain = candidateDomains[0];
    }
    if (inferDomain) {
      const inferred = inferEmailPatterns(c.firstName, c.lastName, inferDomain);
      if (inferred.length > 0) {
        c.inferredEmails = inferred;
        c.inferredEmailDomain = inferDomain;
        c.infoNotes = c.infoNotes || [];
        c.infoNotes.push('Email patterns inferred from name + company domain (' + inferDomain + ') - NOT verified, please confirm');
        researchLog.push('Inferred ' + inferred.length + ' email candidates for ' + et.name + ' @ ' + inferDomain);
        // Use the most common pattern as a suggestion but mark as inferred
        c.inferredEmail = inferred[0];
        c.inferredEmailConfidence = 'low';
      }
    }
  }
}

// Discovery scraped a page but found no complete contacts: collect the names and
// phones it did show, so the confirmation email can tell the user what was there.
let partialFindings = [];
if (discoveryMode && discoveredContacts.length === 0 && allScrapedTexts.length > 0) {
  try {
    // Names come from raw HTML tags plus text lines, with strict validation so
    // navigation labels are not mistaken for people.
    for (const scraped of allScrapedTexts) {
      const rawHtml = scraped.rawHtml || '';
      const rawText = scraped.text || '';

      // Strategy 1: names from the HTML elements that usually hold person names
      // Covers h1-h6, strong, b, span, p, div, a, li - any tag that might wrap a name
      const tagNames = [];
      // Headings (any level)
      const hRegex = /<h[1-6][^>]*>\s*([^<]{3,60})\s*<\/h[1-6]>/gi;
      let hMatch;
      while ((hMatch = hRegex.exec(rawHtml)) !== null) {
        tagNames.push(hMatch[1].trim());
      }
      // Strong, b, em tags (names are often bolded)
      const boldRegex = /<(?:strong|b|em)[^>]*>\s*([^<]{3,60})\s*<\/(?:strong|b|em)>/gi;
      while ((hMatch = boldRegex.exec(rawHtml)) !== null) {
        tagNames.push(hMatch[1].trim());
      }
      // Spans and divs with name-like classes/IDs
      const classRegex = /<(?:span|div|p|a|li)[^>]*class="[^"]*(?:name|member|person|team|staff|author|bio)[^"]*"[^>]*>\s*([^<]{3,60})\s*<\/(?:span|div|p|a|li)>/gi;
      while ((hMatch = classRegex.exec(rawHtml)) !== null) {
        tagNames.push(hMatch[1].trim());
      }

      // Clean HTML entities
      const cleanedTagNames = tagNames.map(t =>
        t.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
         .replace(/&#x27;/g, "'").replace(/&#\d+;/g, '').replace(/\s+/g, ' ').trim()
      );

      // Strategy 2: names from plain text lines, always merged with the tag results
      const textNames = rawText.split('\n').map(l => l.trim()).filter(l => l.length >= 5 && l.length <= 50);

      // Combine both sources - tag names first (higher confidence), then text lines
      const allCandidates = [...new Set([...cleanedTagNames, ...textNames])];

      // Strict person name validation
      const NOT_NAMES = new Set([
        'office','phone','email','address','contact','locations','form','about','home',
        'menu','search','login','our','the','and','for','with',
        'featured','skip','content','social','media','facebook','youtube','instagram',
        'twitter','linkedin','pinterest','tiktok','read','more','learn','view','click',
        'here','back','next','previous','submit','send','close','open','download',
        'subscribe','newsletter','blog','news','events','services','products','gallery',
        'portfolio','testimonials','reviews','faq','privacy','terms','policy','sitemap',
        'copyright','all','rights','reserved','powered','built','designed','website',
        'locations','hours','directions','map','careers','jobs','team','staff','crew',
        'leadership','management','executives','advisors','partners','associates',
        'sales','marketing','operations','finance','legal','technology','support',
        'customer','client','member','account','profile','settings','dashboard',
        'mobile','desktop','app','platform','system','network','group','company',
        'solutions','consulting','international','global','national','regional','local',
        'new','top','best','great','free','get','buy','sell','rent','lease','find',
        'street','avenue','road','boulevard','suite','floor','city','state','zip',
        'office','submission','form','request','quote','inquiry','appointment'
      ]);

      for (const candidate of allCandidates) {
        const words = candidate.split(/\s+/);
        // Person names are 2-4 words
        if (words.length < 2 || words.length > 4) continue;
        // Every word must start with uppercase (or be all-caps like "TY")
        if (!words.every(w => /^[A-Z]/.test(w))) continue;
        // No word should be in the not-names list
        if (words.some(w => NOT_NAMES.has(w.toLowerCase()))) continue;
        // No numbers, special chars (except apostrophe/hyphen in names)
        if (/[0-9<>{}@\[\]|\\\/()&,;:!?]/.test(candidate)) continue;
        // At least one word should be 3+ chars (filters out "Mr. X" type junk)
        if (!words.some(w => w.replace(/[^a-zA-Z]/g, '').length >= 3)) continue;
        // Filter common title patterns that aren't names
        if (/^(Dr|Mr|Mrs|Ms|CEO|CFO|COO|CTO|VP|SVP|EVP|President|Director|Manager)\b/i.test(candidate)) continue;

        const firstName = words[0].charAt(0) + words[0].slice(1).toLowerCase();
        const lastName = words.slice(1).map(w => {
          // All-caps names: "EXAMPLE" -> "Example"
          if (w === w.toUpperCase() && w.length > 2) return w.charAt(0) + w.slice(1).toLowerCase();
          return w;
        }).join(' ');

        partialFindings.push({ name: firstName + ' ' + lastName, firstName, lastName, source: scraped.url });
      }

      // Strategy 3: Phone numbers from tel: links in raw HTML
      const telRegex = /href=["']tel:([^"']+)["']/gi;
      let telMatch;
      const foundPhones = [];
      while ((telMatch = telRegex.exec(rawHtml)) !== null) {
        const phone = telMatch[1].replace(/[^\d+\-().]/g, '').trim();
        if (phone.length >= 10) foundPhones.push(phone);
      }

      // Try to match phones to names by proximity in HTML
      if (foundPhones.length > 0 && partialFindings.length > 0) {
        // Simple: assign phones round-robin to names if count matches roughly
        if (foundPhones.length === partialFindings.length) {
          for (let i = 0; i < foundPhones.length; i++) {
            partialFindings[i].phone = foundPhones[i];
          }
        } else {
          researchLog.push('Found ' + foundPhones.length + ' phone(s) but ' + partialFindings.length + ' name(s) - could not match');
        }
      }
    }

    // Deduplicate by name
    const seen = new Set();
    partialFindings = partialFindings.filter(p => {
      const key = p.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (partialFindings.length > 0) {
      researchLog.push('Partial findings: ' + partialFindings.length + ' person names found on page (no emails)');
    }
  } catch(e) {
    researchLog.push('Partial findings extraction failed: ' + (e.message || ''));
  }
}

// Still needs research only if fields were cleared and nothing was found.
const remainingCleared = contacts.flatMap(c => c.clearedFields || []);
const stillNeedsResearch = remainingCleared.length > 0 && enrichedFields.length === 0;


allResults.push({ json: {
  ...input,
  contacts: contacts,
  webResearchAttempted: true,
  webResearchSucceeded: enrichedFields.length > 0,
  webResearchTier1: tier1Success,
  webResearchTier2: tier2Success,
  enrichedFields: enrichedFields,
  enrichedFieldCount: enrichedFields.length,
  pagesVisited: pagesVisited,
  researchLog: researchLog,
  needsWebResearch: stillNeedsResearch,
  perplexityConfigured: !!perplexityKey,
  partialFindings: partialFindings.length > 0 ? partialFindings : undefined
}});
} // end of allItems loop

return allResults;