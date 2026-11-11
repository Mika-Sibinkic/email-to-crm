// Map Outlook to Standard Format
//
// First node after the Outlook trigger. Turns each Microsoft Graph message into the
// flat shape the rest of the workflow reads, and rejects mail that must never be
// extracted: drafts and Sent Items copies, duplicates, the intake mailbox's own
// mail, auto-replies, unsolicited outside mail, bounces, the workflow's own
// confirmations, and blank bodies. A rejected email becomes { skip: true,
// skipReason } and every downstream node passes it through untouched.
//
// It also strips HTML to text, flags image and PDF attachments (including inline
// CID photos such as business cards), and normalizes entities, invisible characters,
// odd spaces and Unicode dashes once here so later regexes only see plain text.
//
// Input: Graph message items from the trigger.
// Output: { email_id, thread_id, subject, body, rawHtml, received_date,
// forwarderEmail, forwarderName, hasAttachments, attachmentHints, source } or a skip item.

// Organization settings
const OWN_DOMAINS = new Set(['yourcompany.com']);
const OWN_STAFF = [
  { name: 'Pat Staffer', email: 'pat@yourcompany.com', title: 'Managing Director' },
  { name: 'Alex Example', email: 'alex@yourcompany.com', title: 'Associate' }
];
const INTAKE_ADDRESS = 'contacts@yourcompany.com';
const SUBJECT_TAG = '[CRM]';
// Outside addresses allowed to send requests, e.g. a staff member's personal mailbox.
const KNOWN_FORWARDERS = new Set([]);

// The trigger polls every folder, so a message the intake mailbox sends to itself shows up in
// Sent Items as well as the Inbox. Folder IDs are fixed per mailbox: read them once from
// GET /users/<intake mailbox>/mailFolders/sentitems and /drafts and paste them here.
const SENT_ITEMS_FOLDER_ID = '<sent-items-folder-id>';
const DRAFTS_FOLDER_ID = '<drafts-folder-id>';

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SUBJECT_TAG_RE = escapeRe(SUBJECT_TAG.toLowerCase());
const OWN_DOMAIN_RE = [...OWN_DOMAINS].map(escapeRe).join('|');

// Cyrillic and Greek letters that look like Latin ones, as pasted from PDFs or used to spoof.
const HOMOGLYPH_FROM = '\u0410\u0430\u0412\u0415\u0435\u041a\u041c\u041d\u041e\u043e\u0420\u0440\u0421\u0441\u0422\u0425\u0445\u0423\u0443\u0406\u0456\u0408\u0458\u0405\u0455' +
  '\u0391\u0392\u0395\u0396\u0397\u0399\u039a\u039c\u039d\u039f\u03bf\u03a1\u03c1\u03a4\u03a5\u03a7\u03b9\u03bd';
const HOMOGLYPH_TO = 'AaBEeKMHOoPpCcTXxYyIiJjSs' + 'ABEZHIKMNOoPpTYXiv';
const HOMOGLYPHS = Object.fromEntries([...HOMOGLYPH_FROM].map((ch, i) => [ch, HOMOGLYPH_TO[i]]));
if (HOMOGLYPH_FROM.length !== HOMOGLYPH_TO.length) throw new Error('HOMOGLYPH tables differ in length');

// Spelled-out addresses. Bare AT/DOT must be uppercase so English "at" never matches.
const OBF_AT = String.raw`(?:\s*[\[(]\s*[Aa][Tt]\s*[\])]\s*|\s+AT\s+)`;
const OBF_DOT = String.raw`(?:\s*[\[(]\s*[Dd][Oo][Tt]\s*[\])]\s*|\s+DOT\s+)`;
const OBFUSCATED_EMAIL = new RegExp(String.raw`([\w.+-]+)${OBF_AT}([\w-]+(?:${OBF_DOT}[\w-]+)+)`, 'g');

const allItems = $input.all();
const results = [];
const seenInternetIds = new Set();

