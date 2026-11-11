// Prepare Dev Log Row
//
// Hands the developer log row built by Format for CSV to the Excel append.
// Input: one Format for CSV item. Output: the developerLogRow, or nothing when
// the email was skipped (self-sent, auto-reply) and no row exists.

const data = $input.first().json;

if (!data || !data.developerLogRow || typeof data.developerLogRow !== 'object') {
  return [];
}

return [{ json: data.developerLogRow }];
