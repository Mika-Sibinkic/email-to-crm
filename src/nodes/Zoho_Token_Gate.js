// Zoho Token Gate
//
// Logs in to Zoho at most once every 50 minutes. Refreshing the token once per email
// made one login per forwarded message, and Zoho blocks logins after about 10 in 10
// minutes, so a burst of forwards lost contacts. Prepare Upsert saves each fresh token
// (valid 60 minutes) in the workflow's static data and this node hands it back.
//
// Input: one item per email from Skip Zoho?.
// Output: always one item, so a needed refresh happens once per run:
// { access_token, cachedToken: true } when a token under 50 minutes old exists, else { needRefresh: true }.
const s = $getWorkflowStaticData('global');
if (s.zohoToken && Date.now() - (s.zohoTokenAt || 0) < 50 * 60 * 1000) {
  return [{ json: { access_token: s.zohoToken, cachedToken: true } }];
}
return [{ json: { needRefresh: true } }];