for (const item of allItems) {
  const email = item.json;

  const senderAddress = (email.from?.emailAddress?.address || '').toLowerCase();
  const rawSubject = (email.subject || '').toLowerCase();

  // Only the Inbox copy is processed; the others would upsert the same contact twice.
  if (email.isDraft === true || email.parentFolderId === DRAFTS_FOLDER_ID) {
    results.push({ json: { skip: true, skipReason: 'DRAFT', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }
  if (email.parentFolderId === SENT_ITEMS_FOLDER_ID) {
    results.push({ json: { skip: true, skipReason: 'SENT_ITEMS_COPY', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }
  if (email.internetMessageId) {
    if (seenInternetIds.has(email.internetMessageId)) {
      results.push({ json: { skip: true, skipReason: 'DUPLICATE_COPY: ' + email.internetMessageId, email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
    seenInternetIds.add(email.internetMessageId);
  }

  // Mail from the intake mailbox is usually the workflow's own output; processing it would loop.
  if (senderAddress === INTAKE_ADDRESS) {
    // A human can bounce a request through a personal mailbox and back: the From header still
    // shows the intake address, but the body carries the forward headers.
    const bodySnippet = (email.body?.content || email.bodyPreview || '').substring(0, 3000);
    const reforwardSenders = [...KNOWN_FORWARDERS, ...OWN_STAFF.map(s => s.email)];
    const isHumanReforward = /---------- Forwarded message/i.test(bodySnippet) ||
      reforwardSenders.some(a => new RegExp('From:.*' + escapeRe(a), 'i').test(bodySnippet));

    // Confirmations carry the subject tag; a RE:/FW: of one is still not a request.
    const isSystemEmail = new RegExp('^(?:(?:re|fw|fwd)\\s*:\\s*)*' + SUBJECT_TAG_RE, 'i').test((email.subject || ''));

    // A request typed inside the intake mailbox and addressed to itself is a real request.
    const recipients = [...(email.toRecipients || []), ...(email.ccRecipients || [])]
      .map(r => (r.emailAddress?.address || '').toLowerCase());
    const isSelfAddressedRequest = recipients.includes(INTAKE_ADDRESS);

    if (!(isHumanReforward || isSelfAddressedRequest) || isSystemEmail) {
      results.push({ json: { skip: true, skipReason: 'SELF_SENT: from contacts@ inbox', email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
  }

  // A person forwarding an auto-reply or bounce ("FW: Automatic reply: ...") is making a
  // request, so the subject checks below only apply when the subject does not start with FW:.
  const isHumanForward = /^\s*fwd?\s*:/i.test(rawSubject);

  // Auto-replies and out-of-office notices, including the localized Outlook prefixes.
  const autoReplyPatterns = [
    /out\s+of\s+(the\s+)?office/i,
    /automatic\s+reply/i,
    /auto[\s-]?reply/i,
    /auto[\s-]?response/i,
    /auto[\s-]?generated/i,
    /do\s+not\s+reply/i,
    /this\s+is\s+an?\s+automated/i,
    /r[\u00e9e]ponse\s+automatique|absence\s+du\s+bureau/i,
    /respuesta\s+autom[\u00e1a]tica|fuera\s+de\s+la\s+oficina/i,
    /resposta\s+autom[\u00e1a]tica|risposta\s+automatica/i,
    /automatische\s+antwort|abwesenheitsnotiz|automatisch\s+antwoord/i
  ];
  const isAutoReply = (!isHumanForward && autoReplyPatterns.some(p => p.test(rawSubject))) ||
    (email.internetMessageHeaders || []).some(h =>
      h.name?.toLowerCase() === 'auto-submitted' && h.value !== 'no'
    );
  if (isAutoReply) {
    results.push({ json: { skip: true, skipReason: 'AUTO_REPLY: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // Bounces and delivery failures. Checked before the outside-sender rule so a bounce from an
  // outside mail server is reported as a bounce.
  const bouncePatterns = [
    /delivery\s+(status|failure|has\s+failed)/i,
    /undeliverable/i,
    /undelivered/i,
    /mail\s+delivery\s+(failed|subsystem)/i,
    /mailer[\s-]?daemon/i,
    /returned\s+mail/i,
    /failure\s+notice/i
  ];
  const isBounce = (!isHumanForward && bouncePatterns.some(p => p.test(rawSubject))) ||
    senderAddress.includes('mailer-daemon') ||
    senderAddress.includes('postmaster@');
  if (isBounce) {
    results.push({ json: { skip: true, skipReason: 'BOUNCE: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // Newsletters and cold outreach sent straight to the intake address are not requests.
  const senderDomain = senderAddress.split('@')[1] || '';
  const isOwnSender = OWN_DOMAINS.has(senderDomain);
  const isKnownForwarder = KNOWN_FORWARDERS.has(senderAddress);

  if (!isOwnSender && !isKnownForwarder) {
    // Unless the body shows staff forwarded it from somewhere else.
    const bodyText = (email.body?.content || email.bodyPreview || '').substring(0, 2000);
    const hasForwardIndicator = new RegExp('---------- Forwarded message|Begin forwarded message|From:.*@(?:' + OWN_DOMAIN_RE + ')', 'i').test(bodyText);
    if (!hasForwardIndicator) {
      results.push({ json: { skip: true, skipReason: 'UNSOLICITED: external sender ' + senderAddress + ' (not forwarded by staff)', email_id: email.id || '', subject: email.subject || '' } });
      continue;
    }
  }

  // The workflow's own confirmations ("[CRM] Upserted 1 contact: Jane Doe"); see Prepare Confirmation Email.
  // A staff "RE: [CRM] ..." quotes the confirmation and is skipped too, unless the new text above
  // the quote supplies an outside address, as the "No Contact Found" confirmation asks.
  const confirmMatch = new RegExp('^((?:(?:re|aw|fw|fwd)\\s*:\\s*)*)' + SUBJECT_TAG_RE).exec(rawSubject);
  let isConfirmationReply = !!confirmMatch;
  if (confirmMatch && confirmMatch[1]) {
    const replyText = (email.body?.content || email.bodyPreview || '')
      .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
      .split(/\bFrom\s*:|-----Original Message/i)[0];
    const replyEmails = replyText.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) || [];
    if (replyEmails.some(a => !OWN_DOMAINS.has(a.split('@')[1].toLowerCase()))) isConfirmationReply = false;
  }
  if (isConfirmationReply ||
      /^\[contact\s+extractor\]/i.test(rawSubject) ||
      /^✅\s*(contact|extraction|processed)/i.test(rawSubject)) {
    results.push({ json: { skip: true, skipReason: 'OWN_CONFIRMATION: ' + rawSubject, email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  // Attachment hints tell Email Parser which extraction strategy to pick.
  let attachmentHints = [];
  if (email.hasAttachments) {
    const atts = email.attachments || [];
    for (const att of atts) {
      const name = (att.name || '').toLowerCase();
      const ctype = (att.contentType || '').toLowerCase();
      if (/\.(png|jpg|jpeg|gif|bmp|tiff|webp|heic)$/.test(name) || ctype.startsWith('image/')) {
        if (!attachmentHints.includes('IMAGE')) attachmentHints.push('IMAGE');
      }
      if (/\.pdf$/.test(name) || ctype === 'application/pdf') {
        if (!attachmentHints.includes('PDF')) attachmentHints.push('PDF');
      }
      // A shared contact card (iPhone "Share Contact", Outlook "Forward as vCard").
      if (/\.vcf$/.test(name) || ctype.includes('vcard')) {
        if (!attachmentHints.includes('VCARD')) attachmentHints.push('VCARD');
      }
    }
  }

  // Graph returns either HTML or plain text.
  let bodyText = '';
  if (email.body) {
    bodyText = email.body.content || '';
    // A basic strip is enough: the model and the regexes only need readable lines.
    if (email.body.contentType === 'html' || email.body.contentType === 'HTML') {
      // Look for inline CID images before stripping them: phone forwards embed business card
      // photos this way and Graph reports hasAttachments=false for them.
      const cidImageTags = bodyText.match(/<img[^>]*src\s*=\s*["']cid:[^"']*["'][^>]*>/gi) || [];
      for (const tag of cidImageTags) {
        const altMatch = tag.match(/alt\s*=\s*["']([^"']+)["']/i);
        const alt = altMatch ? altMatch[1] : '';
        // Camera photos have alt text like IMG_1234.jpeg or DSC_; signature icons have none or "logo".
        if (/^(IMG_|DSC_|Photo|image|pic)/i.test(alt) || /\.(jpe?g|png|heic)$/i.test(alt)) {
          if (!attachmentHints.includes('IMAGE')) attachmentHints.push('IMAGE');
        }
      }
      // Many inline images with one wider than 100px usually means a real picture among
      // the signature icons (social buttons and logos are small).
      if (cidImageTags.length >= 4 && !attachmentHints.includes('IMAGE')) {
        const hasLargeImage = cidImageTags.some(tag => {
          const wMatch = tag.match(/width\s*=\s*["']?(\d+)/i);
          const w = wMatch ? parseInt(wMatch[1]) : 0;
          const altM = tag.match(/alt\s*=\s*["']([^"']+)["']/i);
          const a = altM ? altM[1].toLowerCase() : '';
          const isBrandIcon = /^(facebook|linkedin|instagram|twitter|youtube|your\s*company|logo|icon)/i.test(a);
          return w > 100 && !isBrandIcon;
        });
        if (hasLargeImage) {
          attachmentHints.push('IMAGE');
        }
      }
      
      // A label/value table (CRM lead notices, web forms: "Title | Controller") would flatten to
      // "Title Controller", which reads as a name. Write its rows as "Label: value" instead.
      // Innermost tables only; needs 3+ two-cell rows, short label cells, and 2+ contact-field labels.
      const cellText = c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ').trim();
      bodyText = bodyText.replace(/<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi, table => {
        const rows = (table.match(/<tr\b[\s\S]*?<\/tr>/gi) || []).map(r => r.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []);
        const labels = rows.map(cells => cells.length === 2 ? cellText(cells[0]) : null);
        const isForm = rows.length >= 3 && labels.every(l => l && l.length <= 30 && /^[A-Za-z][A-Za-z .#&\/-]*:?$/.test(l) && l.split(' ').length <= 4) &&
          labels.filter(l => /^(?:(?:first|last|full|contact)\s+)?name:?$|^e-?mail|phone|mobile|^company|title/i.test(l)).length >= 2;
        return isForm ? table.replace(/(<tr\b[^>]*>\s*<t[dh]\b[\s\S]*?)(<\/t[dh]>)/gi, (m, cell, close) => (/:\s*$/.test(cellText(cell)) ? m : cell + ':' + close)) : table;
      });

      bodyText = bodyText
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<img[^>]*src\s*=\s*["']cid:[^"']*["'][^>]*>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<\/li>/gi, '\n')
        // Table signatures: rows become lines, cells are separated by a space.
        .replace(/<\/tr>/gi, '\n')
        .replace(/<\/t[dh]>/gi, ' ')
        // A mailto link worded "email" or "here" would lose its address with the tags.
        .replace(/<a\b[^>]*href\s*=\s*["']mailto:([^"'?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
          (m, addr, text) => (text.includes('@') ? m : m + ' (' + addr + ')'))
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
  } else if (email.bodyPreview) {
    bodyText = email.bodyPreview;
  }

  // Normalize once here so downstream regexes see plain characters. Word signatures write
  // phones with non-breaking hyphens, which source validation would otherwise reject.
  bodyText = bodyText
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Fullwidth and math-styled characters pasted into signatures ("\uFF15\uFF15\uFF15", bold names).
    .replace(/[\uFF01-\uFF5E]|[\u{1D400}-\u{1D7FF}]/gu, ch => ch.normalize('NFKC'))
    // Cyrillic or Greek look-alikes inside a Latin word ("\u0410rden") are Latin letters.
    .replace(/[A-Za-z\u0370-\u03FF\u0400-\u04FF]+/g, w => (/[A-Za-z]/.test(w) ? w.replace(/[^A-Za-z]/g, ch => HOMOGLYPHS[ch] || ch) : w))
    .replace(/(\d)[\u00B7\u2022\u2219](?=\d)/g, '$1.')     // "555\u00B7010\u00B70133"
    // Phone emoji used as labels: a handset means mobile, a desk phone means office.
    .replace(/[\u{1F4F1}\u{1F4F2}]\uFE0F?\s*(?=[\d(+])/gu, 'M: ')
    .replace(/[\u260E\u{1F4DE}]\uFE0F?\s*(?=[\d(+])/gu, 'T: ')
    // "jane [at] acme [dot] example", "jane AT acme DOT example"
    .replace(OBFUSCATED_EMAIL, (m, local, domain) => local + '@' + domain.replace(new RegExp(OBF_DOT, 'g'), '.'))
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u2002-\u200a\u202f\u205f\u3000]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\r\n?/g, '\n')        // plain-text bodies arrive with CRLF
    .replace(/[ \t]+/g, ' ')          // tabs + doubled spaces broke name and label regexes
    .replace(/[ \t]+\n/g, '\n');

  // Blank body with nothing attached: nothing to extract. Checked after stripping, since
  // an HTML body can look non-empty and turn out to be only markup.
  const strippedBody = bodyText.replace(/\s+/g, ' ').trim();
  if (strippedBody.length < 20 && !email.hasAttachments && !attachmentHints.includes('IMAGE')) {
    results.push({ json: { skip: true, skipReason: 'BLANK_BODY: body too short (' + strippedBody.length + ' chars), no attachments', email_id: email.id || '', subject: email.subject || '' } });
    continue;
  }

  results.push({
    json: {
      email_id: email.id || '',
      thread_id: email.conversationId || '',
      subject: email.subject || '',
      body: bodyText,
      rawHtml: (email.body?.contentType === 'html') ? (email.body?.content || '') : '',
      received_date: email.receivedDateTime || new Date().toISOString(),
      forwarderEmail: email.from?.emailAddress?.address || '',
      forwarderName: email.from?.emailAddress?.name || '',
      hasAttachments: email.hasAttachments || attachmentHints.length > 0,
      attachmentHints: attachmentHints,
      source: 'outlook'
    }
  });
}

return results;
