// Detect Image-Primary Body — v3.34 (vision pipeline gating)
//
// Runs after Email Parser. Reads the email's body HTML and decides whether the
// vision path should fire. Sets imageMode=true when:
//   - text content (HTML stripped, signatures removed) has < THIN_BODY_CHARS useful chars, AND
//   - body has at least one <img> tag whose src is on the safe-list (not a social icon
//     and not a tracking pixel), AND
//   - no usable EXTERNAL email or phone is already present in the text body.
//
// The third condition is important — if the email's signature already contains the
// real contact, the existing text path will catch it and the vision path adds noise.
//
// Outputs (when imageMode=true):
//   imageMode: true
//   visionImageUrls: [string, ...]   (max 5, ordered by preference)
//   visionDetectionReason: '...'     (audit log)
//
// Outputs (when imageMode=false):
//   imageMode: false  (existing pipeline continues unchanged)

const THIN_BODY_CHARS = 800;
const MIN_IMAGE_HINT_BYTES = 20 * 1024;
const MAX_IMAGES = 5;

// Allow-list: image hosts we trust to fetch from (a marketing-platform CDN,Microsoft/Google CDNs, public webfonts CDNs).
// Anything else is dropped — defends against malicious/inappropriate URLs.
const SAFE_IMAGE_HOST_PATTERNS = [
  /^https?:\/\/[a-z0-9.-]*\.filesafe\.space\//i,
  /^https?:\/\/[a-z0-9.-]*\.googleapis\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.gstatic\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.outlook\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.office\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.googleusercontent\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.dropbox\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.dropboxusercontent\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.amazonaws\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.cloudfront\.net\//i,
  /^https?:\/\/[a-z0-9.-]*\.imgur\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.cdninstagram\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.licdn\.com\//i,
  /^https?:\/\/[a-z0-9.-]*\.linkedin\.com\//i,
];

// Skip-list inside the safe hosts (social icons, spacers, signature buttons, tracking pixels)
const SKIP_PATH_PATTERNS = [
  /\/social\/(facebook|instagram|twitter|linkedin|tiktok|youtube|x_circle|website_circle|pinterest)/i,
  /\/icon\//i,
  /\/spacer/i,
  /\/pixel/i,
  /\/tracking\//i,
  /\/[1-9x]\.(?:gif|png)$/i, // 1x1 / x.png pixel trackers
  /open\.gif/i,
  /\.svg$/i, // svgs usually decorative
];

const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','aol.com','icloud.com',
  'me.com','live.com','msn.com','protonmail.com','mail.com','zoho.com'
]);
const OWN_DOMAINS = new Set([
  'yourcompany.com', 'example-consultancy.com'
]);
const GENERIC_LOCAL_PARTS = new Set([
  'info','sales','support','admin','contact','help','billing',
  'noreply','no-reply','postmaster','webmaster','newsletter','marketing','service'
]);

const allItems = $input.all();
const out = [];

for (const item of allItems) {
  const j = item.json || {};
  // Pass-through if pipeline already decided to skip
  if (j.skip) { out.push({ json: { ...j, imageMode: false } }); continue; }

  const bodyHtml = j.bodyHtml || j.fullBodyHtml || j.htmlBody || (j.body && typeof j.body === 'string' ? j.body : '') || j.fullBody || '';
  const fullBody = j.fullBody || j.body || '';

  // 1) Strip HTML for text-content size estimate
  const textOnly = bodyHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
                            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&[a-z]+;/gi, ' ')
                            .replace(/\s+/g, ' ')
                            .trim();
  const textChars = textOnly.length;

  // 2) Pull <img src> URLs and filter to safe-list, drop social icons/pixels
  const imgUrls = [];
  const imgRegex = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = imgRegex.exec(bodyHtml)) !== null) {
    let src = m[1].trim();
    if (!src || src.startsWith('cid:') || src.startsWith('data:')) continue;
    if (!SAFE_IMAGE_HOST_PATTERNS.some(re => re.test(src))) continue;
    if (SKIP_PATH_PATTERNS.some(re => re.test(src))) continue;
    if (!imgUrls.includes(src)) imgUrls.push(src);
    if (imgUrls.length >= MAX_IMAGES * 3) break;
  }

  // 3) Check if text body already contains a usable external email
  const emailRegex = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const phoneRegex = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g;
  const textEmails = (textOnly.match(emailRegex) || []);
  const externalUsableEmail = textEmails.some(e => {
    const local = (e.split('@')[0] || '').toLowerCase();
    const domain = (e.split('@')[1] || '').toLowerCase();
    return !OWN_DOMAINS.has(domain) && !PERSONAL_EMAIL_DOMAINS.has(domain) && !GENERIC_LOCAL_PARTS.has(local);
  });
  const textPhones = (textOnly.match(phoneRegex) || []);
  const externalPhone = textPhones.some(p => {
    const digits = p.replace(/\D/g, '').slice(-10);
    // crude internal phone exclusion — populate with the firm's own phone numbers (last 10 digits)
    return !['5550100101','5550100102','5550100103','5550100104','5550100105','5550100106','5550100107'].includes(digits);
  });

  // 4) Decide
  const reasonParts = [];
  let imageMode = false;
  if (imgUrls.length > 0) {
    if (textChars < THIN_BODY_CHARS) reasonParts.push(`thin_body(${textChars}<${THIN_BODY_CHARS})`);
    if (!externalUsableEmail) reasonParts.push('no_external_email_in_text');
    if (!externalPhone) reasonParts.push('no_external_phone_in_text');
    // Fire vision when (thin body) AND (no usable text contact). Both must hold.
    if (textChars < THIN_BODY_CHARS && !externalUsableEmail) {
      imageMode = true;
    }
  } else {
    reasonParts.push('no_safe_images');
  }

  const finalUrls = imgUrls.slice(0, MAX_IMAGES);
  out.push({
    json: {
      ...j,
      imageMode,
      visionImageUrls: imageMode ? finalUrls : [],
      visionDetectionReason: reasonParts.join(','),
      visionDetectionMetrics: {
        textChars,
        imgCandidatesFound: imgUrls.length,
        externalUsableEmailInText: externalUsableEmail,
        externalPhoneInText: externalPhone,
      },
    }
  });
}

return out;
