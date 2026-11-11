// Determine Research URL
//
// Picks the one URL the research branch should fetch. Order of preference:
// 1. URL_DISCOVERY strategy with a primaryUrl: the URL the forwarder sent on purpose.
// 2. The first contact's known website.
// 3. The first contact's email domain (personal domains skipped).
// 4. Any prominent URL from the email (primaryUrl).
// 5. allUrls (signatures, replies, the forwarded chain): a team/about page first,
//    then the first URL that is not social, search, or a link shortener.
// 6. A company domain taken from any email address in the body, except the forwarder's.
// Nothing found leaves hasResearchUrl false.
//
// Input: one item from Validate Contact Type.
// Output: the same item plus researchUrl, hasResearchUrl, urlSource, discoveryUrl.

const prevData = $input.all()[0].json;
const strategy = prevData.extractionStrategy || '';
const contacts = prevData.contacts || [];
const primaryUrl = prevData.primaryUrl || '';
const allUrls = prevData.allUrls || [];

// A personal mailbox domain says nothing about the contact's company.
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'aol.com',
  'icloud.com', 'me.com', 'live.com', 'msn.com', 'protonmail.com',
  'mail.com', 'zoho.com', 'yandex.com', 'gmx.com', 'pm.me',
  'fastmail.com', 'tutanota.com', 'hey.com', 'comcast.net', 'att.net',
  'verizon.net', 'sbcglobal.net', 'bellsouth.net', 'cox.net',
  'earthlink.net', 'mac.com', 'rocketmail.com'
]);

// Team pages list several people with contact details, so they beat a homepage.
const TEAM_PAGE_PATTERN = /\/(team|about|contact|staff|people|leadership|management|executives|directors|board|bios|profiles|personnel|partners|principals|professionals|members)/i;

let researchUrl = '';
let hasResearchUrl = false;
let urlSource = '';

// 1. Discovery strategy with an explicit URL
if (strategy === 'URL_DISCOVERY' && primaryUrl) {
  researchUrl = primaryUrl;
  hasResearchUrl = true;
  urlSource = 'URL_DISCOVERY_PRIMARY';
}

// 2. Contact's website
if (!hasResearchUrl && contacts.length > 0) {
  const c = contacts[0];
  if (c.website) {
    researchUrl = c.website.startsWith('http') ? c.website : 'https://' + c.website;
    hasResearchUrl = true;
    urlSource = 'CONTACT_WEBSITE';
  }
}

// 3. Contact's email domain
if (!hasResearchUrl && contacts.length > 0) {
  const c = contacts[0];
  if (c.email) {
    const domain = c.email.split('@')[1];
    if (domain && !PERSONAL_DOMAINS.has(domain.toLowerCase())) {
      researchUrl = 'https://' + domain;
      hasResearchUrl = true;
      urlSource = 'CONTACT_EMAIL_DOMAIN';
    }
  }
}

// 4. Any prominent URL from the email
if (!hasResearchUrl && primaryUrl) {
  researchUrl = primaryUrl;
  hasResearchUrl = true;
  urlSource = 'PRIMARY_URL';
}

// 5. allUrls: team/about page first, then the first usable URL
if (!hasResearchUrl && allUrls.length > 0) {
  const teamUrl = allUrls.find(u => TEAM_PAGE_PATTERN.test(u));
  if (teamUrl) {
    researchUrl = teamUrl;
    hasResearchUrl = true;
    urlSource = 'ALL_URLS_TEAM_PAGE';
  }

  if (!hasResearchUrl) {
    const socialDomains = ['facebook.com', 'twitter.com', 'x.com', 'linkedin.com',
      'instagram.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com',
      'google.com', 'bing.com', 'maps.google.com', 'goo.gl', 'bit.ly', 't.co',
      'wa.me', 'whatsapp.com', 'telegram.me', 'discord.gg'];
    const socialSet = new Set(socialDomains);

    for (const url of allUrls) {
      try {
        const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
        if (!socialSet.has(hostname) && !PERSONAL_DOMAINS.has(hostname)) {
          researchUrl = url;
          hasResearchUrl = true;
          urlSource = 'ALL_URLS_FIRST_VALID';
          break;
        }
      } catch (e) {
        // Unparseable URL: try the next one
      }
    }
  }
}

// 6. Last resort: a company domain from any address in the body
if (!hasResearchUrl) {
  const fullBody = prevData.fullBody || '';
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const foundEmails = fullBody.match(emailPattern) || [];
  // The forwarder's own address would point research at our own site.
  const forwarderEmail = (prevData.forwarderEmail || '').toLowerCase();

  for (const email of foundEmails) {
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain && !PERSONAL_DOMAINS.has(domain) && email.toLowerCase() !== forwarderEmail) {
      researchUrl = 'https://' + domain;
      hasResearchUrl = true;
      urlSource = 'BODY_EMAIL_DOMAIN';
      break;
    }
  }
}

return [{
  json: {
    ...prevData,
    researchUrl: researchUrl,
    hasResearchUrl: hasResearchUrl,
    urlSource: urlSource,
    discoveryUrl: researchUrl // alias read by Prepare Research Request
  }
}];
