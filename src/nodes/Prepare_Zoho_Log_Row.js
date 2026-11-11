// Prepare Zoho Log Row
//
// Hands the Zoho log row to the Excel append.
// Input: one upstream item. Output: the zohoLogRow, or nothing when the email
// was skipped and no row exists.

const data = $input.first().json;

if (!data || !data.zohoLogRow || typeof data.zohoLogRow !== 'object') {
  return [];
}

return [{ json: data.zohoLogRow }];
